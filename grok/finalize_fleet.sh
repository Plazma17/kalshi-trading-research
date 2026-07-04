#!/usr/bin/env bash
# Durable MODE-D fleet finalizer. Waits for the fleet to finish, regenerates the
# deliverables, then re-arms the C 1,000,000-epoch extension (which waits on the
# C2-done marker and resumes ckpts). Launched detached via Start-Process.
# NOTE: deliberately NO launcher-respawn guard — Windows/bash process detection is
# unreliable here and a false negative would double-launch and corrupt ckpts. If
# the launcher dies before FLEET-done, resume manually: `bash launch_grok_D.sh`.
cd /c/Users/Noah/claude-workspace/grok
while ! grep -q "=== FLEET done" run_D.log 2>/dev/null; do sleep 30; done
echo "=== FINALIZE: fleet done $(date) ===" >> finalize_fleet.log
python grok_fleet_summary.py >> finalize_fleet.log 2>&1
python grok_fleet_chart.py   >> finalize_fleet.log 2>&1
echo "=== deliverables regenerated $(date) ===" >> finalize_fleet.log
nohup bash launch_grok_C_ext.sh >> finalize_fleet.log 2>&1 &
echo "=== C extension re-armed $(date) ===" >> finalize_fleet.log
echo "DONE $(date)" > FLEET_FINALIZED.flag
