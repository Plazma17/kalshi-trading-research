@echo off
title WC ARB LIVE - SUICAN + BIHQAT - REAL MONEY $10/side - KEEP OPEN
color 0E
echo ==================================================================
echo   WORLD CUP ARB EXECUTOR -- LIVE REAL MONEY ($10 per side)
echo   Games: SUI v CAN + BIH v QAT   (1 PM EDT, Wed Jun 24)
echo   Places REAL IOC orders on qualifying cross-venue gaps.
echo   Safe: leg-risk protocol, $10/side hard cap, auto-unwind.
echo   Output also logged to arb_live_jun24.log -- KEEP THIS OPEN.
echo ==================================================================
cd /d C:\users\Noah\claude-workspace\kalshi-poly-arb
set ARB_LIVE=1
set ARB_PER_VENUE=10
set ARB_MINUTES=160
"C:\Users\Noah\AppData\Local\Programs\Python\Python312\python.exe" -u arb_live.py > arb_live_jun24.log 2>&1
echo.
echo === arb run ended (see arb_live_jun24.log) ===
pause
