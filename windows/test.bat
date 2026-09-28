@echo off
chcp 65001 >NUL
rem NeuroFly: quick check that the model runs and how fast (look for "x slower than real time" and the MN9 rate).
setlocal
cd /d "%~dp0.."
set PYTHONPATH=%CD%
set NUMBA_CACHE_DIR=%TEMP%\neurofly_numba
echo === 1/2: exact (rest threshold 0.2 mV) ===
".venv\Scripts\python.exe" -m neurofly.cli run --activate sugar --rate 200 --trials 3
echo.
echo === 2/2: fast (rest threshold 1.0 mV) ===
".venv\Scripts\python.exe" -m neurofly.cli run --activate sugar --rate 200 --trials 3 --eps 1.0
echo.
echo Look at "engine:" (must say numba) and "speed ...x real time" in both runs: 1.0 or more is real time.
pause
