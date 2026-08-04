/**
 * LogExplorer Evidence · N live adopt — drives adoptEvidencePlacementForExplorer
 * (the same function LogExplorer.tsx calls) + subscribeEvidenceLanesApply.
 * Synthetic XYZ only.
 */
import { describe, expect, it } from "vitest";
import {
  adoptEvidencePlacementForExplorer,
  subscribeEvidenceLanesApply,
  EVIDENCE_LANE_APPLY_EVENT,
} from "../../lib/logExplorer/evidenceLaneApplyBridge";

describe("LogExplorer Evidence · N live adopt (shipped adoptEvidencePlacementForExplorer)", () => {
  it("sets lanes/preferredLaneCount/laneCount from apply detail for matching corpus", () => {
    const result = adoptEvidencePlacementForExplorer("corpus-xyz-demo", 4, {
      corpusId: "corpus-xyz-demo",
      lanes: [
        { id: "lane-0", label: "xyz-api", sources: ["xyz/api.log"] },
        { id: "lane-1", label: "xyz-worker", sources: ["xyz/worker.log"] },
        { id: "lane-2", label: "xyz-db", sources: ["xyz/db.log"] },
      ],
      visibleLaneCount: 3,
      linkMode: "align_time",
      highlightSeqs: [101, 202, 303],
      revision: 1,
    });
    expect(result).not.toBeNull();
    expect(result!.preferredLaneCount).toBe(3);
    expect(result!.laneCount).toBe(3);
    expect(result!.lanes).toHaveLength(3);
    expect(result!.lanes[1]!.sources).toEqual(["xyz/worker.log"]);
    expect(result!.highlightSeqs).toEqual([101, 202, 303]);
    expect(result!.linkMode).toBe("align_time");
  });

  it("respects maxLaneCount clamp (narrow layout) while keeping preferred", () => {
    const result = adoptEvidencePlacementForExplorer("corpus-xyz-demo", 1, {
      corpusId: "corpus-xyz-demo",
      lanes: [
        { id: "lane-0", label: "a", sources: ["a.log"] },
        { id: "lane-1", label: "b", sources: ["b.log"] },
      ],
      visibleLaneCount: 2,
      linkMode: "independent",
      highlightSeqs: [],
      revision: 1,
    });
    expect(result!.preferredLaneCount).toBe(2);
    expect(result!.laneCount).toBe(1);
  });

  it("returns null for a different corpus (session isolation)", () => {
    const result = adoptEvidencePlacementForExplorer("corpus-xyz-demo", 4, {
      corpusId: "other-corpus",
      lanes: [{ id: "lane-0", label: "x", sources: ["x.log"] }],
      visibleLaneCount: 1,
      linkMode: "independent",
      highlightSeqs: [1],
      revision: 1,
    });
    expect(result).toBeNull();
  });

  it("subscribe (Tauri inject) delivers into adoptEvidencePlacementForExplorer", async () => {
    const adopted: NonNullable<
      ReturnType<typeof adoptEvidencePlacementForExplorer>
    >[] = [];
    let tauriHandler:
      | ((e: { payload: Parameters<typeof adoptEvidencePlacementForExplorer>[2] & { eventId?: string } }) => void)
      | null = null;
    const listen: import("../../lib/logExplorer/evidenceLaneApplyBridge").EvidenceLaneListen =
      async (_n, h) => {
        tauriHandler = h as typeof tauriHandler;
        return () => {
          tauriHandler = null;
        };
      };
    const stop = subscribeEvidenceLanesApply((detail) => {
      const next = adoptEvidencePlacementForExplorer(
        "corpus-xyz-demo",
        4,
        detail,
      );
      if (next) adopted.push(next);
    }, listen);
    await new Promise((r) => setTimeout(r, 0));

    // Cross-window Tauri delivery (main chat → log-explorer-* webview)
    tauriHandler!({
      payload: {
        corpusId: "corpus-xyz-demo",
        lanes: [
          { id: "lane-0", label: "xyz-api", sources: ["xyz/api.log"] },
          { id: "lane-1", label: "xyz-worker", sources: ["xyz/worker.log"] },
        ],
        visibleLaneCount: 2,
        linkMode: "align_time",
        highlightSeqs: [101, 202],
        eventId: "cross-window-1",
        revision: 1,
      },
    });
    expect(adopted).toHaveLength(1);
    expect(adopted[0]!.preferredLaneCount).toBe(2);
    expect(adopted[0]!.lanes[0]!.sources).toEqual(["xyz/api.log"]);

    // Same-window CustomEvent
    window.dispatchEvent(
      new CustomEvent(EVIDENCE_LANE_APPLY_EVENT, {
        detail: {
          corpusId: "corpus-xyz-demo",
          lanes: [{ id: "lane-0", label: "only", sources: ["only.log"] }],
          visibleLaneCount: 1,
          linkMode: "independent",
          highlightSeqs: [9],
          eventId: "same-window-1",
          revision: 2,
        },
      }),
    );
    expect(adopted).toHaveLength(2);
    expect(adopted[1]!.laneCount).toBe(1);

    stop();
  });
});
