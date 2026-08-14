//! The scripting DSL: what the gateway does for one accepted connection.

use std::time::Duration;

/// One wire-timed fragment of a streamed body.
#[derive(Debug, Clone)]
pub struct Frame {
    pub data: Vec<u8>,
    /// Delay applied before this frame is written, measured from when the
    /// previous frame (or the headers, for the first frame) finished
    /// sending. Under `#[tokio::test(start_paused = true)]` this advances
    /// virtual time instantly and deterministically; under a live clock it
    /// is a real (but test-author-chosen, ideally millisecond-scale) delay.
    pub delay: Duration,
}

impl Frame {
    pub fn new(data: impl Into<Vec<u8>>) -> Self {
        Self {
            data: data.into(),
            delay: Duration::ZERO,
        }
    }

    pub fn delayed(data: impl Into<Vec<u8>>, delay: Duration) -> Self {
        Self {
            data: data.into(),
            delay,
        }
    }
}

/// How the response body is framed and delivered on the wire.
#[derive(Debug, Clone)]
pub enum Body {
    /// `Content-Length: 0`, no body bytes.
    Empty,
    /// `Content-Length`-framed body sent as a single write after `delay`.
    Fixed { data: Vec<u8>, delay: Duration },
    /// `Content-Length` is the sum of all frame lengths, but the bytes are
    /// delivered as several separate writes (each optionally delayed) —
    /// "fragmented JSON": a well-formed body arriving in more than one TCP
    /// read on the client side.
    FixedFragments(Vec<Frame>),
    /// A `Content-Length` is declared, but fewer bytes than that are ever
    /// written before the connection drops — "connection close mid-body"
    /// for length-framed responses.
    FixedThenDrop {
        declared_len: usize,
        sent: Vec<u8>,
        reset: bool,
    },
    /// Proper HTTP chunked transfer-encoding; each `Frame` is one wire
    /// chunk (size-prefixed), terminated correctly with a final `0` chunk.
    Chunked(Vec<Frame>),
    /// Chunked transfer-encoding that never sends the terminating
    /// `0\r\n\r\n` — "connection close mid-body" for chunked responses.
    ChunkedThenDrop { frames: Vec<Frame>, reset: bool },
    /// No `Content-Length`, no chunked encoding: raw bytes streamed and the
    /// connection closed cleanly to mark end-of-body — the common shape of
    /// real provider SSE. Omitting a terminal marker (e.g. `[DONE]`) from
    /// `frames` models "premature connection close" during a stream.
    Stream(Vec<Frame>),
    /// Headers are sent; the body never arrives and the connection is never
    /// closed — "infinite/stalled body", released only by client-side
    /// cancellation or deadline.
    NeverEnds,
}

/// A scripted HTTP response: status line, headers, and body framing.
#[derive(Debug, Clone)]
pub struct Response {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    /// Delay after the request is fully read, before the status line and
    /// headers are written — "delayed headers".
    pub header_delay: Duration,
    pub body: Body,
}

impl Response {
    pub fn new(status: u16, body: Body) -> Self {
        Self {
            status,
            headers: Vec::new(),
            header_delay: Duration::ZERO,
            body,
        }
    }

    pub fn status_only(status: u16) -> Self {
        Self::new(status, Body::Empty)
    }

    pub fn json(status: u16, value: &serde_json::Value) -> Self {
        Self::text(
            status,
            "application/json",
            serde_json::to_vec(value).expect("serializable json fixture"),
        )
    }

    pub fn text(status: u16, content_type: &str, body: impl Into<Vec<u8>>) -> Self {
        Self::new(
            status,
            Body::Fixed {
                data: body.into(),
                delay: Duration::ZERO,
            },
        )
        .with_header("content-type", content_type)
    }

    pub fn sse_ok(body: impl Into<Vec<u8>>) -> Self {
        Self::text(200, "text/event-stream", body)
    }

    pub fn json_ok(value: &serde_json::Value) -> Self {
        Self::json(200, value)
    }

    pub fn with_header(mut self, name: impl Into<String>, value: impl Into<String>) -> Self {
        self.headers.push((name.into(), value.into()));
        self
    }

    pub fn with_header_delay(mut self, delay: Duration) -> Self {
        self.header_delay = delay;
        self
    }

    pub fn with_body(mut self, body: Body) -> Self {
        self.body = body;
        self
    }
}

/// What the gateway does for one accepted TCP connection, from the moment
/// the request has been fully read.
#[derive(Debug, Clone)]
pub enum Step {
    Respond(Response),
    /// Read the request, then abort before writing any response bytes.
    /// `reset = true` uses `SO_LINGER(0)` (a genuine TCP RST); `reset =
    /// false` is a graceful FIN, which a client may or may not distinguish
    /// from RST, but neither delivers a response.
    CloseBeforeHeaders {
        reset: bool,
    },
    /// Read the request, then hold the socket open forever: no bytes, no
    /// close. Pair with a client-side deadline or cancellation in the test.
    Stall,
}

impl Step {
    pub fn respond(response: Response) -> Self {
        Step::Respond(response)
    }
}

/// Split `data` into frames at the given byte offsets (each offset is where
/// the *next* frame starts), with no delay. Panics if offsets are not
/// strictly increasing and `<= data.len()` — a fixture bug, not a runtime
/// condition.
pub fn split_at(data: &[u8], offsets: &[usize]) -> Vec<Frame> {
    let mut frames = Vec::new();
    let mut start = 0usize;
    for &at in offsets {
        assert!(
            at >= start && at <= data.len(),
            "split offset {at} out of range (start={start}, len={})",
            data.len()
        );
        frames.push(Frame::new(data[start..at].to_vec()));
        start = at;
    }
    frames.push(Frame::new(data[start..].to_vec()));
    frames
}

/// Split `data` into `n` roughly-equal frames (last frame absorbs any
/// remainder). `n == 0` or `data.is_empty()` yields a single empty frame.
pub fn split_evenly(data: &[u8], n: usize) -> Vec<Frame> {
    if n == 0 || data.is_empty() {
        return vec![Frame::new(data.to_vec())];
    }
    let chunk_len = data.len().div_ceil(n);
    let offsets: Vec<usize> = (1..n).map(|i| (i * chunk_len).min(data.len())).collect();
    split_at(data, &offsets)
}
