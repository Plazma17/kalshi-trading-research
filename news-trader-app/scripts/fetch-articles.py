# Fetch ~250 FNSPID rows that have a REAL article body (not just a headline), for
# our universe tickers + event headlines. Writes date,headline,article,ticker.
import sys, subprocess, csv, re
try:
    import requests
except ImportError:
    subprocess.run([sys.executable, "-m", "pip", "install", "-q", "requests"], check=True)
    import requests

URL = "https://huggingface.co/datasets/Zihan1004/FNSPID/resolve/main/Stock_news/All_external.csv"
OUT = r"C:\users\Noah\claude-workspace\news-trader-data\fnspid-articles.csv"
TICKERS = set("XOM CVX OXY SLB NVDA AMD AMAT MU DAL UAL AAL LMT RTX NOC JPM BAC GS KRE NEM SPY QQQ".split())
GOOD = re.compile(r"\b(beat|miss|guidance|upgrade|downgrade|fda|approv|recall|lawsuit|acqui|merger|earnings|cut|raise|surge|plunge|warn|launch|deal|contract|investigat|bankrupt|outage|hike|sanction|ban|halt|probe|record|jump|tumble|soar|slump|defaul)", re.I)
BAD = re.compile(r"52-week|biggest mover|stocks moving|mid-?day|hit .* high|hit .* low|market update|pre-?market|watchlist|gainers|losers|what to know|here'?s why|to watch|movers", re.I)
PER, TOTAL, MAXSCAN = 22, 250, 8_000_000

counts, rows, scanned = {}, [], 0
with requests.get(URL, stream=True, timeout=600) as r:
    r.raise_for_status()
    it = r.iter_lines(decode_unicode=True)
    cols = next(csv.reader([next(it)]))
    di, ti, si, ai = cols.index("Date"), cols.index("Article_title"), cols.index("Stock_symbol"), cols.index("Article")
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
        if len(rec) <= ai:
            continue
        sym = rec[si].strip().upper()
        if sym not in TICKERS or counts.get(sym, 0) >= PER:
            continue
        title = rec[ti].strip()
        if not title or BAD.search(title) or not GOOD.search(title):
            continue
        article = rec[ai].strip()
        if len(article) < 250:  # require a real body
            continue
        rows.append((rec[di].strip(), title, article[:4000], sym))
        counts[sym] = counts.get(sym, 0) + 1
        if len(rows) % 25 == 0:
            print(f"  {len(rows)} with-body collected (scanned {scanned})…")

with open(OUT, "w", encoding="utf-8", newline="") as f:
    w = csv.writer(f)
    w.writerow(["date", "headline", "article", "ticker"])
    for d, t, a, s in rows:
        w.writerow([d, t, a, s])
print(f"\ncollected {len(rows)} rows WITH article body across {len(counts)} tickers (scanned {scanned})")
print("by ticker:", dict(sorted(counts.items())))
