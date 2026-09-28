@echo off
rem Settings for THIS computer. Copy this file to local.bat and edit it;
rem start.bat reads local.bat on every launch and git pull never overwrites it.

rem Weak machine (old i3, two cores): let neurons below 1 mV sleep.
rem About 2x faster; sugar/walk/back results stay within trial-to-trial noise.
set OPTIONS=--eps 1.0

rem Other examples (append to OPTIONS):
rem   --idle 60 --attract-step 15   demonstration starts after 60 s, 15 s per scenario
rem   --hold 30                     a visitor's stimulus lasts 30 s
rem   --fresh                       start the day from scratch
rem set KIOSK=0                     normal browser window instead of full screen
