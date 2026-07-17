//! Chat provider clients (OpenAI-compatible + Ollama).

use crate::error::{CoreError, CoreResult};
use crate::ssrf::{validate_provider_url, SsrfPolicy};
use crate::tools::ToolSpec;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// Chat message role.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    /// System.
    System,
    /// User.
    User,
    /// Assistant.
    Assistant,
    /// Tool result.
    Tool,
}

/// One chat message.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    /// Role.
    pub role: Role,
    /// Content.
    pub content: String,
    /// Tool call id when role=tool.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    /// Tool calls from assistant.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<ToolCallMsg>>,
}

/// Tool call in assistant message.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCallMsg {
    /// Id.
    pub id: String,
    /// Type (function).
    #[serde(rename = "type")]
    pub kind: String,
    /// Function body.
    pub function: FunctionCall,
}

/// Function name + args JSON string.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FunctionCall {
    /// Name.
    pub name: String,
    /// Arguments JSON string.
    pub arguments: String,
}

/// Result of a chat completion (non-stream).
#[derive(Debug, Clone)]
pub struct ChatCompletion {
    /// Assistant text (may be empty if only tools).
    pub content: String,
    /// Tool calls.
    pub tool_calls: Vec<ToolCallMsg>,
    /// Finish reason.
    pub finish_reason: String,
}

/// Convert tool specs to OpenAI tools array.
pub fn tools_to_openai(specs: &[ToolSpec]) -> Value {
    Value::Array(
        specs
            .iter()
            .map(|t| {
                json!({
                    "type": "function",
                    "function": {
                        "name": t.name,
                        "description": t.description,
                        "parameters": t.parameters,
                    }
                })
            })
            .collect(),
    )
}

/// OpenAI-compatible chat client.
#[derive(Debug, Clone)]
pub struct OpenAiCompatibleClient {
    /// HTTP client.
    http: reqwest::Client,
    /// Base URL (may include /v1).
    pub base_url: String,
    /// Bearer token (optional).
    pub api_key: Option<String>,
    /// Model id.
    pub model: String,
}

impl OpenAiCompatibleClient {
    /// Create client after SSRF check.
    pub fn new(
        base_url: impl Into<String>,
        api_key: Option<String>,
        model: impl Into<String>,
        policy: &SsrfPolicy,
    ) -> CoreResult<Self> {
        let base_url = base_url.into();
        validate_provider_url(&base_url, policy)?;
        let http = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(120))
            .build()
            .map_err(|e| CoreError::Message(format!("http client: {e}")))?;
        Ok(Self {
            http,
            base_url: base_url.trim_end_matches('/').to_string(),
            api_key,
            model: model.into(),
        })
    }

    fn chat_url(&self) -> String {
        let b = &self.base_url;
        if b.ends_with("/v1") {
            format!("{b}/chat/completions")
        } else if b.contains("/v1/") {
            format!("{}/chat/completions", b.trim_end_matches('/'))
        } else {
            format!("{b}/v1/chat/completions")
        }
    }

    /// Non-streaming chat completion.
    pub async fn complete(
        &self,
        messages: &[ChatMessage],
        tools: Option<&[ToolSpec]>,
    ) -> CoreResult<ChatCompletion> {
        let mut body = json!({
            "model": self.model,
            "messages": messages,
            "stream": false,
        });
        if let Some(specs) = tools {
            if !specs.is_empty() {
                body["tools"] = tools_to_openai(specs);
                body["tool_choice"] = json!("auto");
            }
        }
        let mut req = self.http.post(self.chat_url()).json(&body);
        if let Some(k) = &self.api_key {
            req = req.bearer_auth(k);
        }
        let resp = req
            .send()
            .await
            .map_err(|e| CoreError::Message(format!("chat request: {e}")))?;
        let status = resp.status();
        let text = resp
            .text()
            .await
            .map_err(|e| CoreError::Message(format!("chat body: {e}")))?;
        if !status.is_success() {
            return Err(CoreError::Message(format!(
                "chat HTTP {status}: {}",
                text.chars().take(300).collect::<String>()
            )));
        }
        parse_openai_completion(&text)
    }

    /// List models via GET /v1/models.
    pub async fn list_models(&self) -> CoreResult<Vec<String>> {
        let url = if self.base_url.ends_with("/v1") {
            format!("{}/models", self.base_url)
        } else {
            format!("{}/v1/models", self.base_url)
        };
        let mut req = self.http.get(url);
        if let Some(k) = &self.api_key {
            req = req.bearer_auth(k);
        }
        let resp = req
            .send()
            .await
            .map_err(|e| CoreError::Message(format!("models: {e}")))?;
        let status = resp.status();
        let text = resp
            .text()
            .await
            .map_err(|e| CoreError::Message(format!("models body: {e}")))?;
        if !status.is_success() {
            return Err(CoreError::Message(format!("models HTTP {status}")));
        }
        let v: Value = serde_json::from_str(&text)?;
        let mut ids = Vec::new();
        if let Some(arr) = v.get("data").and_then(|d| d.as_array()) {
            for m in arr {
                if let Some(id) = m.get("id").and_then(|x| x.as_str()) {
                    ids.push(id.to_string());
                }
            }
        }
        Ok(ids)
    }
}

