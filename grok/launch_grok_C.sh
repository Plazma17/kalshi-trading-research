#!/usr/bin/env bash
# Sequential grok Mode C launcher: C1 (wd=0.05) then C2 (wd=0.10), 100k epochs each.
# Both resumable (ckpt_C1.pt / ckpt_C2.pt). Detached; survives parent exit.
cd /c/Users/Noah/claude-workspace/grok
echo "=== C1 start $(date) ===" >> run_C1.log
python grok_train_C.py C1 >> run_C1.log 2>&1
echo "=== C1 done $(date) ===" >> run_C1.log
echo "=== C2 start $(date) ===" >> run_C2.log
python grok_train_C.py C2 >> run_C2.log 2>&1
echo "=== C2 done $(date) ===" >> run_C2.log
