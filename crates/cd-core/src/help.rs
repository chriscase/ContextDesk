//! Curated, bundled product Help corpus and ranked retrieval (#437).
//!
//! Help is deliberately separate from workspace [`crate::index::KeywordIndex`]
//! and durable memory SQLite. Hosts provide a trusted corpus root; this module
//! parses and validates it, chunks pages by heading, offers deterministic
//! keyword search, and optionally fuses semantic scores from an
//! [`crate::embed::EmbedBackend`] through [`crate::vector_index::ExactIndex`].

use crate::embed::EmbedBackend;
use crate::error::{CoreError, CoreResult};
use crate::tools::{ToolSideEffect, ToolSpec};
use crate::vector_index::{ExactIndex, VectorIndex};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

const MAX_PAGE_BYTES: u64 = 2 * 1024 * 1024;
const MAX_ASSET_BYTES: u64 = 256 * 1024;
const MAX_PAGES: usize = 1_000;
const MAX_CHUNKS: usize = 20_000;
const SOFT_CHUNK_CHARS: usize = 2_400;
const HARD_CHUNK_CHARS: usize = 3_200;
const MAX_SEARCH_LIMIT: usize = 20;
const MAX_CANDIDATES: usize = 64;
const MAX_SNIPPET_CHARS: usize = 320;
const EMBED_BATCH: usize = 32;
const EMBED_TIMEOUT: Duration = Duration::from_secs(5);

/// Read-only ranked search over the bundled product guide.
pub const SEARCH_HELP: &str = "search_help";
/// Read one bounded page or heading from the bundled product guide.
pub const READ_HELP: &str = "read_help";

const SECTION_DEFS: &[(&str, &str, u16)] = &[
    ("overview", "Overview", 10),
    ("getting-started", "Getting started", 20),
    ("providers", "AI providers", 30),
    ("chat-context", "Chat & context", 40),
    ("workspace-indexing", "Workspace & indexing", 50),
    ("permissions", "Permissions & writes", 60),
    ("memory", "Memory", 70),
    ("log-analysis", "Log analysis", 80),
    ("connectors", "Connectors", 90),
    ("backup", "Backup & export", 100),
    ("skills", "Skills & context packs", 110),
    ("settings", "Settings & prelaunch", 120),
    ("security", "Security model", 130),
    ("troubleshooting", "Troubleshooting", 140),
    ("reference", "Reference", 150),
];

/// Agent-visible Help tools. Hosts register these only when a corpus is loaded.
pub fn help_tool_specs() -> Vec<ToolSpec> {
    vec![
        ToolSpec {
            name: SEARCH_HELP.into(),
            description: "Search the bundled ContextDesk product guide for feature behavior, setup, permissions, and troubleshooting. Returns bounded help:// citations."
                .into(),
            side_effect: ToolSideEffect::Read,
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string" },
                    "limit": { "type": "integer", "minimum": 1, "maximum": 8 }
                },
                "required": ["query"]
            }),
        },
        ToolSpec {
            name: READ_HELP.into(),
            description: "Read one bounded page or heading from the bundled ContextDesk product guide by stable id. Use after search_help; never pass a filesystem path."
                .into(),
            side_effect: ToolSideEffect::Read,
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "id": { "type": "string", "description": "Stable Help page id" },
                    "anchor": { "type": "string", "description": "Optional heading anchor returned by search_help" }
                },
                "required": ["id"]
            }),
        },
    ]
}

/// Metadata declared in a Help page's frontmatter.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HelpPageMeta {
    /// Stable kebab-case public id.
    pub id: String,
    /// Human-readable page title.
    pub title: String,
    /// Short search/navigation summary.
    pub summary: String,
    /// Stable information-architecture section key.
    pub section: String,
    /// Search/editorial tags.
    pub tags: Vec<String>,
    /// Order within the section.
    pub order: u16,
    /// Stable ids of related Help pages.
    pub related: Vec<String>,
}

/// One generated entry in a page's in-reader table of contents.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HelpTocEntry {
    /// Markdown heading depth (2 or 3 in the supported subset).
    pub level: u8,
    /// Heading display text.
    pub title: String,
    /// Stable normalized anchor within the page.
    pub anchor: String,
}

/// One trusted SVG reference declared by a parsed Help page.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HelpAssetRef {
    /// Corpus-relative normalized path, always below `assets/`.
    pub path: String,
    /// Author-supplied accessible alternative text.
    pub alt: String,
    /// Validated MIME type.
    pub mime: String,
}

/// A complete Help page returned to trusted hosts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HelpPage {
    /// Page frontmatter.
    pub meta: HelpPageMeta,
    /// Markdown body without frontmatter.
    pub body: String,
    /// Generated H2/H3 table of contents.
    pub toc: Vec<HelpTocEntry>,
    /// Trusted bundled assets referenced by the page.
    pub assets: Vec<HelpAssetRef>,
}

/// Compact page metadata for navigation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HelpPageSummary {
    /// Stable page id.
    pub id: String,
    /// Page title.
    pub title: String,
    /// Short page summary.
    pub summary: String,
    /// Order within the section.
    pub order: u16,
    /// Search/editorial tags.
    pub tags: Vec<String>,
}

/// One ordered section in Help navigation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HelpSection {
    /// Stable section key.
    pub id: String,
    /// User-facing navigation label.
    pub title: String,
    /// Global navigation order.
    pub order: u16,
    /// Ordered pages in the section.
    pub pages: Vec<HelpPageSummary>,
}

/// Ranking path that produced a Help hit.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HelpSearchMode {
    /// Deterministic local keyword ranking only.
    Keyword,
    /// Keyword score fused with optional semantic similarity.
    Hybrid,
}

/// One page-collapsed ranked Help search hit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HelpSearchHit {
    /// Stable page id.
    pub page_id: String,
    /// Page title.
    pub title: String,
    /// Page summary.
    pub summary: String,
    /// Information-architecture section key.
    pub section: String,
    /// Winning chunk heading when present.
    pub heading: Option<String>,
    /// Winning heading anchor when present.
    pub anchor: Option<String>,
    /// Plain-text bounded excerpt.
    pub snippet: String,
    /// Normalized score in `[0, 1]`.
    pub score: f32,
    /// Ranking path used for this query.
    pub mode: HelpSearchMode,
    /// Stable `help://` locator.
    pub citation: String,
}

#[derive(Debug, Clone)]
struct HelpChunk {
    page_id: String,
    heading: Option<String>,
    anchor: Option<String>,
    ordinal: u16,
    text: String,
}

