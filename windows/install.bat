@echo off
rem NeuroFly: one-time setup on Windows. Run from the project folder (double-click is fine).
setlocal
cd /d "%~dp0.."
echo === NeuroFly setup ===

where python >NUL 2>&1
if errorlevel 1 (
  echo Python was not found. Install Python 3.11 or 3.12 from python.org and tick "Add python.exe to PATH".
  pause
  exit /b 1
)

if not exist ".venv\Scripts\python.exe" (
  echo Creating virtual environment...
  python -m venv .venv || (echo venv failed & pause & exit /b 1)
)

echo Installing NeuroFly and dependencies...
".venv\Scripts\python.exe" -m pip install --upgrade pip >NUL
".venv\Scripts\python.exe" -m pip install -e ".[gallery]" || (echo pip install failed & pause & exit /b 1)

echo Downloading the connectome (about 105 MB) and building the cache...
".venv\Scripts\neurofly.exe" download || (echo download failed & pause & exit /b 1)

echo Fetching the neuron atlas and the brain outline...
".venv\Scripts\neurofly.exe" archive --meshes || (echo archive failed & pause & exit /b 1)

echo.
echo Done. Start the installation with start.bat
echo Optional: synapses.bat downloads the 2 GB synapse table for real contact points.
pause
