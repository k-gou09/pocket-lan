"""Configuration : port, URL de LM Studio, CLI lms, reglages par defaut.

Les valeurs peuvent etre ecrasees par des variables d'environnement :
  POCKET_PORT       port HTTP du serveur (8000 par defaut)
  LMSTUDIO_URL      URL du serveur local de LM Studio (http://127.0.0.1:1234)
  LMS_CLI           chemin du CLI lms, utilise pour charger un modele
  POCKET_MAX_MODEL_GO taille maximale acceptee pour un modele, en Go
  POCKET_ADMIN_TOKEN jeton admin (genere automatiquement si absent)
"""

import os
import secrets
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

# Depot GitHub "owner/repo" pour la detection silencieuse des releases.
# POCKET_GITHUB_REPO="" desactive la detection (aucune requete reseau).
GITHUB_REPO = os.environ.get("POCKET_GITHUB_REPO", "k-gou09/pocket-lan").strip()

# Jeton optionnel pour interroger l'API GitHub d'un depot prive.
# Sans jeton, la detection retombe sur les tags git du depot local.
GITHUB_TOKEN = os.environ.get("POCKET_GITHUB_TOKEN", "").strip()

# Jeton admin : variable POCKET_ADMIN_TOKEN si fournie, sinon generation
# automatique au premier lancement et stockage dans data/admin_token.
ADMIN_TOKEN_FILE = DATA_DIR / "admin_token"


def _load_admin_token() -> tuple[str, str]:
    override = os.environ.get("POCKET_ADMIN_TOKEN", "").strip()
    if override:
        return override, "variable POCKET_ADMIN_TOKEN"
    try:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        if ADMIN_TOKEN_FILE.exists():
            saved = ADMIN_TOKEN_FILE.read_text(encoding="utf-8").strip()
            if saved:
                return saved, str(ADMIN_TOKEN_FILE)
        token = secrets.token_urlsafe(24)
        ADMIN_TOKEN_FILE.write_text(token + "\n", encoding="utf-8")
        try:
            ADMIN_TOKEN_FILE.chmod(0o600)
        except OSError:
            pass
        return token, str(ADMIN_TOKEN_FILE)
    except OSError:
        return "", "indisponible"


ADMIN_TOKEN, ADMIN_TOKEN_SOURCE = _load_admin_token()
if ADMIN_TOKEN:
    print("")
    print("[Pocket LAN] Jeton administrateur : " + ADMIN_TOKEN)
    print("[Pocket LAN] Source : " + ADMIN_TOKEN_SOURCE)
    print("[Pocket LAN] A saisir dans l'interface si une mise a jour est proposee.")
    print("")
else:
    print("")
    print("[Pocket LAN] Jeton administrateur indisponible : ecriture de data/ impossible.")
    print("")

# Consigne par defaut, utilisee pour creer le persona initial si absent.
DEFAULT_SYSTEM_PROMPT = (
    "Tu es Pocket, un assistant de poche amical, curieux et concis. "
    "Tu reponds toujours en francais, de facon claire et naturelle. "
    "Tes reponses sont courtes (1 a 4 phrases) sauf si l'utilisateur demande un "
    "developpement. Tu ne montres jamais de raisonnement interne."
)

# Reglages appliques a tout le monde : le moteur est unique, donc le modele et
# le persona actif sont globaux.
GLOBAL_DEFAULTS = {
    "model": "qwen3-0.6b",
    "persona": "default",
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
    "voiceNova": "",
    "avatar": "pocket",
}

COOKIE_NAME = "pocket_sid"
