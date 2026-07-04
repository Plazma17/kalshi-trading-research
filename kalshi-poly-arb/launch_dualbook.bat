@echo off
title DUAL-BOOK LOGGER  --  KEEP THIS WINDOW OPEN
color 0A
echo ============================================================
echo.
echo    DUAL-BOOK LOGGER   (Kalshi vs Polymarket, World Cup)
echo.
echo    *** KEEP THIS WINDOW OPEN ***
echo    Closing this window STOPS the logging.
echo    Live activity prints below so you can see it working.
echo.
echo ============================================================
echo.
cd /d C:\users\Noah\claude-workspace\kalshi-poly-arb
set DB_MINUTES=150
set DB_TICK=1.0
REM print to THIS console (so the window is informative, not blank) -- output is also visible live
"C:\Users\Noah\AppData\Local\Programs\Python\Python312\python.exe" -u dualbook_logger.py
echo.
echo === logger exited ===  (safe to close this window now)
pause
