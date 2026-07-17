//! UTF-8 boundary-safe string truncation.
//!
//! Never use raw `&s[..n]` / `&s[n..]` with a computed byte index on untrusted
//! or multi-byte text — use these helpers instead.

/// Floor `idx` to the nearest UTF-8 char boundary ≤ idx (clamped to `s.len()`).
/// Never panics.
pub fn floor_char_boundary(s: &str, idx: usize) -> usize {
    let mut end = idx.min(s.len());
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    end
}

/// Longest prefix of `s` that is ≤ `max_bytes` bytes and ends on a char boundary.
///
/// Returns a subslice of `s` (empty when `max_bytes == 0`).
#[allow(clippy::string_slice)] // safe: index from floor_char_boundary
pub fn truncate_bytes(s: &str, max_bytes: usize) -> &str {
    &s[..floor_char_boundary(s, max_bytes)]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ascii_passthrough() {
        assert_eq!(truncate_bytes("hello world", 5), "hello");
        assert_eq!(truncate_bytes("hello", 100), "hello");
        assert_eq!(truncate_bytes("hello", 0), "");
    }

    #[test]
    fn mid_multibyte_returns_shorter_valid_prefix() {
        // "é" is 2 bytes (UTF-8 C3 A9)
        let s = "abécd";
        assert_eq!(truncate_bytes(s, 3), "ab"); // would panic mid-é
        assert_eq!(truncate_bytes(s, 4), "abé");
        // CJK 世 is 3 bytes
        let s2 = "x世y";
        assert_eq!(truncate_bytes(s2, 2), "x");
        assert_eq!(truncate_bytes(s2, 4), "x世");
        // emoji 🌍 is 4 bytes
        let s3 = "a🌍b";
        assert_eq!(truncate_bytes(s3, 2), "a");
        assert_eq!(truncate_bytes(s3, 5), "a🌍");
        assert!(std::str::from_utf8(truncate_bytes(s3, 3).as_bytes()).is_ok());
    }

    #[test]
    fn floor_clamps_and_walks_down() {
        let s = "🌍";
        assert_eq!(floor_char_boundary(s, 0), 0);
        assert_eq!(floor_char_boundary(s, 1), 0);
        assert_eq!(floor_char_boundary(s, 2), 0);
        assert_eq!(floor_char_boundary(s, 3), 0);
        assert_eq!(floor_char_boundary(s, 4), 4);
        assert_eq!(floor_char_boundary(s, 99), 4);
    }
}
