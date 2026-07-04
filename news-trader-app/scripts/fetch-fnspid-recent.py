# Fetch 2021-2023 event headlines for our universe from FNSPID's nasdaq file (date-DESCENDING,
# runs through 2023-12 — unlike All_external which ends 2020-06). Streams from the top, keeps
# only our tickers + 2021..2023 + real event headlines, and STOPS once it crosses into 2020
# (everything below is older). Gives the multi-regime data (2021 bull, 2022 bear, 2023 recovery)
# the overlay needs to be proven beyond the 2020 COVID crash.
import sys, subprocess, csv, re, io
csv.field_size_limit(100_000_000)
try:
    import requests
except ImportError:
    subprocess.run([sys.executable, "-m", "pip", "install", "-q", "requests"], check=True)
    import requests

URL = "https://huggingface.co/datasets/Zihan1004/FNSPID/resolve/main/Stock_news/nasdaq_exteral_data.csv"
OUT = r"C:\users\Noah\claude-workspace\news-trader-data\fnspid-2021-2023.csv"
TICKERS = set("XOM CVX OXY SLB NVDA AMD AMAT MU DAL UAL AAL LMT RTX NOC JPM BAC GS KRE NEM SPY QQQ".split())
GOOD = re.compile(r"\b(beat|miss|guidance|upgrade|downgrade|fda|approv|recall|lawsuit|acqui|merger|earnings|cut|raise|surge|plunge|warn|launch|deal|contract|investigat|bankrupt|outage|hike|sanction|ban|halt|probe|record|jump|tumble|soar|slump|defaul)", re.I)
BAD = re.compile(r"52-week|biggest mover|stocks moving|mid-?day|hit .* high|hit .* low|put and call|options for|market update|pre-?market|watchlist|gainers|losers|what to know|to watch|movers", re.I)
LO, HI = "2021-01-01", "2023-12-31"
PER, TOTAL, MAXSCAN = 400, 8000, 6_000_000

r = requests.get(URL, stream=True, timeout=900)
r.raise_for_status()
r.raw.decode_content = True
stream = io.TextIOWrapper(r.raw, encoding="utf-8", errors="replace")
reader = csv.reader(stream)
cols = next(reader)
di, ti, si = cols.index("Date"), cols.index("Article_title"), cols.index("Stock_symbol")

counts, rows, scanned, past = {}, [], 0, 0
for rec in reader:
    scanned += 1
    if scanned > MAXSCAN or len(rows) >= TOTAL:
        break
    if len(rec) <= max(di, ti, si):
        continue
    d = rec[di].strip()[:10]
    if d and d < LO:                 # date-descending: we've crossed below 2021
        past += 1
        if past > 30000:             # consistently in 2020 now -> stop
            break
        continue
    if not d or d > HI:
        continue
    past = 0
    sym = rec[si].strip().upper()
    if sym not in TICKERS or counts.get(sym, 0) >= PER:
        continue
    title = rec[ti].strip()
    if not title or BAD.search(title) or not GOOD.search(title):
        continue
    rows.append((d, title, sym))
    counts[sym] = counts.get(sym, 0) + 1
    if len(rows) % 100 == 0:
        print(f"  {len(rows)} collected (scanned {scanned}, at {d})…", flush=True)

with open(OUT, "w", encoding="utf-8", newline="") as f:
    w = csv.writer(f)
    w.writerow(["date", "headline", "ticker"])
    for d, t, s in rows:
        w.writerow([d, t, s])
print(f"\ncollected {len(rows)} headlines across {len(counts)} tickers (scanned {scanned})")
print("by ticker:", dict(sorted(counts.items())))
yr = {}
for d, _, _ in rows:
    yr[d[:4]] = yr.get(d[:4], 0) + 1
print("by year:", dict(sorted(yr.items())))
print("wrote", OUT)
