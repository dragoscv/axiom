//! Percent-encoding matching `encodeURIComponent` (query args) and `encodeHeader`
//! (= `encodeURIComponent` with `/` kept) from packages/mcp/src/daemon-proto.ts.

fn unreserved(b: u8) -> bool {
    // encodeURIComponent leaves A-Z a-z 0-9 - _ . ! ~ * ' ( ) unescaped.
    b.is_ascii_alphanumeric()
        || matches!(
            b,
            b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')'
        )
}

fn encode(bytes: &[u8], keep_slash: bool) -> String {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    let mut out = String::with_capacity(bytes.len());
    for &b in bytes {
        if unreserved(b) || (keep_slash && b == b'/') {
            out.push(b as char);
        } else {
            out.push('%');
            out.push(HEX[(b >> 4) as usize] as char);
            out.push(HEX[(b & 15) as usize] as char);
        }
    }
    out
}

/// `encodeURIComponent` over UTF-8 bytes.
pub fn encode_component(s: &str) -> String {
    encode(s.as_bytes(), false)
}

/// `encodeHeader`: like `encode_component` but `/` stays literal. Non-UTF-8 OS strings are
/// encoded from their lossy UTF-8 form (Node would see the same replacement characters).
pub fn encode_header(s: &str) -> String {
    encode(s.as_bytes(), true)
}

/// `decodeHeader`: `decodeURIComponent`, or "" when the input is not valid percent-encoded UTF-8.
pub fn decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            let hex = |c: u8| (c as char).to_digit(16);
            match (
                b.get(i + 1).and_then(|&c| hex(c)),
                b.get(i + 2).and_then(|&c| hex(c)),
            ) {
                (Some(h), Some(l)) => {
                    out.push((h * 16 + l) as u8);
                    i += 3;
                }
                _ => return String::new(),
            }
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_like_encode_uri_component() {
        assert_eq!(encode_component("--format"), "--format");
        assert_eq!(encode_component("a b&c=d/e"), "a%20b%26c%3Dd%2Fe");
        assert_eq!(encode_component("!~*'()_.-"), "!~*'()_.-");
        assert_eq!(encode_component("é"), "%C3%A9");
        assert_eq!(encode_component("C:\\x"), "C%3A%5Cx");
        assert_eq!(encode_component("%"), "%25");
    }

    #[test]
    fn header_keeps_slash() {
        assert_eq!(encode_header("/home/u/my repo"), "/home/u/my%20repo");
        assert_eq!(encode_header("E:\\gh\\axiom"), "E%3A%5Cgh%5Caxiom");
    }

    #[test]
    fn decode_round_trips_and_rejects_garbage() {
        for s in [
            "",
            "plain",
            "a b\nc",
            "ünïcödé /x",
            "AXIOM GATE DENY ERR_X: y (a/b.ts)",
        ] {
            assert_eq!(decode(&encode_header(s)), s);
        }
        assert_eq!(decode("%E0%A4%A"), "");
        assert_eq!(decode("%zz"), "");
        assert_eq!(
            decode("%FF"),
            "",
            "invalid UTF-8 yields empty, like decodeURIComponent throwing"
        );
    }
}
