//! Gateway URL normalization and candidate expansion (no network).
//!
//! Network probe lives in a later issue; pure functions here keep CI offline.

use serde::{Deserialize, Serialize};
use url::Url;

/// Classification of a discovered model id.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ModelKind {
    /// Chat / completion models.
    Chat,
    /// Embedding models.
    Embedding,
    /// Unknown / dual-use.
    Unknown,
}

/// Heuristic model kind from id string.
pub fn classify_model_id(id: &str) -> ModelKind {
    let s = id.to_lowercase();
    if s.contains("embed")
        || s.contains("nomic")
        || s.contains("e5-")
        || s.contains("bge-")
        || s.contains("gte-")
        || s.contains("text-embedding")
        || s.contains("voyage")
    {
        return ModelKind::Embedding;
    }
    if s.contains("gpt")
        || s.contains("claude")
        || s.contains("mistral")
        || s.contains("llama")
        || s.contains("grok")
        || s.contains("sonnet")
        || s.contains("opus")
        || s.contains("haiku")
        || s.contains("gemini")
        || s.contains("qwen")
        || s.contains("deepseek")
        || s.contains("chat")
    {
        return ModelKind::Chat;
    }
    ModelKind::Unknown
}

fn strip_slash(u: &str) -> String {
    u.trim().trim_end_matches('/').to_string()
}

/// Normalize user input: accept host, `…/v1`, or full `…/v1/models` from docs.
pub fn normalize_gateway_input(raw: &str) -> String {
    let mut s = strip_slash(raw);
    let lower = s.to_lowercase();
    if lower.ends_with("/models") {
        // ASCII suffix strip — never mid-char (suffix is pure ASCII).
        #[allow(clippy::string_slice)] // safe: ASCII "/models" suffix length
        {
            s = s[..s.len() - "/models".len()]
                .trim_end_matches('/')
                .to_string();
        }
    }
    s
}

/// Expand a user-entered base into probe candidate URLs (capped).
pub fn expand_base_candidates(raw: &str) -> Vec<String> {
    let base = normalize_gateway_input(raw);
    if base.is_empty() {
        return vec![];
    }
    let mut out: Vec<String> = Vec::new();
    let mut add = |u: String| {
        let s = strip_slash(&u);
        if !s.is_empty() && !out.iter().any(|x| x == &s) {
            out.push(s);
        }
    };
    add(base.clone());
    let lower = base.to_lowercase();
    if !lower.ends_with("/v1") {
        add(format!("{base}/v1"));
    }
    // Enterprise / TriageTool-compatible path shapes
    if !lower.contains("/llm") {
        add(format!("{base}/llm/v1"));
        add(format!("{base}/llm"));
        add(format!("{base}/api/llm/v1"));
    }
    if !lower.contains("/openai") {
        add(format!("{base}/openai/v1"));
        add(format!("{base}/openai"));
    }
    if !lower.contains("/anthropic") {
        add(format!("{base}/anthropic/v1"));
        add(format!("{base}/anthropic"));
    }
    if !lower.contains("/api") {
        add(format!("{base}/api"));
        add(format!("{base}/api/v1"));
    }
    // Parent of …/v1 (some docs paste host+path with trailing /v1 only)
    if lower.ends_with("/v1") {
        if let Ok(mut url) = Url::parse(&base) {
            let path = url.path().trim_end_matches('/').to_string();
            if let Some(parent) = path.strip_suffix("/v1") {
                url.set_path(if parent.is_empty() { "/" } else { parent });
                add(url.to_string().trim_end_matches('/').to_string());
            }
        } else if let Some(parent) = base.strip_suffix("/v1") {
            add(parent.to_string());
        }
    }
    out.truncate(16);
    out
}

/// Detect whether a path string looks like a secret-bearing file name.
pub fn looks_like_secret_filename(name: &str) -> bool {
    let n = name.to_lowercase();
    n == ".env"
        || n.starts_with(".env.")
        || n.ends_with(".pem")
        || n == "id_rsa"
        || n == "id_ed25519"
        || n.contains("credentials")
        || n == "auth.json"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_models_suffix() {
        let n = normalize_gateway_input("https://gateway.example.com/v1/models");
        assert_eq!(n, "https://gateway.example.com/v1");
    }

    #[test]
    fn expands_v1_candidate() {
        let c = expand_base_candidates("https://gateway.example.com");
        assert!(c.iter().any(|u| u.ends_with("/v1")));
        assert!(c.iter().any(|u| u.contains("/llm/v1")));
        assert!(c.len() <= 16);
    }

    #[test]
    fn classifies_embed_and_chat() {
        assert_eq!(classify_model_id("nomic-embed-text"), ModelKind::Embedding);
        assert_eq!(classify_model_id("grok-3"), ModelKind::Chat);
    }

    #[test]
    fn secret_filenames() {
        assert!(looks_like_secret_filename(".env"));
        assert!(looks_like_secret_filename("auth.json"));
        assert!(!looks_like_secret_filename("README.md"));
    }
}
