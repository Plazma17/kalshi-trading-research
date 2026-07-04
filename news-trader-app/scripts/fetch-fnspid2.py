# Stream FNSPID's news CSV and keep only (a) our universe tickers and (b) real
# event-driven headlines (drop generic roundups). Balanced per-ticker. Writes a
# clean date,headline,ticker CSV the app can import.
import sys, subprocess, csv, re
try:
    import requests
except ImportError:
    subprocess.run([sys.executable, "-m", "pip", "install", "-q", "requests"], check=True)
    import requests

URL = "https://huggingface.co/datasets/Zihan1004/FNSPID/resolve/main/Stock_news/All_external.csv"
OUT = r"C:\users\Noah\claude-workspace\news-trader-data\fnspid-universe.csv"

TICKERS = set("XOM CVX OXY SLB NVDA AMD AMAT MU DAL UAL AAL LMT RTX NOC JPM BAC GS KRE NEM SPY QQQ".split())
GOOD = re.compile(r"\b(beat|miss|guidance|upgrade|downgrade|fda|approv|recall|lawsuit|acqui|merger|earnings|cut|raise|surge|plunge|warn|launch|deal|contract|investigat|bankrupt|outage|hike|sanction|ban|halt|probe|record|jump|tumble|soar|slump|defaul)", re.I)
BAD = re.compile(r"52-week|biggest mover|stocks moving|mid-day|midday|hit .* high|hit .* low|market update|pre-?market|watchlist|gainers|losers|what to know|here'?s why|to watch|movers", re.I)
PER, TOTAL, MAXSCAN = 300, 6000, 16_000_000

counts, rows, scanned = {}, [], 0
with requests.get(URL, stream=True, timeout=600) as r:
    r.raise_for_status()
    it = r.iter_lines(decode_unicode=True)
    cols = next(csv.reader([next(it)]))
    di, ti, si = cols.index("Date"), cols.index("Article_title"), cols.index("Stock_symbol")
    for line in it:
        if not line:
            continue
        scanned += 1
        if scanned > MAXSCAN or len(rows) >= TOTAL:
            break
        try:
            rec = next(csv.reader([line]))
        except Exception:
            continue
        if len(rec) <= si:
            continue
        sym = rec[si].strip().upper()
        if sym not in TICKERS or counts.get(sym, 0) >= PER:
            continue
        title = rec[ti].strip()
        if not title or BAD.search(title) or not GOOD.search(title):
            continue
        rows.append((rec[di].strip(), title, sym))
        counts[sym] = counts.get(sym, 0) + 1
        if len(rows) % 100 == 0:
            print(f"  {len(rows)} collected (scanned {scanned})…")

with open(OUT, "w", encoding="utf-8", newline="") as f:
    w = csv.writer(f)
    w.writerow(["date", "headline", "ticker"])
    for d, t, s in rows:
        w.writerow([d, t, s])
print(f"\ncollected {len(rows)} headlines across {len(counts)} tickers (scanned {scanned} rows)")
print("by ticker:", dict(sorted(counts.items())))
print("wrote", OUT)
