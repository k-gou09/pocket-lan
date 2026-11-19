"""Configuration : port, URL de LM Studio, CLI lms, reglages par defaut.

Les valeurs peuvent etre ecrasees par des variables d'environnement :
  POCKET_PORT       port HTTP du serveur (8000 par defaut)
  LMSTUDIO_URL      URL du serveur local de LM Studio (http://127.0.0.1:1234)
  LMS_CLI           chemin du CLI lms, utilise pour charger un modele
  POCKET_MAX_MODEL_GO taille maximale acceptee pour un modele, en Go
"""

import os
import shutil
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / "data"
STATIC_DIR = BASE_DIR / "static"

PORT = int(os.environ.get("POCKET_PORT", "8000"))
LM_BASE_URL = os.environ.get("LMSTUDIO_URL", "http://127.0.0.1:1234").rstrip("/")
DB_PATH = DATA_DIR / "pocket.db"

# Le CLI lms est optionnel. Sans lui l'application utilise un modele deja charge
# dans LM Studio, et le choix du modele se fait depuis l'interface de LM Studio.
LMS_CLI = os.environ.get("LMS_CLI") or shutil.which("lms") or ""

# Un modele de 20 Go ferait exploser la memoire d'un PC partage par plusieurs
# utilisateurs. 0 desactive le controle.
MAX_MODEL_SIZE_GB = float(os.environ.get("POCKET_MAX_MODEL_GO", "8"))

# Coefficient d'estimation : 4 caracteres par token est l'ordre de grandeur
# observe sur les modeles GGUF de la famille Qwen. Ce n'est pas un comptage exact.
CHARS_PER_TOKEN = 4

# Reglages appliques a tout le monde : le moteur est unique, donc le modele et la
# consigne sont globaux.
GLOBAL_DEFAULTS = {
    "model": "qwen3-0.6b",
    "systemPrompt": (
        "Tu es Pocket, un assistant de poche amical, curieux et concis. "
        "Tu reponds toujours en francais, de facon claire et naturelle. "
        "Tes reponses sont courtes (1 a 4 phrases) sauf si l'utilisateur demande un "
        "developpement. Tu ne montres jamais de raisonnement interne."
    ),
    "contextBudget": 3000,
    "maxParallel": 2,
}

# Reglages par utilisateur. contextBudget = 0 veut dire : utiliser le reglage global.
SESSION_DEFAULTS = {
    "contextBudget": 0,
    "maxTokens": 512,
    "temperature": 0.7,
    "tts": True,
    "mic": True,
    "autoSend": True,
    "showReasoning": False,
    "voice": "",
}

COOKIE_NAME = "pocket_sid"
