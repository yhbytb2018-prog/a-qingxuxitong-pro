@echo off
rem Launcher for Sentiment V5.2 GUI (ASCII-only on purpose: .bat + CJK text garbles under cp936)
rem The default "python" on PATH (managed 3.13 build) has NO tkinter -> ModuleNotFoundError.
rem This launcher always uses the gui312 venv (tkinter + pandas + matplotlib + openpyxl).
setlocal
set PY=C:\Users\Administrator\.workbuddy\binaries\python\envs\gui312\Scripts\python.exe
if exist "%PY%" goto run
set PY=C:\Users\Administrator\AppData\Local\Programs\Python\Python312\python.exe
echo [WARN] gui312 venv not found, falling back to system Python 3.12.
echo [WARN] If pandas/matplotlib/openpyxl are missing there, recreate the venv first.
:run
cd /d "%~dp0"
echo Starting Sentiment V5.2 GUI with: %PY%
"%PY%" sentiment_gui.py
if errorlevel 1 (
  echo.
  echo [ERROR] GUI exited with an error. Read the message above.
  pause
)
endlocal
