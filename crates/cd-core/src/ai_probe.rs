//! Discover AI gateway models (TriageTool-parity native HTTP).
//!
//! Uses a plain `reqwest` client (no SSRF pin) so corporate gateways on private
//! DNS/IPs work the same as TriageTool. User-supplied base URL + key only —
//! not model-controlled outbound.

#![allow(missing_docs)]

use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::time::Duration;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiDiscoveredModel {
    pub id: String,
    /// "chat" | "embedding" | "unknown"
    pub kind: String,
    pub source: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiProbeResult {
    pub ok: bool,
    /// "ollama" | "openai_compatible" | "anthropic"
    pub flavor: Option<String>,
    pub base_url: String,
    pub effective_base_url: String,
    pub models: Vec<AiDiscoveredModel>,
    pub chat_candidates: Vec<AiDiscoveredModel>,
    pub embed_candidates: Vec<AiDiscoveredModel>,
    pub notes: Vec<String>,
    pub errors: Vec<String>,
    pub local_ollama_reachable: bool,
    pub local_ollama_models: Vec<AiDiscoveredModel>,
}

fn strip_slash(u: &str) -> String {
    u.trim().trim_end_matches('/').to_string()
}

fn normalize_gateway_input(raw: &str) -> String {
    let mut s = strip_slash(raw);
    let lower = s.to_lowercase();
    if lower.ends_with("/models") {
        #[allow(clippy::string_slice)]
        {
            s = s[..s.len() - "/models".len()]
                .trim_end_matches('/')
                .to_string();
        }
    }
    s
}

fn expand_base_candidates(raw: &str) -> Vec<String> {
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
    if let Ok(mut url) = reqwest::Url::parse(&base) {
        let path = url.path().trim_end_matches('/').to_string();
        if path.ends_with("/v1") {
            let parent = path.trim_end_matches("/v1");
            url.set_path(if parent.is_empty() { "/" } else { parent });
            add(url.to_string().trim_end_matches('/').to_string());
        }
    }
    out.truncate(12);
    out
}

fn classify_model_id(id: &str) -> &'static str {
    let s = id.to_lowercase();
    if s.contains("embed")
        || s.contains("nomic")
        || s.contains("e5-")
        || s.contains("bge-")
        || s.contains("gte-")
        || s.contains("text-embedding")
        || s.contains("voyage")
    {
        return "embedding";
    }
    if s.contains("gpt")
        || s.contains("claude")
        || s.contains("mistral")
        || s.contains("llama")
        || s.contains("sonnet")
        || s.contains("opus")
        || s.contains("haiku")
        || s.contains("command")
        || s.contains("gemini")
        || s.contains("qwen")
        || s.contains("phi")
        || s.contains("deepseek")
        || s.contains("o1")
        || s.contains("o3")
        || s.contains("chat")
        || s.contains("instruct")
        || s.contains("grok")
    {
        return "chat";
    }
    "unknown"
}

fn rank_chat(id: &str) -> i32 {
    let s = id.to_lowercase();
    if s.contains("sonnet") {
        90
    } else if s.contains("gpt-4o") {
        85
    } else if s.contains("gpt-4") {
        80
    } else if s.contains("mistral") {
        75
    } else if s.contains("claude") {
        70
    } else if s.contains("gpt") {
        60
    } else {
        40
    }
}

fn rank_embed(id: &str) -> i32 {
    let s = id.to_lowercase();
    if s.contains("nomic-embed") {
        100
    } else if s.contains("text-embedding-3-small") {
        90
    } else if s.contains("768") {
        80
    } else if s.contains("embed") {
        50
    } else {
        10
    }
}

fn parse_openai_models(v: &serde_json::Value, source: &str) -> Vec<AiDiscoveredModel> {
    let mut out = Vec::new();
    let mut take = |arr: &[serde_json::Value]| {
        for row in arr {
            let id = row
                .get("id")
                .and_then(|x| x.as_str())
                .or_else(|| row.get("name").and_then(|x| x.as_str()))
                .or_else(|| row.get("model").and_then(|x| x.as_str()))
                .unwrap_or("");
            if id.is_empty() {
                continue;
            }
            out.push(AiDiscoveredModel {
                kind: classify_model_id(id).to_string(),
                id: id.to_string(),
                source: source.to_string(),
            });
        }
    };
    if let Some(arr) = v.get("data").and_then(|d| d.as_array()) {
        take(arr);
    }
    if let Some(arr) = v.get("models").and_then(|d| d.as_array()) {
        take(arr);
    }
    if let Some(arr) = v.as_array() {
        take(arr);
    }
    out
}

fn parse_ollama_tags(v: &serde_json::Value, source: &str) -> Vec<AiDiscoveredModel> {
    let Some(arr) = v.get("models").and_then(|d| d.as_array()) else {
        return vec![];
    };
    arr.iter()
        .filter_map(|row| {
            let id = row
                .get("name")
                .or_else(|| row.get("model"))
                .and_then(|x| x.as_str())?
                .to_string();
            if id.is_empty() {
                return None;
            }
            Some(AiDiscoveredModel {
                kind: classify_model_id(&id).to_string(),
                id,
                source: source.to_string(),
            })
        })
        .collect()
}

