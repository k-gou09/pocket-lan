"""Choix du moteur d'inférence : LM Studio ou Ollama.

Les deux serveurs exposent la même API OpenAI compatible, donc un seul client
HTTP suffit (``app/lm_client.py``). Ce module ne fait que résoudre l'URL et
quelques capacités propres à chaque backend.
"""

from . import config, store

LMS = "lms"
OLLAMA = "ollama"


def normalize(value):
    return OLLAMA if str(value or "").strip().lower() == OLLAMA else LMS


def current():
    """Backend global, tel qu'enregistré dans les réglages partagés."""
    return normalize(store.get_global_settings().get("backend"))


def base_url(backend=None, settings=None):
    backend = normalize(backend if backend is not None else (settings or {}).get("backend"))
    if backend == OLLAMA:
        custom = str((settings or {}).get("ollamaUrl") or "").strip()
        return (custom or config.OLLAMA_BASE_URL).rstrip("/")
    return config.LM_BASE_URL


def label(backend=None):
    return "Ollama" if normalize(backend) == OLLAMA else "LM Studio"


def uses_lms_cli(backend=None):
    """Seul LM Studio a un CLI capable de charger un modèle à distance."""
    return normalize(backend) == LMS
