@echo off
setlocal
cd /d "%~dp0"

rem ------------------------------------------------------------------
rem Pocket LAN : lancement.
rem Le serveur écoute sur toutes les interfaces : les autres PC du reseau
rem ouvrent http://ADRESSE_IP_DU_PC:8000.
rem Le pare-feu Windows doit autoriser le port (une seule fois, a la demande).
rem ------------------------------------------------------------------

if not exist ".venv\Scripts\activate.bat" (
  echo Le virtualenv est absent : lance install.bat une premiere fois.
  exit /b 1
)

call ".venv\Scripts\activate.bat"

if "%POCKET_PORT%"=="" set "POCKET_PORT=8000"
if "%LMSTUDIO_URL%"=="" set "LMSTUDIO_URL=http://127.0.0.1:1234"

python check_env.py
echo.
echo URLs :
echo   local   http://localhost:%POCKET_PORT%
echo   reseau  http://ADRESSE_IP_DU_PC:%POCKET_PORT%
echo.

:serve
python -m uvicorn app.main:app --host 0.0.0.0 --port %POCKET_PORT%
set "POCKET_EXIT=%ERRORLEVEL%"
if "%POCKET_EXIT%"=="42" (
  echo.
  echo [Pocket LAN] Mise a jour appliquee, redemarrage...
  echo.
  goto serve
)

endlocal
