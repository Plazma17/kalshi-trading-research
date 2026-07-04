# After training: merge the LoRA adapter into the base weights (on CPU to spare VRAM
# for anything else), write a merged safetensors model that Ollama can import directly.
import os, torch
from transformers import AutoModelForCausalLM, AutoTokenizer
from peft import PeftModel

HERE = os.path.dirname(os.path.abspath(__file__))
BASE = os.environ.get("NT_BASE", "Qwen/Qwen2.5-7B-Instruct")
ADAPTER = os.path.join(HERE, "lora-out")
OUT = os.path.join(HERE, "merged-model")

print(f"loading base {BASE} (cpu, fp16)…")
base = AutoModelForCausalLM.from_pretrained(BASE, dtype=torch.float16, device_map="cpu")
print("applying adapter + merging…")
model = PeftModel.from_pretrained(base, ADAPTER)
model = model.merge_and_unload()
model.save_pretrained(OUT, safe_serialization=True)
AutoTokenizer.from_pretrained(BASE).save_pretrained(OUT)
print(f"merged model -> {OUT}")

# write a Modelfile so `ollama create news-trader -f scripts/Modelfile` imports it
with open(os.path.join(HERE, "Modelfile"), "w", encoding="utf-8") as f:
    f.write("FROM ./merged-model\nPARAMETER temperature 0\nPARAMETER num_ctx 4096\n")
print("wrote Modelfile — next: ollama create news-trader -f scripts/Modelfile")
