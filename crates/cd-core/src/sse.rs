//! Byte-safe, bounded accumulation for streaming HTTP bodies (SSE or any
//! newline-delimited wire format, and the "gateway ignored `stream=true`
//! and sent one ordinary JSON body" fallback).
//!
//! Extracted so [`crate::chat::OpenAiCompatibleClient::complete_stream_cb`]
//! and [`crate::chat::AnthropicClient::complete_stream_cb`] share ONE
//! buffering implementation instead of several independent copies that must
//! be kept in sync by hand — the same "one maintained implementation"
//! reason `cd_workflow` exists for the CLI/desktop split.
//!
//! Three correctness properties an ad hoc `String`-based buffer gets wrong
//! under real network conditions:
//!
//! 1. **UTF-8 safety across chunk boundaries.** A naive loop that calls
//!    `String::from_utf8_lossy` on each `bytes_stream()` item *before*
//!    accumulating it corrupts any multi-byte UTF-8 character whose bytes
//!    happen to land in two different network reads — a routine occurrence,
//!    not a pathological edge case, for any non-ASCII model output. Both
//!    [`SseLineDecoder`] and [`BoundedBodyAccumulator`] buffer raw bytes and
//!    only decode once, on a complete unit (a full line, or the whole
//!    body), never per chunk.
//! 2. **Bounded memory.** A provider that never sends a newline (a stalled
//!    or malicious gateway, or simply an oversized single SSE line or
//!    non-streamed body) must fail closed with a clear error rather than
//!    growing the buffer without limit for as long as the connection stays
//!    open. The bound applies to every individual line as it is produced —
//!    not only to bytes still waiting for a terminator — so one oversized
//!    line delivered complete (even in a single `push` call) is caught too,
//!    and a candidate line is checked before it is copied out of the
//!    pending buffer, so no allocation happens for a line that is about to
//!    be rejected.
//! 3. **No silent substitution.** A complete line (or body) that is not
//!    valid UTF-8 fails closed rather than lossily inserting replacement
//!    characters — that would mask a genuinely malformed or corrupted
//!    response as if it had decoded correctly. (Once bytes are known to
//!    form a complete unit — delimited by `\n`, or the whole final body — a
//!    strict decode failure means the bytes themselves are invalid, not
//!    that a valid character was merely split across chunks; that case is
//!    already handled by property 1.)

use crate::error::{CoreError, CoreResult};

/// Generous but finite — real SSE lines and non-streamed completion bodies
/// stay well under this; a legitimate provider never needs more.
pub const DEFAULT_MAX_BUFFERED_LINE_BYTES: usize = 4 * 1024 * 1024;

