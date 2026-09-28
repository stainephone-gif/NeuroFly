@echo off
chcp 65001 >NUL
rem NeuroFly: one-time setup on Windows. Double-click it; it can be re-run safely.
setlocal EnableDelayedExpansion
cd /d "%~dp0.."
set PYTHONPATH=%CD%
echo === NeuroFly setup ===
echo Folder: %CD%
echo.

rem ---- find a real Python 3.10-3.14 --------------------------------------
rem "python" on a fresh Windows is often only a Microsoft Store stub that does nothing,
rem so try the py launcher first and check that the interpreter actually runs.
set PY=
for %%V in (3.12 3.11 3.13 3.10 3.14) do (
  if not defined PY (
    py -%%V -c "import sys" >NUL 2>&1 && set "PY=py -%%V"
  )
)
if not defined PY (
  python -c "import sys; assert (3,10) <= sys.version_info[:2] <= (3,14)" >NUL 2>&1 && set "PY=python"
)
if not defined PY (
  echo Python 3.10-3.14 was not found on this computer.
  echo.
  echo  1. Download Python 3.12 from https://www.python.org/downloads/windows/
  echo  2. On the first screen of the installer tick "Add python.exe to PATH"
  echo  3. Run install.bat again.
  echo.
  echo If typing "python" opens Microsoft Store, that is only a stub, not Python.
  echo What Windows finds under the name "python":
  where python 2>NUL
  pause
  exit /b 1
)
echo Using Python:
!PY! -c "import sys; print(' ', sys.version.split()[0], sys.executable)"
echo.

rem ---- virtual environment -----------------------------------------------
if exist ".venv" if not exist ".venv\Scripts\python.exe" (
  echo Removing a half-made .venv from an earlier attempt...
  rmdir /s /q ".venv"
)
rem a .venv copied from another computer points to a Python that does not exist here
if exist ".venv\Scripts\python.exe" (
  ".venv\Scripts\python.exe" -c "import sys" >NUL 2>&1
  if errorlevel 1 (
    echo The .venv folder was made on another computer and does not work here. Recreating it...
    rmdir /s /q ".venv"
  )
)
if not exist ".venv\Scripts\python.exe" (
  echo Creating virtual environment...
  !PY! -m venv .venv
  if errorlevel 1 (
    echo.
    echo Could not create the virtual environment. The message above says why.
    echo Common causes:
    echo  - antivirus blocked python.exe from being copied: allow it and retry;
    echo  - no free disk space;
    echo  - the folder is read-only or on a network drive: move the project to C:\ or D:\.
    pause
    exit /b 1
  )
)

echo Installing NeuroFly and dependencies (a few minutes)...
".venv\Scripts\python.exe" -m pip install --upgrade pip >NUL
".venv\Scripts\python.exe" -m pip install -e ".[gallery]"
if errorlevel 1 (echo pip install failed, see the message above & pause & exit /b 1)

".venv\Scripts\python.exe" -c "import numba" >NUL 2>&1
if errorlevel 1 (
  echo.
  echo WARNING: the numba accelerator does not work with this Python, the model will run about 8x slower.
  echo Install Python 3.12 from python.org, delete the .venv folder and run install.bat again.
  ".venv\Scripts\python.exe" -c "import numba"
  echo.
)

echo.
echo Downloading the connectome (about 105 MB) and building the cache...
".venv\Scripts\python.exe" -m neurofly.cli download
if errorlevel 1 (echo download failed, check the internet connection & pause & exit /b 1)

echo Fetching the neuron atlas and the brain outline...
".venv\Scripts\python.exe" -m neurofly.cli archive --meshes
if errorlevel 1 (echo archive failed, check the internet connection & pause & exit /b 1)

echo.
echo Done. Start the installation with start.bat
echo Optional: synapses.bat downloads the 2 GB synapse table for real contact points.
pause