impl HelpChunk {
    fn key(&self) -> String {
        format!(
            "{}#{}:{}",
            self.page_id,
            self.anchor.as_deref().unwrap_or("overview"),
            self.ordinal
        )
    }
}

struct SemanticCache {
    index: ExactIndex,
    dims: usize,
}

/// Read-only in-memory index over a trusted bundled Help corpus.
pub struct HelpIndex {
    root: PathBuf,
    pages: BTreeMap<String, HelpPage>,
    chunks: Vec<HelpChunk>,
    postings: HashMap<String, Vec<usize>>,
    semantic: Mutex<Option<SemanticCache>>,
}

impl HelpIndex {
    /// Load, validate, and index a Help corpus from a trusted root.
    pub fn load(root: impl AsRef<Path>) -> CoreResult<Self> {
        let root = root.as_ref();
        let root_meta = fs::metadata(root)?;
        if !root_meta.is_dir() {
            return Err(help_error("corpus root is not a directory"));
        }
        let canonical_root = root.canonicalize()?;
        let mut page_paths = Vec::new();
        let mut sections = sorted_entries(&canonical_root)?;
        for entry in sections.drain(..) {
            let name = entry.file_name().to_string_lossy().to_string();
            if name == "README.md" || name == "assets" || name.starts_with('.') {
                continue;
            }
            let file_type = entry.file_type()?;
            if file_type.is_symlink() {
                return Err(help_error(format!("symlinked section rejected: {name}")));
            }
            if !file_type.is_dir() {
                return Err(help_error(format!(
                    "unexpected corpus entry outside a section: {name}"
                )));
            }
            for page_entry in sorted_entries(&entry.path())? {
                let page_name = page_entry.file_name().to_string_lossy().to_string();
                let page_type = page_entry.file_type()?;
                if page_type.is_symlink() {
                    return Err(help_error(format!(
                        "symlinked page rejected: {name}/{page_name}"
                    )));
                }
                if !page_type.is_file()
                    || page_entry.path().extension().and_then(|v| v.to_str()) != Some("md")
                {
                    return Err(help_error(format!(
                        "section entries must be Markdown: {name}/{page_name}"
                    )));
                }
                page_paths.push(page_entry.path());
            }
        }
        if page_paths.len() > MAX_PAGES {
            return Err(help_error("corpus exceeds the page limit"));
        }

        let mut pages = BTreeMap::new();
        for page_path in page_paths {
            let relative = safe_relative(&canonical_root, &page_path)?;
            let metadata = fs::metadata(&page_path)?;
            if metadata.len() > MAX_PAGE_BYTES {
                return Err(help_error(format!("page exceeds size limit: {relative}")));
            }
            let raw = fs::read_to_string(&page_path)?;
            let (meta, body) = parse_page(&raw, &relative)?;
            let expected_section = Path::new(&relative)
                .components()
                .next()
                .and_then(component_str)
                .unwrap_or_default();
            if meta.section != expected_section {
                return Err(help_error(format!(
                    "section does not match directory: {relative}"
                )));
            }
            if pages.contains_key(&meta.id) {
                return Err(help_error(format!("duplicate page id: {}", meta.id)));
            }
            let toc = parse_toc(&body, &relative)?;
            let assets = parse_assets(&canonical_root, &page_path, &body, &relative)?;
            pages.insert(
                meta.id.clone(),
                HelpPage {
                    meta,
                    body,
                    toc,
                    assets,
                },
            );
        }

        for page in pages.values() {
            for related in &page.meta.related {
                if !pages.contains_key(related) {
                    return Err(help_error(format!(
                        "unknown related page '{}' in {}",
                        related, page.meta.id
                    )));
                }
            }
            validate_help_links(&page.body, &page.meta.id, &pages)?;
        }

        let mut chunks = Vec::new();
        for page in pages.values() {
            chunks.extend(chunk_page(page));
        }
        if chunks.len() > MAX_CHUNKS {
            return Err(help_error("corpus exceeds the chunk limit"));
        }
        let postings = build_postings(&pages, &chunks);
        Ok(Self {
            root: canonical_root,
            pages,
            chunks,
            postings,
            semantic: Mutex::new(None),
        })
    }

    /// Number of parsed pages.
    pub fn len(&self) -> usize {
        self.pages.len()
    }

    /// Whether the corpus has no pages.
    pub fn is_empty(&self) -> bool {
        self.pages.is_empty()
    }

    /// Ordered Help navigation sections, omitting empty sections.
    pub fn sections(&self) -> Vec<HelpSection> {
        let mut sections = Vec::new();
        for (id, title, order) in SECTION_DEFS {
            let mut page_summaries: Vec<HelpPageSummary> = self
                .pages
                .values()
                .filter(|page| page.meta.section == *id)
                .map(|page| HelpPageSummary {
                    id: page.meta.id.clone(),
                    title: page.meta.title.clone(),
                    summary: page.meta.summary.clone(),
                    order: page.meta.order,
                    tags: page.meta.tags.clone(),
                })
                .collect();
            page_summaries.sort_by(|a, b| {
                a.order
                    .cmp(&b.order)
                    .then_with(|| a.title.cmp(&b.title))
                    .then_with(|| a.id.cmp(&b.id))
            });
            if !page_summaries.is_empty() {
                sections.push(HelpSection {
                    id: (*id).to_string(),
                    title: (*title).to_string(),
                    order: *order,
                    pages: page_summaries,
                });
            }
        }
        sections
    }

    /// Read one complete page by stable id.
    pub fn page(&self, id: &str) -> CoreResult<HelpPage> {
        let id = validate_public_id(id)?;
        self.pages
            .get(id)
            .cloned()
            .ok_or_else(|| help_error("unknown help page"))
    }

