// cta_scan — multithreaded scan engine for the CTA dashboard "Window Analysis" tab.
// Reads a big append-only ticklog .jsonl archive fresh per query, computes derived + causal
// forward-looking metrics, and answers pivot / correlation / window-catalog / distribution queries.
// Query arrives as JSON on stdin (or argv[1]); result is compact JSON on stdout.
//
// Design: hand-written byte scanner for the hot path (no serde), rayon for the parallel parse,
// two-pass forward-fill per 15-minute window so the +Hs columns use only ticks STRICTLY AFTER t.
use rayon::prelude::*;
use std::io::Read;
use std::time::Instant;

mod json;
use json::Val;

// ---------- Tick ----------
// Compact per-tick record. f32 for everything analytic (plenty of precision for prob/price ratios);
// f64 only for the epoch timestamp where we need sub-second absolute precision.
#[derive(Clone, Default)]
struct Tick {
    t: f64,
    tk_hash: u64,
    win: u32,
    // raw fields
    secleft: f32,
    elapsed: f32,
    mid: f32,
    fair: f32,
    dev: f32,
    btc: f32,
    strike: f32,
    zstrike: f32,
    sig: f32,
    calk: f32,
    ya: f32,
    na: f32,
    yb: f32,
    nb: f32,
    cfmean: f32,
    tfi: f32,
    tvol: f32,
    btcobi: f32,
    btcspread: f32,
    eth: f32,
    sol: f32,
    // derived (pass 2)
    mid_d1: f32,
    mid_d2: f32,
    tfi_cum: f32,
    // forward (pass 2, causal)
    mv10: f32,
    mv30: f32,
    mv60: f32,
    mv120: f32,
    mv300: f32,
    settle: f32, // final mid of the window this tick belongs to
}

const NAN: f32 = f32::NAN;

