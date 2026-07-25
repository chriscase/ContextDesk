//! Multi-lane timestamp link + gap visualization pure logic (#486).
//!
//! Link mode shares a time cursor across lanes. Gaps are regions where one lane
//! has events while another does not. Order-only quality refuses fake wall sync.

use super::query::TimeQuality;
use serde::{Deserialize, Serialize};

/// Maximum evidence lanes in v1.
pub const MAX_LANES: usize = 4;

/// Minimum evidence lanes when multi-lane is used.
pub const MIN_LANES: usize = 2;

/// A sparse sample of events used for link/gap math (seq + ts only).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LaneEventRef {
    /// Seq.
    pub seq: u64,
    /// Timestamp (wall or order).
    pub ts: i64,
}

/// Gap region relative to a reference time window.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GapRegion {
    /// Inclusive start ts of the gap.
    pub ts_from: i64,
    /// Exclusive end ts of the gap.
    pub ts_to: i64,
    /// Lane ids that are empty in this region while at least one peer has events.
    pub empty_lane_ids: Vec<String>,
    /// Lane ids that have events in this region.
    pub filled_lane_ids: Vec<String>,
}

/// Result of scrubbing peer lanes to a shared time cursor.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkScrubResult {
    /// Requested cursor.
    pub cursor_ts: i64,
    /// Per-lane nearest event (seq) at or after cursor; None if empty lane.
    pub peer_positions: Vec<PeerPosition>,
    /// Whether link was applied (false when quality refuses).
    pub linked: bool,
    /// Reason when not linked.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refuse_reason: Option<String>,
}

/// Peer lane scroll target.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerPosition {
    /// Lane id.
    pub lane_id: String,
    /// Nearest seq at/after cursor when present.
    pub seq: Option<u64>,
    /// ts of that event.
    pub ts: Option<i64>,
    /// Distance in time from cursor (absolute).
    pub delta_ts: Option<i64>,
}

/// Decide whether timestamp link is allowed for the given quality.
pub fn link_allowed(quality: TimeQuality) -> Result<(), String> {
    match quality {
        TimeQuality::Wall => Ok(()),
        TimeQuality::Mixed => Ok(()), // allowed with UI badge; still wall-ish
        TimeQuality::OrderOnly => Err(
            "timestamp link requires wall-clock time; corpus is order-only (seq is not calendar time)"
                .into(),
        ),
    }
}

/// Find nearest event at or after `cursor_ts` (or closest before if none after).
pub fn nearest_at_or_after(events: &[LaneEventRef], cursor_ts: i64) -> Option<LaneEventRef> {
    if events.is_empty() {
        return None;
    }
    // Assume events sorted by ts then seq.
    match events.binary_search_by_key(&cursor_ts, |e| e.ts) {
        Ok(i) => Some(events[i]),
        Err(i) => {
            if i < events.len() {
                Some(events[i])
            } else {
                // all before cursor — take last
                events.last().copied()
            }
        }
    }
}

/// Scrub peers to a shared time cursor. Refuses when quality is order_only.
pub fn scrub_linked(
    cursor_ts: i64,
    lanes: &[(String, Vec<LaneEventRef>)],
    quality: TimeQuality,
) -> LinkScrubResult {
    if let Err(reason) = link_allowed(quality) {
        return LinkScrubResult {
            cursor_ts,
            peer_positions: lanes
                .iter()
                .map(|(id, _)| PeerPosition {
                    lane_id: id.clone(),
                    seq: None,
                    ts: None,
                    delta_ts: None,
                })
                .collect(),
            linked: false,
            refuse_reason: Some(reason),
        };
    }
    let mut peer_positions = Vec::new();
    for (id, events) in lanes {
        let nearest = nearest_at_or_after(events, cursor_ts);
        peer_positions.push(PeerPosition {
            lane_id: id.clone(),
            seq: nearest.map(|e| e.seq),
            ts: nearest.map(|e| e.ts),
            delta_ts: nearest.map(|e| (e.ts - cursor_ts).abs()),
        });
    }
    LinkScrubResult {
        cursor_ts,
        peer_positions,
        linked: true,
        refuse_reason: None,
    }
}