async fn get_json(
    client: &Client,
    url: &str,
    headers: Vec<(String, String)>,
) -> Result<(u16, serde_json::Value), String> {
    let mut req = client.get(url).timeout(Duration::from_secs(12));
    for (k, v) in headers {
        req = req.header(k, v);
    }
    let resp = req.send().await.map_err(|e| format!("{url}: {e}"))?;
    let status = resp.status().as_u16();
    let text = resp.text().await.unwrap_or_default();
    let json: serde_json::Value = serde_json::from_str(&text).unwrap_or(serde_json::Value::Null);
    Ok((status, json))
}

fn bearer_headers(key: &str) -> Vec<(String, String)> {
    if key.is_empty() {
        return vec![("Accept".into(), "application/json".into())];
    }
    vec![
        ("Accept".into(), "application/json".into()),
        ("Authorization".into(), format!("Bearer {key}")),
    ]
}

fn anthropic_headers(key: &str) -> Vec<(String, String)> {
    let mut h = vec![
        ("Accept".into(), "application/json".into()),
        ("anthropic-version".into(), "2023-06-01".into()),
    ];
    if !key.is_empty() {
        h.push(("x-api-key".into(), key.to_string()));
        h.push(("Authorization".into(), format!("Bearer {key}")));
    }
    h
}

