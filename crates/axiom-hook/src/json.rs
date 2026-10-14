//! Minimal JSON reader (RFC 8259) for `~/.axiom/daemon.json`, plus a string escaper for the
//! fail-closed deny documents. Depth-limited; anything malformed yields `None`.

#[derive(Debug, Clone, PartialEq)]
pub enum Json {
    Null,
    Bool(bool),
    Num(f64),
    Str(String),
    Arr(Vec<Json>),
    Obj(Vec<(String, Json)>),
}

impl Json {
    /// Last occurrence wins, like `JSON.parse`.
    pub fn get(&self, key: &str) -> Option<&Json> {
        match self {
            Json::Obj(fields) => fields.iter().rev().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }
}

const MAX_DEPTH: usize = 32;

pub fn parse(text: &str) -> Option<Json> {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let mut p = Parser {
        b: text.as_bytes(),
        i: 0,
    };
    p.ws();
    let v = p.value(0)?;
    p.ws();
    (p.i == p.b.len()).then_some(v)
}

struct Parser<'a> {
    b: &'a [u8],
    i: usize,
}

impl Parser<'_> {
    fn peek(&self) -> Option<u8> {
        self.b.get(self.i).copied()
    }

    fn ws(&mut self) {
        while matches!(self.peek(), Some(b' ' | b'\t' | b'\n' | b'\r')) {
            self.i += 1;
        }
    }

    fn lit(&mut self, word: &[u8], v: Json) -> Option<Json> {
        if self.b[self.i..].starts_with(word) {
            self.i += word.len();
            Some(v)
        } else {
            None
        }
    }

    fn value(&mut self, depth: usize) -> Option<Json> {
        if depth > MAX_DEPTH {
            return None;
        }
        match self.peek()? {
            b'n' => self.lit(b"null", Json::Null),
            b't' => self.lit(b"true", Json::Bool(true)),
            b'f' => self.lit(b"false", Json::Bool(false)),
            b'"' => self.string().map(Json::Str),
            b'[' => self.array(depth),
            b'{' => self.object(depth),
            b'-' | b'0'..=b'9' => self.number(),
            _ => None,
        }
    }

    fn number(&mut self) -> Option<Json> {
        let start = self.i;
        while matches!(
            self.peek(),
            Some(b'-' | b'+' | b'.' | b'e' | b'E' | b'0'..=b'9')
        ) {
            self.i += 1;
        }
        let s = std::str::from_utf8(&self.b[start..self.i]).ok()?;
        // Rust's float parser accepts forms JSON forbids ("1.", ".5", "+1"); reject those.
        let digits = s.strip_prefix('-').unwrap_or(s);
        if !digits.starts_with(|c: char| c.is_ascii_digit())
            || digits.ends_with('.')
            || digits.contains(".e")
            || digits.contains(".E")
            || (digits.len() > 1
                && digits.starts_with('0')
                && digits.as_bytes()[1].is_ascii_digit())
        {
            return None;
        }
        s.parse::<f64>()
            .ok()
            .filter(|f| f.is_finite())
            .map(Json::Num)
    }

    fn hex4(&mut self) -> Option<u32> {
        let s = std::str::from_utf8(self.b.get(self.i..self.i + 4)?).ok()?;
        let v = u32::from_str_radix(s, 16).ok()?;
        self.i += 4;
        Some(v)
    }

    fn string(&mut self) -> Option<String> {
        self.i += 1; // opening quote
        let mut out: Vec<u8> = Vec::new();
        loop {
            let c = self.peek()?;
            self.i += 1;
            match c {
                b'"' => return String::from_utf8(out).ok(),
                b'\\' => {
                    let e = self.peek()?;
                    self.i += 1;
                    let ch = match e {
                        b'"' => '"',
                        b'\\' => '\\',
                        b'/' => '/',
                        b'b' => '\u{8}',
                        b'f' => '\u{c}',
                        b'n' => '\n',
                        b'r' => '\r',
                        b't' => '\t',
                        b'u' => {
                            let hi = self.hex4()?;
                            let cp = if (0xD800..0xDC00).contains(&hi) {
                                if self.b.get(self.i..self.i + 2) != Some(b"\\u") {
                                    return None;
                                }
                                self.i += 2;
                                let lo = self.hex4()?;
                                if !(0xDC00..0xE000).contains(&lo) {
                                    return None;
                                }
                                0x10000 + ((hi - 0xD800) << 10) + (lo - 0xDC00)
                            } else {
                                hi
                            };
                            char::from_u32(cp)?
                        }
                        _ => return None,
                    };
                    let mut buf = [0u8; 4];
                    out.extend_from_slice(ch.encode_utf8(&mut buf).as_bytes());
                }
                0x00..=0x1f => return None,
                _ => out.push(c),
            }
        }
    }

    fn array(&mut self, depth: usize) -> Option<Json> {
        self.i += 1;
        let mut items = Vec::new();
        self.ws();
        if self.peek()? == b']' {
            self.i += 1;
            return Some(Json::Arr(items));
        }
        loop {
            self.ws();
            items.push(self.value(depth + 1)?);
            self.ws();
            match self.peek()? {
                b',' => self.i += 1,
                b']' => {
                    self.i += 1;
                    return Some(Json::Arr(items));
                }
                _ => return None,
            }
        }
    }

    fn object(&mut self, depth: usize) -> Option<Json> {
        self.i += 1;
        let mut fields = Vec::new();
        self.ws();
        if self.peek()? == b'}' {
            self.i += 1;
            return Some(Json::Obj(fields));
        }
        loop {
            self.ws();
            if self.peek()? != b'"' {
                return None;
            }
            let k = self.string()?;
            self.ws();
            if self.peek()? != b':' {
                return None;
            }
            self.i += 1;
            self.ws();
            let v = self.value(depth + 1)?;
            fields.push((k, v));
            self.ws();
            match self.peek()? {
                b',' => self.i += 1,
                b'}' => {
                    self.i += 1;
                    return Some(Json::Obj(fields));
                }
                _ => return None,
            }
        }
    }
}