/// Compute gap regions across lanes over `[window_from, window_to)`.
///
/// Buckets the window into `bucket_secs` slices; a gap is a bucket where some
/// lanes have events and others do not.
pub fn compute_gaps(
    lanes: &[(String, Vec<LaneEventRef>)],
    window_from: i64,
    window_to: i64,
    bucket_secs: i64,
    quality: TimeQuality,
) -> Result<Vec<GapRegion>, String> {
    link_allowed(quality)?;
    if lanes.is_empty() || window_to <= window_from {
        return Ok(vec![]);
    }
    let width = bucket_secs.max(1);
    let mut gaps = Vec::new();
    let mut t = window_from;
    while t < window_to {
        let end = (t + width).min(window_to);
        let mut empty = Vec::new();
        let mut filled = Vec::new();
        for (id, events) in lanes {
            let has = events.iter().any(|e| e.ts >= t && e.ts < end);
            if has {
                filled.push(id.clone());
            } else {
                empty.push(id.clone());
            }
        }
        if !empty.is_empty() && !filled.is_empty() {
            gaps.push(GapRegion {
                ts_from: t,
                ts_to: end,
                empty_lane_ids: empty,
                filled_lane_ids: filled,
            });
        }
        t = end;
    }
    // Merge adjacent identical gap patterns
    Ok(merge_adjacent_gaps(gaps))
}

fn merge_adjacent_gaps(gaps: Vec<GapRegion>) -> Vec<GapRegion> {
    let mut out: Vec<GapRegion> = Vec::new();
    for g in gaps {
        if let Some(last) = out.last_mut() {
            if last.ts_to == g.ts_from
                && last.empty_lane_ids == g.empty_lane_ids
                && last.filled_lane_ids == g.filled_lane_ids
            {
                last.ts_to = g.ts_to;
                continue;
            }
        }
        out.push(g);
    }
    out
}

/// Clamp requested lane count to 1..=MAX_LANES (single lane allowed for #483).
pub fn clamp_lane_count(n: usize) -> usize {
    n.clamp(1, MAX_LANES)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ev(seq: u64, ts: i64) -> LaneEventRef {
        LaneEventRef { seq, ts }
    }

    #[test]
    fn order_only_refuses_link() {
        let r = scrub_linked(
            100,
            &[
                ("a".into(), vec![ev(1, 100)]),
                ("b".into(), vec![ev(2, 200)]),
            ],
            TimeQuality::OrderOnly,
        );
        assert!(!r.linked);
        assert!(r.refuse_reason.is_some());
        assert!(link_allowed(TimeQuality::OrderOnly).is_err());
    }

    #[test]
    fn scrub_finds_peer_positions() {
        let lanes = vec![
            ("api".into(), vec![ev(1, 1000), ev(2, 1100), ev(3, 1200)]),
            ("worker".into(), vec![ev(10, 1050), ev(11, 1150)]),
        ];
        let r = scrub_linked(1100, &lanes, TimeQuality::Wall);
        assert!(r.linked);
        let api = r
            .peer_positions
            .iter()
            .find(|p| p.lane_id == "api")
            .unwrap();
        assert_eq!(api.seq, Some(2));
        let w = r
            .peer_positions
            .iter()
            .find(|p| p.lane_id == "worker")
            .unwrap();
        assert_eq!(w.seq, Some(11)); // 1150 is at-or-after 1100
    }

    #[test]
    fn gaps_where_one_lane_empty() {
        let lanes = vec![
            ("a".into(), vec![ev(1, 0), ev(2, 10), ev(3, 50)]),
            (
                "b".into(),
                vec![ev(10, 0), ev(11, 50)], // gap in middle bucket 10–20
            ),
        ];
        let gaps = compute_gaps(&lanes, 0, 60, 10, TimeQuality::Wall).unwrap();
        // Bucket [10,20): a has event at 10, b empty → gap
        assert!(
            gaps.iter().any(|g| {
                g.empty_lane_ids.contains(&"b".into())
                    && g.filled_lane_ids.contains(&"a".into())
                    && g.ts_from <= 10
                    && g.ts_to > 10
            }),
            "expected gap for b while a filled: {gaps:?}"
        );
    }

    #[test]
    fn clamp_lanes() {
        assert_eq!(clamp_lane_count(0), 1);
        assert_eq!(clamp_lane_count(3), 3);
        assert_eq!(clamp_lane_count(99), MAX_LANES);
    }
}
