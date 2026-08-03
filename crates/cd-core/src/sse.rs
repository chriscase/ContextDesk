//! A byte-safe, bounded line decoder for streaming HTTP bodies (SSE or any
//! newline-delimited wire format).
//!
//! Extracted so [`crate::chat::OpenAiCompatibleClient::complete_stream_cb`]
//! and [`crate::chat::AnthropicClient::complete_stream_cb`] share ONE
//! buffering implementation instead of two independent copies that must be
//! kept in sync by hand — the same "one maintained implementation" reason
//! `cd_workflow` exists for the CLI/desktop split.
//!
//! Two correctness properties an ad hoc `String`-based line buffer gets
//! wrong under real network conditions:
//!
//! 1. **UTF-8 safety across chunk boundaries.** A naive loop that calls
//!    `String::from_utf8_lossy` on each `bytes_stream()` item *before*
//!    accumulating it corrupts any multi-byte UTF-8 character whose bytes
//!    happen to land in two different network reads — a routine occurrence,
//!    not a pathological edge case, for any non-ASCII model output. This
//!    decoder buffers raw bytes and only decodes once it has isolated a
//!    complete line (a `\n` byte can never appear inside a multi-byte UTF-8
//!    sequence, so splitting on it first is always safe).
//! 2. **Bounded memory.** A provider that never sends a newline (a stalled
//!    or malicious gateway, or simply an oversized single SSE line) must
//!    fail closed with a clear error rather than growing the buffer without
//!    limit for as long as the connection stays open.

use crate::error::{CoreError, CoreResult};

/// Generous but finite — real SSE lines carry one JSON delta and stay well
/// under this; a legitimate provider never needs more.
pub const DEFAULT_MAX_BUFFERED_LINE_BYTES: usize = 4 * 1024 * 1024;

/// Buffers raw bytes across arbitrary network chunk boundaries and yields
/// complete, decoded lines (CRLF or LF terminated, terminator stripped).
pub struct SseLineDecoder {
    pending: Vec<u8>,
    max_buffered_line_bytes: usize,
}

impl SseLineDecoder {
    /// New decoder bounded at [`DEFAULT_MAX_BUFFERED_LINE_BYTES`].
    pub fn new() -> Self {
        Self::with_max_buffered_line_bytes(DEFAULT_MAX_BUFFERED_LINE_BYTES)
    }

    /// New decoder with an explicit bound (tests use a small one so an
    /// over-bound case runs in microseconds, not by allocating megabytes).
    pub fn with_max_buffered_line_bytes(max_buffered_line_bytes: usize) -> Self {
        Self {
            pending: Vec::new(),
            max_buffered_line_bytes,
        }
    }

    /// Feed one raw chunk exactly as received from the transport (never
    /// pre-decoded). Returns every complete line the chunk completed, in
    /// order; a chunk that completes no line returns an empty vec.
    ///
    /// Fails closed — rather than growing forever — once bytes with no `\n`
    /// yet in them exceed the configured bound.
    pub fn push(&mut self, bytes: &[u8]) -> CoreResult<Vec<String>> {
        self.pending.extend_from_slice(bytes);
        let mut lines = Vec::new();
        while let Some(pos) = self.pending.iter().position(|&b| b == b'\n') {
            // `\n` (0x0A) can only ever appear as a standalone ASCII byte in
            // valid UTF-8 — every continuation byte of a multi-byte sequence
            // is >= 0x80 — so slicing here never lands inside a character.
            let mut line: Vec<u8> = self.pending.drain(..=pos).collect();
            line.pop(); // drop '\n'
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            lines.push(String::from_utf8_lossy(&line).into_owned());
        }
        if self.pending.len() > self.max_buffered_line_bytes {
            return Err(CoreError::Message(format!(
                "SSE line exceeded {} bytes with no terminator — refusing to buffer further \
                 (malformed or oversized provider response)",
                self.max_buffered_line_bytes
            )));
        }
        Ok(lines)
    }