    /// Read one declared SVG asset for a page.
    ///
    /// Returns `(MIME, bytes)` without exposing the absolute bundle path.
    pub fn asset(&self, page_id: &str, asset_path: &str) -> CoreResult<(String, Vec<u8>)> {
        let page = self.page(page_id)?;
        let normalized = normalize_asset_public_path(asset_path)?;
        let asset = page
            .assets
            .iter()
            .find(|asset| asset.path == normalized)
            .ok_or_else(|| help_error("asset is not declared by the page"))?;
        let full = self.root.join(&asset.path);
        let canonical = full.canonicalize()?;
        let assets_root = self.root.join("assets").canonicalize()?;
        if !canonical.starts_with(&assets_root) {
            return Err(help_error("asset escaped the corpus root"));
        }
        let metadata = fs::symlink_metadata(&canonical)?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err(help_error("asset is not a regular bundled file"));
        }
        if metadata.len() > MAX_ASSET_BYTES {
            return Err(help_error("asset exceeds the size limit"));
        }
        Ok((asset.mime.clone(), fs::read(canonical)?))
    }

    /// Deterministic ranked keyword search.
    pub fn search_keyword(&self, query: &str, limit: usize) -> Vec<HelpSearchHit> {
        let terms = query_terms(query);
        if terms.is_empty() {
            return Vec::new();
        }
        let ranked = self.keyword_candidates(query, &terms, MAX_CANDIDATES);
        self.collapse_hits(
            ranked
                .into_iter()
                .map(|candidate| (candidate.idx, candidate.normalized, HelpSearchMode::Keyword))
                .collect(),
            &terms,
            limit,
        )
    }

    /// Ranked keyword search with optional semantic score fusion.
    ///
    /// Embed failures, timeouts, and incompatible dimensions degrade to the
    /// keyword path without logging provider details or corpus text.
    pub async fn search(
        &self,
        query: &str,
        limit: usize,
        embed: Option<&dyn EmbedBackend>,
    ) -> Vec<HelpSearchHit> {
        let Some(embed) = embed else {
            return self.search_keyword(query, limit);
        };
        let terms = query_terms(query);
        if query.trim().is_empty() {
            return Vec::new();
        }
        let keyword = self.keyword_candidates(query, &terms, MAX_CANDIDATES);
        let keyword_by_idx: HashMap<usize, f32> = keyword
            .iter()
            .map(|candidate| (candidate.idx, candidate.normalized))
            .collect();
        let semantic = match self.semantic_scores(query, embed).await {
            Ok(scores) => scores,
            Err(()) => {
                tracing::warn!("help semantic search unavailable; using keyword ranking");
                return self.search_keyword(query, limit);
            }
        };

        let mut union: HashMap<usize, f32> = HashMap::new();
        for candidate in keyword {
            union.insert(candidate.idx, 0.65 * candidate.normalized);
        }
        for (idx, similarity) in semantic {
            let kw = keyword_by_idx.get(&idx).copied().unwrap_or(0.0);
            union.insert(idx, (0.65 * kw + 0.35 * similarity).clamp(0.0, 1.0));
        }
        let mut scored: Vec<(usize, f32, HelpSearchMode)> = union
            .into_iter()
            .map(|(idx, score)| (idx, score, HelpSearchMode::Hybrid))
            .collect();
        scored.sort_by(|a, b| {
            b.1.partial_cmp(&a.1)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| self.chunks[a.0].key().cmp(&self.chunks[b.0].key()))
        });
        self.collapse_hits(scored, &terms, limit)
    }

    fn keyword_candidates(
        &self,
        query: &str,
        terms: &[String],
        limit: usize,
    ) -> Vec<KeywordCandidate> {
        let mut scores: HashMap<usize, f32> = HashMap::new();
        for term in terms {
            let Some(posted) = self.postings.get(term) else {
                continue;
            };
            let idf = 1.0 + (self.chunks.len() as f32 / (1 + posted.len()) as f32).ln();
            for idx in posted {
                let chunk = &self.chunks[*idx];
                let Some(page) = self.pages.get(&chunk.page_id) else {
                    continue;
                };
                let body_tf = tokenize(&chunk.text).filter(|token| token == term).count() as f32;
                let mut score = body_tf.max(1.0) * idf;
                if tokenize(&page.meta.title).any(|token| token == *term) {
                    score += 4.0;
                }
                if page.meta.tags.iter().any(|tag| tag == term) {
                    score += 3.0;
                }
                if chunk
                    .heading
                    .as_deref()
                    .map(|heading| tokenize(heading).any(|token| token == *term))
                    .unwrap_or(false)
                {
                    score += 2.5;
                }
                if tokenize(&page.meta.summary).any(|token| token == *term) {
                    score += 1.5;
                }
                *scores.entry(*idx).or_default() += score;
            }
        }
        let query_phrase = normalize_phrase(query);
        if !query_phrase.is_empty() {
            for (idx, score) in &mut scores {
                if let Some(page) = self.pages.get(&self.chunks[*idx].page_id) {
                    if normalize_phrase(&page.meta.title).contains(&query_phrase) {
                        *score += 2.0;
                    }
                }
            }
        }
        let max = scores.values().copied().fold(0.0f32, f32::max).max(1e-6);
        let mut ranked: Vec<KeywordCandidate> = scores
            .into_iter()
            .map(|(idx, raw)| KeywordCandidate {
                idx,
                normalized: (raw / max).clamp(0.0, 1.0),
            })
            .collect();
        ranked.sort_by(|a, b| {
            b.normalized
                .partial_cmp(&a.normalized)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| self.chunks[a.idx].key().cmp(&self.chunks[b.idx].key()))
        });
        ranked.truncate(limit);
        ranked
    }

    async fn semantic_scores(
        &self,
        query: &str,
        embed: &dyn EmbedBackend,
    ) -> Result<Vec<(usize, f32)>, ()> {
        if self.semantic.lock().map_err(|_| ())?.is_none() {
            let texts: Vec<String> = self
                .chunks
                .iter()
                .map(|chunk| self.embedding_text(chunk))
                .collect();
            let mut all_vectors = Vec::with_capacity(texts.len());
            for batch in texts.chunks(EMBED_BATCH) {
                let batch_vec = batch.to_vec();
                let embedded = tokio::time::timeout(EMBED_TIMEOUT, embed.embed(&batch_vec))
                    .await
                    .map_err(|_| ())?
                    .map_err(|_| ())?;
                if embedded.len() != batch.len() {
                    return Err(());
                }
                all_vectors.extend(embedded);
            }
            let dims = all_vectors
                .first()
                .map(Vec::len)
                .filter(|dims| *dims > 0)
                .ok_or(())?;
            if all_vectors.iter().any(|vector| vector.len() != dims) {
                return Err(());
            }
            let index = ExactIndex::new();
            for (idx, vector) in all_vectors.iter().enumerate() {
                index.upsert((idx + 1) as u64, vector).map_err(|_| ())?;
            }
            let mut guard = self.semantic.lock().map_err(|_| ())?;
            if guard.is_none() {
                *guard = Some(SemanticCache { index, dims });
            }
        }

        let query_vectors = tokio::time::timeout(EMBED_TIMEOUT, embed.embed(&[query.to_string()]))
            .await
            .map_err(|_| ())?
            .map_err(|_| ())?;
        let query_vector = query_vectors.first().ok_or(())?;
        let guard = self.semantic.lock().map_err(|_| ())?;
        let cache = guard.as_ref().ok_or(())?;
        if query_vector.len() != cache.dims {
            return Err(());
        }
        cache
            .index
            .search(query_vector, MAX_CANDIDATES, None)
            .map_err(|_| ())
            .map(|hits| {
                hits.into_iter()
                    .filter_map(|(id, score)| {
                        usize::try_from(id)
                            .ok()
                            .and_then(|raw| raw.checked_sub(1))
                            .filter(|idx| *idx < self.chunks.len())
                            .map(|idx| (idx, score))
                    })
                    .collect()
            })
    }

    fn embedding_text(&self, chunk: &HelpChunk) -> String {
        let Some(page) = self.pages.get(&chunk.page_id) else {
            return chunk.text.clone();
        };
        format!(
            "{}\n{}\n{}\n{}\n{}",
            page.meta.title,
            page.meta.summary,
            page.meta.tags.join(" "),
            chunk.heading.as_deref().unwrap_or("Overview"),
            chunk.text
        )
    }

    fn collapse_hits(
        &self,
        scored: Vec<(usize, f32, HelpSearchMode)>,
        terms: &[String],
        limit: usize,
    ) -> Vec<HelpSearchHit> {
        let mut seen = HashSet::new();
        let mut hits = Vec::new();
        for (idx, score, mode) in scored {
            let Some(chunk) = self.chunks.get(idx) else {
                continue;
            };
            if !seen.insert(chunk.page_id.clone()) {
                continue;
            }
            let Some(page) = self.pages.get(&chunk.page_id) else {
                continue;
            };
            let citation = match chunk.anchor.as_deref() {
                Some(anchor) => format!("help://{}#{anchor}", page.meta.id),
                None => format!("help://{}", page.meta.id),
            };
            hits.push(HelpSearchHit {
                page_id: page.meta.id.clone(),
                title: page.meta.title.clone(),
                summary: page.meta.summary.clone(),
                section: page.meta.section.clone(),
                heading: chunk.heading.clone(),
                anchor: chunk.anchor.clone(),
                snippet: make_snippet(&chunk.text, terms),
                score: score.clamp(0.0, 1.0),
                mode,
                citation,
            });
            if hits.len() >= limit.clamp(1, MAX_SEARCH_LIMIT) {
                break;
            }
        }
        hits
    }
}

