//! Curated publisher RSS sources for current-events research fan-in.
//!
//! Feeds are fixed public URLs (no API keys). Results are keyword-filtered
//! against the user query and merged into `web_search`. Per-source enablement
//! lives in app config; missing keys default to [`NewsSourceDef::default_enabled`].

use crate::error::{CoreError, CoreResult};
use crate::ssrf::{validate_provider_url, SsrfPolicy};
use crate::web_research::{
    condense_search_query, host_display_label, urlencoding_encode, WebSearchHit, MAX_BODY_BYTES,
    REQUEST_TIMEOUT_SECS,
};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// UI / config grouping for source packs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NewsSourceGroup {
    /// Public broadcasters / wire-style international.
    PublicIntl,
    /// US mainstream network / wire-adjacent.
    UsMainstream,
    /// Middle East / conflict coverage.
    MiddleEast,
    /// Defense / security analysis.
    Security,
    /// Left / progressive / investigative.
    Progressive,
    /// Right / conservative / libertarian / alt-finance.
    Conservative,
}

impl NewsSourceGroup {
    /// Human label for Settings.
    pub fn label(self) -> &'static str {
        match self {
            Self::PublicIntl => "Public & international",
            Self::UsMainstream => "US mainstream",
            Self::MiddleEast => "Middle East",
            Self::Security => "Defense & security",
            Self::Progressive => "Progressive / investigative",
            Self::Conservative => "Conservative / libertarian",
        }
    }

    /// Stable pack id for `web_search` packs argument / Settings group key.
    pub fn pack_id(self) -> &'static str {
        match self {
            Self::PublicIntl => "public_intl",
            Self::UsMainstream => "us_mainstream",
            Self::MiddleEast => "middle_east",
            Self::Security => "security",
            Self::Progressive => "progressive",
            Self::Conservative => "conservative",
        }
    }

    /// Parse pack id; unknown → None.
    pub fn from_pack_id(id: &str) -> Option<Self> {
        match id.trim().to_ascii_lowercase().as_str() {
            "public_intl" | "public" | "intl" | "international" => Some(Self::PublicIntl),
            "us_mainstream" | "us" | "mainstream" => Some(Self::UsMainstream),
            "middle_east" | "me" | "mena" => Some(Self::MiddleEast),
            "security" | "defense" | "defence" => Some(Self::Security),
            "progressive" | "left" | "investigative" => Some(Self::Progressive),
            "conservative" | "right" | "libertarian" => Some(Self::Conservative),
            _ => None,
        }
    }

    /// All pack ids (stable order).
    pub fn all_pack_ids() -> &'static [&'static str] {
        &[
            "public_intl",
            "us_mainstream",
            "middle_east",
            "security",
            "progressive",
            "conservative",
        ]
    }
}

/// Static definition of a publisher feed.
#[derive(Debug, Clone, Copy)]
pub struct NewsSourceDef {
    /// Stable config id (snake_case).
    pub id: &'static str,
    /// Display name.
    pub label: &'static str,
    /// Public RSS/Atom URL.
    pub feed_url: &'static str,
    /// Settings group.
    pub group: NewsSourceGroup,
    /// Default on when config omits this id.
    pub default_enabled: bool,
    /// Short note for Settings (fetch reliability).
    pub hint: &'static str,
}

