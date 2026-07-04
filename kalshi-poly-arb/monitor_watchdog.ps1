# monitor watchdog -- runs every ~10 min as Scheduled Task "monitor_watchdog" (2026-07-02).
# Auto-launches the in-play cross-venue arb monitor (monitor.py) so a World Cup match's
# in-play window is never missed for want of a manual launch (ESP-AUT was lost that way).
#
#   * monitor.py already running          -> NO-OP (single-instance guard; never dup-launch)
#   * not running AND a WC match is within
#     its pre-window (derived from watchlist.json game_start, same source monitor.py uses)
#                                         -> launch it (detached, hidden, --live-only)
#   * not running AND no upcoming match   -> NO-OP ("no upcoming match")
#
# The monitor is OBSERVATION-ONLY (alert + CSV log; it never trades). All actions -> watchdog
# log below. Durable across reboots (Scheduled Task). Mirrors pm_duallog_watchdog.ps1.
$ErrorActionPreference = "SilentlyContinue"
$dir = "C:\Users\Noah\claude-workspace\kalshi-poly-arb"
$py = "C:\Users\Noah\AppData\Local\Programs\Python\Python312\python.exe"
$script = "$dir\monitor.py"
$watchlist = "$dir\watchlist.json"
$wlog = "$dir\monitor_watchdog.log"
$stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'

# Launch flags: fast-poll live matches, structured CSV logging on.
$monArgs = @("-u", $script, "--live-only", "--interval", "5", "--pre-min", "10",
             "--match-min", "150", "--log-all")

# --- single-instance guard: is a monitor.py already running? ---
$procs = @(Get-CimInstance Win32_Process -Filter "Name='python.exe'" |
           Where-Object { $_.CommandLine -like "*monitor.py*" })
if ($procs.Count -ge 1) {
    "$stamp  monitor.py already running [pid $($procs.ProcessId -join ',')] -> no-op" |
        Out-File -Append -Encoding utf8 $wlog
    return
}

# --- derive the upcoming-match schedule the SAME way monitor.py does (watchlist game_start) ---
# Launch if now is inside [kickoff - LEAD, kickoff + MATCH_MIN] for any pair. LEAD =
# pre_min(10) + task interval(10) = 20 min, so the monitor is always up before its own
# pre-window opens despite the 10-min task cadence. match_min = 150 (90m + ET/pens + stoppage).
$LEAD_MIN = 20
$MATCH_MIN = 150
$nowUtc = (Get-Date).ToUniversalTime()

$inWindow = $false
$nextKick = $null
if (Test-Path $watchlist) {
    $pairs = (Get-Content $watchlist -Raw | ConvertFrom-Json).pairs
    foreach ($p in $pairs) {
        if (-not $p.game_start) { continue }
        $gs = $null
        try { $gs = [datetimeoffset]::Parse($p.game_start).UtcDateTime } catch { continue }
        $winStart = $gs.AddMinutes(-$LEAD_MIN)
        $winEnd = $gs.AddMinutes($MATCH_MIN)
        if ($nowUtc -ge $winStart -and $nowUtc -le $winEnd) { $inWindow = $true }
        if ($gs -gt $nowUtc -and ($null -eq $nextKick -or $gs -lt $nextKick)) { $nextKick = $gs }
    }
}

if (-not $inWindow) {
    $nk = if ($nextKick) { "next kickoff $($nextKick.ToString('yyyy-MM-dd HH:mm'))Z" } else { "none" }
    "$stamp  not running; no WC match in pre-window ($nk) -> no-op" |
        Out-File -Append -Encoding utf8 $wlog
    return
}

# --- launch (detached, hidden); re-check just before to avoid a race dup-launch ---
$procs2 = @(Get-CimInstance Win32_Process -Filter "Name='python.exe'" |
            Where-Object { $_.CommandLine -like "*monitor.py*" })
if ($procs2.Count -ge 1) {
    "$stamp  raced -> monitor.py started elsewhere [pid $($procs2.ProcessId -join ',')] -> no-op" |
        Out-File -Append -Encoding utf8 $wlog
    return
}

"$stamp  not running + WC match in window -> launching monitor.py --live-only --log-all" |
    Out-File -Append -Encoding utf8 $wlog
Start-Process -WindowStyle Hidden -FilePath $py -ArgumentList $monArgs `
    -RedirectStandardOutput "$dir\monitor_watchdog_launch.out" `
    -RedirectStandardError "$dir\monitor_watchdog_launch.err" `
    -WorkingDirectory $dir
Start-Sleep -Seconds 3
$p = @(Get-CimInstance Win32_Process -Filter "Name='python.exe'" |
       Where-Object { $_.CommandLine -like "*monitor.py*" })
"$stamp  started -> $($p.Count) proc(s) [pid $($p.ProcessId -join ',')]" |
    Out-File -Append -Encoding utf8 $wlog
