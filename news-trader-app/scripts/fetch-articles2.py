# Stream the 23GB FNSPID nasdaq file with a PROPER csv parser (handles multi-line
# quoted article bodies). Collect ~200 event headlines WITH full article text for our
# (early-alphabet) universe tickers. Bounded scan so we don't pull all 23GB.
import sys, subprocess, csv, re, io
csv.field_size_limit(10_000_000)
try:
    import requests
except ImportError:
    subprocess.run([sys.executable, "-m", "pip", "install", "-q", "requests"], check=True)
    import requests

URL = "https://huggingface.co/datasets/Zihan1004/FNSPID/resolve/main/Stock_news/nasdaq_exteral_data.csv"
OUT = r"C:\users\Noah\claude-workspace\news-trader-data\fnspid-articles.csv"
TICKERS = set("XOM CVX OXY SLB NVDA AMD AMAT MU DAL UAL AAL LMT RTX NOC JPM BAC GS KRE NEM".split())
GOOD = re.compile(r"\b(beat|miss|guidance|upgrade|downgrade|fda|approv|recall|lawsuit|acqui|merger|earnings|cut|raise|surge|plunge|warn|launch|deal|contract|investigat|bankrupt|outage|hike|sanction|ban|halt|probe|record|jump|tumble|soar|slump|defaul)", re.I)
BAD = re.compile(r"52-week|biggest mover|stocks moving|mid-?day|hit .* high|hit .* low|put and call|options for|market update|pre-?market|watchlist|gainers|losers|what to know|to watch|movers", re.I)
PER, TOTAL, MAXSCAN = 30, 220, 2_500_000

r = requests.get(URL, stream=True, timeout=900)
r.raise_for_status()
r.raw.decode_content = True
stream = io.TextIOWrapper(r.raw, encoding="utf-8", errors="replace")
reader = csv.reader(stream)
cols = next(reader)
di, ti, si, ai = cols.index("Date"), cols.index("Article_title"), cols.index("Stock_symbol"), cols.index("Article")

counts, rows, scanned = {}, [], 0
for rec in reader:
    scanned += 1
    if scanned > MAXSCAN or len(rows) >= TOTAL:
        break
    if len(rec) <= ai:
        continue
    sym = rec[si].strip().upper()
    if sym not in TICKERS or counts.get(sym, 0) >= PER:
        continue
    title = rec[ti].strip()
    if not title or BAD.search(title) or not GOOD.search(title):
        continue
    article = rec[ai].strip()
    if len(article) < 250:
        continue
    rows.append((rec[di].strip(), title, article[:4000], sym))
    counts[sym] = counts.get(sym, 0) + 1
    if len(rows) % 20 == 0:
        print(f"  {len(rows)} with-body collected (scanned {scanned})…")

with open(OUT, "w", encoding="utf-8", newline="") as f:
    w = csv.writer(f)
    w.writerow(["date", "headline", "article", "ticker"])
    for d, t, a, s in rows:
        w.writerow([d, t, a, s])
print(f"\ncollected {len(rows)} rows WITH article body across {len(counts)} tickers (scanned {scanned})")
print("by ticker:", dict(sorted(counts.items())))
