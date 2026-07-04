import sys, subprocess, csv
try:
    import requests
except ImportError:
    subprocess.run([sys.executable, "-m", "pip", "install", "-q", "requests"], check=True)
    import requests

URL = "https://huggingface.co/datasets/Zihan1004/FNSPID/resolve/main/Stock_news/nasdaq_exteral_data.csv"
with requests.get(URL, stream=True, timeout=120) as r:
    r.raise_for_status()
    it = r.iter_lines(decode_unicode=True)
    header = next(it)
    print("HEADER:", header)
    cols = next(csv.reader([header]))
    shown = 0
    for line in it:
        if not line:
            continue
        try:
            rec = next(csv.reader([line]))
        except Exception:
            continue
        # find the longest field (likely the article body) and report its length
        lens = [(cols[i] if i < len(cols) else f"col{i}", len(v)) for i, v in enumerate(rec)]
        longest = max(lens, key=lambda x: x[1])
        print(f"row: longest field = {longest[0]} ({longest[1]} chars); sample: {rec[:3]}")
        shown += 1
        if shown >= 3:
            break