    /// Consume the decoder at stream end, returning any final unterminated
    /// line (a provider that closes the connection without a trailing
    /// newline after its last event) — `None` if nothing is pending.
    pub fn finish(self) -> Option<String> {
        if self.pending.is_empty() {
            None
        } else {
            Some(String::from_utf8_lossy(&self.pending).into_owned())
        }
    }
}

impl Default for SseLineDecoder {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_multi_byte_utf8_character_split_across_chunks_decodes_intact() {
        // "café 🎉" — 'é' (U+00E9, 2 bytes) and the emoji (U+1F389, 4 bytes)
        // give us both a 2-byte and a 4-byte sequence to split mid-character.
        let line = "café 🎉 done\n";
        let bytes = line.as_bytes();
        // Split so the 2-byte 'é' straddles chunk 1/2, and the 4-byte emoji
        // straddles chunk 2/3 — exactly the adversarial case a naive
        // per-chunk `from_utf8_lossy` corrupts.
        let e_start = line.find('é').unwrap();
        let emoji_start = line.find('🎉').unwrap();
        let mut decoder = SseLineDecoder::new();
        let mut lines = Vec::new();
        for chunk in [
            &bytes[..e_start + 1],
            &bytes[e_start + 1..emoji_start + 2],
            &bytes[emoji_start + 2..],
        ] {
            lines.extend(decoder.push(chunk).unwrap());
        }
        assert_eq!(lines, vec!["café 🎉 done".to_string()]);
    }

    #[test]
    fn splitting_every_single_byte_never_corrupts_multi_byte_content() {
        let line = "日本語 test 🚀\n";
        let mut decoder = SseLineDecoder::new();
        let mut lines = Vec::new();
        for byte in line.as_bytes() {
            lines.extend(decoder.push(std::slice::from_ref(byte)).unwrap());
        }
        assert_eq!(lines, vec!["日本語 test 🚀".to_string()]);
    }

    #[test]
    fn crlf_and_lf_both_terminate_and_strip_cleanly() {
        let mut decoder = SseLineDecoder::new();
        let lines = decoder.push(b"data: one\r\ndata: two\n").unwrap();
        assert_eq!(
            lines,
            vec!["data: one".to_string(), "data: two".to_string()]
        );
    }

    #[test]
    fn blank_lines_and_comment_lines_round_trip_as_empty_and_colon_prefixed() {
        let mut decoder = SseLineDecoder::new();
        let lines = decoder.push(b"\n: keep-alive\n\ndata: x\n").unwrap();
        assert_eq!(
            lines,
            vec![
                "".to_string(),
                ": keep-alive".to_string(),
                "".to_string(),
                "data: x".to_string(),
            ]
        );
    }

    #[test]
    fn a_line_that_never_terminates_fails_closed_before_unbounded_growth() {
        let mut decoder = SseLineDecoder::with_max_buffered_line_bytes(1024);
        // Well past the bound, still no '\n'.
        let chunk = vec![b'x'; 2048];
        let error = decoder.push(&chunk).unwrap_err();
        assert!(error.to_string().contains("exceeded"));
    }

    #[test]
    fn staying_under_the_bound_across_many_small_chunks_never_errors() {
        let mut decoder = SseLineDecoder::with_max_buffered_line_bytes(1024);
        for _ in 0..100 {
            decoder.push(b"abcde").unwrap();
        }
        // Still under bound and still no newline — must not have errored yet.
        let lines = decoder.push(b"\n").unwrap();
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0].len(), 500);
    }

    #[test]
    fn finish_returns_a_trailing_unterminated_line() {
        let mut decoder = SseLineDecoder::new();
        assert!(decoder.push(b"data: complete\n").unwrap().len() == 1);
        decoder.push(b"data: no newline at close").unwrap();
        assert_eq!(
            decoder.finish(),
            Some("data: no newline at close".to_string())
        );
    }

    #[test]
    fn finish_on_a_fully_drained_decoder_returns_none() {
        let mut decoder = SseLineDecoder::new();
        decoder.push(b"data: x\n").unwrap();
        assert_eq!(decoder.finish(), None);
    }
}