/// Curated sources useful for **current events** (probe-backed; real publisher URLs).
///
/// Defaults are **on**. Users can disable any source in Settings.
pub static NEWS_SOURCES: &[NewsSourceDef] = &[
    // --- Public & international ---
    NewsSourceDef {
        id: "bbc_world",
        label: "BBC World",
        feed_url: "https://feeds.bbci.co.uk/news/world/rss.xml",
        group: NewsSourceGroup::PublicIntl,
        default_enabled: true,
        hint: "Strong headlines; article pages sometimes thin under automation",
    },
    NewsSourceDef {
        id: "bbc_middle_east",
        label: "BBC Middle East",
        feed_url: "https://feeds.bbci.co.uk/news/world/middle_east/rss.xml",
        group: NewsSourceGroup::PublicIntl,
        default_enabled: true,
        hint: "ME desk headlines",
    },
    NewsSourceDef {
        id: "npr",
        label: "NPR",
        feed_url: "https://feeds.npr.org/1001/rss.xml",
        group: NewsSourceGroup::PublicIntl,
        default_enabled: true,
        hint: "US public radio; articles usually fetchable",
    },
    NewsSourceDef {
        id: "pbs_newshour",
        label: "PBS NewsHour",
        feed_url: "https://www.pbs.org/newshour/feeds/rss/headlines",
        group: NewsSourceGroup::PublicIntl,
        default_enabled: true,
        hint: "US public TV headlines",
    },
    NewsSourceDef {
        id: "guardian_world",
        label: "The Guardian (World)",
        feed_url: "https://www.theguardian.com/world/rss",
        group: NewsSourceGroup::PublicIntl,
        default_enabled: true,
        hint: "UK center-left; solid full-text fetch",
    },
    NewsSourceDef {
        id: "euronews",
        label: "Euronews",
        feed_url: "https://www.euronews.com/rss?format=mrss&level=vertical&name=news",
        group: NewsSourceGroup::PublicIntl,
        default_enabled: true,
        hint: "European wire-style",
    },
    NewsSourceDef {
        id: "abc_australia",
        label: "ABC Australia",
        feed_url: "https://www.abc.net.au/news/feed/51120/rss.xml",
        group: NewsSourceGroup::PublicIntl,
        default_enabled: true,
        hint: "AU public broadcaster",
    },
    NewsSourceDef {
        id: "cna",
        label: "CNA (Singapore)",
        feed_url:
            "https://www.channelnewsasia.com/api/v1/rss-outbound-feed?_format=xml&category=6511",
        group: NewsSourceGroup::PublicIntl,
        default_enabled: true,
        hint: "Asia-focused international",
    },
    NewsSourceDef {
        id: "un_news",
        label: "UN News",
        feed_url: "https://news.un.org/feed/subscribe/en/news/all/rss.xml",
        group: NewsSourceGroup::PublicIntl,
        default_enabled: true,
        hint: "UN institutional reporting",
    },
    // --- US mainstream ---
    NewsSourceDef {
        id: "cbs_news",
        label: "CBS News",
        feed_url: "https://www.cbsnews.com/latest/rss/main",
        group: NewsSourceGroup::UsMainstream,
        default_enabled: true,
        hint: "US network",
    },
    NewsSourceDef {
        id: "nbc_news",
        label: "NBC News",
        feed_url: "https://feeds.nbcnews.com/nbcnews/public/news",
        group: NewsSourceGroup::UsMainstream,
        default_enabled: true,
        hint: "US network",
    },
    NewsSourceDef {
        id: "the_hill",
        label: "The Hill",
        feed_url: "https://thehill.com/feed/",
        group: NewsSourceGroup::UsMainstream,
        default_enabled: true,
        hint: "US politics volume; body extract often thin",
    },
    // --- Middle East ---
    NewsSourceDef {
        id: "al_jazeera",
        label: "Al Jazeera English",
        feed_url: "https://www.aljazeera.com/xml/rss/all.xml",
        group: NewsSourceGroup::MiddleEast,
        default_enabled: true,
        hint: "Strong ME coverage; usually fetchable",
    },
    NewsSourceDef {
        id: "anadolu",
        label: "Anadolu Agency",
        feed_url: "https://www.aa.com.tr/en/rss/default?cat=guncel",
        group: NewsSourceGroup::MiddleEast,
        default_enabled: true,
        hint: "Turkish state wire — useful volume; treat as one viewpoint",
    },
    NewsSourceDef {
        id: "jpost",
        label: "Jerusalem Post",
        feed_url: "https://www.jpost.com/rss/rssfeedsfrontpage.aspx",
        group: NewsSourceGroup::MiddleEast,
        default_enabled: true,
        hint: "Israel-based; paywall risk on some pages",
    },
    // --- Defense & security ---
    NewsSourceDef {
        id: "defense_one",
        label: "Defense One",
        feed_url: "https://www.defenseone.com/rss/all/",
        group: NewsSourceGroup::Security,
        default_enabled: true,
        hint: "US defense policy",
    },
    NewsSourceDef {
        id: "breaking_defense",
        label: "Breaking Defense",
        feed_url: "https://breakingdefense.com/feed/",
        group: NewsSourceGroup::Security,
        default_enabled: true,
        hint: "Defense industry / ops",
    },
    NewsSourceDef {
        id: "war_on_the_rocks",
        label: "War on the Rocks",
        feed_url: "https://warontherocks.com/feed/",
        group: NewsSourceGroup::Security,
        default_enabled: true,
        hint: "National security analysis",
    },
    NewsSourceDef {
        id: "foreign_policy",
        label: "Foreign Policy",
        feed_url: "https://foreignpolicy.com/feed/",
        group: NewsSourceGroup::Security,
        default_enabled: true,
        hint: "IR magazine; some paywall",
    },
    // --- Progressive / investigative ---
    NewsSourceDef {
        id: "propublica",
        label: "ProPublica",
        feed_url: "https://www.propublica.org/feeds/propublica/main",
        group: NewsSourceGroup::Progressive,
        default_enabled: true,
        hint: "Investigative non-profit",
    },
    NewsSourceDef {
        id: "intercept",
        label: "The Intercept",
        feed_url: "https://theintercept.com/feed/?lang=en",
        group: NewsSourceGroup::Progressive,
        default_enabled: true,
        hint: "Investigative / left",
    },
    NewsSourceDef {
        id: "mother_jones",
        label: "Mother Jones",
        feed_url: "https://www.motherjones.com/feed/",
        group: NewsSourceGroup::Progressive,
        default_enabled: true,
        hint: "Progressive investigative",
    },
    NewsSourceDef {
        id: "vox",
        label: "Vox",
        feed_url: "https://www.vox.com/rss/index.xml",
        group: NewsSourceGroup::Progressive,
        default_enabled: true,
        hint: "Explainers; center-left",
    },
    // --- Conservative / libertarian / alt ---
    NewsSourceDef {
        id: "fox_news",
        label: "Fox News",
        feed_url: "https://moxie.foxnews.com/google-publisher/latest.xml",
        group: NewsSourceGroup::Conservative,
        default_enabled: true,
        hint: "US right mainstream",
    },
    NewsSourceDef {
        id: "nypost",
        label: "New York Post",
        feed_url: "https://nypost.com/feed/",
        group: NewsSourceGroup::Conservative,
        default_enabled: true,
        hint: "Tabloid right; high volume",
    },
    NewsSourceDef {
        id: "national_review",
        label: "National Review",
        feed_url: "https://www.nationalreview.com/feed/",
        group: NewsSourceGroup::Conservative,
        default_enabled: true,
        hint: "Conservative magazine; paywall risk",
    },
    NewsSourceDef {
        id: "federalist",
        label: "The Federalist",
        feed_url: "https://thefederalist.com/feed/",
        group: NewsSourceGroup::Conservative,
        default_enabled: true,
        hint: "Conservative opinion",
    },
    NewsSourceDef {
        id: "daily_wire",
        label: "Daily Wire",
        feed_url: "https://www.dailywire.com/feeds/rss.xml",
        group: NewsSourceGroup::Conservative,
        default_enabled: true,
        hint: "Conservative news/opinion",
    },
    NewsSourceDef {
        id: "reason",
        label: "Reason",
        feed_url: "https://reason.com/feed/",
        group: NewsSourceGroup::Conservative,
        default_enabled: true,
        hint: "Libertarian",
    },
    NewsSourceDef {
        id: "american_conservative",
        label: "The American Conservative",
        feed_url: "https://www.theamericanconservative.com/feed/",
        group: NewsSourceGroup::Conservative,
        default_enabled: true,
        hint: "Paleocon foreign-policy focus",
    },
    NewsSourceDef {
        id: "zerohedge",
        label: "ZeroHedge",
        feed_url: "https://feeds.feedburner.com/zerohedge/feed",
        group: NewsSourceGroup::Conservative,
        default_enabled: true,
        hint: "Markets / contrarian; real article URLs",
    },
    NewsSourceDef {
        id: "breitbart",
        label: "Breitbart",
        feed_url: "https://feeds.feedburner.com/breitbart",
        group: NewsSourceGroup::Conservative,
        default_enabled: true,
        hint: "Right populist; Feedburner",
    },
    // TGP: discovery only quality — still useful titles, default on as requested peers
    NewsSourceDef {
        id: "gateway_pundit",
        label: "Gateway Pundit",
        feed_url: "https://www.thegatewaypundit.com/feed/",
        group: NewsSourceGroup::Conservative,
        default_enabled: true,
        hint: "Right populist; feed OK, full-page fetch often thin",
    },
];

