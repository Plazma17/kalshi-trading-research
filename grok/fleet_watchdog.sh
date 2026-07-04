#!/usr/bin/env bash
# MODE-D fleet anti-wedge watchdog. The observed failure mode (D1 ep76.6k, D5
# ep72.4k) = the training python wedges: alive + 100% CPU + 0% GPU + log frozen.
# Every 60 s: if the current run_D<k>.log hasn't been written in >300 s while a
# grok_train_D python is alive, kill that python -- ckpts save every 200 epochs,
# so <=200 epochs are lost and the launcher advances to the next run (all
# resumable). Exits when the fleet finishes. Never touches the launcher itself.
cd /c/Users/Noah/claude-workspace/grok
echo "watchdog start $(date)" >> fleet_watchdog.log
while ! grep -q "=== FLEET done" run_D.log 2>/dev/null; do
  sleep 60
  R=$(grep -oE "D[0-9]+ start" run_D.log 2>/dev/null | tail -1 | grep -oE "D[0-9]+")
  [ -z "$R" ] && continue
  # is that run still marked running (no done line after its last start)?
  last=$(grep -E "=== $R (start|done)" run_D.log | tail -1)
  case "$last" in *done*) continue;; esac
  [ -f "run_$R.log" ] || continue
  age=$(( $(date +%s) - $(stat -c %Y "run_$R.log") ))
  if [ "$age" -gt 300 ]; then
    PID=$(powershell -NoProfile -Command "(Get-CimInstance Win32_Process | Where-Object { \$_.CommandLine -match 'grok_train_D\.py' -and \$_.Name -eq 'python.exe' } | Select-Object -First 1).ProcessId" 2>/dev/null | tr -d '[:space:]')
    if [ -n "$PID" ]; then
      echo "$(date) WEDGE: $R log frozen ${age}s -> killing python $PID (ckpt-resumable)" >> fleet_watchdog.log
      taskkill //PID "$PID" //F >> fleet_watchdog.log 2>&1
    fi
  fi
done
echo "watchdog exit (fleet done) $(date)" >> fleet_watchdog.log
