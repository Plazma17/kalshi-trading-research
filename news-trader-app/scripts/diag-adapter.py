# Fast diagnostic: base (4-bit, cached) + LoRA adapter from lora-out, generate directly.
# Mirrors the training setup. If this is sane -> adapter good, merge/GGUF broke it.
import os, torch
from transformers import AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig
from peft import PeftModel

HERE = os.path.dirname(os.path.abspath(__file__))
BASE = "Qwen/Qwen2.5-7B-Instruct"
ADAPTER = os.path.join(HERE, "lora-out")

SYS = ('You are a markets analyst. Decide which sector/theme groups a news item moves and how strongly. '
       'direction: bear|down|neutral|up|bull. confidence_pct integer 0-100.\n\n'
       'OUTPUT FORMAT: respond with ONLY a JSON object {"signals":[{"topic":"oil","direction":"up","confidence_pct":80}]}.')
HEADS = ["Iran closes the Strait of Hormuz to oil tankers.",
         "Pete Najarian thinks regional banks ETF KRE is going up"]

bnb = BitsAndBytesConfig(load_in_4bit=True, bnb_4bit_quant_type="nf4",
                         bnb_4bit_compute_dtype=torch.bfloat16, bnb_4bit_use_double_quant=True)
tok = AutoTokenizer.from_pretrained(BASE)
print(f"eos={tok.eos_token!r}({tok.eos_token_id}) pad={tok.pad_token!r}", flush=True)
base = AutoModelForCausalLM.from_pretrained(BASE, quantization_config=bnb, device_map={"": 0}, dtype=torch.bfloat16)

def gen(m, tag):
    print(f"\n===== {tag} =====", flush=True)
    for h in HEADS:
        msgs = [{"role": "system", "content": SYS}, {"role": "user", "content": h}]
        enc = tok.apply_chat_template(msgs, add_generation_prompt=True, return_tensors="pt", return_dict=True).to(m.device)
        out = m.generate(**enc, max_new_tokens=100, do_sample=False, pad_token_id=tok.eos_token_id)
        print(f"  {h[:34]!r} -> {tok.decode(out[0][enc['input_ids'].shape[1]:], skip_special_tokens=True)[:180]!r}", flush=True)

gen(base, "BASE only (sanity)")
model = PeftModel.from_pretrained(base, ADAPTER)
gen(model, "BASE + TRAINED ADAPTER")