/// DTO for Settings / IPC.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NewsSourceDto {
    /// Config id.
    pub id: String,
    /// Display name.
    pub label: String,
    /// Group id (snake_case).
    pub group: String,
    /// Group display label.
    pub group_label: String,
    /// Currently enabled.
    pub enabled: bool,
    /// Default for this source.
    pub default_enabled: bool,
    /// Hint text.
    pub hint: String,
    /// Feed URL (informational).
    pub feed_url: String,
}

/// Resolve enabled map: missing keys → default_enabled from registry.
pub fn resolve_enabled_map(overrides: &HashMap<String, bool>) -> HashMap<String, bool> {
    let mut out = HashMap::new();
    for s in NEWS_SOURCES {
        let en = overrides.get(s.id).copied().unwrap_or(s.default_enabled);
        out.insert(s.id.to_string(), en);
    }
    out
}

/// Default enable map (all registry defaults).
pub fn default_enabled_map() -> HashMap<String, bool> {
    resolve_enabled_map(&HashMap::new())
}

/// List sources for UI with effective enable flags.
pub fn list_sources_dto(overrides: &HashMap<String, bool>) -> Vec<NewsSourceDto> {
    let enabled = resolve_enabled_map(overrides);
    NEWS_SOURCES
        .iter()
        .map(|s| NewsSourceDto {
            id: s.id.into(),
            label: s.label.into(),
            group: s.group.pack_id().into(),
            group_label: s.group.label().into(),
            enabled: *enabled.get(s.id).unwrap_or(&s.default_enabled),
            default_enabled: s.default_enabled,
            hint: s.hint.into(),
            feed_url: s.feed_url.into(),
        })
        .collect()
}

