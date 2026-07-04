# Stream just the first N rows of FNSPID's 5.7GB news CSV (downloads ~a few MB,
# then stops) into a manageable real-news sample the app can import.
import sys, subprocess
try:
    import requests
except ImportError:
    subprocess.run([sys.executable, "-m", "pip", "install", "-q", "requests"], check=True)
    import requests

URL = "https://huggingface.co/datasets/Zihan1004/FNSPID/resolve/main/Stock_news/All_external.csv"
OUT = r"C:\users\Noah\claude-workspace\news-trader-data\fnspid-sample.csv"
N = 25000

with requests.get(URL, stream=True, timeout=120) as r:
    r.raise_for_status()
    it = r.iter_lines(decode_unicode=True)
    header = next(it)
    print("HEADER:", header)
    count = 0
    with open(OUT, "w", encoding="utf-8", newline="") as f:
        f.write(header + "\n")
        for line in it:
            if not line:
                continue
            f.write(line + "\n")
            count += 1
            if count <= 4:
                print("ROW:", line[:220])
            if count >= N:
                break
print(f"\nwrote {count} rows to {OUT}")