fn decode_strict(bytes: Vec<u8>, what: &str) -> CoreResult<String> {
    String::from_utf8(bytes).map_err(|error| {
        CoreError::Message(format!(
            "{what} was not valid UTF-8 ({error}) — refusing to silently substitute replacement characters"
        ))
    })
}

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
    /// Fails closed on two conditions, checked per line so a single
    /// over-bound line can never slip through by arriving complete (with
    /// its own terminator) in one call:
    /// - a line's content exceeds the bound, however it was delivered;
    /// - bytes with no `\n` in them yet exceed the bound.
    pub fn push(&mut self, bytes: &[u8]) -> CoreResult<Vec<String>> {
        self.pending.extend_from_slice(bytes);
        let mut lines = Vec::new();
        while let Some(pos) = self.pending.iter().position(|&b| b == b'\n') {
            if pos > self.max_buffered_line_bytes {
                return Err(CoreError::Message(format!(
                    "SSE line exceeded {} bytes — refusing to buffer further \
                     (malformed or oversized provider response)",
                    self.max_buffered_line_bytes
                )));
            }
            // `\n` (0x0A) can only ever appear as a standalone ASCII byte in
            // valid UTF-8 — every continuation byte of a multi-byte sequence
            // is >= 0x80 — so slicing here never lands inside a character.
            // The bound check above runs BEFORE this copy, so a line already
            // known to be rejected is never copied out just to be discarded.
            let mut line: Vec<u8> = self.pending.drain(..=pos).collect();
            line.pop(); // drop '\n'
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            lines.push(decode_strict(line, "SSE line")?);
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
    /// newline after its last event) — `None` if nothing is pending. Fails
    /// closed if that trailing data is not valid UTF-8 (a connection that
    /// dropped mid-character never completes it, so this is a genuine
    /// truncation, not a chunk-boundary artifact).
    pub fn finish(self) -> CoreResult<Option<String>> {
        if self.pending.is_empty() {
            Ok(None)
        } else {
            decode_strict(self.pending, "trailing SSE data").map(Some)
        }
    }
}

impl Default for SseLineDecoder {
    fn default() -> Self {
        Self::new()
    }
}

/// Buffers raw bytes across arbitrary network chunk boundaries for a body
/// that is decoded as ONE unit at the end, never per chunk — the shape
/// [`crate::chat::OpenAiCompatibleClient::complete_stream_cb`] needs for its
/// "gateway ignored `stream=true`" fallback: until the stream ends, there is
/// no line-oriented structure to exploit the way [`SseLineDecoder`] does, so
/// the bound instead applies to the running total.
pub struct BoundedBodyAccumulator {
    bytes: Vec<u8>,
    max_bytes: usize,
}

impl BoundedBodyAccumulator {
    /// New accumulator bounded at [`DEFAULT_MAX_BUFFERED_LINE_BYTES`].
    pub fn new() -> Self {
        Self::with_max_bytes(DEFAULT_MAX_BUFFERED_LINE_BYTES)
    }

    /// New accumulator with an explicit bound (tests use a small one).
    pub fn with_max_bytes(max_bytes: usize) -> Self {
        Self {
            bytes: Vec::new(),
            max_bytes,
        }
    }

    /// Feed one raw chunk. Fails closed, before copying the chunk in, once
    /// the running total would exceed the bound.
    pub fn push(&mut self, bytes: &[u8]) -> CoreResult<()> {
        if self.bytes.len() + bytes.len() > self.max_bytes {
            return Err(CoreError::Message(format!(
                "non-streamed response body exceeded {} bytes — refusing to buffer further \
                 (malformed or oversized provider response)",
                self.max_bytes
            )));
        }
        self.bytes.extend_from_slice(bytes);
        Ok(())
    }

    /// Consume the accumulator at stream end, decoding the whole body
    /// exactly once. Fails closed if the bytes are not valid UTF-8.
    pub fn finish(self) -> CoreResult<String> {
        decode_strict(self.bytes, "non-streamed response body")
    }
}

impl Default for BoundedBodyAccumulator {
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

    /// The bug an adversarial review caught in the first cut of this
    /// decoder: the bound was only ever checked on `pending` AFTER the
    /// drain loop, so a line that arrived complete — WITH its own
    /// terminator — in a single `push` call sailed through with no size
    /// check at all, because by the time the trailing check ran, the
    /// oversized line had already been drained out of `pending`.
    #[test]
    fn a_single_oversized_line_delivered_complete_with_its_terminator_fails_closed() {
        let mut decoder = SseLineDecoder::with_max_buffered_line_bytes(1024);
        let mut chunk = vec![b'x'; 2048];
        chunk.push(b'\n');
        let error = decoder.push(&chunk).unwrap_err();
        assert!(error.to_string().contains("exceeded"), "{error}");
    }

    /// The same bug, but with a legitimate short line ahead of the
    /// over-bound one in the SAME push call — every individual line must be
    /// checked, not just the first or the trailing remainder.
    #[test]
    fn an_oversized_line_after_a_valid_one_in_the_same_push_still_fails_closed() {
        let mut decoder = SseLineDecoder::with_max_buffered_line_bytes(1024);
        let mut chunk = b"short line\n".to_vec();
        chunk.extend(vec![b'x'; 2048]);
        chunk.push(b'\n');
        let error = decoder.push(&chunk).unwrap_err();
        assert!(error.to_string().contains("exceeded"), "{error}");
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
            decoder.finish().unwrap(),
            Some("data: no newline at close".to_string())
        );
    }

    #[test]
    fn finish_on_a_fully_drained_decoder_returns_none() {
        let mut decoder = SseLineDecoder::new();
        decoder.push(b"data: x\n").unwrap();
        assert_eq!(decoder.finish().unwrap(), None);
    }

    /// A complete line (delimited by its own `\n`, so this is genuinely
    /// invalid content, never a chunk-boundary artifact) that is not valid
    /// UTF-8 must fail closed, not silently become replacement characters.
    #[test]
    fn invalid_utf8_in_a_complete_line_fails_closed() {
        let mut decoder = SseLineDecoder::new();
        let mut chunk = b"data: ".to_vec();
        chunk.extend_from_slice(&[0xFF, 0xFE]); // never valid UTF-8, in any position
        chunk.push(b'\n');
        let error = decoder.push(&chunk).unwrap_err();
        assert!(error.to_string().contains("not valid UTF-8"), "{error}");
    }

    /// The trailing (unterminated) case of the same guarantee: a connection
    /// that closes mid multi-byte character never completes it, so `finish`
    /// must fail closed rather than lossily decode the fragment.
    #[test]
    fn invalid_trailing_utf8_at_finish_fails_closed() {
        let mut decoder = SseLineDecoder::new();
        decoder.push(b"data: complete\n").unwrap();
        // The lead byte of a 4-byte sequence with no continuation bytes ever
        // arriving — a stream that just stops here, not a valid character.
        decoder.push(&[0xF0, 0x9F]).unwrap();
        let error = decoder.finish().unwrap_err();
        assert!(error.to_string().contains("not valid UTF-8"), "{error}");
    }

    #[test]
    fn bounded_body_accumulator_decodes_once_regardless_of_chunk_boundaries() {
        // Same adversarial multi-byte split as the line decoder test above,
        // but through the non-line-oriented accumulator used for the
        // "gateway ignored stream=true" whole-body fallback.
        let body = "{\"choices\":[{\"message\":{\"content\":\"café 🎉 done\"}}]}";
        let bytes = body.as_bytes();
        let e_start = body.find('é').unwrap();
        let emoji_start = body.find('🎉').unwrap();
        let mut acc = BoundedBodyAccumulator::new();
        for chunk in [
            &bytes[..e_start + 1],
            &bytes[e_start + 1..emoji_start + 2],
            &bytes[emoji_start + 2..],
        ] {
            acc.push(chunk).unwrap();
        }
        assert_eq!(acc.finish().unwrap(), body);
    }

    #[test]
    fn bounded_body_accumulator_fails_closed_once_the_running_total_exceeds_the_bound() {
        let mut acc = BoundedBodyAccumulator::with_max_bytes(1024);
        acc.push(&vec![b'x'; 512]).unwrap();
        let error = acc.push(&vec![b'x'; 1024]).unwrap_err();
        assert!(error.to_string().contains("exceeded"), "{error}");
    }

    #[test]
    fn bounded_body_accumulator_fails_closed_on_invalid_utf8() {
        let mut acc = BoundedBodyAccumulator::new();
        acc.push(&[0xFF, 0xFE]).unwrap();
        let error = acc.finish().unwrap_err();
        assert!(error.to_string().contains("not valid UTF-8"), "{error}");
    }
}