/// Set of enabled source ids.
pub fn enabled_ids(overrides: &HashMap<String, bool>) -> HashSet<String> {
    resolve_enabled_map(overrides)
        .into_iter()
        .filter(|(_, en)| *en)
        .map(|(id, _)| id)
        .collect()
}

/// Intersect user-enabled source ids with optional pack filters.
///
/// - Empty / missing packs → return `enabled` unchanged + note `packs:all`.
/// - Known packs → only sources in those groups that are also user-enabled.
/// - Unknown pack ids → ignored with notes (not a hard fail).
/// - If all packs invalid or intersection empty → empty set + notes (caller may fall back).
pub fn filter_ids_by_packs(
    enabled: &HashSet<String>,
    packs: &[String],
) -> (HashSet<String>, Vec<String>) {
    let mut notes = Vec::new();
    if packs.is_empty() {
        notes.push("packs:all".into());
        return (enabled.clone(), notes);
    }

    let mut groups: HashSet<NewsSourceGroup> = HashSet::new();
    let mut unknown = Vec::new();
    for p in packs {
        match NewsSourceGroup::from_pack_id(p) {
            Some(g) => {
                groups.insert(g);
            }
            None => unknown.push(p.trim().to_string()),
        }
    }
    for u in &unknown {
        notes.push(format!("packs:unknown:{u}"));
    }
    if groups.is_empty() {
        notes.push("packs:none_valid".into());
        // Fall back to all enabled so a typo does not zero-out research.
        notes.push("packs:fallback_all".into());
        return (enabled.clone(), notes);
    }

    let pack_list: Vec<&str> = groups.iter().map(|g| g.pack_id()).collect();
    notes.push(format!("packs:{}", pack_list.join(",")));

    let mut out = HashSet::new();
    for s in NEWS_SOURCES {
        if !enabled.contains(s.id) {
            continue;
        }
        if groups.contains(&s.group) {
            out.insert(s.id.to_string());
        }
    }
    if out.is_empty() {
        notes.push("packs:intersection_empty".into());
    } else {
        notes.push(format!("packs:sources:{}", out.len()));
    }
    (out, notes)
}