#[derive(Debug)]
struct KeywordCandidate {
    idx: usize,
    normalized: f32,
}

fn sorted_entries(dir: &Path) -> CoreResult<Vec<fs::DirEntry>> {
    let mut entries: Vec<fs::DirEntry> = fs::read_dir(dir)?.collect::<Result<_, _>>()?;
    entries.sort_by_key(|entry| entry.file_name());
    Ok(entries)
}

fn safe_relative(root: &Path, path: &Path) -> CoreResult<String> {
    let relative = path
        .strip_prefix(root)
        .map_err(|_| help_error("path escaped the corpus root"))?;
    Ok(relative
        .components()
        .filter_map(component_str)
        .collect::<Vec<_>>()
        .join("/"))
}

fn component_str(component: Component<'_>) -> Option<&str> {
    match component {
        Component::Normal(value) => value.to_str(),
        _ => None,
    }
}

fn help_error(message: impl Into<String>) -> CoreError {
    CoreError::Config(format!("help corpus: {}", message.into()))
}

fn validate_public_id(id: &str) -> CoreResult<&str> {
    let id = id.trim();
    if is_kebab_id(id) {
        Ok(id)
    } else {
        Err(help_error("invalid help page id"))
    }
}

fn is_kebab_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.bytes().enumerate().all(|(idx, byte)| {
            byte.is_ascii_lowercase()
                || byte.is_ascii_digit()
                || (byte == b'-'
                    && idx > 0
                    && idx + 1 < value.len()
                    && value.as_bytes()[idx - 1] != b'-')
        })
        && !value.ends_with('-')
}

fn parse_page(raw: &str, source: &str) -> CoreResult<(HelpPageMeta, String)> {
    let normalized = raw.replace("\r\n", "\n");
    let mut lines = normalized.lines();
    if lines.next() != Some("---") {
        return Err(help_error(format!(
            "frontmatter must start on the first line: {source}"
        )));
    }
    let mut frontmatter = Vec::new();
    let mut found_close = false;
    for line in &mut lines {
        if line == "---" {
            found_close = true;
            break;
        }
        frontmatter.push(line);
    }
    if !found_close {
        return Err(help_error(format!("unterminated frontmatter: {source}")));
    }
    let body = lines.collect::<Vec<_>>().join("\n");
    let meta = parse_frontmatter(&frontmatter, source)?;
    validate_page_body(&body, &meta, source)?;
    Ok((meta, body))
}

