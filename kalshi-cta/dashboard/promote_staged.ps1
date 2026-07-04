# Promote app.asar.staged -> the live asar the running app loads, then relaunch.
# Run this AFTER closing the CTA Dashboard (the live asar is file-locked while it runs).
$ErrorActionPreference = 'Stop'
$dash  = "C:\Users\Noah\claude-workspace\kalshi-cta\dashboard"
$live  = "$dash\dist\win-unpacked\resources\app.asar"
$staged = "$dash\app.asar.staged"

# refuse if the app is still running (would be locked / partial write)
$proc = Get-Process | Where-Object { $_.ProcessName -match 'CTA Dashboard|electron' }
if ($proc) { Write-Host "CTA Dashboard is still running (PIDs: $($proc.Id -join ', ')). Close it first, then re-run." -ForegroundColor Yellow; exit 1 }

if (-not (Test-Path $staged)) { Write-Host "No app.asar.staged found." -ForegroundColor Red; exit 1 }
Copy-Item $live "$live.bak-$(Get-Date -Format yyyyMMdd_HHmmss)" -ErrorAction SilentlyContinue
Copy-Item $staged $live -Force
Write-Host "Promoted staged -> live ($((Get-Item $live).Length) bytes). Relaunching..." -ForegroundColor Green
$exe = "$dash\dist\win-unpacked\CTA Dashboard.exe"
if (Test-Path $exe) { Start-Process $exe } else { Write-Host "Relaunch manually: $exe" }