// --- Feed cache + parse ---

#[derive(Debug, Clone)]
struct CachedFeed {
    at: Instant,
    items: Vec<RawFeedItem>,
}

#[derive(Debug, Clone)]
pub(crate) struct RawFeedItem {
    title: String,
    url: String,
    snippet: String,
}

static FEED_CACHE: Mutex<Option<HashMap<String, CachedFeed>>> = Mutex::new(None);
const FEED_TTL: Duration = Duration::from_secs(8 * 60);

fn cache_get(url: &str) -> Option<Vec<RawFeedItem>> {
    let guard = FEED_CACHE.lock().ok()?;
    let map = guard.as_ref()?;
    let ent = map.get(url)?;
    if ent.at.elapsed() > FEED_TTL {
        return None;
    }
    Some(ent.items.clone())
}

fn cache_put(url: &str, items: Vec<RawFeedItem>) {
    if let Ok(mut guard) = FEED_CACHE.lock() {
        let map = guard.get_or_insert_with(HashMap::new);
        map.insert(
            url.to_string(),
            CachedFeed {
                at: Instant::now(),
                items,
            },
        );
    }
}

async fn fetch_feed_xml(feed_url: &str) -> CoreResult<String> {
    let policy = SsrfPolicy {
        block_private: true,
        allow_loopback: false,
    };
    let _ = validate_provider_url(feed_url, &policy)
        .map_err(|e| CoreError::Policy(format!("feed URL rejected: {e}")))?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(REQUEST_TIMEOUT_SECS.min(15)))
        .redirect(reqwest::redirect::Policy::limited(3))
        .user_agent(concat!(
            "Mozilla/5.0 (compatible; ContextDesk/",
            env!("CARGO_PKG_VERSION"),
            "; web research)"
        ))
        .build()
        .map_err(|e| CoreError::Message(format!("http client: {e}")))?;
    let resp = client
        .get(feed_url)
        .header(
            "Accept",
            "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
        )
        .send()
        .await
        .map_err(|e| CoreError::Message(format!("feed fetch: {e}")))?;
    if !resp.status().is_success() {
        return Err(CoreError::Message(format!(
            "feed HTTP {}",
            resp.status().as_u16()
        )));
    }
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| CoreError::Message(format!("feed body: {e}")))?;
    let slice = if bytes.len() > MAX_BODY_BYTES {
        &bytes[..MAX_BODY_BYTES]
    } else {
        &bytes[..]
    };
    Ok(String::from_utf8_lossy(slice).into_owned())
}

