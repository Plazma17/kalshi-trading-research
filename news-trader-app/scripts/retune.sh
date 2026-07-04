#!/usr/bin/env bash
# v2 retune: retrain on market-neutral (excess-vs-SPY) balanced labels, then validate via the
# transformers base+adapter path (ollama GGUF export is broken), BATCHED for speed. Steps run
# sequentially (torch owns the GPU during train + classify; scoring is CPU/network).
set -o pipefail
cd "C:/users/Noah/claude-workspace/news-trader-app/scripts" || exit 1
PY="C:/Users/Noah/AppData/Local/Programs/Python/Python312/python.exe"
OLLAMA="C:/Users/Noah/AppData/Local/Programs/Ollama/ollama.exe"
export PATH="/c/Program Files/nodejs:$PATH"
export NT_BASE="Qwen/Qwen2.5-7B-Instruct"
export NT_OUT="lora-out-v2"      # dedicated v2 dir (no stale v1 checkpoints; auto-resume-safe)
export NT_ADAPTER="$PWD/lora-out-v2"
log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

log "================ RETUNE v2 START (excess-return balanced labels) ================"
log "STEP 1/4: free VRAM"
for M in qwen2.5:14b news-trader news-trader-q4 qwen2.5:7b-instruct; do "$OLLAMA" stop "$M" 2>/dev/null; done

log "STEP 2/4: TRAIN v2 LoRA (watch RUNNING tab)"
"$PY" train-lora.py; rc=$?
if [ $rc -ne 0 ]; then log "!! TRAIN FAILED (rc=$rc)"; exit 1; fi
log "STEP 2 done — v2 adapter in lora-out/"

log "STEP 3/4: CLASSIFY held-out (base+adapter v2, batched x16)"
NT_BATCH=16 NT_SKIP_BASE=1 "$PY" classify-adapter.py; rc=$?
if [ $rc -ne 0 ]; then log "!! CLASSIFY FAILED (rc=$rc)"; exit 1; fi

log "STEP 4/4: SCORE + DEEP BREAKDOWN"
NT_PRECLASSIFIED=adapter-classifications.json NT_MODEL=trained-v2 node validate-model.mjs 2>&1 | grep -vE "ExperimentalWarning|yahooSurvey|--trace-warnings|ripHistorical"
node analyze-adapter.mjs 2>&1 | grep -vE "ExperimentalWarning|yahooSurvey|--trace-warnings|ripHistorical"
log "================ RETUNE v2 DONE ================"