fn parse_frontmatter(lines: &[&str], source: &str) -> CoreResult<HelpPageMeta> {
    let mut scalars: HashMap<String, String> = HashMap::new();
    let mut arrays: HashMap<String, Vec<String>> = HashMap::new();
    let allowed: HashSet<&str> = [
        "id", "title", "summary", "section", "tags", "order", "related",
    ]
    .into_iter()
    .collect();
    let mut array_key: Option<String> = None;
    for (line_idx, line) in lines.iter().enumerate() {
        if line.trim().is_empty() || line.trim_start().starts_with('#') {
            continue;
        }
        if let Some(item) = line.strip_prefix("  - ") {
            let Some(key) = array_key.as_ref() else {
                return Err(help_error(format!(
                    "array item without field at {source}:{}",
                    line_idx + 2
                )));
            };
            arrays
                .get_mut(key)
                .expect("array key initialized")
                .push(unquote(item.trim()).to_string());
            continue;
        }
        let Some((key, raw_value)) = line.split_once(':') else {
            return Err(help_error(format!(
                "unsupported frontmatter syntax at {source}:{}",
                line_idx + 2
            )));
        };
        if key.is_empty()
            || !key
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte == b'_')
        {
            return Err(help_error(format!(
                "unsupported frontmatter key at {source}:{}",
                line_idx + 2
            )));
        }
        if !allowed.contains(key) {
            return Err(help_error(format!(
                "unknown frontmatter field '{key}' in {source}"
            )));
        }
        if scalars.contains_key(key) || arrays.contains_key(key) {
            return Err(help_error(format!(
                "duplicate frontmatter field '{key}' in {source}"
            )));
        }
        let value = raw_value.trim();
        if matches!(key, "tags" | "related") {
            if value == "[]" {
                arrays.insert(key.to_string(), Vec::new());
                array_key = None;
            } else if value.is_empty() {
                arrays.insert(key.to_string(), Vec::new());
                array_key = Some(key.to_string());
            } else {
                return Err(help_error(format!(
                    "'{key}' must use a list or [] in {source}"
                )));
            }
        } else {
            if value.is_empty() {
                return Err(help_error(format!("empty '{key}' in {source}")));
            }
            scalars.insert(key.to_string(), unquote(value).to_string());
            array_key = None;
        }
    }
    for field in ["id", "title", "summary", "section", "order"] {
        if !scalars.contains_key(field) {
            return Err(help_error(format!(
                "missing frontmatter field '{field}' in {source}"
            )));
        }
    }
    for field in ["tags", "related"] {
        if !arrays.contains_key(field) {
            return Err(help_error(format!(
                "missing frontmatter field '{field}' in {source}"
            )));
        }
    }

    let id = scalars.remove("id").expect("checked");
    if !is_kebab_id(&id) {
        return Err(help_error(format!("invalid id in {source}")));
    }
    let title = scalars.remove("title").expect("checked");
    let summary = scalars.remove("summary").expect("checked");
    validate_plain_text(&title, 120, "title", source)?;
    validate_plain_text(&summary, 240, "summary", source)?;
    let section = scalars.remove("section").expect("checked");
    if !SECTION_DEFS
        .iter()
        .any(|definition| definition.0 == section)
    {
        return Err(help_error(format!("unknown section in {source}")));
    }
    let order_raw = scalars.remove("order").expect("checked");
    let order: u16 = order_raw
        .parse()
        .map_err(|_| help_error(format!("invalid order in {source}")))?;
    let tags = arrays.remove("tags").expect("checked");
    let related = arrays.remove("related").expect("checked");
    if tags.is_empty() || tags.len() > 20 {
        return Err(help_error(format!(
            "tags must contain 1-20 values in {source}"
        )));
    }
    validate_id_list(&tags, "tags", source)?;
    validate_id_list(&related, "related", source)?;
    Ok(HelpPageMeta {
        id,
        title,
        summary,
        section,
        tags,
        order,
        related,
    })
}

fn unquote(value: &str) -> &str {
    value
        .strip_prefix('"')
        .and_then(|inner| inner.strip_suffix('"'))
        .or_else(|| {
            value
                .strip_prefix('\'')
                .and_then(|inner| inner.strip_suffix('\''))
        })
        .unwrap_or(value)
}

fn validate_plain_text(value: &str, max_chars: usize, field: &str, source: &str) -> CoreResult<()> {
    if value.is_empty()
        || value.chars().count() > max_chars
        || value.contains(['\r', '\n', '<', '>'])
    {
        return Err(help_error(format!("invalid {field} in {source}")));
    }
    Ok(())
}

fn validate_id_list(values: &[String], field: &str, source: &str) -> CoreResult<()> {
    let mut seen = HashSet::new();
    for value in values {
        if !is_kebab_id(value) {
            return Err(help_error(format!("invalid {field} value in {source}")));
        }
        if !seen.insert(value) {
            return Err(help_error(format!("duplicate {field} value in {source}")));
        }
    }
    Ok(())
}

fn validate_page_body(body: &str, meta: &HelpPageMeta, source: &str) -> CoreResult<()> {
    let headings: Vec<(usize, &str)> = body.lines().filter_map(parse_heading).collect();
    let h1: Vec<&(usize, &str)> = headings.iter().filter(|(level, _)| *level == 1).collect();
    if h1.len() != 1 || h1[0].1 != meta.title {
        return Err(help_error(format!(
            "body must contain one H1 equal to title: {source}"
        )));
    }
    let mut previous = 1usize;
    for (level, _) in headings.iter().skip(1) {
        if *level == 1 || *level > previous + 1 {
            return Err(help_error(format!("invalid heading structure: {source}")));
        }
        previous = *level;
    }
    let lower = body.to_ascii_lowercase();
    for forbidden in ["<script", "<iframe", "<object", "<embed", "<style"] {
        if lower.contains(forbidden) {
            return Err(help_error(format!("raw HTML rejected: {source}")));
        }
    }
    Ok(())
}

fn parse_heading(line: &str) -> Option<(usize, &str)> {
    let trimmed = line.trim_end();
    let level = trimmed.bytes().take_while(|byte| *byte == b'#').count();
    if !(1..=6).contains(&level) || trimmed.as_bytes().get(level) != Some(&b' ') {
        return None;
    }
    Some((level, trimmed.get(level + 1..)?.trim()))
}

fn parse_toc(body: &str, source: &str) -> CoreResult<Vec<HelpTocEntry>> {
    let mut toc = Vec::new();
    let mut counts: HashMap<String, u16> = HashMap::new();
    for (level, title) in body.lines().filter_map(parse_heading) {
        if level == 1 {
            continue;
        }
        if level > 3 {
            return Err(help_error(format!(
                "Help TOC supports H2/H3 only: {source}"
            )));
        }
        let base = heading_anchor(title);
        if base.is_empty() {
            return Err(help_error(format!("empty heading anchor: {source}")));
        }
        let count = counts.entry(base.clone()).or_default();
        *count += 1;
        let anchor = if *count == 1 {
            base
        } else {
            format!("{base}-{count}")
        };
        toc.push(HelpTocEntry {
            level: level as u8,
            title: title.to_string(),
            anchor,
        });
    }
    Ok(toc)
}

fn heading_anchor(title: &str) -> String {
    let mut out = String::new();
    let mut separator = false;
    for ch in title.to_lowercase().chars() {
        if ch.is_alphanumeric() {
            if separator && !out.is_empty() {
                out.push('-');
            }
            out.push(ch);
            separator = false;
        } else {
            separator = true;
        }
    }
    out
}

