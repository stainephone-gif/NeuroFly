@echo off
rem NeuroFly: start the simulation server and open the screen in a full-screen browser.
rem The server is restarted automatically if it ever exits. Close this window to stop everything.
setlocal
cd /d "%~dp0.."

rem ---- settings ---------------------------------------------------------
set PORT=8765
set KIOSK=1
rem extra server options, e.g. --hold 30 --trace-alpha 0 --fresh
set OPTIONS=
rem -----------------------------------------------------------------------

rem numba keeps its compiled cache in a plain ASCII path (Cyrillic folders can break it)
set NUMBA_CACHE_DIR=%TEMP%\neurofly_numba
set PYTHONIOENCODING=utf-8

if not exist ".venv\Scripts\neurofly.exe" (
  echo NeuroFly is not installed yet. Run install.bat first.
  pause
  exit /b 1
)

title NeuroFly server (close this window to stop)
start "" /min cmd /c "%~dp0open_browser.bat" %PORT% %KIOSK%

:loop
echo [%date% %time%] starting server on port %PORT%
".venv\Scripts\neurofly.exe" serve --port %PORT% %OPTIONS%
echo [%date% %time%] server exited, restarting in 5 s (Ctrl+C to stop)
timeout /t 5 /nobreak >NUL
goto loop
