//! Pure Confluence→local transforms (#326 PR3).
//! Full storage↔markdown converters land in PR4.

use crate::confluence_ro::{strip_tags, ConfluencePageMeta};

/// Apply a built-in transform profile to storage body + meta.
///
/// Unknown profiles fall back to [`profiles::PLAIN_STRIP`] behavior with a note
/// in the returned content header only when profile is empty.
pub fn apply_transform(profile: &str, storage: &str, meta: &ConfluencePageMeta) -> String {
    let p = profile.trim();
    match p {
        "" | super::profiles::PLAIN_STRIP => plain_strip(storage),
        super::profiles::RAW_STORAGE => identity_storage(storage),
        super::profiles::STRUCTURED_FIELDS => structured_fields_md(meta),
        super::profiles::SUMMARY => summary_extract(storage, meta),
        // cleaned_markdown until PR4 converters: best-effort plain with notice
        super::profiles::CLEANED_MARKDOWN => {
            let plain = plain_strip(storage);
            format!(
                "<!-- transform=cleaned_markdown (lossy plain until PR4 converters) -->\n\n{plain}"
            )
        }
        other => {
            let plain = plain_strip(storage);
            format!("<!-- unknown transform `{other}`; used plain_strip -->\n\n{plain}")
        }
    }
}

/// Existing strip_tags path (default harvest profile).
pub fn plain_strip(storage: &str) -> String {
    strip_tags(storage)
}

/// Faithful storage body (raw_storage profile).
pub fn identity_storage(storage: &str) -> String {
    storage.to_string()
}

/// Title / space / labels / version / url table.
pub fn structured_fields_md(meta: &ConfluencePageMeta) -> String {
    let labels = if meta.labels.is_empty() {
        "—".into()
    } else {
        meta.labels.join(", ")
    };
    let ver = meta
        .version
        .map(|v| v.to_string())
        .unwrap_or_else(|| "—".into());
    let url = meta.url.as_deref().unwrap_or("—");
    format!(
        "# {}\n\n| Field | Value |\n|-------|-------|\n| id | {} |\n| space | {} |\n| version | {ver} |\n| labels | {labels} |\n| url | {url} |\n",
        meta.title, meta.id, meta.space
    )
}

/// Heuristic summary: title + first N plain chars.
pub fn summary_extract(storage: &str, meta: &ConfluencePageMeta) -> String {
    let plain = plain_strip(storage);
    let excerpt: String = plain.chars().take(800).collect();
    format!("# {}\n\n{}\n", meta.title, excerpt.trim())
}

/// Content hash for local body (stable for sync).
pub fn content_hash(text: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(text.as_bytes());
    format!("{:x}", h.finalize())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::confluence_ro::ConfluencePageMeta;
    use crate::harvest::profiles;

    fn meta() -> ConfluencePageMeta {
        ConfluencePageMeta {
            id: "99".into(),
            title: "Auth Runbook".into(),
            space: "ENG".into(),
            version: Some(3),
            parent_id: None,
            url: Some("https://wiki.example.com/pages/viewpage.action?pageId=99".into()),
            labels: vec!["ops".into()],
            excerpt: None,
        }
    }

    #[test]
    fn plain_strips_html() {
        assert_eq!(plain_strip("<p>Hi <b>x</b></p>"), "Hi x");
    }

    #[test]
    fn structured_has_table() {
        let md = structured_fields_md(&meta());
        assert!(md.contains("Auth Runbook"));
        assert!(md.contains("ENG"));
        assert!(md.contains("| version | 3 |"));
    }

    #[test]
    fn apply_raw_and_default() {
        let m = meta();
        let storage = "<p>body</p>";
        assert_eq!(apply_transform(profiles::RAW_STORAGE, storage, &m), storage);
        assert_eq!(apply_transform(profiles::PLAIN_STRIP, storage, &m), "body");
        assert_eq!(apply_transform("", storage, &m), "body");
    }

    #[test]
    fn content_hash_stable() {
        assert_eq!(content_hash("a"), content_hash("a"));
        assert_ne!(content_hash("a"), content_hash("b"));
    }
}
