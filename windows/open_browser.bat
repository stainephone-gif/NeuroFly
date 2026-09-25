@echo off
rem Helper for start.bat: waits until the server answers, then opens the screen.
setlocal
set PORT=%1
set KIOSK=%2
set URL=http://localhost:%PORT%/

set /a tries=0
:wait
curl -s -o NUL "%URL%api/meta.json" && goto ready
set /a tries+=1
if %tries% geq 180 (echo server did not start in time & exit /b 1)
timeout /t 1 /nobreak >NUL
goto wait

:ready
set CHROME=
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe
if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" set CHROME=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe
if exist "%LocalAppData%\Google\Chrome\Application\chrome.exe" set CHROME=%LocalAppData%\Google\Chrome\Application\chrome.exe
set EDGE=
if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" set EDGE=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe
if exist "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" set EDGE=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe

set FLAGS=--new-window --no-first-run --disable-session-crashed-bubble --disable-infobars --autoplay-policy=no-user-gesture-required
if "%KIOSK%"=="1" set FLAGS=%FLAGS% --kiosk

if defined CHROME (
  start "" "%CHROME%" %FLAGS% --user-data-dir="%TEMP%\neurofly_chrome" "%URL%"
) else if defined EDGE (
  start "" "%EDGE%" %FLAGS% --user-data-dir="%TEMP%\neurofly_edge" "%URL%"
) else (
  start "" "%URL%"
)