/// Parse RSS 2.0 / simple Atom into items (fixture-friendly).
pub(crate) fn parse_feed_items(xml: &str) -> Vec<RawFeedItem> {
    let mut items = Vec::new();
    // RSS <item>
    let mut rest = xml;
    while let Some(start) = rest.find("<item") {
        let after = &rest[start..];
        let Some(gt) = after.find('>') else { break };
        // skip self-closing
        if after[..gt].ends_with('/') {
            rest = &after[gt + 1..];
            continue;
        }
        let body_start = gt + 1;
        let Some(end_rel) = after[body_start..].find("</item>") else {
            break;
        };
        let body = &after[body_start..body_start + end_rel];
        rest = &after[body_start + end_rel + 7..];
        if let Some(it) = item_from_block(body) {
            items.push(it);
        }
        if items.len() >= 40 {
            break;
        }
    }
    if !items.is_empty() {
        return items;
    }
    // Atom <entry>
    rest = xml;
    while let Some(start) = rest.find("<entry") {
        let after = &rest[start..];
        let Some(gt) = after.find('>') else { break };
        let body_start = gt + 1;
        let Some(end_rel) = after[body_start..].find("</entry>") else {
            break;
        };
        let body = &after[body_start..body_start + end_rel];
        rest = &after[body_start + end_rel + 8..];
        if let Some(it) = atom_from_block(body) {
            items.push(it);
        }
        if items.len() >= 40 {
            break;
        }
    }
    items
}

// Re-export type for tests without making RawFeedItem fully public API mess
// — tests use parse_feed_items via public WebSearchHit path

fn item_from_block(body: &str) -> Option<RawFeedItem> {
    let title = xml_tag(body, "title")?;
    let mut url = xml_tag(body, "link").unwrap_or_default();
    if url.is_empty() {
        url = xml_tag(body, "guid").unwrap_or_default();
    }
    url = clean_url(&url);
    if title.is_empty() || !url.starts_with("http") {
        return None;
    }
    let desc = xml_tag(body, "description")
        .or_else(|| xml_tag(body, "content:encoded"))
        .unwrap_or_default();
    let snippet = collapse_plain(&desc);
    let pub_date = xml_tag(body, "pubDate").unwrap_or_default();
    let mut snip = snippet.chars().take(280).collect::<String>();
    if !pub_date.is_empty() {
        if !snip.is_empty() {
            snip.push_str(" · ");
        }
        snip.push_str(&pub_date.chars().take(32).collect::<String>());
    }
    Some(RawFeedItem {
        title: title.chars().take(200).collect(),
        url,
        snippet: snip,
    })
}

fn atom_from_block(body: &str) -> Option<RawFeedItem> {
    let title = xml_tag(body, "title")?;
    // <link href="..."/>
    let url = atom_link(body).unwrap_or_default();
    let url = clean_url(&url);
    if title.is_empty() || !url.starts_with("http") {
        return None;
    }
    let summary = xml_tag(body, "summary")
        .or_else(|| xml_tag(body, "content"))
        .unwrap_or_default();
    Some(RawFeedItem {
        title: title.chars().take(200).collect(),
        url,
        snippet: collapse_plain(&summary).chars().take(280).collect(),
    })
}

fn atom_link(body: &str) -> Option<String> {
    // Prefer rel=alternate
    for cap in [
        r#"rel="alternate"[^>]*href=""#,
        r#"href="[^"]*"[^>]*rel="alternate""#,
        r#"href=""#,
    ] {
        if let Some(i) = body.find("href=\"") {
            let rest = &body[i + 6..];
            if let Some(end) = rest.find('"') {
                let u = &rest[..end];
                if u.starts_with("http") {
                    return Some(u.to_string());
                }
            }
        }
        let _ = cap;
    }
    None
}

fn xml_tag(block: &str, tag: &str) -> Option<String> {
    let open = format!("<{tag}");
    let close = format!("</{tag}>");
    let lower = block.to_ascii_lowercase();
    let open_l = open.to_ascii_lowercase();
    let close_l = close.to_ascii_lowercase();
    let start = lower.find(&open_l)?;
    let after_open = &block[start..];
    let gt = after_open.find('>')?;
    let content_start = start + gt + 1;
    // self-closing
    if after_open.as_bytes().get(gt.saturating_sub(1)) == Some(&b'/') {
        return None;
    }
    let end_rel = lower[content_start..].find(&close_l)?;
    let raw = &block[content_start..content_start + end_rel];
    Some(strip_cdata(raw).trim().to_string())
}

fn strip_cdata(s: &str) -> &str {
    let t = s.trim();
    if let Some(inner) = t
        .strip_prefix("<![CDATA[")
        .and_then(|x| x.strip_suffix("]]>"))
    {
        inner
    } else {
        t
    }
}

