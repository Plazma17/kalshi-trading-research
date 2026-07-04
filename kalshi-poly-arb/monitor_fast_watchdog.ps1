# monitor_fast watchdog -- runs every ~10 min as Scheduled Task "monitor_fast_watchdog".
# Keeps the WS-driven real-time cross-venue arb monitor (monitor_fast.py) alive so a World Cup
# match's in-play window is covered at ~4 Hz push cadence (monitor_fast idles between matches and
# auto-covers each match when its pre-window opens, so this only needs to keep ONE instance up).
#
#   * monitor_fast.py already running -> NO-OP (single-instance guard; never dup-launch)
#   * not running                      -> launch it (detached, hidden; it self-idles until a match)
#
# monitor_fast.py is OBSERVATION-ONLY (WS reads + CSV/alert log; it NEVER trades) and is fully
# independent of arb_live.py / arb_executor.py, so running it cannot disturb a live executor run.
# Distinct output files (inplay_gaps_fast.csv / alerts_fast.jsonl) => coexists with monitor.py.
$ErrorActionPreference = "SilentlyContinue"
$dir = "C:\Users\Noah\claude-workspace\kalshi-poly-arb"
$py = "C:\Users\Noah\AppData\Local\Programs\Python\Python312\python.exe"
$script = "$dir\monitor_fast.py"
$wlog = "$dir\monitor_fast_watchdog.log"
$stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'

$monArgs = @("-u", $script, "--min-profit", "0.02", "--eval-ms", "250")

# --- single-instance guard ---
$procs = @(Get-CimInstance Win32_Process -Filter "Name='python.exe'" |
           Where-Object { $_.CommandLine -like "*monitor_fast.py*" })
if ($procs.Count -ge 1) {
    "$stamp  monitor_fast.py already running [pid $($procs.ProcessId -join ',')] -> no-op" |
        Out-File -Append -Encoding utf8 $wlog
    return
}

"$stamp  not running -> launching monitor_fast.py (WS, 4 Hz)" |
    Out-File -Append -Encoding utf8 $wlog
Start-Process -WindowStyle Hidden -FilePath $py -ArgumentList $monArgs `
    -RedirectStandardOutput "$dir\monitor_fast.out" `
    -RedirectStandardError "$dir\monitor_fast.err" `
    -WorkingDirectory $dir
Start-Sleep -Seconds 3
$p = @(Get-CimInstance Win32_Process -Filter "Name='python.exe'" |
       Where-Object { $_.CommandLine -like "*monitor_fast.py*" })
"$stamp  started -> $($p.Count) proc(s) [pid $($p.ProcessId -join ',')]" |
    Out-File -Append -Encoding utf8 $wlog