/// Parse OpenAI chat completion JSON (also used in tests with fixtures).
pub fn parse_openai_completion(text: &str) -> CoreResult<ChatCompletion> {
    let v: Value = serde_json::from_str(text)?;
    let choice = v
        .get("choices")
        .and_then(|c| c.as_array())
        .and_then(|a| a.first())
        .ok_or_else(|| CoreError::Message("no choices in completion".into()))?;
    let message = choice
        .get("message")
        .ok_or_else(|| CoreError::Message("no message".into()))?;
    let content = message
        .get("content")
        .and_then(|c| c.as_str())
        .unwrap_or("")
        .to_string();
    let finish = choice
        .get("finish_reason")
        .and_then(|f| f.as_str())
        .unwrap_or("stop")
        .to_string();
    let mut tool_calls = Vec::new();
    if let Some(arr) = message.get("tool_calls").and_then(|t| t.as_array()) {
        for tc in arr {
            let id = tc
                .get("id")
                .and_then(|x| x.as_str())
                .unwrap_or("call")
                .to_string();
            let func = tc.get("function").cloned().unwrap_or(json!({}));
            let name = func
                .get("name")
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string();
            let arguments = func
                .get("arguments")
                .and_then(|x| x.as_str())
                .unwrap_or("{}")
                .to_string();
            tool_calls.push(ToolCallMsg {
                id,
                kind: "function".into(),
                function: FunctionCall { name, arguments },
            });
        }
    }
    Ok(ChatCompletion {
        content,
        tool_calls,
        finish_reason: finish,
    })
}

/// Ollama chat client (native /api/chat).
#[derive(Debug, Clone)]
pub struct OllamaClient {
    http: reqwest::Client,
    /// Base URL (e.g. http://127.0.0.1:11434).
    pub base_url: String,
    /// Model name.
    pub model: String,
}