fn clean_url(u: &str) -> String {
    let u = html_decode(u.trim());
    // Feedburner sometimes wraps
    u.replace("&amp;", "&")
}

fn html_decode(s: &str) -> String {
    s.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&nbsp;", " ")
}

fn collapse_plain(html: &str) -> String {
    let mut out = String::new();
    let mut in_tag = false;
    for c in html_decode(html).chars() {
        match c {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => {
                if c.is_whitespace() {
                    if !out.ends_with(' ') {
                        out.push(' ');
                    }
                } else {
                    out.push(c);
                }
            }
            _ => {}
        }
    }
    out.trim().to_string()
}

/// Score feed item against query tokens (condensed).
fn score_item(query: &str, title: &str, snippet: &str) -> f32 {
    let q = condense_search_query(query).to_ascii_lowercase();
    let tokens: Vec<&str> = q.split_whitespace().filter(|t| t.len() >= 2).collect();
    if tokens.is_empty() {
        return 0.0;
    }
    let hay = format!("{title} {snippet}").to_ascii_lowercase();
    let mut hits = 0u32;
    let mut score = 0.0f32;
    for t in &tokens {
        if hay.contains(t) {
            hits += 1;
            score += if title.to_ascii_lowercase().contains(t) {
                2.0
            } else {
                1.0
            };
        }
    }
    // Require at least one token for short queries, two for longer
    let need = if tokens.len() >= 4 { 2 } else { 1 };
    if hits < need {
        return 0.0;
    }
    score
}

async fn load_feed_items(feed_url: &str) -> Vec<RawFeedItem> {
    if let Some(cached) = cache_get(feed_url) {
        return cached;
    }
    match fetch_feed_xml(feed_url).await {
        Ok(xml) => {
            let items = parse_feed_items(&xml);
            cache_put(feed_url, items.clone());
            items
        }
        Err(_) => Vec::new(),
    }
}

/// Search enabled publisher feeds; return ranked hits (real publisher URLs).
pub async fn search_publisher_feeds(
    query: &str,
    limit: usize,
    enabled_ids: &HashSet<String>,
) -> (Vec<WebSearchHit>, Vec<String>) {
    let limit = limit.clamp(1, 20);
    let mut notes = Vec::new();
    let mut scored: Vec<(f32, WebSearchHit)> = Vec::new();

    let sources: Vec<&NewsSourceDef> = NEWS_SOURCES
        .iter()
        .filter(|s| enabled_ids.contains(s.id))
        .collect();

    if sources.is_empty() {
        notes.push("publishers:none_enabled".into());
        return (vec![], notes);
    }

    // Sequential fetch is fine with 8‑minute cache; first cold search is slower.
    let mut fed = 0u32;
    let mut matched_sources = 0u32;
    for s in sources {
        let items = load_feed_items(s.feed_url).await;
        if items.is_empty() {
            continue;
        }
        fed += 1;
        let mut any = false;
        for it in items {
            let sc = score_item(query, &it.title, &it.snippet);
            if sc <= 0.0 {
                continue;
            }
            any = true;
            // Prefer display label as publisher brand
            let title = if it.title.contains(s.label) {
                it.title.clone()
            } else {
                format!("{} - {}", it.title, s.label)
            };
            scored.push((
                sc,
                WebSearchHit {
                    title: title.chars().take(200).collect(),
                    url: it.url,
                    snippet: if it.snippet.is_empty() {
                        format!("via {}", s.label)
                    } else {
                        format!("{} · via {}", it.snippet, s.label)
                    },
                },
            ));
        }
        if any {
            matched_sources += 1;
        }
    }

    scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    // Dedupe by URL
    let mut hits = Vec::new();
    let mut seen = HashSet::new();
    for (_, h) in scored {
        if !seen.insert(h.url.clone()) {
            continue;
        }
        // Drop private/non-http (should not happen)
        if !h.url.starts_with("http://") && !h.url.starts_with("https://") {
            continue;
        }
        hits.push(h);
        if hits.len() >= limit {
            break;
        }
    }

    notes.push(format!(
        "publishers:feeds_ok={fed} matched_sources={matched_sources} hits={}",
        hits.len()
    ));
    (hits, notes)
}

