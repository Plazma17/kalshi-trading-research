# Diagnostic: does the MERGED model generate sane output when driven directly by transformers
# (same chat template used in training), bypassing ollama/GGUF? Isolates merge-corruption vs
# ollama-import/template problem. Loads 4-bit for speed.
import os, torch
from transformers import AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig

HERE = os.path.dirname(os.path.abspath(__file__))
MERGED = os.path.join(HERE, "merged-model")
BASE = "Qwen/Qwen2.5-7B-Instruct"

SYS = ('You are a markets analyst. Decide which sector/theme groups a news item moves and how strongly. '
       'direction: bear|down|neutral|up|bull. confidence_pct integer 0-100.\n\n'
       'OUTPUT FORMAT: respond with ONLY a JSON object {"signals":[{"topic":"<lowercase>","direction":"up","confidence_pct":80}]}.')
HEADS = ["Iran closes the Strait of Hormuz to oil tankers.",
         "Pete Najarian thinks regional banks ETF KRE is going up"]

bnb = BitsAndBytesConfig(load_in_4bit=True, bnb_4bit_quant_type="nf4", bnb_4bit_compute_dtype=torch.bfloat16)

def run(tag, path, tok_path):
    print(f"\n===== {tag}: {path} =====")
    tok = AutoTokenizer.from_pretrained(tok_path)
    print(f"eos_token={tok.eos_token!r} eos_id={tok.eos_token_id} pad={tok.pad_token!r} bos={tok.bos_token!r}")
    m = AutoModelForCausalLM.from_pretrained(path, quantization_config=bnb, device_map={"": 0}, dtype=torch.bfloat16)
    print(f"model.config eos_token_id={m.config.eos_token_id} bos_token_id={m.config.bos_token_id}")
    for h in HEADS:
        msgs = [{"role": "system", "content": SYS}, {"role": "user", "content": h}]
        ids = tok.apply_chat_template(msgs, add_generation_prompt=True, return_tensors="pt").to(m.device)
        out = m.generate(ids, max_new_tokens=120, do_sample=False, temperature=None, top_p=None,
                         pad_token_id=tok.eos_token_id)
        txt = tok.decode(out[0][ids.shape[1]:], skip_special_tokens=True)
        print(f"  {h[:38]!r} -> {txt[:200]!r}")
    del m
    torch.cuda.empty_cache()

run("MERGED (own tokenizer)", MERGED, MERGED)
