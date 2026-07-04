@echo off
title WC ARB LIVE (Jun23 eve) - REAL MONEY $10/side total - pre-fire /book gate
set ARB_LIVE=1
set ARB_PER_VENUE=10
set ARB_MINUTES=210
cd /d C:\users\Noah\claude-workspace\kalshi-poly-arb
"C:\Users\Noah\AppData\Local\Programs\Python\Python312\python.exe" -u arb_live.py > arb_live_jun23.log 2>&1
