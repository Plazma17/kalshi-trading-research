@echo off
title WC ARB LIVE -- ARG v CPV -- REAL MONEY $10/side -- ALL GATES + HARD-KILLS ON
color 0E
echo ==================================================================
echo   WORLD CUP ARB EXECUTOR -- LIVE REAL MONEY ($10 per side)
echo   Game: ARG v CPV  (22:00Z / 6PM ET, 2026-07-03)
echo   *** LAUNCH AT ~21:50Z -- NOT EARLIER (live pairs picked at start) ***
echo   Gates: MIN_EDGE 0.07 (after both fees; +3c cushion for the REAL
echo          PM taker fee 0.06*p*(1-p)/leg the preview hides), verified-
echo          deep, pre-fire re-check, leg-safe sequencing.
echo   Hard-kills: 2-strike leg-risk, session -$8, $10/venue code cap.
echo   Output -> arb_live_argcpv.log ; kills -> arb_kill.log. KEEP OPEN.
echo ==================================================================
cd /d C:\users\Noah\claude-workspace\kalshi-poly-arb
set ARB_LIVE=1
set ARB_PER_VENUE=10
set ARB_MIN_EDGE=0.07
set ARB_MINUTES=160
"C:\Users\Noah\AppData\Local\Programs\Python\Python312\python.exe" -u arb_live.py > arb_live_argcpv.log 2>&1
echo.
echo === arb run ended (see arb_live_argcpv.log / arb_kill.log) ===
pause
