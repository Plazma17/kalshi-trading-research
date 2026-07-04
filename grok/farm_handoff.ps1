# FARM HANDOFF — waits for the D fleet to release the GPU/data file, swaps in the
# augmented dataset, then starts the queue runner with the verified speed flags.
# Runs detached; logs to farm_restart.log. Written 2026-07-03 (Noah: "start training all
# the models" — this makes the fleet->farm handoff automatic, no human timing needed).
$G = "C:\Users\Noah\claude-workspace\grok"
$log = Join-Path $G "farm_restart.log"
function Log($m){ Add-Content -Path $log -Value ("{0}  {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $m) -Encoding utf8 }

function FleetActive {
  # ALL fleet-family work: D fleet, the C 1M-epoch extensions the finalizer re-arms,
  # their bash launchers, and the finalizer itself (they hold grok_data.npz / own the GPU).
  $py = Get-CimInstance Win32_Process -Filter "Name='python.exe'" |
    Where-Object { $_.CommandLine -match 'grok_train_D\.py|grok_train_C\.py|grok_fleet|launch_grok|finalize_fleet' }
  $sh = Get-CimInstance Win32_Process -Filter "Name='bash.exe'" |
    Where-Object { $_.CommandLine -match 'launch_grok|finalize_fleet' }
  return ([bool]$py -or [bool]$sh)
}
Log "handoff watcher started; waiting for D fleet to finish"
# require 3 consecutive ABSENT polls 30s apart — the launcher starts diets back-to-back,
# so a single poll can land in the seconds-wide gap between runs and fire early.
$absent = 0
while ($absent -lt 3) {
  if (FleetActive) { $absent = 0 } else { $absent++ }
  Start-Sleep -Seconds 30
}
Log "fleet gone (3 consecutive checks); swapping data"

# swap in the 335-channel dataset (retry a few times in case of a slow file release)
$swapped = $false
for ($i = 0; $i -lt 6; $i++) {
  try {
    if (Test-Path (Join-Path $G "grok_data.pending.npz")) {
      # IDEMPOTENT: only archive the old data if it's still in place. A prior attempt
      # that archived grok_data.npz but then FAILED the pending-move would otherwise
      # re-attempt the archive on a now-missing source and fail EVERY retry, leaving
      # grok_data.npz absent -> the runner crash-loops on np.load. Guarding the archive
      # lets a retry recover: skip archive, just move pending into place.
      if (Test-Path (Join-Path $G "grok_data.npz")) {
        Move-Item (Join-Path $G "grok_data.npz") (Join-Path $G "grok_data.pre_research.npz") -Force -ErrorAction Stop
      }
      Move-Item (Join-Path $G "grok_data.pending.npz") (Join-Path $G "grok_data.npz") -Force -ErrorAction Stop
      Log "data swap OK (old kept as grok_data.pre_research.npz)"
    } else { Log "no pending data file - skipping swap" }
    $swapped = $true; break
  } catch { Log ("swap attempt {0} failed: {1}" -f $i, $_.Exception.Message); Start-Sleep -Seconds 10 }
}
if (-not $swapped) {
  # NEVER leave the runner without a dataset. If the archive step succeeded but the
  # pending move never did, grok_data.npz is MISSING -> restore the old data so the
  # runner starts on OLD data instead of crashing on a missing file.
  if (-not (Test-Path (Join-Path $G "grok_data.npz")) -and (Test-Path (Join-Path $G "grok_data.pre_research.npz"))) {
    try {
      Move-Item (Join-Path $G "grok_data.pre_research.npz") (Join-Path $G "grok_data.npz") -Force -ErrorAction Stop
      Log "SWAP FAILED - restored OLD grok_data.npz from pre_research (runner has data; hod/interaction channels ABSENT this run)"
    } catch { Log ("SWAP FAILED - and could NOT restore grok_data.npz: {0} - runner will crash on load; investigate" -f $_.Exception.Message) }
  }
  Log "SWAP FAILED after retries - starting runner on OLD data (hod/interaction specs DEGRADED/ABSENT this run)"
}

# start the queue runner with the verified speed stack
$env:GROK_FAST = "1"
$env:GROK_BATCH = "1"
# GROK_GRAPH RETIRED 2026-07-03: capture hit cudaErrorStreamCaptureInvalidated and the
# eager fallback ran on the still-invalidated stream -> uncaught -> killed the L05/RA3/RA13
# group. grok_batch now hard-guards this (a capture/replay CUDA error checkpoints + leaves
# the group PENDING to resume EAGER, never 'error') AND reads GROK_GRAPH as == '1', so "0"
# is genuinely OFF. Left OFF here so an automatic handoff can't silently re-enable graph.
$env:GROK_GRAPH = "0"
Set-Location $G
# DOUBLE-RUNNER GUARD: two grok_queue.py instances do NOT see each other as "training"
# (others_training() excludes grok_queue.py), so both would work the queue at once ->
# GPU thrash + both select the same next_spec (nothing marks it 'running' in the file)
# -> duplicate training + racing writes to the same ckpt_q_<id>.pt. Never start a second.
$already = Get-CimInstance Win32_Process -Filter "Name='python.exe'" | Where-Object { $_.CommandLine -match 'grok_queue\.py' }
if ($already) {
  Log ("runner ALREADY RUNNING PID {0} - NOT starting a second (would thrash GPU + double-train specs)" -f $already.ProcessId)
} else {
  Start-Process -FilePath "python" -ArgumentList "grok_queue.py" -WindowStyle Hidden -WorkingDirectory $G
  Start-Sleep -Seconds 20
  $r = Get-CimInstance Win32_Process -Filter "Name='python.exe'" | Where-Object { $_.CommandLine -match 'grok_queue\.py' }
  if ($r) { Log ("runner started PID {0} with GROK_FAST=1 GROK_BATCH=1 GROK_GRAPH=0 (graph retired)" -f $r.ProcessId) } else { Log "RUNNER FAILED TO START - investigate" }
}
Log "handoff complete"
