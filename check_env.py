"""Controle d'environnement, lance par install.bat.

Verifie trois choses : le virtualenv est actif, les dependances sont presentes,
et le serveur local de LM Studio repond.
"""

import json
import os
import shutil
import sys
import urllib.error
import urllib.request

DEPENDANCES = ["fastapi", "uvicorn", "httpx", "multipart"]
LM_URL = os.environ.get("LMSTUDIO_URL", "http://127.0.0.1:1234").rstrip("/")
PORT = os.environ.get("POCKET_PORT", "8000")


def module_ok(name):
    try:
        __import__(name)
        return True
    except ImportError:
        return False


def ping_lm_studio():
    try:
        with urllib.request.urlopen(LM_URL + "/api/v0/models", timeout=6) as response:
            data = json.load(response)
            models = data.get("data") or []
            loaded = [m.get("id") for m in models if m.get("state") == "loaded"]
            return True, "modeles connus : " + str(len(models)) + " | charges : " + (", ".join(loaded) or "aucun")
    except urllib.error.HTTPError as err:
        return False, "LM Studio repond mais avec le code " + str(err.code) + " (le serveur local est peut-etre eteint)"
    except Exception as err:  # noqa: BLE001 - le serveur est peut-etre simplement eteint
        return False, "LM Studio injoignable : " + str(err)


def main():
    in_venv = sys.prefix != getattr(sys, "base_prefix", sys.prefix)
    print("Python : " + sys.version.split()[0] + (" (virtualenv actif)" if in_venv else " (hors virtualenv)"))

    missing = [name for name in DEPENDANCES if not module_ok(name)]
    if missing:
        print("Dependances manquantes : " + ", ".join(missing))
    else:
        print("Dependances : ok")

    cli = shutil.which("lms") or os.environ.get("LMS_CLI") or ""
    print("CLI lms : " + (cli or "absent (le modele doit etre charge dans LM Studio)"))

    ok, detail = ping_lm_studio()
    print("LM Studio : " + detail)

    print("Serveur Pocket : http://localhost:" + PORT)
    print("Reseau : http://ADRESSE_IP_DU_PC:" + PORT + " (le pare-feu Windows doit autoriser le port)")
    if not ok:
        sys.exit(2)


if __name__ == "__main__":
    main()
