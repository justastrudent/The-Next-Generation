@echo off
setlocal
chcp 65001 >nul
pushd "%~dp0"
py -3 --version >nul 2>&1
if errorlevel 1 goto use_python
py -3 "%~dp0apply_design.py" %*
goto finished
:use_python
python --version >nul 2>&1
if errorlevel 1 goto no_python
python "%~dp0apply_design.py" %*
goto finished
:no_python
echo Python 3 was not found. Use the Python installation that starts your local simulator server.
goto finish_pause
:finished
if errorlevel 1 echo Installation stopped. Read the ERROR above. Do not replace scene3d.js manually.
:finish_pause
echo.
pause
popd
endlocal
