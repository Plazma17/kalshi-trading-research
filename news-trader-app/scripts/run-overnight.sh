#!/usr/bin/env bash
# Autonomous overnight fine-tune pipeline: train LoRA -> merge -> ollama create -> validate.
# All steps run SEQUENTIALLY (torch and ollama never share the GPU at once).
# Logs to overnight.log with timestamps. Stops at the first hard failure.
set -o pipefail
cd "C:/users/Noah/claude-workspace/news-trader-app/scripts" || exit 1

PY="C:/Users/Noah/AppData/Local/Programs/Python/Python312/python.exe"
OLLAMA="C:/Users/Noah/AppData/Local/Programs/Ollama/ollama.exe"
export PATH="/c/Program Files/nodejs:$PATH"
export NT_BASE="${NT_BASE:-Qwen/Qwen2.5-7B-Instruct}"
export HF_HUB_DISABLE_PROGRESS_BARS=0

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

log "================ OVERNIGHT PIPELINE START (base=$NT_BASE) ================"

log "STEP 1/6: free VRAM (unload any ollama models)"
"$OLLAMA" stop qwen2.5:14b 2>/dev/null
"$OLLAMA" stop news-trader 2>/dev/null

log "STEP 2/6: TRAIN LoRA adapter (this is the long one; watch RUNNING tab)"
"$PY" train-lora.py; rc=$?
if [ $rc -ne 0 ]; then log "!! TRAIN FAILED (rc=$rc) — stopping"; exit 1; fi
log "STEP 2 done — adapter in lora-out/"

log "STEP 3/6: MERGE adapter into base (CPU, fp16)"
"$PY" merge-lora.py; rc=$?
if [ $rc -ne 0 ]; then log "!! MERGE FAILED (rc=$rc) — stopping"; exit 1; fi

log "STEP 4/6: ollama create news-trader"
"$OLLAMA" create news-trader -f Modelfile; rc=$?
if [ $rc -ne 0 ]; then log "!! OLLAMA CREATE FAILED (rc=$rc) — stopping"; exit 1; fi

log "STEP 5/6: VALIDATE trained model on held-out window"
NT_MODEL=news-trader node validate-model.mjs 2>&1; log "STEP 5 (trained) exit=$?"

log "STEP 6/6: baseline — validate untrained 7B for honest comparison"
"$OLLAMA" pull qwen2.5:7b-instruct 2>&1 \
  && NT_MODEL=qwen2.5:7b-instruct node validate-model.mjs 2>&1
log "STEP 6 (baseline) exit=$?"

log "================ OVERNIGHT PIPELINE DONE ================"
