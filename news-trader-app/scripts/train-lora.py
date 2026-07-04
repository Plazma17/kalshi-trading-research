# QLoRA fine-tune of a Qwen2.5 base on our reaction dataset (headline -> what the
# stock actually did). Trains a LoRA adapter; later merged + converted to GGUF for Ollama.
# Start with 7B (fits 12GB comfortably in 4-bit); bump to 14B once the pipeline works.
import json, os, time, torch
from datetime import datetime, timezone
from datasets import Dataset
from transformers import AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig, TrainerCallback
from peft import LoraConfig
from trl import SFTTrainer, SFTConfig

HERE = os.path.dirname(os.path.abspath(__file__))
MODEL = os.environ.get("NT_BASE", "Qwen/Qwen2.5-7B-Instruct")
DATA = os.path.join(HERE, "train-data.jsonl")
OUT = os.path.join(HERE, os.environ.get("NT_OUT", "lora-out"))
STATUS = os.path.join(os.environ["APPDATA"], "news-trader-app", "default-workspace", "running-status.json")

# Live progress -> the app's RUNNING tab (step count, loss, ETA, loss curve).
class StatusCallback(TrainerCallback):
    def __init__(self):
        self.start = time.time()
        self.last = 0.0
        self.losses = []
        self.started_at = datetime.now(timezone.utc).isoformat()
    def _write(self, state, done=False):
        total = max(int(state.max_steps or 1), 1)
        step = int(state.global_step)
        loss = None
        for h in reversed(state.log_history):
            if "loss" in h:
                loss = h["loss"]; break
        if loss is not None and (not self.losses or self.losses[-1]["x"] != step / total):
            self.losses.append({"x": step / total, "v": float(loss)})
        elapsed = time.time() - self.start
        eta = (elapsed / step * (total - step)) if step else 0
        eta_str = f"{int(eta // 60)}m{int(eta % 60):02d}s"
        msg = f"training step {step}/{total}" + (f"  loss={loss:.3f}" if loss is not None else "") + f"  ETA {eta_str}"
        bignums = [{"label": "STEP", "value": f"{step}/{total}"}]
        if loss is not None:
            bignums.append({"label": "LOSS", "value": f"{loss:.3f}"})
        bignums.append({"label": "ETA", "value": "—" if done else eta_str})
        with open(STATUS, "w", encoding="utf-8") as f:
            json.dump({
                "active": not done, "label": f"FINE-TUNING {MODEL} (LoRA)", "kind": "training",
                "phase": "done" if done else "training", "message": "training complete" if done else msg,
                "fraction": 1.0 if done else step / total, "trades": step, "accuracy": 0,
                "pnlPct": 0, "marketNeutralPct": 0, "bignums": bignums,
                "equity": [], "feed": [],
                "startedAt": self.started_at, "updatedAt": datetime.now(timezone.utc).isoformat()
            }, f)
    def on_step_end(self, args, state, control, **kw):
        now = time.time()
        if now - self.last >= 1.0:
            self.last = now
            self._write(state)
    def on_train_end(self, args, state, control, **kw):
        self._write(state, done=True)

rows = [json.loads(l) for l in open(DATA, encoding="utf-8") if l.strip()]
print(f"{len(rows)} training examples")

tok = AutoTokenizer.from_pretrained(MODEL)
def fmt(ex):
    return {"text": tok.apply_chat_template(ex["messages"], tokenize=False)}
ds = Dataset.from_list(rows).map(fmt, remove_columns=["messages"])

bnb = BitsAndBytesConfig(load_in_4bit=True, bnb_4bit_quant_type="nf4", bnb_4bit_compute_dtype=torch.bfloat16, bnb_4bit_use_double_quant=True)
model = AutoModelForCausalLM.from_pretrained(MODEL, quantization_config=bnb, device_map="auto", dtype=torch.bfloat16)
model.config.use_cache = False

lora = LoraConfig(r=16, lora_alpha=32, lora_dropout=0.05, task_type="CAUSAL_LM",
                  target_modules=["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"])

cfg = SFTConfig(output_dir=OUT, per_device_train_batch_size=2, gradient_accumulation_steps=8,
                num_train_epochs=2, learning_rate=2e-4, bf16=True, logging_steps=10,
                save_strategy="steps", save_steps=40, save_total_limit=2,  # frequent -> restart-safe
                lr_scheduler_type="cosine", warmup_ratio=0.03, optim="paged_adamw_8bit",
                max_length=1024, dataset_text_field="text", report_to="none", gradient_checkpointing=True,
                gradient_checkpointing_kwargs={"use_reentrant": False})
trainer = SFTTrainer(model=model, args=cfg, train_dataset=ds, processing_class=tok, peft_config=lora, callbacks=[StatusCallback()])
# auto-resume from the latest checkpoint in OUT if one exists (survives reboots/kills)
resume = os.path.isdir(OUT) and any(d.startswith("checkpoint-") for d in os.listdir(OUT))
print(f"resuming from checkpoint in {OUT}" if resume else f"fresh training -> {OUT}")
trainer.train(resume_from_checkpoint=resume)
trainer.save_model(OUT)
tok.save_pretrained(OUT)
print(f"done — LoRA adapter saved to {OUT}")
