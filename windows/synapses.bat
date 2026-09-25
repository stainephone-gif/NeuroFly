@echo off
rem NeuroFly: download the synapse table (2 GB) and build the index of real contact points. One-off, 5-15 minutes.
setlocal
cd /d "%~dp0.."
if not exist ".venv\Scripts\neurofly.exe" (echo Run install.bat first & pause & exit /b 1)
".venv\Scripts\neurofly.exe" archive --synapses
echo.
echo Done. Restart start.bat to use the synapse points.
pause
