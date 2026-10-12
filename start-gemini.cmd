@echo off
setlocal
cd /d "%~dp0"
python build.py
if errorlevel 1 goto failed
if not exist "unknown-device-v7.0.html" goto failed
python gemini_bridge.py --open-browser --prompt-key
goto end
:failed
echo Build failed. Install Python and run this file again.
:end
pause
