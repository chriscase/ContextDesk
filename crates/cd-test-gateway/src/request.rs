//! Wire-level capture of one accepted HTTP/1.1 request.

use tokio::io::AsyncReadExt;
use tokio::net::TcpStream;

/// Hard ceiling on buffered request-header bytes before a connection is
/// treated as malformed and dropped. Mirrors the defensive bound production
/// SSE parsing applies to response lines (`cd_core::sse`); nothing in this
/// harness should buffer an unbounded amount of attacker/test-controlled
/// input.
const MAX_HEADER_BYTES: usize = 1024 * 1024;

/// One fully-read request as the mock gateway's TCP listener observed it.
///
/// Field order preserves wire order (including duplicate header names) so
/// tests can assert exact framing, not just a normalized view.
#[derive(Debug, Clone, Default)]
pub struct RecordedRequest {
    pub method: String,
    pub path: String,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
    /// Monotonic acceptance order assigned by the gateway (0-based). Use this
    /// instead of wall-clock time to assert ordering.
    pub seq: usize,
}

impl RecordedRequest {
    /// Case-insensitive header lookup (first match; HTTP allows repeats, and
    /// production sends none of interest here more than once).
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }

    pub fn body_str(&self) -> std::borrow::Cow<'_, str> {
        String::from_utf8_lossy(&self.body)
    }

    /// `None` on any non-JSON or malformed body — callers decide whether
    /// that itself is the assertion.
    pub fn json_body(&self) -> Option<serde_json::Value> {
        serde_json::from_slice(&self.body).ok()
    }
}

/// Read one HTTP/1.1 request line + headers + (if `content-length` is
/// present) exactly that many body bytes.
///
/// Deliberately minimal: no chunked *request* bodies (nothing this lab
/// drives ever sends one — provider clients POST fixed JSON), no header
/// continuation lines (obsolete in HTTP/1.1). Returns `None` on a peer that
/// closes before a full head arrives, which callers treat as "no request to
/// record" (e.g. a client that gave up before sending anything).
pub async fn read_request(stream: &mut TcpStream) -> Option<RecordedRequest> {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 4096];
    let head_end = loop {
        let n = stream.read(&mut chunk).await.ok()?;
        if n == 0 {
            return None;
        }
        buf.extend_from_slice(&chunk[..n]);
        if let Some(pos) = find_subslice(&buf, b"\r\n\r\n") {
            break pos;
        }
        if buf.len() > MAX_HEADER_BYTES {
            return None;
        }
    };

    let head = String::from_utf8_lossy(&buf[..head_end]).into_owned();
    let mut lines = head.split("\r\n");
    let request_line = lines.next().unwrap_or_default();
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or_default().to_string();
    let path = parts.next().unwrap_or_default().to_string();

    let mut headers = Vec::new();
    let mut content_length = 0usize;
    for line in lines {
        if line.is_empty() {
            continue;
        }
        if let Some((k, v)) = line.split_once(':') {
            let k = k.trim().to_string();
            let v = v.trim().to_string();
            if k.eq_ignore_ascii_case("content-length") {
                content_length = v.trim().parse().unwrap_or(0);
            }
            headers.push((k, v));
        }
    }

    let body_start = head_end + 4;
    while buf.len() < body_start + content_length {
        let n = stream.read(&mut chunk).await.ok()?;
        if n == 0 {
            break;
        }
        buf.extend_from_slice(&chunk[..n]);
    }
    let body_end = buf.len().min(body_start + content_length);
    let body = buf[body_start..body_end].to_vec();

    Some(RecordedRequest {
        method,
        path,
        headers,
        body,
        seq: 0,
    })
}

fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}
