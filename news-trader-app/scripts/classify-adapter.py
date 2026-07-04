# Classify held-out headlines with base+adapter via transformers (bypasses the broken ollama
# GGUF export). BATCHED generation (NT_BATCH headlines per GPU forward pass) for speed -- this
# is the "parallel requests" idea applied where it actually helps: inference, not training.
# Writes {headline: [signals]} that validate-model.mjs scores via NT_PRECLASSIFIED.
import os, csv, json, re, time, torch
from transformers import AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig
from peft import PeftModel

HERE = os.path.dirname(os.path.abspath(__file__))
BASE = "Qwen/Qwen2.5-7B-Instruct"
ADAPTER = os.environ.get("NT_ADAPTER", os.path.join(HERE, "lora-out"))
CSV = os.path.join(HERE, "..", "..", "news-trader-data", "fnspid-universe.csv")
CUTOFF = "2019-11-25"
SYS = open(os.path.join(HERE, "train-system.txt"), encoding="utf-8").read()
STATUS = os.path.join(os.environ["APPDATA"], "news-trader-app", "default-workspace", "running-status.json")
BATCH = int(os.environ.get("NT_BATCH", "16"))
SKIP_BASE = os.environ.get("NT_SKIP_BASE", "1") == "1"  # default: adapter only (base pass is degenerate)

UNIVERSE = {"XOM","CVX","OXY","SLB","NVDA","AMD","AMAT","MU","DAL","UAL","AAL",
            "LMT","RTX","NOC","JPM","BAC","GS","KRE","NEM","GOLD","SPY","QQQ"}

heads, seen = [], set()
with open(CSV, encoding="utf-8") as f:
    for r in csv.DictReader(f):
        d = (r.get("date") or "")[:10]
        if len(d) != 10 or d <= CUTOFF: continue
        if (r.get("ticker") or "").strip().upper() not in UNIVERSE: continue
        h = r.get("headline") or ""
        if h and h not in seen:
            seen.add(h); heads.append(h)
LIMIT = int(os.environ.get("NT_LIMIT", "0"))  # smoke-test cap (0 = all)
if LIMIT: heads = heads[:LIMIT]
print(f"{len(heads)} unique held-out headlines, batch={BATCH}", flush=True)

bnb = BitsAndBytesConfig(load_in_4bit=True, bnb_4bit_quant_type="nf4",
                         bnb_4bit_compute_dtype=torch.bfloat16, bnb_4bit_use_double_quant=True)
tok = AutoTokenizer.from_pretrained(BASE)
tok.padding_side = "left"  # left-pad so generated tokens align across the batch
if tok.pad_token is None: tok.pad_token = tok.eos_token
model = AutoModelForCausalLM.from_pretrained(BASE, quantization_config=bnb, device_map={"": 0}, dtype=torch.bfloat16)
model = PeftModel.from_pretrained(model, ADAPTER)
model.eval()

VALID_DIR = {"bear","down","neutral","up","bull"}
def parse(txt):
    try:
        m = re.search(r"\{.*\}", txt, re.S)
        sigs = json.loads(m.group(0)).get("signals", []) if m else []
    except Exception:
        return []
    out = []
    for s in (sigs if isinstance(sigs, list) else []):
        try:
            d = str(s.get("direction","")).lower()
            if d not in VALID_DIR: continue
            out.append({"topic": str(s.get("topic","")).lower(), "direction": d,
                        "confidence_pct": int(float(s.get("confidence_pct", 0)))})
        except Exception:
            continue
    return out

@torch.no_grad()
def gen_batch(batch):
    prompts = [tok.apply_chat_template([{"role":"system","content":SYS},{"role":"user","content":h}],
                                       add_generation_prompt=True, tokenize=False) for h in batch]
    enc = tok(prompts, return_tensors="pt", padding=True).to(model.device)
    out = model.generate(**enc, max_new_tokens=128, do_sample=False, pad_token_id=tok.eos_token_id)
    gen = out[:, enc["input_ids"].shape[1]:]
    return [parse(t) for t in tok.batch_decode(gen, skip_special_tokens=True)]

def write_status(i, n, t0):
    eta = (time.time()-t0)/max(i,1)*(n-i)
    try:
        json.dump({"active": i<n, "label": "CLASSIFYING held-out — ADAPTER v2 (batched)", "kind":"classifying",
                   "phase":"classifying" if i<n else "done", "message": f"{i}/{n}  ETA {int(eta//60)}m{int(eta%60):02d}s",
                   "fraction": i/n, "trades": i, "accuracy":0, "pnlPct":0, "marketNeutralPct":0,
                   "bignums":[{"label":"DONE","value":f"{i}/{n}"},{"label":"ETA","value":f"{int(eta//60)}m{int(eta%60):02d}s"},{"label":"BATCH","value":str(BATCH)}],
                   "equity":[], "feed":[], "startedAt":"", "updatedAt":""}, open(STATUS,"w",encoding="utf-8"))
    except Exception: pass

def run_pass(outfile):
    res = {}; n = len(heads); t0 = time.time()
    for i in range(0, n, BATCH):
        batch = heads[i:i+BATCH]
        for h, sig in zip(batch, gen_batch(batch)): res[h] = sig
        done = min(i+BATCH, n)
        json.dump(res, open(outfile,"w",encoding="utf-8")); write_status(done, n, t0)
        print(f"{done}/{n}  ({(time.time()-t0)/done:.2f}s/ea)", flush=True)
    nonempty = sum(1 for v in res.values() if v)
    print(f"DONE -> {outfile}  ({nonempty}/{n} produced >=1 signal)", flush=True)

run_pass(os.path.join(HERE, "adapter-classifications.json"))
print("ALL DONE", flush=True)
