#!/usr/bin/env bash
# MODE D DIET FLEET launcher: D1..D10 sequential, 100k epochs each, grok regime.
# Each resumable (ckpt_D<k>.pt) + writes progress_D<k>.json (GROK MONITOR auto-discovers).
# Detached; survives parent exit. Waits for C2's 100k pass to finish first so the
# GPU is free. NOTE: the C 1,000,000-epoch extension is re-armed SEPARATELY after the
# fleet via launch_grok_C_ext.sh (kept out of this loop so the fleet stays self-contained).
cd /c/Users/Noah/claude-workspace/grok
while ! grep -q "=== C2 done" run_C2.log 2>/dev/null; do sleep 15; done
echo "=== FLEET start $(date) ===" >> run_D.log
for R in D1 D2 D3 D4 D5 D6 D7 D8 D9 D10; do
  echo "=== $R start $(date) ===" >> run_D.log
  python grok_train_D.py $R >> run_$R.log 2>&1
  echo "=== $R done $(date) ===" >> run_D.log
done
echo "=== FLEET done $(date) ===" >> run_D.log