fn fnv1a(b: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    for &c in b {
        h ^= c as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}

// Iterate top-level "key": value pairs of one JSON object line, skipping nested objects/arrays and
// respecting quoted strings. `f(key, value_bytes, is_string)`.
fn for_each_kv<F: FnMut(&[u8], &[u8], bool)>(line: &[u8], mut f: F) {
    let b = line;
    let n = b.len();
    let mut i = 0usize;
    while i < n && b[i] != b'{' {
        i += 1;
    }
    if i >= n {
        return;
    }
    i += 1;
    loop {
        while i < n && matches!(b[i], b' ' | b',' | b'\n' | b'\t' | b'\r') {
            i += 1;
        }
        if i >= n || b[i] == b'}' {
            break;
        }
        if b[i] != b'"' {
            break;
        }
        i += 1;
        let ks = i;
        while i < n && b[i] != b'"' {
            i += 1;
        }
        if i >= n {
            break;
        }
        let key = &b[ks..i];
        i += 1;
        while i < n && b[i] != b':' {
            i += 1;
        }
        i += 1;
        while i < n && b[i] == b' ' {
            i += 1;
        }
        if i >= n {
            break;
        }
        let c = b[i];
        if c == b'"' {
            i += 1;
            let vs = i;
            while i < n && b[i] != b'"' {
                if b[i] == b'\\' {
                    i += 1;
                }
                i += 1;
            }
            let val = &b[vs..i.min(n)];
            f(key, val, true);
            i += 1;
        } else if c == b'{' || c == b'[' {
            let open = c;
            let close = if c == b'{' { b'}' } else { b']' };
            let mut depth = 1i32;
            i += 1;
            while i < n && depth > 0 {
                let d = b[i];
                if d == b'"' {
                    i += 1;
                    while i < n && b[i] != b'"' {
                        if b[i] == b'\\' {
                            i += 1;
                        }
                        i += 1;
                    }
                } else if d == open {
                    depth += 1;
                } else if d == close {
                    depth -= 1;
                }
                i += 1;
            }
        } else {
            let vs = i;
            while i < n && b[i] != b',' && b[i] != b'}' {
                i += 1;
            }
            let val = &b[vs..i];
            f(key, val, false);
        }
    }
}

#[inline]
fn pf(v: &[u8]) -> f32 {
    std::str::from_utf8(v)
        .ok()
        .and_then(|s| s.trim().parse::<f32>().ok())
        .unwrap_or(NAN)
}

fn parse_tick(line: &[u8]) -> Option<Tick> {
    if line.len() < 8 {
        return None;
    }
    let mut t = Tick::default();
    // pre-set analytic fields to NaN so "missing" != 0
    t.secleft = NAN;
    t.elapsed = NAN;
    t.mid = NAN;
    t.fair = NAN;
    t.dev = NAN;
    t.btc = NAN;
    t.strike = NAN;
    t.zstrike = NAN;
    t.sig = NAN;
    t.calk = NAN;
    t.ya = NAN;
    t.na = NAN;
    t.yb = NAN;
    t.nb = NAN;
    t.cfmean = NAN;
    t.tfi = NAN;
    t.tvol = NAN;
    t.btcobi = NAN;
    t.btcspread = NAN;
    t.eth = NAN;
    t.sol = NAN;
    t.t = f64::NAN;
    for_each_kv(line, |k, v, is_str| match k {
        b"t" => {
            t.t = std::str::from_utf8(v).ok().and_then(|s| s.trim().parse::<f64>().ok()).unwrap_or(f64::NAN)
        }
        b"tk" if is_str => t.tk_hash = fnv1a(v),
        b"secleft" => t.secleft = pf(v),
        b"elapsed" => t.elapsed = pf(v),
        b"mid" => t.mid = pf(v),
        b"fair" => t.fair = pf(v),
        b"dev" => t.dev = pf(v),
        b"btc" => t.btc = pf(v),
        b"strike" => t.strike = pf(v),
        b"zstrike" => t.zstrike = pf(v),
        b"sig" => t.sig = pf(v),
        b"calk" => t.calk = pf(v),
        b"ya" => t.ya = pf(v),
        b"na" => t.na = pf(v),
        b"yb" => t.yb = pf(v),
        b"nb" => t.nb = pf(v),
        b"cfmean" => t.cfmean = pf(v),
        b"tfi" => t.tfi = pf(v),
        b"tvol" => t.tvol = pf(v),
        b"btcobi" => t.btcobi = pf(v),
        b"btcspread" => t.btcspread = pf(v),
        b"eth" => t.eth = pf(v),
        b"sol" => t.sol = pf(v),
        _ => {}
    });
    if t.t.is_nan() {
        return None;
    }
    Some(t)
}

// ---------- load + build ----------
struct Loaded {
    ticks: Vec<Tick>,
    // window boundaries as (start_idx, end_idx_exclusive)
    wins: Vec<(usize, usize)>,
}

fn load(path: &str) -> std::io::Result<(Vec<u8>, Vec<(usize, usize)>)> {
    let mut f = std::fs::File::open(path)?;
    let sz = f.metadata().map(|m| m.len() as usize).unwrap_or(0);
    let mut buf = Vec::with_capacity(sz + 16);
    f.read_to_end(&mut buf)?;
    // line ranges
    let mut lines = Vec::new();
    let mut start = 0usize;
    for (i, &c) in buf.iter().enumerate() {
        if c == b'\n' {
            if i > start {
                lines.push((start, i));
            }
            start = i + 1;
        }
    }
    if start < buf.len() {
        lines.push((start, buf.len()));
    }
    Ok((buf, lines))
}

fn build(path: &str) -> std::io::Result<Loaded> {
    let (buf, lines) = load(path)?;
    // parallel parse, order preserved
    let mut ticks: Vec<Tick> = lines
        .par_iter()
        .filter_map(|&(s, e)| parse_tick(&buf[s..e]))
        .collect();
    // assign dense window ids (file is time-ordered; window ticks are contiguous by tk)
    let mut wins: Vec<(usize, usize)> = Vec::new();
    if !ticks.is_empty() {
        let mut cur = 0u32;
        let mut wstart = 0usize;
        let mut prev = ticks[0].tk_hash;
        ticks[0].win = 0;
        for i in 1..ticks.len() {
            if ticks[i].tk_hash != prev {
                wins.push((wstart, i));
                cur += 1;
                wstart = i;
                prev = ticks[i].tk_hash;
            }
            ticks[i].win = cur;
        }
        wins.push((wstart, ticks.len()));
    }
    // pass 2: per-window derived + causal forward moves + settle
    let horizons = [10.0f64, 30.0, 60.0, 120.0, 300.0];
    for &(s, e) in &wins {
        let settle = ticks[e - 1].mid; // final mid of the window
        // derived + forward
        // precompute for the window into temp vecs to avoid borrow issues
        let n = e - s;
        // mid_d1 / mid_d2 / tfi_cum
        let mut tfi_cum = 0.0f32;
        for local in 0..n {
            let idx = s + local;
            ticks[idx].settle = settle;
            // mid_d1 (per second)
            if local > 0 {
                let dt = (ticks[idx].t - ticks[idx - 1].t) as f32;
                if dt > 0.0 {
                    ticks[idx].mid_d1 = (ticks[idx].mid - ticks[idx - 1].mid) / dt;
                } else {
                    ticks[idx].mid_d1 = 0.0;
                }
            } else {
                ticks[idx].mid_d1 = 0.0;
            }
            // tfi integral (tfi * dt)
            if local > 0 {
                let dt = (ticks[idx].t - ticks[idx - 1].t) as f32;
                let tv = ticks[idx].tfi;
                if tv.is_finite() && dt > 0.0 {
                    tfi_cum += tv * dt;
                }
            }
            ticks[idx].tfi_cum = tfi_cum;
        }
        // mid_d2 = derivative of mid_d1
        for local in 0..n {
            let idx = s + local;
            if local > 0 {
                let dt = (ticks[idx].t - ticks[idx - 1].t) as f32;
                if dt > 0.0 {
                    ticks[idx].mid_d2 = (ticks[idx].mid_d1 - ticks[idx - 1].mid_d1) / dt;
                } else {
                    ticks[idx].mid_d2 = 0.0;
                }
            } else {
                ticks[idx].mid_d2 = 0.0;
            }
        }
        // forward moves: two-pointer per horizon (strictly-after semantics)
        for (hi, &h) in horizons.iter().enumerate() {
            let mut j = s;
            for local in 0..n {
                let idx = s + local;
                let target = ticks[idx].t + h;
                if j <= idx {
                    j = idx + 1;
                }
                while j < e && ticks[j].t < target {
                    j += 1;
                }
                let mv = if j < e {
                    ticks[j].mid - ticks[idx].mid
                } else {
                    NAN
                };
                match hi {
                    0 => ticks[idx].mv10 = mv,
                    1 => ticks[idx].mv30 = mv,
                    2 => ticks[idx].mv60 = mv,
                    3 => ticks[idx].mv120 = mv,
                    _ => ticks[idx].mv300 = mv,
                }
            }
        }
    }
    Ok(Loaded { ticks, wins })
}

// ---------- metrics ----------
fn metric(t: &Tick, name: &str) -> f64 {
    match name {
        "t" => t.t,
        "secleft" => t.secleft as f64,
        "elapsed" | "time" => t.elapsed as f64,
        "mid" => t.mid as f64,
        "fair" => t.fair as f64,
        "dev" => t.dev as f64,
        "btc" => t.btc as f64,
        "strike" => t.strike as f64,
        "zstrike" => t.zstrike as f64,
        "sig" => t.sig as f64,
        "calk" => t.calk as f64,
        "ya" => t.ya as f64,
        "na" => t.na as f64,
        "yb" => t.yb as f64,
        "nb" => t.nb as f64,
        "cfmean" => t.cfmean as f64,
        "tfi" => t.tfi as f64,
        "tvol" => t.tvol as f64,
        "btcobi" | "imbalance" => t.btcobi as f64,
        "btcspread" => t.btcspread as f64,
        "eth" => t.eth as f64,
        "sol" => t.sol as f64,
        // derived
        "pf" => {
            let m = t.mid as f64;
            m.max(1.0 - m)
        }
        "dist" => ((t.cfmean - t.strike) as f64).abs(),
        "sdist" => (t.cfmean - t.strike) as f64, // signed
        "spread" => (t.ya - t.yb) as f64,
        "mid_d1" => t.mid_d1 as f64,
        "mid_d2" => t.mid_d2 as f64,
        "tfi_cum" => t.tfi_cum as f64,
        "hour" => {
            if t.t.is_finite() {
                (((t.t as i64).rem_euclid(86400)) / 3600) as f64
            } else {
                f64::NAN
            }
        }
        "weekday" => {
            if t.t.is_finite() {
                (((t.t as i64).div_euclid(86400) + 4).rem_euclid(7)) as f64
            } else {
                f64::NAN
            }
        }
        // forward
        "mv10" => t.mv10 as f64,
        "mv30" => t.mv30 as f64,
        "mv60" => t.mv60 as f64,
        "mv120" => t.mv120 as f64,
        "mv300" => t.mv300 as f64,
        "settle" => t.settle as f64,
        "settle_bin" => {
            if t.settle.is_finite() {
                if t.settle >= 0.5 {
                    1.0
                } else {
                    0.0
                }
            } else {
                f64::NAN
            }
        }
        _ => f64::NAN,
    }
}

const METRIC_NAMES: &[&str] = &[
    "t", "secleft", "elapsed", "mid", "fair", "dev", "btc", "strike", "zstrike", "sig", "calk",
    "ya", "na", "yb", "nb", "cfmean", "tfi", "tvol", "btcobi", "btcspread", "eth", "sol", "pf",
    "dist", "sdist", "spread", "mid_d1", "mid_d2", "tfi_cum", "hour", "weekday", "mv10", "mv30",
    "mv60", "mv120", "mv300", "settle", "settle_bin",
];

// ---------- filters ----------
struct Filters {
    date_from: f64,
    date_to: f64,
    secleft_min: f64,
    secleft_max: f64,
    price_min: f64,
    price_max: f64,
    outcome: i8, // -1 any, 0 no, 1 yes
}

fn parse_filters(q: &Val) -> Filters {
    let fobj = q.get("filters");
    let g = |k: &str, d: f64| -> f64 {
        fobj.and_then(|f| f.f(k)).unwrap_or(d)
    };
    let outcome = match fobj.and_then(|f| f.s("outcome")) {
        Some("yes") => 1,
        Some("no") => 0,
        _ => -1,
    };
    Filters {
        date_from: g("date_from", f64::NEG_INFINITY),
        date_to: g("date_to", f64::INFINITY),
        secleft_min: g("secleft_min", f64::NEG_INFINITY),
        secleft_max: g("secleft_max", f64::INFINITY),
        price_min: g("price_min", f64::NEG_INFINITY),
        price_max: g("price_max", f64::INFINITY),
        outcome,
    }
}

#[inline]
fn passes(t: &Tick, f: &Filters) -> bool {
    if t.t < f.date_from || t.t > f.date_to {
        return false;
    }
    let sl = t.secleft as f64;
    if sl < f.secleft_min || sl > f.secleft_max {
        return false;
    }
    let m = t.mid as f64;
    if m < f.price_min || m > f.price_max {
        return false;
    }
    if f.outcome >= 0 {
        if !t.settle.is_finite() {
            return false;
        }
        let sb = if t.settle >= 0.5 { 1 } else { 0 };
        if sb != f.outcome {
            return false;
        }
    }
    true
}

// ---------- helpers ----------
fn pearson(xs: &[f64], ys: &[f64]) -> (f64, usize) {
    let mut n = 0usize;
    let (mut sx, mut sy, mut sxx, mut syy, mut sxy) = (0.0, 0.0, 0.0, 0.0, 0.0);
    for i in 0..xs.len().min(ys.len()) {
        let (x, y) = (xs[i], ys[i]);
        if x.is_finite() && y.is_finite() {
            n += 1;
            sx += x;
            sy += y;
            sxx += x * x;
            syy += y * y;
            sxy += x * y;
        }
    }
    if n < 2 {
        return (f64::NAN, n);
    }
    let nf = n as f64;
    let cov = sxy - sx * sy / nf;
    let vx = sxx - sx * sx / nf;
    let vy = syy - sy * sy / nf;
    let d = (vx * vy).sqrt();
    if d <= 0.0 {
        (f64::NAN, n)
    } else {
        (cov / d, n)
    }
}

fn median(v: &mut [f64]) -> f64 {
    if v.is_empty() {
        return f64::NAN;
    }
    v.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let n = v.len();
    if n % 2 == 1 {
        v[n / 2]
    } else {
        (v[n / 2 - 1] + v[n / 2]) / 2.0
    }
}

fn percentile(sorted: &[f64], p: f64) -> f64 {
    if sorted.is_empty() {
        return f64::NAN;
    }
    let idx = ((sorted.len() - 1) as f64 * p).round() as usize;
    sorted[idx.min(sorted.len() - 1)]
}

// ---------- queries ----------
fn q_fields() -> String {
    let mut s = String::from("{\"metrics\":[");
    for (i, m) in METRIC_NAMES.iter().enumerate() {
        if i > 0 {
            s.push(',');
        }
        s.push('"');
        s.push_str(m);
        s.push('"');
    }
    s.push_str("]}");
    s
}

fn q_pivot(l: &Loaded, q: &Val, f: &Filters, t0: Instant) -> String {
    let xa = q.get("x");
    let ya = q.get("y");
    let xm = xa.and_then(|v| v.s("metric")).unwrap_or("elapsed").to_string();
    let ym = ya.and_then(|v| v.s("metric")).unwrap_or("pf").to_string();
    let xbin = xa.and_then(|v| v.f("bin")).unwrap_or(30.0).max(1e-9);
    let ybin = ya.and_then(|v| v.f("bin")).unwrap_or(0.05).max(1e-9);
    // auto range from data if not provided
    let (mut xmin, mut xmax) = (
        xa.and_then(|v| v.f("min")),
        xa.and_then(|v| v.f("max")),
    );
    let (mut ymin, mut ymax) = (
        ya.and_then(|v| v.f("min")),
        ya.and_then(|v| v.f("max")),
    );
    if xmin.is_none() || xmax.is_none() || ymin.is_none() || ymax.is_none() {
        let (mut xlo, mut xhi, mut ylo, mut yhi) =
            (f64::INFINITY, f64::NEG_INFINITY, f64::INFINITY, f64::NEG_INFINITY);
        for t in &l.ticks {
            if !passes(t, f) {
                continue;
            }
            let x = metric(t, &xm);
            let y = metric(t, &ym);
            if x.is_finite() {
                xlo = xlo.min(x);
                xhi = xhi.max(x);
            }
            if y.is_finite() {
                ylo = ylo.min(y);
                yhi = yhi.max(y);
            }
        }
        if xmin.is_none() {
            xmin = Some(xlo);
        }
        if xmax.is_none() {
            xmax = Some(xhi);
        }
        if ymin.is_none() {
            ymin = Some(ylo);
        }
        if ymax.is_none() {
            ymax = Some(yhi);
        }
    }
    let xmin = xmin.unwrap_or(0.0);
    let xmax = xmax.unwrap_or(1.0);
    let ymin = ymin.unwrap_or(0.0);
    let ymax = ymax.unwrap_or(1.0);
    let nx = (((xmax - xmin) / xbin).ceil() as usize).clamp(1, 400);
    let ny = (((ymax - ymin) / ybin).ceil() as usize).clamp(1, 400);
    let agg = q.s("agg").unwrap_or("count").to_string();
    let zm = q.s("z").unwrap_or("mv60").to_string();
    let ncell = nx * ny;
    let mut counts = vec![0u64; ncell];
    let mut sums = vec![0.0f64; ncell];
    // for median we collect values per cell
    let need_med = agg == "median";
    let mut cellvals: Vec<Vec<f64>> = if need_med {
        vec![Vec::new(); ncell]
    } else {
        Vec::new()
    };
    let mut total = 0u64;
    for t in &l.ticks {
        if !passes(t, f) {
            continue;
        }
        let x = metric(t, &xm);
        let y = metric(t, &ym);
        if !x.is_finite() || !y.is_finite() {
            continue;
        }
        if x < xmin || x >= xmax + xbin || y < ymin || y >= ymax + ybin {
            continue;
        }
        let ix = (((x - xmin) / xbin).floor() as isize).clamp(0, nx as isize - 1) as usize;
        let iy = (((y - ymin) / ybin).floor() as isize).clamp(0, ny as isize - 1) as usize;
        let ci = iy * nx + ix;
        counts[ci] += 1;
        total += 1;
        if agg != "count" {
            let z = metric(t, &zm);
            if z.is_finite() {
                if need_med {
                    cellvals[ci].push(z);
                } else {
                    sums[ci] += z;
                }
            }
        }
    }
    // build cells
    let mut cells = String::from("[");
    let mut first = true;
    for iy in 0..ny {
        for ix in 0..nx {
            let ci = iy * nx + ix;
            let n = counts[ci];
            if n == 0 {
                continue;
            }
            let v = match agg.as_str() {
                "count" => n as f64,
                "mean" => {
                    if need_med {
                        f64::NAN
                    } else {
                        sums[ci] / n as f64
                    }
                }
                "median" => median(&mut cellvals[ci]),
                _ => n as f64,
            };
            if !first {
                cells.push(',');
            }
            first = false;
            cells.push_str(&format!(
                "{{\"ix\":{},\"iy\":{},\"v\":{},\"n\":{}}}",
                ix,
                iy,
                json::num(v),
                n
            ));
        }
    }
    cells.push(']');
    format!(
        "{{\"type\":\"pivot\",\"nx\":{},\"ny\":{},\"xmin\":{},\"xmax\":{},\"ymin\":{},\"ymax\":{},\"xbin\":{},\"ybin\":{},\"xlabel\":\"{}\",\"ylabel\":\"{}\",\"agg\":\"{}\",\"zlabel\":\"{}\",\"total\":{},\"cells\":{},\"elapsed_ms\":{}}}",
        nx, ny, json::num(xmin), json::num(xmax), json::num(ymin), json::num(ymax),
        json::num(xbin), json::num(ybin), json::esc(&xm), json::esc(&ym), json::esc(&agg),
        json::esc(&zm), total, cells, t0.elapsed().as_millis()
    )
}

fn q_corr(l: &Loaded, q: &Val, f: &Filters, t0: Instant) -> String {
    let am = q.s("a").unwrap_or("tfi").to_string();
    let bm = q.s("b").unwrap_or("mv60").to_string();
    let lag_max = q.f("lag_max").unwrap_or(60.0) as i64;
    let lag_step = (q.f("lag_step").unwrap_or(1.0) as i64).max(1);
    let roll = q.f("roll").unwrap_or(300.0).max(2.0) as usize;
    // collect aligned sequences (per filtered tick)
    let mut xs = Vec::new();
    let mut ys = Vec::new();
    let mut ts = Vec::new();
    for t in &l.ticks {
        if !passes(t, f) {
            continue;
        }
        let a = metric(t, &am);
        let b = metric(t, &bm);
        xs.push(a);
        ys.push(b);
        ts.push(t.t);
    }
    let (r, n) = pearson(&xs, &ys);
    // scatter downsample <= 5000
    let mut scatter = String::from("[");
    let valid: Vec<usize> = (0..xs.len())
        .filter(|&i| xs[i].is_finite() && ys[i].is_finite())
        .collect();
    let stride = (valid.len() / 5000).max(1);
    let mut sc_first = true;
    let mut k = 0;
    while k < valid.len() {
        let i = valid[k];
        if !sc_first {
            scatter.push(',');
        }
        sc_first = false;
        scatter.push_str(&format!("[{},{}]", json::num(xs[i]), json::num(ys[i])));
        k += stride;
    }
    scatter.push(']');
    // lag scan (index lag)
    let mut lags = String::from("[");
    let mut lg_first = true;
    let mut lag = -lag_max;
    while lag <= lag_max {
        // correlate xs[i] with ys[i+lag]
        let mut ax = Vec::new();
        let mut ay = Vec::new();
        for i in 0..xs.len() {
            let j = i as i64 + lag;
            if j < 0 || j as usize >= ys.len() {
                continue;
            }
            ax.push(xs[i]);
            ay.push(ys[j as usize]);
        }
        let (lr, ln) = pearson(&ax, &ay);
        if !lg_first {
            lags.push(',');
        }
        lg_first = false;
        lags.push_str(&format!("{{\"lag\":{},\"r\":{},\"n\":{}}}", lag, json::num(lr), ln));
        lag += lag_step;
    }
    lags.push(']');
    // rolling correlation (downsampled to <= 800 points)
    let mut rolling = String::from("[");
    if xs.len() >= roll {
        let npts = xs.len() - roll + 1;
        let rstride = (npts / 800).max(1);
        let mut rf = true;
        let mut i = 0;
        while i + roll <= xs.len() {
            let (rr, _) = pearson(&xs[i..i + roll], &ys[i..i + roll]);
            if !rf {
                rolling.push(',');
            }
            rf = false;
            rolling.push_str(&format!("[{},{}]", json::num(ts[i + roll - 1]), json::num(rr)));
            i += rstride;
        }
    }
    rolling.push(']');
    format!(
        "{{\"type\":\"corr\",\"a\":\"{}\",\"b\":\"{}\",\"r\":{},\"n\":{},\"scatter\":{},\"lags\":{},\"rolling\":{},\"roll\":{},\"elapsed_ms\":{}}}",
        json::esc(&am), json::esc(&bm), json::num(r), n, scatter, lags, rolling, roll,
        t0.elapsed().as_millis()
    )
}

fn q_corrmatrix(l: &Loaded, q: &Val, f: &Filters, t0: Instant) -> String {
    let metrics: Vec<String> = match q.get("metrics") {
        Some(Val::Arr(a)) => a.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect(),
        _ => vec![
            "tfi", "tvol", "btcobi", "mid_d1", "dev", "mv60", "mv300", "dist",
        ]
        .into_iter()
        .map(|s| s.to_string())
        .collect(),
    };
    let k = metrics.len();
    let mut data: Vec<Vec<f64>> = vec![Vec::new(); k];
    for t in &l.ticks {
        if !passes(t, f) {
            continue;
        }
        for mi in 0..k {
            data[mi].push(metric(t, &metrics[mi]));
        }
    }
    let mut mat = vec![vec![f64::NAN; k]; k];
    for a in 0..k {
        for b in a..k {
            let r = if a == b {
                1.0
            } else {
                pearson(&data[a], &data[b]).0
            };
            mat[a][b] = r;
            mat[b][a] = r;
        }
    }
    let n = data.get(0).map(|d| d.len()).unwrap_or(0);
    let mut ms = String::from("[");
    for (i, m) in metrics.iter().enumerate() {
        if i > 0 {
            ms.push(',');
        }
        ms.push('"');
        ms.push_str(&json::esc(m));
        ms.push('"');
    }
    ms.push(']');
    let mut mstr = String::from("[");
    for a in 0..k {
        if a > 0 {
            mstr.push(',');
        }
        mstr.push('[');
        for b in 0..k {
            if b > 0 {
                mstr.push(',');
            }
            mstr.push_str(&json::num(mat[a][b]));
        }
        mstr.push(']');
    }
    mstr.push(']');
    format!(
        "{{\"type\":\"corrmatrix\",\"metrics\":{},\"matrix\":{},\"n\":{},\"elapsed_ms\":{}}}",
        ms,
        mstr,
        n,
        t0.elapsed().as_millis()
    )
}

fn q_windows(l: &Loaded, q: &Val, buf_path: &str, t0: Instant) -> String {
    // per-window catalog rows. reload tk strings by re-scanning each window's first line.
    let _ = q;
    // reopen to get tk strings + dates cheaply
    let (buf, lines) = load(buf_path).unwrap_or((Vec::new(), Vec::new()));
    // map: window start tick index -> line index. Since parse dropped some lines, we approximate
    // tk string by re-parsing the first line whose tk matches the window hash near the boundary.
    // Simpler + robust: rebuild tk string per window by scanning lines and grouping identically.
    let mut tkstrings: Vec<String> = Vec::new();
    {
        let mut prev_hash = 0u64;
        let mut have = false;
        for &(s, e) in &lines {
            let line = &buf[s..e];
            let mut tk: Option<String> = None;
            let mut valid = false;
            for_each_kv(line, |k, v, is_str| {
                if k == b"tk" && is_str {
                    tk = Some(String::from_utf8_lossy(v).to_string());
                }
                if k == b"t" {
                    valid = std::str::from_utf8(v).ok().and_then(|x| x.trim().parse::<f64>().ok()).is_some();
                }
            });
            if !valid {
                continue;
            }
            let h = tk.as_ref().map(|s| fnv1a(s.as_bytes())).unwrap_or(0);
            if !have || h != prev_hash {
                tkstrings.push(tk.unwrap_or_default());
                prev_hash = h;
                have = true;
            }
        }
    }
    let mut rows = String::from("[");
    let mut first = true;
    for (wi, &(s, e)) in l.wins.iter().enumerate() {
        let n = e - s;
        if n < 2 {
            continue;
        }
        let slice = &l.ticks[s..e];
        let t_open = slice[0].t;
        let t_close = slice[n - 1].t;
        let dur = t_close - t_open;
        // btc range, path efficiency, rvol, drift on btc
        let mut bmin = f64::INFINITY;
        let mut bmax = f64::NEG_INFINITY;
        let mut path = 0.0f64;
        let mut tfi_sum = 0.0f64;
        let mut obi_sum = 0.0f64;
        let mut obi_n = 0.0f64;
        let mut ret_sq = 0.0f64;
        let mut ret_n = 0.0f64;
        for i in 0..n {
            let b = slice[i].btc as f64;
            if b.is_finite() {
                bmin = bmin.min(b);
                bmax = bmax.max(b);
            }
            if slice[i].tfi.is_finite() {
                tfi_sum += slice[i].tfi as f64;
            }
            if slice[i].btcobi.is_finite() {
                obi_sum += slice[i].btcobi as f64;
                obi_n += 1.0;
            }
            if i > 0 {
                let d = (slice[i].btc - slice[i - 1].btc) as f64;
                if d.is_finite() {
                    path += d.abs();
                    ret_sq += d * d;
                    ret_n += 1.0;
                }
            }
        }
        let net = (slice[n - 1].btc - slice[0].btc) as f64;
        let range = if bmax > bmin { bmax - bmin } else { 0.0 };
        let path_eff = if path > 0.0 { net.abs() / path } else { 0.0 };
        let rvol = if ret_n > 0.0 { (ret_sq / ret_n).sqrt() } else { 0.0 };
        let strike = slice[0].strike as f64;
        let dist_open = ((slice[0].cfmean - slice[0].strike) as f64).abs();
        let dist_close = ((slice[n - 1].cfmean - slice[n - 1].strike) as f64).abs();
        let settle = slice[n - 1].mid as f64;
        let obi_mean = if obi_n > 0.0 { obi_sum / obi_n } else { f64::NAN };
        let tk = tkstrings.get(wi).cloned().unwrap_or_default();
        if !first {
            rows.push(',');
        }
        first = false;
        rows.push_str(&format!(
            "{{\"wi\":{},\"tk\":\"{}\",\"t0\":{},\"dur\":{},\"n\":{},\"range\":{},\"path_eff\":{},\"rvol\":{},\"drift\":{},\"tfi_sum\":{},\"obi_mean\":{},\"strike\":{},\"dist_open\":{},\"dist_close\":{},\"settle\":{},\"settle_bin\":{}}}",
            wi, json::esc(&tk), json::num(t_open), json::num(dur), n, json::num(range),
            json::num(path_eff), json::num(rvol), json::num(net), json::num(tfi_sum),
            json::num(obi_mean), json::num(strike), json::num(dist_open), json::num(dist_close),
            json::num(settle), if settle >= 0.5 { 1 } else { 0 }
        ));
    }
    rows.push(']');
    format!(
        "{{\"type\":\"windows\",\"nwin\":{},\"rows\":{},\"elapsed_ms\":{}}}",
        l.wins.len(),
        rows,
        t0.elapsed().as_millis()
    )
}

fn q_dist(l: &Loaded, q: &Val, f: &Filters, t0: Instant) -> String {
    let m = q.s("metric").unwrap_or("mv60").to_string();
    let nbins = (q.f("bins").unwrap_or(60.0) as usize).clamp(2, 400);
    let mut vals: Vec<f64> = Vec::new();
    for t in &l.ticks {
        if !passes(t, f) {
            continue;
        }
        let v = metric(t, &m);
        if v.is_finite() {
            vals.push(v);
        }
    }
    if vals.is_empty() {
        return format!(
            "{{\"type\":\"dist\",\"metric\":\"{}\",\"n\":0,\"bins\":[],\"elapsed_ms\":{}}}",
            json::esc(&m),
            t0.elapsed().as_millis()
        );
    }
    // range: allow override
    let lo = q.f("min").unwrap_or_else(|| vals.iter().cloned().fold(f64::INFINITY, f64::min));
    let hi = q.f("max").unwrap_or_else(|| vals.iter().cloned().fold(f64::NEG_INFINITY, f64::max));
    let span = if hi > lo { hi - lo } else { 1.0 };
    let bw = span / nbins as f64;
    let mut counts = vec![0u64; nbins];
    for &v in &vals {
        if v < lo || v > hi {
            continue;
        }
        let bi = (((v - lo) / bw).floor() as isize).clamp(0, nbins as isize - 1) as usize;
        counts[bi] += 1;
    }
    let mut sorted = vals.clone();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let n = sorted.len();
    let mean = sorted.iter().sum::<f64>() / n as f64;
    let var = sorted.iter().map(|x| (x - mean) * (x - mean)).sum::<f64>() / n as f64;
    let std = var.sqrt();
    let med = sorted[n / 2];
    let p5 = percentile(&sorted, 0.05);
    let p95 = percentile(&sorted, 0.95);
    let mut bins = String::from("[");
    for i in 0..nbins {
        if i > 0 {
            bins.push(',');
        }
        let blo = lo + i as f64 * bw;
        bins.push_str(&format!(
            "{{\"lo\":{},\"hi\":{},\"n\":{}}}",
            json::num(blo),
            json::num(blo + bw),
            counts[i]
        ));
    }
    bins.push(']');
    format!(
        "{{\"type\":\"dist\",\"metric\":\"{}\",\"n\":{},\"min\":{},\"max\":{},\"mean\":{},\"median\":{},\"std\":{},\"p5\":{},\"p95\":{},\"bins\":{},\"elapsed_ms\":{}}}",
        json::esc(&m), n, json::num(lo), json::num(hi), json::num(mean), json::num(med),
        json::num(std), json::num(p5), json::num(p95), bins, t0.elapsed().as_millis()
    )
}

fn default_path() -> String {
    std::env::var("CTA_TICKLOG")
        .unwrap_or_else(|_| "C:\\Users\\Noah\\claude-workspace\\ticklog_archive.jsonl".to_string())
}

fn run(q: &Val) -> String {
    let t0 = Instant::now();
    let qtype = q.s("type").unwrap_or("fields");
    if qtype == "fields" {
        return q_fields();
    }
    let path = q.s("file").map(|s| s.to_string()).unwrap_or_else(default_path);
    let loaded = match build(&path) {
        Ok(l) => l,
        Err(e) => {
            return format!("{{\"error\":\"load failed: {}\"}}", json::esc(&e.to_string()));
        }
    };
    let f = parse_filters(q);
    match qtype {
        "pivot" => q_pivot(&loaded, q, &f, t0),
        "corr" => q_corr(&loaded, q, &f, t0),
        "corrmatrix" => q_corrmatrix(&loaded, q, &f, t0),
        "windows" => q_windows(&loaded, q, &path, t0),
        "dist" => q_dist(&loaded, q, &f, t0),
        "bench" => format!(
            "{{\"type\":\"bench\",\"ticks\":{},\"windows\":{},\"elapsed_ms\":{},\"path\":\"{}\"}}",
            loaded.ticks.len(),
            loaded.wins.len(),
            t0.elapsed().as_millis(),
            json::esc(&path)
        ),
        _ => format!("{{\"error\":\"unknown type: {}\"}}", json::esc(qtype)),
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let qstr = if args.len() > 1 && !args[1].is_empty() {
        args[1].clone()
    } else {
        let mut s = String::new();
        let _ = std::io::stdin().read_to_string(&mut s);
        s
    };
    let qstr = qstr.trim();
    let q = if qstr.is_empty() {
        Val::Obj(std::collections::BTreeMap::new())
    } else {
        match json::parse(qstr) {
            Ok(v) => v,
            Err(e) => {
                println!("{{\"error\":\"bad query json: {}\"}}", json::esc(&e));
                return;
            }
        }
    };
    let out = run(&q);
    println!("{}", out);
}

// ================= TESTS =================
#[cfg(test)]
mod tests {
    use super::*;

    fn sample_line(t: f64, tk: &str, mid: f32, secleft: f32) -> String {
        format!(
            "{{\"t\": {}, \"tk\": \"{}\", \"secleft\": {}, \"elapsed\": {}, \"mid\": {}, \"fair\": 0.5, \"dev\": 0.01, \"btc\": 60000.0, \"strike\": 60050.0, \"cfmean\": 60010.0, \"tfi\": -0.5, \"tvol\": 1.2, \"btcobi\": 0.3, \"btcspread\": 0.01, \"ya\": {}, \"yb\": {}, \"cfpx\": {{\"coinbase\": 60000.1, \"kraken\": 59999.0}}}}",
            t, tk, secleft, 900.0 - secleft, mid, mid + 0.005, mid - 0.005
        )
    }

    #[test]
    fn parse_real_line() {
        let line = br#"{"t": 1782336432.3, "tk": "KXBTC15M-26JUN241730-30", "secleft": 167, "elapsed": 732, "mid": 0.9905, "fair": 0.9594, "dev": 0.0311, "btc": 60791.82, "strike": 60658.64, "zstrike": 0.753, "sig": 0.0007525, "calk": 0.6545, "ya": 0.991, "yb": 0.99, "cfmean": 60754.43, "cfpx": {"coinbase": 60754.79, "kraken": 60750.0}, "tfi": -0.72, "tvol": 1.4481, "btcobi": 0.5344, "btcspread": 0.01}"#;
        let t = parse_tick(line).expect("parse");
        assert!((t.t - 1782336432.3).abs() < 1e-6);
        assert!((t.mid - 0.9905).abs() < 1e-6);
        assert!((t.cfmean - 60754.43).abs() < 0.01);
        assert!((t.tfi - (-0.72)).abs() < 1e-6);
        assert!((t.btcspread - 0.01).abs() < 1e-6);
        assert!((t.secleft - 167.0).abs() < 1e-6);
        // cfpx nested must NOT leak into any field
        assert!((t.strike - 60658.64).abs() < 0.01);
    }

    #[test]
    fn nested_object_skipped() {
        // a nested object containing keys that collide with top-level names must be ignored
        let line = br#"{"t": 100.0, "tk": "W-1", "mid": 0.4, "cfpx": {"mid": 999.0, "strike": 888.0}, "strike": 60000.0}"#;
        let t = parse_tick(line).unwrap();
        assert!((t.mid - 0.4).abs() < 1e-6);
        assert!((t.strike - 60000.0).abs() < 1e-6);
    }

    #[test]
    fn derived_metrics() {
        let line = br#"{"t": 100.0, "tk": "W-1", "mid": 0.7, "cfmean": 60010.0, "strike": 60050.0, "ya": 0.71, "yb": 0.69}"#;
        let t = parse_tick(line).unwrap();
        assert!((metric(&t, "pf") - 0.7).abs() < 1e-6); // max(0.7, 0.3)
        assert!((metric(&t, "dist") - 40.0).abs() < 1e-3); // |60010-60050|
        assert!((metric(&t, "sdist") - (-40.0)).abs() < 1e-3);
        assert!((metric(&t, "spread") - 0.02).abs() < 1e-4);
    }

    #[test]
    fn hour_weekday() {
        // 2021-01-07 00:00:00 UTC = 1609977600 -> Thursday
        let line = format!("{{\"t\": 1609977600.0, \"tk\": \"W\", \"mid\": 0.5}}");
        let t = parse_tick(line.as_bytes()).unwrap();
        assert_eq!(metric(&t, "hour") as i64, 0);
        assert_eq!(metric(&t, "weekday") as i64, 4); // Thursday
    }

    #[test]
    fn forward_move_no_lookahead() {
        // build a tiny archive: one window, mids increasing every 10s
        let mut lines = String::new();
        for k in 0..40 {
            let t = 1000.0 + k as f64 * 10.0;
            let mid = 0.50 + k as f32 * 0.01;
            lines.push_str(&sample_line(t, "KXBTC15M-W1", mid, (900 - k * 20) as f32));
            lines.push('\n');
        }
        let tmp = std::env::temp_dir().join("cta_scan_test_fwd.jsonl");
        std::fs::write(&tmp, &lines).unwrap();
        let l = build(tmp.to_str().unwrap()).unwrap();
        // tick 0 is at t=1000, mid=0.50. +30s -> first tick with t>=1030 is k=3 (t=1030), mid=0.53.
        let t0 = &l.ticks[0];
        assert!((t0.mv30 - 0.03).abs() < 1e-5, "mv30={}", t0.mv30);
        // +10s from tick 0 -> k=1 (t=1010, mid=0.51)
        assert!((t0.mv10 - 0.01).abs() < 1e-5, "mv10={}", t0.mv10);
        // the +30s column at tick t must use a tick STRICTLY AFTER t (t=1030 > 1000). verify monotonic index.
        // last tick has no future -> NaN
        let last = &l.ticks[l.ticks.len() - 1];
        assert!(last.mv30.is_nan());
        // settle = final mid of window = 0.50 + 39*0.01 = 0.89
        assert!((t0.settle - 0.89).abs() < 1e-4, "settle={}", t0.settle);
        let _ = std::fs::remove_file(&tmp);
    }

    #[test]
    fn window_grouping_and_settle_bin() {
        let mut lines = String::new();
        // window A: settles NO (final mid 0.1)
        for k in 0..5 {
            lines.push_str(&sample_line(1000.0 + k as f64, "W-A", 0.1, 100.0));
            lines.push('\n');
        }
        // window B: settles YES (final mid 0.9)
        for k in 0..5 {
            lines.push_str(&sample_line(2000.0 + k as f64, "W-B", 0.9, 100.0));
            lines.push('\n');
        }
        let tmp = std::env::temp_dir().join("cta_scan_test_win.jsonl");
        std::fs::write(&tmp, &lines).unwrap();
        let l = build(tmp.to_str().unwrap()).unwrap();
        assert_eq!(l.wins.len(), 2);
        assert_eq!(l.ticks[0].win, 0);
        assert_eq!(l.ticks[9].win, 1);
        assert!((metric(&l.ticks[0], "settle_bin") - 0.0).abs() < 1e-9);
        assert!((metric(&l.ticks[9], "settle_bin") - 1.0).abs() < 1e-9);
        let _ = std::fs::remove_file(&tmp);
    }

    #[test]
    fn binning_edges() {
        // pivot binning: value exactly on an edge lands in the lower bin; clamp on max edge.
        let mut lines = String::new();
        for k in 0..10 {
            // elapsed steps 0..9, mid ramps
            let mid = 0.05 + k as f32 * 0.1;
            lines.push_str(&sample_line(1000.0 + k as f64, "W-1", mid, (900 - k) as f32));
            lines.push('\n');
        }
        let tmp = std::env::temp_dir().join("cta_scan_test_bin.jsonl");
        std::fs::write(&tmp, &lines).unwrap();
        let l = build(tmp.to_str().unwrap()).unwrap();
        let q = json::parse(r#"{"type":"pivot","x":{"metric":"elapsed","bin":1,"min":0,"max":10},"y":{"metric":"mid","bin":0.1,"min":0,"max":1},"agg":"count"}"#).unwrap();
        let f = parse_filters(&q);
        let out = q_pivot(&l, &q, &f, Instant::now());
        assert!(out.contains("\"total\":10"), "out={}", out);
        let _ = std::fs::remove_file(&tmp);
    }

    #[test]
    fn pearson_perfect() {
        let x = [1.0, 2.0, 3.0, 4.0];
        let y = [2.0, 4.0, 6.0, 8.0];
        let (r, n) = pearson(&x, &y);
        assert_eq!(n, 4);
        assert!((r - 1.0).abs() < 1e-9);
    }

    #[test]
    fn median_ok() {
        let mut v = [3.0, 1.0, 2.0];
        assert!((median(&mut v) - 2.0).abs() < 1e-9);
        let mut w = [4.0, 1.0, 2.0, 3.0];
        assert!((median(&mut w) - 2.5).abs() < 1e-9);
    }
}

#[cfg(test)]
mod bench {
    use super::*;
    #[test]
    #[ignore]
    fn bench_full_ticklog() {
        let path = r"C:\Users\Noah\claude-workspace\ticklog_archive.jsonl";
        let t0 = Instant::now();
        let l = build(path).unwrap();
        let ms = t0.elapsed().as_millis();
        println!("BENCH ticks={} windows={} elapsed_ms={}", l.ticks.len(), l.wins.len(), ms);
    }
}