#[allow(clippy::string_slice)] // all indices originate from `find`, hence UTF-8 boundaries
fn parse_assets(
    root: &Path,
    page_path: &Path,
    body: &str,
    source: &str,
) -> CoreResult<Vec<HelpAssetRef>> {
    let mut assets = Vec::new();
    let mut cursor = 0usize;
    while let Some(start_rel) = body[cursor..].find("![") {
        let start = cursor + start_rel;
        let alt_start = start + 2;
        let Some(alt_end_rel) = body[alt_start..].find("](") else {
            return Err(help_error(format!("malformed image link: {source}")));
        };
        let alt_end = alt_start + alt_end_rel;
        let target_start = alt_end + 2;
        let Some(target_end_rel) = body[target_start..].find(')') else {
            return Err(help_error(format!("malformed image target: {source}")));
        };
        let target_end = target_start + target_end_rel;
        let alt = body[alt_start..alt_end].trim();
        let target = body[target_start..target_end].trim();
        if alt.is_empty() {
            return Err(help_error(format!("empty image alt text: {source}")));
        }
        let normalized = resolve_asset(root, page_path, target, source)?;
        let full = root.join(&normalized);
        validate_svg(&full, &normalized)?;
        if !assets
            .iter()
            .any(|asset: &HelpAssetRef| asset.path == normalized)
        {
            assets.push(HelpAssetRef {
                path: normalized,
                alt: alt.to_string(),
                mime: "image/svg+xml".to_string(),
            });
        }
        cursor = target_end + 1;
    }
    Ok(assets)
}

fn resolve_asset(root: &Path, page_path: &Path, target: &str, source: &str) -> CoreResult<String> {
    let target_path = Path::new(target);
    if target_path.is_absolute() || target.contains('\\') {
        return Err(help_error(format!("invalid image path: {source}")));
    }
    for component in target_path.components() {
        if !matches!(
            component,
            Component::Normal(_) | Component::ParentDir | Component::CurDir
        ) {
            return Err(help_error(format!("invalid image path: {source}")));
        }
    }
    let parent = page_path
        .parent()
        .ok_or_else(|| help_error("page has no parent directory"))?;
    let joined = parent.join(target_path);
    let canonical = joined
        .canonicalize()
        .map_err(|_| help_error(format!("missing image asset: {source}")))?;
    let assets_root = root.join("assets").canonicalize()?;
    if !canonical.starts_with(&assets_root) {
        return Err(help_error(format!("image escaped assets root: {source}")));
    }
    if canonical.extension().and_then(|value| value.to_str()) != Some("svg") {
        return Err(help_error(format!(
            "only SVG assets are supported: {source}"
        )));
    }
    safe_relative(root, &canonical)
}

fn normalize_asset_public_path(value: &str) -> CoreResult<String> {
    let path = Path::new(value.trim());
    if path.is_absolute() || value.contains('\\') {
        return Err(help_error("invalid asset path"));
    }
    let mut parts = Vec::new();
    for component in path.components() {
        match component {
            Component::Normal(part) => {
                let part = part
                    .to_str()
                    .ok_or_else(|| help_error("invalid asset path"))?;
                parts.push(part);
            }
            _ => return Err(help_error("invalid asset path")),
        }
    }
    if parts.first().copied() != Some("assets")
        || parts.len() < 2
        || !parts.last().is_some_and(|part| part.ends_with(".svg"))
    {
        return Err(help_error("invalid asset path"));
    }
    Ok(parts.join("/"))
}

fn validate_svg(path: &Path, relative: &str) -> CoreResult<()> {
    let metadata = fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(help_error(format!("SVG is not a regular file: {relative}")));
    }
    if metadata.len() > MAX_ASSET_BYTES {
        return Err(help_error(format!("SVG exceeds size limit: {relative}")));
    }
    let svg = fs::read_to_string(path)?;
    let lower = svg.to_ascii_lowercase();
    if !lower.contains("<svg") || !lower.contains("viewbox=") || !lower.contains("<title") {
        return Err(help_error(format!(
            "SVG requires svg/viewBox/title: {relative}"
        )));
    }
    for forbidden in [
        "<script",
        "<foreignobject",
        "<image",
        "<animate",
        "<set",
        "javascript:",
        " href=\"http",
        " href='http",
        "xlink:href=\"http",
        "xlink:href='http",
    ] {
        if lower.contains(forbidden) {
            return Err(help_error(format!(
                "SVG contains forbidden content: {relative}"
            )));
        }
    }
    if has_event_attribute(&lower) {
        return Err(help_error(format!(
            "SVG contains event attributes: {relative}"
        )));
    }
    Ok(())
}

fn has_event_attribute(svg: &str) -> bool {
    svg.split_whitespace().any(|token| {
        token
            .strip_prefix("on")
            .is_some_and(|rest| rest.contains('=') && rest.len() > 1)
    })
}

fn validate_help_links(
    body: &str,
    source_id: &str,
    pages: &BTreeMap<String, HelpPage>,
) -> CoreResult<()> {
    let mut rest = body;
    while let Some(start) = rest.find("help://") {
        rest = rest.get(start + "help://".len()..).unwrap_or_default();
        let id: String = rest
            .chars()
            .take_while(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || *ch == '-')
            .collect();
        // Prose may name the scheme itself (for example, "`help://` citations")
        // without forming a locator. Actual ids are validated below.
        if id.is_empty() {
            continue;
        }
        if !is_kebab_id(&id) || !pages.contains_key(&id) {
            return Err(help_error(format!("unknown help link in {source_id}")));
        }
        rest = rest.strip_prefix(id.as_str()).unwrap_or("");
    }
    Ok(())
}

fn chunk_page(page: &HelpPage) -> Vec<HelpChunk> {
    let mut sections: Vec<(Option<String>, Option<String>, Vec<String>)> = Vec::new();
    let mut current_heading: Option<String> = None;
    let mut current_anchor: Option<String> = None;
    let mut current_lines = Vec::new();
    let mut toc_iter = page.toc.iter();
    for line in page.body.lines() {
        let heading = parse_heading(line);
        if let Some((level, title)) = heading {
            if level == 1 {
                continue;
            }
            if !current_lines.is_empty() {
                sections.push((
                    current_heading.take(),
                    current_anchor.take(),
                    std::mem::take(&mut current_lines),
                ));
            }
            let toc = toc_iter.next();
            current_heading = Some(title.to_string());
            current_anchor = toc.map(|entry| entry.anchor.clone());
            continue;
        }
        current_lines.push(line.to_string());
    }
    if !current_lines.is_empty() || sections.is_empty() {
        sections.push((current_heading, current_anchor, current_lines));
    }

    let mut chunks = Vec::new();
    for (heading, anchor, lines) in sections {
        let text = lines.join("\n").trim().to_string();
        if text.is_empty() {
            continue;
        }
        let pieces = split_section(&text);
        for (ordinal, piece) in pieces.into_iter().enumerate() {
            chunks.push(HelpChunk {
                page_id: page.meta.id.clone(),
                heading: heading.clone(),
                anchor: anchor.clone(),
                ordinal: u16::try_from(ordinal + 1).unwrap_or(u16::MAX),
                text: piece,
            });
        }
    }
    chunks
}