/// Probe local Ollama + optional remote gateway. Native HTTP (no browser CORS, no SSRF pin).
pub async fn probe_ai_gateway(
    base_url: &str,
    api_key: Option<&str>,
    probe_local: bool,
) -> AiProbeResult {
    let client = Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .unwrap_or_else(|_| Client::new());

    let mut local_models = Vec::new();
    let mut local_ok = false;
    if probe_local {
        if let Ok((status, json)) = get_json(
            &client,
            "http://127.0.0.1:11434/api/tags",
            vec![("Accept".into(), "application/json".into())],
        )
        .await
        {
            if (200..300).contains(&status) {
                local_ok = true;
                local_models = parse_ollama_tags(&json, "http://127.0.0.1:11434/api/tags");
            }
        }
    }

    let key = api_key.unwrap_or("").trim();
    let base_trim = normalize_gateway_input(base_url);

    // Local-only request (empty or loopback URL)
    if base_trim.is_empty()
        || base_trim.contains("127.0.0.1")
        || base_trim.to_lowercase().contains("localhost")
    {
        if local_ok {
            let mut chat: Vec<_> = local_models
                .iter()
                .filter(|m| m.kind != "embedding")
                .cloned()
                .collect();
            chat.sort_by(|a, b| rank_chat(&b.id).cmp(&rank_chat(&a.id)));
            let mut emb: Vec<_> = local_models
                .iter()
                .filter(|m| m.kind == "embedding")
                .cloned()
                .collect();
            emb.sort_by(|a, b| rank_embed(&b.id).cmp(&rank_embed(&a.id)));
            return AiProbeResult {
                ok: true,
                flavor: Some("ollama".into()),
                base_url: "http://127.0.0.1:11434".into(),
                effective_base_url: "http://127.0.0.1:11434".into(),
                models: local_models.clone(),
                chat_candidates: chat,
                embed_candidates: emb,
                notes: vec!["Local Ollama is reachable.".into()],
                errors: vec![],
                local_ollama_reachable: local_ok,
                local_ollama_models: local_models,
            };
        }
        return AiProbeResult {
            ok: false,
            flavor: None,
            base_url: base_trim,
            effective_base_url: String::new(),
            models: vec![],
            chat_candidates: vec![],
            embed_candidates: vec![],
            notes: vec!["Local Ollama not reachable at 127.0.0.1:11434.".into()],
            errors: vec![],
            local_ollama_reachable: false,
            local_ollama_models: vec![],
        };
    }

    let mut notes = Vec::new();
    let mut errors = Vec::new();
    let mut models: Vec<AiDiscoveredModel> = Vec::new();
    let mut flavor: Option<String> = None;
    let mut effective = base_trim.clone();
    let mut ok = false;

    let candidates = expand_base_candidates(&base_trim);
    notes.push(format!(
        "Trying {} URL shape(s) via native HTTP (TriageTool-parity)…",
        candidates.len()
    ));

    'roots: for root in &candidates {
        let tags_url = format!("{root}/api/tags");
        if let Ok((status, json)) = get_json(
            &client,
            &tags_url,
            vec![("Accept".into(), "application/json".into())],
        )
        .await
        {
            if (200..300).contains(&status) {
                let list = parse_ollama_tags(&json, &tags_url);
                flavor = Some("ollama".into());
                effective = root.clone();
                ok = true;
                models.extend(list);
                notes.push(format!("Ollama API at {tags_url}"));
                break 'roots;
            }
        }

        let model_paths: Vec<String> = if root.to_lowercase().ends_with("/v1") {
            vec![format!("{root}/models")]
        } else {
            vec![format!("{root}/v1/models"), format!("{root}/models")]
        };

        for path in model_paths {
            // Bearer (OpenAI-compatible)
            match get_json(&client, &path, bearer_headers(key)).await {
                Ok((status, json)) if (200..300).contains(&status) => {
                    let list = parse_openai_models(&json, &path);
                    if !list.is_empty() {
                        let mostly_claude = list
                            .iter()
                            .filter(|m| m.id.to_lowercase().contains("claude"))
                            .count()
                            > list.len() / 2;
                        let has_gpt = list.iter().any(|m| {
                            let s = m.id.to_lowercase();
                            s.contains("gpt") || s.contains("o1") || s.contains("o3")
                        });
                        flavor = Some(
                            if path.contains("anthropic") || (mostly_claude && !has_gpt) {
                                "anthropic".into()
                            } else {
                                "openai_compatible".into()
                            },
                        );
                        effective = if path.ends_with("/v1/models") {
                            path.trim_end_matches("/models").to_string()
                        } else if root.to_lowercase().ends_with("/v1") {
                            root.clone()
                        } else {
                            root.clone()
                        };
                        ok = true;
                        models.extend(list);
                        notes.push(format!(
                            "Models list at {path} (Bearer) — {} model(s)",
                            models.len()
                        ));
                        break 'roots;
                    }
                }
                Ok((status, _)) if status == 401 || status == 403 => {
                    errors.push(format!("{path}: auth failed ({status}) — check API key"));
                }
                Ok((status, _)) => {
                    errors.push(format!("{path}: HTTP {status}"));
                }
                Err(e) => errors.push(e),
            }

            // Anthropic-style headers
            match get_json(&client, &path, anthropic_headers(key)).await {
                Ok((status, json)) if (200..300).contains(&status) => {
                    let list = parse_openai_models(&json, &path);
                    if !list.is_empty() {
                        flavor = Some("anthropic".into());
                        effective = path.trim_end_matches("/models").to_string();
                        ok = true;
                        models.extend(list);
                        notes.push(format!(
                            "Models list at {path} (x-api-key) — {} model(s)",
                            models.len()
                        ));
                        break 'roots;
                    }
                }
                Ok((status, _)) if status == 401 || status == 403 => {
                    errors.push(format!("{path}: auth failed ({status}) with x-api-key"));
                }
                Err(e) => {
                    if !errors.iter().any(|x| x == &e) {
                        errors.push(e);
                    }
                }
                _ => {}
            }
        }
    }

    let mut by_id = std::collections::BTreeMap::new();
    for m in models {
        by_id.entry(m.id.clone()).or_insert(m);
    }
    let unique: Vec<_> = by_id.into_values().collect();
    let mut chat: Vec<_> = unique
        .iter()
        .filter(|m| m.kind == "chat" || m.kind == "unknown")
        .cloned()
        .collect();
    chat.sort_by(|a, b| rank_chat(&b.id).cmp(&rank_chat(&a.id)));
    let mut emb: Vec<_> = unique
        .iter()
        .filter(|m| m.kind == "embedding")
        .cloned()
        .collect();
    emb.sort_by(|a, b| rank_embed(&b.id).cmp(&rank_embed(&a.id)));

    if ok && emb.is_empty() {
        notes.push("No embedding models listed (chat-only is fine for ContextDesk).".into());
    }
    if !ok {
        notes.push(
            "Could not list models. Check URL, API key, VPN, and that the host is reachable from this machine.".into(),
        );
        if key.is_empty() {
            notes.push("No API key provided — many gateways require a key to list models.".into());
        }
    }

    AiProbeResult {
        ok,
        flavor,
        base_url: base_trim,
        effective_base_url: effective,
        models: unique,
        chat_candidates: chat,
        embed_candidates: emb,
        notes,
        errors: errors.into_iter().take(12).collect(),
        local_ollama_reachable: local_ok,
        local_ollama_models: local_models,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expands_gateway_shapes() {
        let c = expand_base_candidates("https://gw.example.com");
        assert!(c.iter().any(|u| u.contains("/openai")));
        assert!(c.iter().any(|u| u.contains("/anthropic")));
        assert!(c.iter().any(|u| u.contains("/llm")));
        assert!(c.iter().any(|u| u.ends_with("/v1")));
        let d = expand_base_candidates("https://gw.example.com/llm/v1/models");
        assert!(d.iter().any(|u| u.ends_with("/llm/v1")), "{d:?}");
        assert!(!d.iter().any(|u| u.ends_with("/models/models")));
    }

    #[test]
    fn classifies_models() {
        assert_eq!(classify_model_id("text-embedding-3-small"), "embedding");
        assert_eq!(classify_model_id("gpt-4o-mini"), "chat");
        assert_eq!(classify_model_id("claude-sonnet-4"), "chat");
    }
}