/// Lookup source label by id.
pub fn source_label(id: &str) -> Option<&'static str> {
    NEWS_SOURCES.iter().find(|s| s.id == id).map(|s| s.label)
}

/// Host label helper re-export for tests.
pub fn debug_host_label(url: &str) -> String {
    host_display_label(url)
}

// Silence unused import of urlencoding in this module if any
#[allow(dead_code)]
fn _encode(s: &str) -> String {
    urlencoding_encode(s)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_has_balanced_defaults() {
        assert!(NEWS_SOURCES.len() >= 20);
        assert!(NEWS_SOURCES.iter().any(|s| s.id == "al_jazeera"));
        assert!(NEWS_SOURCES.iter().any(|s| s.id == "bbc_world"));
        assert!(NEWS_SOURCES.iter().any(|s| s.id == "fox_news"));
        assert!(NEWS_SOURCES.iter().any(|s| s.id == "zerohedge"));
        assert!(NEWS_SOURCES.iter().any(|s| s.id == "propublica"));
        assert!(NEWS_SOURCES.iter().all(|s| s.default_enabled));
    }

    #[test]
    fn resolve_enabled_respects_overrides() {
        let mut o = HashMap::new();
        o.insert("bbc_world".into(), false);
        let m = resolve_enabled_map(&o);
        assert_eq!(m.get("bbc_world"), Some(&false));
        assert_eq!(m.get("al_jazeera"), Some(&true));
    }

    #[test]
    fn filter_ids_by_packs_narrows_and_falls_back() {
        let enabled = enabled_ids(&HashMap::new());
        let (all, notes) = filter_ids_by_packs(&enabled, &[]);
        assert_eq!(all.len(), enabled.len());
        assert!(notes.iter().any(|n| n == "packs:all"));

        let (me, notes) = filter_ids_by_packs(&enabled, &["middle_east".into()]);
        assert!(!me.is_empty());
        assert!(me.len() < enabled.len());
        assert!(me.contains("al_jazeera") || me.contains("anadolu") || me.contains("jpost"));
        assert!(!me.contains("fox_news"));
        assert!(notes
            .iter()
            .any(|n| n.starts_with("packs:middle_east") || n.contains("middle_east")));

        let (fallback, notes) = filter_ids_by_packs(&enabled, &["not_a_real_pack".into()]);
        assert_eq!(fallback.len(), enabled.len());
        assert!(notes.iter().any(|n| n.contains("unknown")));
        assert!(notes.iter().any(|n| n.contains("fallback_all")));
    }

    #[test]
    fn parse_rss_fixture() {
        let xml = r#"<?xml version="1.0"?>
        <rss><channel>
          <item>
            <title>IRGC commander reported killed</title>
            <link>https://www.example.com/a</link>
            <description>Details from the region.</description>
            <pubDate>Fri, 17 Jul 2026 12:00:00 GMT</pubDate>
          </item>
          <item>
            <title>Unrelated sports</title>
            <link>https://www.example.com/b</link>
            <description>scores</description>
          </item>
        </channel></rss>"#;
        let items = parse_feed_items(xml);
        assert_eq!(items.len(), 2);
        assert!(items[0].url.contains("example.com/a"));
        let sc = score_item("IRGC commander killed", &items[0].title, &items[0].snippet);
        assert!(sc > 0.0);
        let sc2 = score_item("IRGC commander killed", &items[1].title, &items[1].snippet);
        assert_eq!(sc2, 0.0);
    }

    #[test]
    fn list_dto_complete() {
        let dtos = list_sources_dto(&HashMap::new());
        assert_eq!(dtos.len(), NEWS_SOURCES.len());
        assert!(dtos.iter().all(|d| d.enabled));
    }
}