fn split_section(text: &str) -> Vec<String> {
    if text.chars().count() <= HARD_CHUNK_CHARS {
        return vec![text.to_string()];
    }
    let blocks: Vec<&str> = text
        .split("\n\n")
        .filter(|block| !block.trim().is_empty())
        .collect();
    let mut out = Vec::new();
    let mut current = String::new();
    for block in blocks {
        let block_chars = block.chars().count();
        if block_chars > HARD_CHUNK_CHARS {
            if !current.is_empty() {
                out.push(std::mem::take(&mut current));
            }
            out.extend(split_by_chars(block, HARD_CHUNK_CHARS));
            continue;
        }
        let separator = usize::from(!current.is_empty()) * 2;
        if !current.is_empty()
            && current.chars().count() + separator + block_chars > SOFT_CHUNK_CHARS
        {
            out.push(std::mem::take(&mut current));
        }
        if !current.is_empty() {
            current.push_str("\n\n");
        }
        current.push_str(block.trim());
    }
    if !current.is_empty() {
        out.push(current);
    }
    out
}

fn split_by_chars(text: &str, max_chars: usize) -> Vec<String> {
    let chars: Vec<char> = text.chars().collect();
    chars
        .chunks(max_chars)
        .map(|chunk| chunk.iter().collect::<String>())
        .filter(|chunk| !chunk.trim().is_empty())
        .collect()
}

fn build_postings(
    pages: &BTreeMap<String, HelpPage>,
    chunks: &[HelpChunk],
) -> HashMap<String, Vec<usize>> {
    let mut postings: HashMap<String, Vec<usize>> = HashMap::new();
    for (idx, chunk) in chunks.iter().enumerate() {
        let Some(page) = pages.get(&chunk.page_id) else {
            continue;
        };
        let searchable = format!(
            "{} {} {} {} {} {}",
            page.meta.title,
            page.meta.summary,
            page.meta.section,
            page.meta.tags.join(" "),
            chunk.heading.as_deref().unwrap_or_default(),
            chunk.text
        );
        let unique: HashSet<String> = tokenize(&searchable).collect();
        for token in unique {
            postings.entry(token).or_default().push(idx);
        }
    }
    postings
}

fn tokenize(value: &str) -> impl Iterator<Item = String> + '_ {
    value
        .split(|ch: char| !ch.is_alphanumeric() && ch != '_' && ch != '-')
        .filter(|token| token.chars().count() > 1)
        .map(str::to_lowercase)
}

fn query_terms(query: &str) -> Vec<String> {
    let mut seen = HashSet::new();
    tokenize(query)
        .filter(|term| seen.insert(term.clone()))
        .collect()
}

fn normalize_phrase(value: &str) -> String {
    tokenize(value).collect::<Vec<_>>().join(" ")
}

fn make_snippet(text: &str, terms: &[String]) -> String {
    let collapsed = snippet_plain_text(text);
    if collapsed.chars().count() <= MAX_SNIPPET_CHARS {
        return collapsed;
    }
    let lower = collapsed.to_lowercase();
    let match_byte = terms
        .iter()
        .filter_map(|term| lower.find(term))
        .min()
        .unwrap_or(0);
    let match_char = crate::text::truncate_bytes(&collapsed, match_byte)
        .chars()
        .count();
    let start_char = match_char.saturating_sub(80);
    let chars: Vec<char> = collapsed.chars().collect();
    let end_char = (start_char + MAX_SNIPPET_CHARS).min(chars.len());
    let mut snippet: String = chars[start_char..end_char].iter().collect();
    if start_char > 0 {
        snippet.insert(0, '…');
    }
    if end_char < chars.len() {
        snippet.push('…');
    }
    snippet
}