/// `JSON.stringify(s)` for a string: quotes, backslash and control characters escaped.
pub fn quote(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_nested_documents() {
        // Surrogate-pair escape for U+1F600, built at runtime ("\\u" + "d83d" ...).
        let pair = format!("\\u{}\\u{}", "d83d", "de00");
        let doc =
            format!(r#" {{"a": [1, -2.5e3, true, null], "b": {{"c": "x\"y\u00e9{pair}"}}}} "#);
        let v = parse(&doc).expect("valid");
        assert_eq!(
            v.get("a"),
            Some(&Json::Arr(vec![
                Json::Num(1.0),
                Json::Num(-2500.0),
                Json::Bool(true),
                Json::Null
            ]))
        );
        assert_eq!(
            v.get("b").and_then(|b| b.get("c")),
            Some(&Json::Str("x\"y\u{e9}\u{1F600}".to_string()))
        );
    }

    #[test]
    fn rejects_malformed_documents() {
        for bad in [
            "",
            "{",
            "{\"a\":1,}",
            "[1 2]",
            "{\"a\" 1}",
            "\"unterminated",
            "01",
            "1.",
            ".5",
            "+1",
            "{\"a\":1} x",
            "\"tab\there\"",
            "nul",
        ] {
            assert_eq!(parse(bad), None, "{bad:?} must be rejected");
        }
        let lone_high = format!("\"\\u{}\"", "d83d");
        assert_eq!(parse(&lone_high), None, "lone surrogate must be rejected");
    }

    #[test]
    fn depth_is_limited() {
        let deep = "[".repeat(100) + &"]".repeat(100);
        assert_eq!(parse(&deep), None);
    }

    #[test]
    fn last_duplicate_key_wins() {
        let v = parse(r#"{"k":1,"k":2}"#).expect("valid");
        assert_eq!(v.get("k"), Some(&Json::Num(2.0)));
    }

    #[test]
    fn quote_escapes_like_json_stringify() {
        assert_eq!(quote("a\"b\\c\nd\u{1}é"), "\"a\\\"b\\\\c\\nd\\u0001é\"");
        let round = parse(&quote("x\t\u{1f}\"\\")).expect("round-trips");
        assert_eq!(round, Json::Str("x\t\u{1f}\"\\".to_string()));
    }
}
