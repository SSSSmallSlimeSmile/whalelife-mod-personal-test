@echo off
rem Start the F9 hold-to-talk helper with pythonw (no console window).
rem If pythonw is not on PATH, set WHALELIFE_F9_PYTHON to its full path first.
set "PY=pythonw"
if not "%WHALELIFE_F9_PYTHON%"=="" set "PY=%WHALELIFE_F9_PYTHON%"
start "" "%PY%" "%~dp0hold_to_talk.py"
