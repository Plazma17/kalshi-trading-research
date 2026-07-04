// Minimal JSON parse/serialize (no external deps). Used ONLY for the small query object
// (from Electron) and for building the compact result object. The hot archive path uses the
// hand-written byte scanner in main.rs, NOT this.
use std::collections::BTreeMap;

#[derive(Debug, Clone)]
pub enum Val {
    Null,
    Bool(bool),
    Num(f64),
    Str(String),
    Arr(Vec<Val>),
    Obj(BTreeMap<String, Val>),
}

impl Val {
    pub fn get(&self, k: &str) -> Option<&Val> {
        match self {
            Val::Obj(m) => m.get(k),
            _ => None,
        }
    }
    pub fn as_f64(&self) -> Option<f64> {
        match self {
            Val::Num(n) => Some(*n),
            Val::Str(s) => s.parse::<f64>().ok(),
            Val::Bool(b) => Some(if *b { 1.0 } else { 0.0 }),
            _ => None,
        }
    }
    pub fn as_str(&self) -> Option<&str> {
        match self {
            Val::Str(s) => Some(s.as_str()),
            _ => None,
        }
    }
    pub fn f(&self, k: &str) -> Option<f64> {
        self.get(k).and_then(|v| v.as_f64())
    }
    pub fn s(&self, k: &str) -> Option<&str> {
        self.get(k).and_then(|v| v.as_str())
    }
}

pub fn parse(s: &str) -> Result<Val, String> {
    let b = s.as_bytes();
    let mut i = 0usize;
    let v = parse_val(b, &mut i)?;
    Ok(v)
}

fn skip_ws(b: &[u8], i: &mut usize) {
    while *i < b.len() && matches!(b[*i], b' ' | b'\t' | b'\n' | b'\r') {
        *i += 1;
    }
}

fn parse_val(b: &[u8], i: &mut usize) -> Result<Val, String> {
    skip_ws(b, i);
    if *i >= b.len() {
        return Err("eof".into());
    }
    match b[*i] {
        b'{' => parse_obj(b, i),
        b'[' => parse_arr(b, i),
        b'"' => Ok(Val::Str(parse_str(b, i)?)),
        b't' => {
            *i += 4;
            Ok(Val::Bool(true))
        }
        b'f' => {
            *i += 5;
            Ok(Val::Bool(false))
        }
        b'n' => {
            *i += 4;
            Ok(Val::Null)
        }
        _ => parse_num(b, i),
    }
}

fn parse_str(b: &[u8], i: &mut usize) -> Result<String, String> {
    *i += 1; // opening quote
    let mut out = String::new();
    while *i < b.len() {
        let c = b[*i];
        if c == b'"' {
            *i += 1;
            return Ok(out);
        }
        if c == b'\\' {
            *i += 1;
            if *i >= b.len() {
                break;
            }
            match b[*i] {
                b'n' => out.push('\n'),
                b't' => out.push('\t'),
                b'r' => out.push('\r'),
                b'"' => out.push('"'),
                b'\\' => out.push('\\'),
                b'/' => out.push('/'),
                b'u' => {
                    // basic \uXXXX
                    if *i + 4 < b.len() {
                        let hex = std::str::from_utf8(&b[*i + 1..*i + 5]).unwrap_or("0000");
                        if let Ok(cp) = u32::from_str_radix(hex, 16) {
                            if let Some(ch) = char::from_u32(cp) {
                                out.push(ch);
                            }
                        }
                        *i += 4;
                    }
                }
                other => out.push(other as char),
            }
            *i += 1;
        } else {
            out.push(c as char);
            *i += 1;
        }
    }
    Err("unterminated string".into())
}

fn parse_num(b: &[u8], i: &mut usize) -> Result<Val, String> {
    let start = *i;
    while *i < b.len()
        && matches!(b[*i], b'0'..=b'9' | b'-' | b'+' | b'.' | b'e' | b'E')
    {
        *i += 1;
    }
    let s = std::str::from_utf8(&b[start..*i]).map_err(|_| "utf8")?;
    s.parse::<f64>().map(Val::Num).map_err(|_| format!("bad num: {}", s))
}

fn parse_arr(b: &[u8], i: &mut usize) -> Result<Val, String> {
    *i += 1;
    let mut arr = Vec::new();
    loop {
        skip_ws(b, i);
        if *i >= b.len() {
            return Err("eof in arr".into());
        }
        if b[*i] == b']' {
            *i += 1;
            break;
        }
        arr.push(parse_val(b, i)?);
        skip_ws(b, i);
        if *i < b.len() && b[*i] == b',' {
            *i += 1;
        }
    }
    Ok(Val::Arr(arr))
}

fn parse_obj(b: &[u8], i: &mut usize) -> Result<Val, String> {
    *i += 1;
    let mut m = BTreeMap::new();
    loop {
        skip_ws(b, i);
        if *i >= b.len() {
            return Err("eof in obj".into());
        }
        if b[*i] == b'}' {
            *i += 1;
            break;
        }
        let key = parse_str(b, i)?;
        skip_ws(b, i);
        if *i < b.len() && b[*i] == b':' {
            *i += 1;
        }
        let v = parse_val(b, i)?;
        m.insert(key, v);
        skip_ws(b, i);
        if *i < b.len() && b[*i] == b',' {
            *i += 1;
        }
    }
    Ok(Val::Obj(m))
}

// ---- output builder ----
pub fn esc(s: &str) -> String {
    let mut o = String::with_capacity(s.len() + 2);
    for c in s.chars() {
        match c {
            '"' => o.push_str("\\\""),
            '\\' => o.push_str("\\\\"),
            '\n' => o.push_str("\\n"),
            '\t' => o.push_str("\\t"),
            '\r' => o.push_str("\\r"),
            _ => o.push(c),
        }
    }
    o
}

// format an f64 for JSON: null for NaN/inf, trim.
pub fn num(x: f64) -> String {
    if x.is_finite() {
        // avoid -0 and excessive precision
        let r = (x * 1e6).round() / 1e6;
        if r == r.trunc() && r.abs() < 1e15 {
            format!("{}", r as i64)
        } else {
            format!("{}", r)
        }
    } else {
        "null".into()
    }
}
