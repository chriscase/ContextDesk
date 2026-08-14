//! Error types for `cd-core`.

use thiserror::Error;

/// Result alias for core operations.
pub type CoreResult<T> = Result<T, CoreError>;

/// Errors returned by core APIs.
#[derive(Debug, Error)]
pub enum CoreError {
    /// Cooperative cancellation requested by the caller.
    #[error("ingest cancelled")]
    Cancelled,

    /// Invalid configuration or branding.
    #[error("config: {0}")]
    Config(String),

    /// Operation denied by policy (permissions, allowlists).
    #[error("policy denied: {0}")]
    Policy(String),

    /// I/O failure.
    #[error("io: {0}")]
    Io(#[from] std::io::Error),

    /// Serialization failure.
    #[error("serde: {0}")]
    Serde(#[from] serde_json::Error),

    /// A provider answered a chat/stream request with a non-success HTTP
    /// status.
    ///
    /// Carrying the status structurally lets every caller classify the
    /// failure — rate limit, authorization, server — from the status the
    /// provider actually returned instead of scraping provider-specific
    /// prose, and lets a capability wrapper tell "this gateway refused
    /// streaming" apart from "this request was rate limited on the streaming
    /// endpoint". `Display` reproduces exactly the operation-prefixed form
    /// the provider clients have always produced, so existing message
    /// contracts are unchanged.
    #[error("{operation} HTTP {status_line}: {body}")]
    ProviderHttp {
        /// Provider-neutral operation label the client used (`chat`,
        /// `stream request`, `ollama`, `anthropic stream`, …).
        operation: String,
        /// Numeric HTTP status — the classification input.
        status: u16,
        /// Full status line as the provider returned it (`429 Too Many Requests`).
        status_line: String,
        /// Bounded provider response body, exactly as the client captured it.
        body: String,
    },

    /// Generic failure with context (host may log details).
    #[error("{0}")]
    Message(String),
}

impl CoreError {
    /// HTTP status a provider returned, when this failure came from the
    /// provider's response rather than from ContextDesk or the transport.
    ///
    /// `None` means "not a provider HTTP status failure" — a connect/read
    /// error, a policy denial, or an internal fault. Callers must not treat
    /// `None` as "healthy".
    pub fn provider_http_status(&self) -> Option<u16> {
        match self {
            CoreError::ProviderHttp { status, .. } => Some(*status),
            _ => None,
        }
    }

    /// The provider's own response body for a [`CoreError::ProviderHttp`].
    ///
    /// Deliberately excludes ContextDesk's operation prefix: classification
    /// heuristics must read what the provider said, never our own framing.
    pub fn provider_http_body(&self) -> Option<&str> {
        match self {
            CoreError::ProviderHttp { body, .. } => Some(body.as_str()),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_http_display_matches_the_historical_client_format() {
        let error = CoreError::ProviderHttp {
            operation: "stream".into(),
            status: 429,
            status_line: "429 Too Many Requests".into(),
            body: r#"{"error":{"message":"provider rate limited"}}"#.into(),
        };
        assert_eq!(
            error.to_string(),
            r#"stream HTTP 429 Too Many Requests: {"error":{"message":"provider rate limited"}}"#
        );
        assert_eq!(error.provider_http_status(), Some(429));
        assert_eq!(
            error.provider_http_body(),
            Some(r#"{"error":{"message":"provider rate limited"}}"#)
        );
    }

    #[test]
    fn non_provider_errors_report_no_provider_status_or_body() {
        for error in [
            CoreError::Message("stream chunk: connection reset".into()),
            CoreError::Policy("denied".into()),
            CoreError::Cancelled,
        ] {
            assert_eq!(error.provider_http_status(), None);
            assert_eq!(error.provider_http_body(), None);
        }
    }
}