impl OllamaClient {
    /// Create with SSRF policy (loopback allowed by default).
    pub fn new(base_url: impl Into<String>, model: impl Into<String>) -> CoreResult<Self> {
        let base_url = base_url.into();
        validate_provider_url(&base_url, &SsrfPolicy::default())?;
        let http = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(120))
            .build()
            .map_err(|e| CoreError::Message(format!("http: {e}")))?;
        Ok(Self {
            http,
            base_url: base_url.trim_end_matches('/').to_string(),
            model: model.into(),
        })
    }

    /// List local models via /api/tags.
    pub async fn list_tags(&self) -> CoreResult<Vec<String>> {
        let url = format!("{}/api/tags", self.base_url);
        let resp = self
            .http
            .get(url)
            .send()
            .await
            .map_err(|e| CoreError::Message(format!("ollama tags: {e}")))?;
        if !resp.status().is_success() {
            return Err(CoreError::Message("ollama tags failed".into()));
        }
        let v: Value = resp
            .json()
            .await
            .map_err(|e| CoreError::Message(format!("ollama json: {e}")))?;
        let mut out = Vec::new();
        if let Some(models) = v.get("models").and_then(|m| m.as_array()) {
            for m in models {
                if let Some(name) = m.get("name").and_then(|n| n.as_str()) {
                    out.push(name.to_string());
                }
            }
        }
        Ok(out)
    }

    /// Non-stream chat.
    pub async fn complete(&self, messages: &[ChatMessage]) -> CoreResult<ChatCompletion> {
        let omsgs: Vec<Value> = messages
            .iter()
            .map(|m| {
                json!({
                    "role": match m.role {
                        Role::System => "system",
                        Role::User => "user",
                        Role::Assistant => "assistant",
                        Role::Tool => "tool",
                    },
                    "content": m.content,
                })
            })
            .collect();
        let body = json!({
            "model": self.model,
            "messages": omsgs,
            "stream": false,
        });
        let url = format!("{}/api/chat", self.base_url);
        let resp = self
            .http
            .post(url)
            .json(&body)
            .send()
            .await
            .map_err(|e| CoreError::Message(format!("ollama chat: {e}")))?;
        let status = resp.status();
        let text = resp
            .text()
            .await
            .map_err(|e| CoreError::Message(format!("ollama body: {e}")))?;
        if !status.is_success() {
            return Err(CoreError::Message(format!(
                "ollama HTTP {status}: {}",
                text.chars().take(200).collect::<String>()
            )));
        }
        let v: Value = serde_json::from_str(&text)?;
        let content = v
            .pointer("/message/content")
            .and_then(|c| c.as_str())
            .unwrap_or("")
            .to_string();
        Ok(ChatCompletion {
            content,
            tool_calls: vec![],
            finish_reason: "stop".into(),
        })
    }

    /// Health: tags reachable.
    pub async fn health(&self) -> bool {
        self.list_tags().await.is_ok()
    }
}

/// Parse JSON tool call fallback from model prose.
pub fn parse_json_tool_fallback(content: &str) -> Option<(String, Value)> {
    let content = content.trim();
    // Look for ```json ... ``` or raw object with "tool"
    let json_str = if let Some(start) = content.find("```json") {
        let rest = &content[start + 7..];
        let end = rest.find("```")?;
        rest[..end].trim()
    } else if content.starts_with('{') {
        content
    } else {
        return None;
    };
    let v: Value = serde_json::from_str(json_str).ok()?;
    let name = v
        .get("tool")
        .or_else(|| v.get("name"))?
        .as_str()?
        .to_string();
    let args = v
        .get("arguments")
        .or_else(|| v.get("parameters"))
        .cloned()
        .unwrap_or(json!({}));
    Some((name, args))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_fixture_with_tools() {
        let fixture = r#"{
          "choices": [{
            "finish_reason": "tool_calls",
            "message": {
              "role": "assistant",
              "content": null,
              "tool_calls": [{
                "id": "call_1",
                "type": "function",
                "function": {
                  "name": "search_kb",
                  "arguments": "{\"query\":\"auth\"}"
                }
              }]
            }
          }]
        }"#;
        let c = parse_openai_completion(fixture).unwrap();
        assert_eq!(c.tool_calls.len(), 1);
        assert_eq!(c.tool_calls[0].function.name, "search_kb");
    }

    #[test]
    fn parse_text_completion() {
        let fixture = r#"{
          "choices": [{
            "finish_reason": "stop",
            "message": { "role": "assistant", "content": "Hello **world**" }
          }]
        }"#;
        let c = parse_openai_completion(fixture).unwrap();
        assert!(c.content.contains("Hello"));
        assert!(c.tool_calls.is_empty());
    }

    #[test]
    fn json_tool_fallback() {
        let (n, a) = parse_json_tool_fallback(
            "```json\n{\"tool\":\"search_kb\",\"arguments\":{\"query\":\"x\"}}\n```",
        )
        .unwrap();
        assert_eq!(n, "search_kb");
        assert_eq!(a["query"], "x");
    }

    #[test]
    fn client_rejects_ssrf() {
        let err = OpenAiCompatibleClient::new(
            "http://169.254.169.254/",
            None,
            "m",
            &SsrfPolicy::default(),
        );
        assert!(err.is_err());
    }
}
