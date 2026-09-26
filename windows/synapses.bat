@echo off
chcp 65001 >NUL
rem NeuroFly: download the synapse table (2 GB) and build the index of real contact points. One-off, 5-15 minutes.
setlocal
cd /d "%~dp0.."
set PYTHONPATH=%CD%
if not exist ".venv\Scripts\python.exe" (echo Run install.bat first & pause & exit /b 1)
".venv\Scripts\python.exe" -m neurofly.cli archive --synapses
echo.
echo Done. Restart start.bat to use the synapse points.
pause
