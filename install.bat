@echo off
setlocal
cd /d "%~dp0"

rem ------------------------------------------------------------------
rem Pocket LAN : installation.
rem   1. Cree le virtualenv .venv s'il manque.
rem   2. L'active, met pip a jour, installe requirements.txt.
rem   3. Verifie les dependances et le serveur local de LM Studio.
rem ------------------------------------------------------------------

set "VENV=.venv"
if not exist "%VENV%" (
  echo Creation du virtualenv "%VENV%" ...
  python -m venv "%VENV%"
  if errorlevel 1 (
    echo Echec : python introuvable. Installe Python 3.11 ou plus, ou remplace python par py.
    exit /b 1
  )
)

if not exist "%VENV%\Scripts\activate.bat" (
  echo Echec : le virtualenv existe mais n'a pas ete cree correctement.
  exit /b 1
)

call "%VENV%\Scripts\activate.bat"

echo Mise a jour de pip ...
python -m pip install --upgrade pip
if errorlevel 1 echo Avertissement : pip n'a pas pu se mettre a jour, on continue quand meme.

echo Installation des dependances ...
python -m pip install -r requirements.txt
if errorlevel 1 (
  echo Echec de l'installation. Verifie la connexion et que le virtualenv est bien actif.
  exit /b 1
)

echo.
python check_env.py
echo.
echo Installation terminee. Lance l'application avec run.bat.
endlocal
