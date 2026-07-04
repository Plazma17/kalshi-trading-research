#!/usr/bin/env bash
# Extension pass: after the 100k C1->C2 pass completes, resume BOTH from their
# checkpoints and train to 1,000,000 epochs (~1 hr each at ~290 ep/s observed).
# Rationale: full-batch tiny-MLP throughput came in ~1000x faster than the
# 0.3-0.7 s/epoch estimate, so 100k epochs = ~7 min; grokking's long tail
# (10^5-10^6 steps) needs the extension. Curves are continuous (resume+append).
cd /c/Users/Noah/claude-workspace/grok
while ! grep -q "=== C2 done" run_C2.log 2>/dev/null; do sleep 30; done
echo "=== C1 EXT start $(date) ===" >> run_C1.log
GROKC_EPOCHS=1000000 python grok_train_C.py C1 >> run_C1.log 2>&1
echo "=== C1 EXT done $(date) ===" >> run_C1.log
echo "=== C2 EXT start $(date) ===" >> run_C2.log
GROKC_EPOCHS=1000000 python grok_train_C.py C2 >> run_C2.log 2>&1
echo "=== C2 EXT done $(date) ===" >> run_C2.log
