#!/usr/bin/env bash
# Re-run held-out validation after the grammar fix. Quantizes the fp16 merged model to
# q4_K_M (fits 12GB VRAM, fast, and apples-to-apples vs the q4 ollama baselines), then
# validates trained vs untrained-7B vs 14B on the same held-out window.
set -o pipefail
cd "C:/users/Noah/claude-workspace/news-trader-app/scripts" || exit 1
OLLAMA="C:/Users/Noah/AppData/Local/Programs/Ollama/ollama.exe"
export PATH="/c/Program Files/nodejs:$PATH"
export NT_MAX="${NT_MAX:-800}"   # cap held-out headlines per model for a sane overnight runtime
log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

log "================ RE-VALIDATE START (NT_MAX=$NT_MAX) ================"
for M in news-trader qwen2.5:7b-instruct qwen2.5:14b news-trader-q4; do "$OLLAMA" stop "$M" 2>/dev/null; done

log "STEP A: quantize trained model -> news-trader-q4 (q4_K_M)"
"$OLLAMA" create news-trader-q4 -q q4_K_M -f Modelfile; rc=$?
if [ $rc -ne 0 ]; then log "!! quantize failed (rc=$rc) — falling back to fp16 news-trader"; QMODEL="news-trader"; else QMODEL="news-trader-q4"; fi

for M in "$QMODEL" qwen2.5:7b-instruct qwen2.5:14b; do
  log ">>> VALIDATING $M"
  NT_MODEL="$M" node validate-model.mjs 2>&1
  log ">>> $M exit=$?"
  "$OLLAMA" stop "$M" 2>/dev/null
done
log "================ RE-VALIDATE DONE ================"
