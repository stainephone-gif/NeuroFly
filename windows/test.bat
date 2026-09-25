@echo off
rem NeuroFly: quick check that the model runs and how fast (look for "x slower than real time" and the MN9 rate).
setlocal
cd /d "%~dp0.."
set NUMBA_CACHE_DIR=%TEMP%\neurofly_numba
".venv\Scripts\neurofly.exe" run --activate sugar --rate 200 --trials 3
pause