#[allow(clippy::string_slice)] // all indices originate from `find`, hence UTF-8 boundaries
fn snippet_plain_text(markdown: &str) -> String {
    let mut without_images = String::with_capacity(markdown.len());
    let mut rest = markdown;
    while let Some(start) = rest.find("![") {
        without_images.push_str(&rest[..start]);
        let alt_start = start + 2;
        let Some(alt_end_rel) = rest[alt_start..].find("](") else {
            without_images.push_str(&rest[start..]);
            rest = "";
            break;
        };
        let alt_end = alt_start + alt_end_rel;
        let target_start = alt_end + 2;
        let Some(target_end_rel) = rest[target_start..].find(')') else {
            without_images.push_str(&rest[start..]);
            rest = "";
            break;
        };
        let target_end = target_start + target_end_rel;
        without_images.push_str(&rest[alt_start..alt_end]);
        rest = &rest[target_end + 1..];
    }
    without_images.push_str(rest);
    without_images
        .chars()
        .map(|ch| match ch {
            '#' | '*' | '_' | '`' | '|' | '>' => ' ',
            other => other,
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use std::fs;

    fn checked_in_root() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("..")
            .join("docs")
            .join("help")
    }

    fn write_fixture_page(
        root: &Path,
        file_name: &str,
        id: &str,
        title: &str,
        body: &str,
        asset_target: &str,
    ) {
        fs::create_dir_all(root.join("overview")).unwrap();
        fs::create_dir_all(root.join("assets")).unwrap();
        fs::write(
            root.join("assets").join("fixture.svg"),
            r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><title>Fixture</title><desc>Fixture asset</desc><path d="M0 0h10v10z"/></svg>"#,
        )
        .unwrap();
        fs::write(
            root.join("overview").join(file_name),
            format!(
                r#"---
id: {id}
title: {title}
summary: A valid deterministic fixture.
section: overview
tags:
  - process
order: 10
related: []
---
# {title}

## Flow

![Fixture]({asset_target})

| Step | Result |
| --- | --- |
| One | Done |

{body}
"#
            ),
        )
        .unwrap();
    }

    #[test]
    fn help_index_loads_checked_in_corpus_without_workspace_or_sqlite() {
        let root = checked_in_root();
        let before: HashSet<PathBuf> = fs::read_dir(&root)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .collect();
        let index = HelpIndex::load(&root).unwrap();
        let after: HashSet<PathBuf> = fs::read_dir(&root)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .collect();
        assert_eq!(before, after, "loading Help must not create a store");
        assert!(index.len() >= 7);
        assert!(index.sections().len() >= 7);
        let page = index.page("log-analysis-pipeline").unwrap();
        assert_eq!(page.meta.title, "How log analysis works");
        assert!(page.body.contains("DuckDB"));
        assert_eq!(page.assets.len(), 1);
        assert_eq!(page.assets[0].path, "assets/log-analysis-pipeline.svg");
        assert!(page.toc.iter().any(|entry| entry.anchor == "tool-guide"));
    }

    #[test]
    fn help_keyword_search_ranks_required_queries() {
        let index = HelpIndex::load(checked_in_root()).unwrap();
        for query in ["log template", "duckdb"] {
            let hits = index.search_keyword(query, 5);
            assert_eq!(
                hits.first().map(|hit| hit.page_id.as_str()),
                Some("log-analysis-pipeline"),
                "query={query} hits={hits:?}"
            );
            assert_eq!(hits[0].mode, HelpSearchMode::Keyword);
            assert!(hits[0].score <= 1.0);
            assert!(hits[0].snippet.chars().count() <= MAX_SNIPPET_CHARS + 2);
        }
        let hits = index.search_keyword("soft write", 5);
        assert_eq!(
            hits.first().map(|hit| hit.page_id.as_str()),
            Some("permission-tiers"),
            "hits={hits:?}"
        );
    }

    #[test]
    fn checked_in_help_search_and_read_cover_current_log_explorer_workflows() {
        let index = HelpIndex::load(checked_in_root()).unwrap();
        for query in [
            "find filter log events",
            "bidirectional paging older newer",
            "long log lines preview deep",
            "timeline navigator",
            "linked chat log tools",
            "evidence lanes align",
        ] {
            let hits = index.search_keyword(query, 5);
            assert!(
                hits.iter().any(|hit| hit.page_id == "log-explorer"),
                "query={query} hits={hits:?}"
            );
        }

        let page = index.page("log-explorer").unwrap();
        for literal in [
            "## Find vs Filter",
            "## Lanes",
            "## Time link",
            "## Timeline navigator",
            "## Long lines",
            "## Bookmarks",
            "## Agent context",
            "Bidirectional paging",
        ] {
            assert!(
                page.body.contains(literal),
                "log-explorer Help is missing {literal:?}"
            );
        }
    }

    #[tokio::test]
    async fn help_search_without_embed_is_keyword_only() {
        let index = HelpIndex::load(checked_in_root()).unwrap();
        let hits = index.search("log analysis", 3, None).await;
        assert!(!hits.is_empty());
        assert!(hits.iter().all(|hit| hit.mode == HelpSearchMode::Keyword));
    }

    #[tokio::test]
    async fn help_hybrid_search_uses_exact_vector_index_offline() {
        let index = HelpIndex::load(checked_in_root()).unwrap();
        let backend = crate::embed::ConceptEmbedBackend::default();
        assert!(
            index.search_keyword("econnrefused", 5).is_empty(),
            "fixture must prove semantic-only recall"
        );
        let hits = index.search("econnrefused", 5, Some(&backend)).await;
        assert_eq!(
            hits.first().map(|hit| hit.page_id.as_str()),
            Some("log-analysis-pipeline"),
            "hits={hits:?}"
        );
        assert!(hits.iter().all(|hit| hit.mode == HelpSearchMode::Hybrid));
    }

    struct FailingEmbed;

    #[async_trait]
    impl EmbedBackend for FailingEmbed {
        async fn embed(&self, _texts: &[String]) -> CoreResult<Vec<Vec<f32>>> {
            Err(CoreError::Message(
                "dummy provider secret-shaped detail".into(),
            ))
        }
    }

    #[tokio::test]
    async fn help_embed_failure_falls_back_to_keyword() {
        let index = HelpIndex::load(checked_in_root()).unwrap();
        let hits = index.search("duckdb", 3, Some(&FailingEmbed)).await;
        assert_eq!(hits[0].page_id, "log-analysis-pipeline");
        assert!(hits.iter().all(|hit| hit.mode == HelpSearchMode::Keyword));
    }

    #[test]
    fn help_index_rejects_asset_traversal() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("corpus");
        fs::create_dir_all(&root).unwrap();
        fs::write(
            temp.path().join("outside.svg"),
            r#"<svg viewBox="0 0 1 1"><title>Outside</title></svg>"#,
        )
        .unwrap();
        write_fixture_page(
            &root,
            "fixture.md",
            "fixture-page",
            "Fixture page",
            "Body.",
            "../../outside.svg",
        );
        let error = HelpIndex::load(&root).err().expect("must reject");
        assert!(error.to_string().contains("escaped assets root"));
    }

    #[test]
    fn help_index_rejects_duplicate_ids() {
        let temp = tempfile::tempdir().unwrap();
        write_fixture_page(
            temp.path(),
            "one.md",
            "fixture-page",
            "Fixture page",
            "First.",
            "../assets/fixture.svg",
        );
        write_fixture_page(
            temp.path(),
            "two.md",
            "fixture-page",
            "Fixture page",
            "Second.",
            "../assets/fixture.svg",
        );
        let error = HelpIndex::load(temp.path()).err().expect("must reject");
        assert!(error.to_string().contains("duplicate page id"));
    }

    #[test]
    fn help_page_and_asset_reject_unknown_or_undeclared_ids() {
        let index = HelpIndex::load(checked_in_root()).unwrap();
        assert!(index.page("../log-analysis-pipeline").is_err());
        assert!(index.page("missing-page").is_err());
        assert!(index
            .asset("log-analysis-pipeline", "assets/product-architecture.svg")
            .is_err());
        let (mime, bytes) = index
            .asset("log-analysis-pipeline", "assets/log-analysis-pipeline.svg")
            .unwrap();
        assert_eq!(mime, "image/svg+xml");
        assert!(bytes.starts_with(b"<svg"));
    }

    #[test]
    fn help_chunks_are_bounded_and_stable() {
        let index = HelpIndex::load(checked_in_root()).unwrap();
        assert!(!index.chunks.is_empty());
        let mut keys = HashSet::new();
        for chunk in &index.chunks {
            assert!(chunk.text.chars().count() <= HARD_CHUNK_CHARS);
            assert!(keys.insert(chunk.key()), "duplicate key {}", chunk.key());
        }
        let snippet = make_snippet(
            "![Diagram](../assets/secret-path.svg)\n\nVisible **words** only.",
            &["visible".to_string()],
        );
        assert!(!snippet.contains("../assets"));
        assert!(!snippet.contains("!["));
        assert!(snippet.contains("Visible words only."));
    }
}
