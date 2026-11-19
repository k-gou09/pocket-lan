"""Personas côté serveur.

Les personas définissent la consigne système utilisée par le modèle. Ils sont
stockés en fichiers JSON dans data/personas/ pour rester simples à éditer et à
versionner côté serveur. La sélection du persona actif est un réglage global.
"""

import json
import re
import unicodedata
from pathlib import Path

from . import config, store


def _dir() -> Path:
    path = config.DATA_DIR / "personas"
    path.mkdir(parents=True, exist_ok=True)
    return path


def _slug(value: str) -> str:
    text = unicodedata.normalize("NFKD", str(value or ""))
    text = text.encode("ascii", "ignore").decode("ascii")
    text = re.sub(r"[^a-zA-Z0-9_-]+", "-", text).strip("-").lower()
    return text or "persona"


def _path(persona_id: str) -> Path:
    return _dir() / (_slug(persona_id) + ".json")


def _read(path: Path) -> dict | None:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError):
        return None
    if not isinstance(data, dict):
        return None
    persona_id = str(data.get("id") or path.stem).strip()
    prompt = str(data.get("prompt") or "").strip()
    if not persona_id or not prompt:
        return None
    return {
        "id": persona_id,
        "name": str(data.get("name") or persona_id).strip() or persona_id,
        "prompt": prompt,
        "description": str(data.get("description") or "").strip(),
    }


def _write(persona: dict):
    path = _path(persona["id"])
    path.write_text(json.dumps(persona, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def ensure_seeded():
    """Crée le persona par défaut si aucun persona n'existe et valide la sélection."""
    existing = list_personas()
    if not existing:
        prompt = ""
        try:
            # Migration : réutilise une ancienne consigne système globale si présente.
            conn = store.connect()
            with store._LOCK:  # usage interne contrôlé
                row = conn.execute(
                    "SELECT value FROM global_settings WHERE key = ?", ("systemPrompt",)
                ).fetchone()
            if row:
                prompt = str(json.loads(row["value"]) or "").strip()
        except Exception:  # noqa: BLE001 - migration best-effort
            prompt = ""

        if not prompt:
            prompt = config.DEFAULT_SYSTEM_PROMPT

        _write(
            {
                "id": "default",
                "name": "Pocket",
                "prompt": prompt,
                "description": "Assistant Pocket par défaut.",
            }
        )
        store.save_global_settings({"persona": "default"})
        return

    active_id = str(store.get_global_settings().get("persona") or "")
    if not any(p["id"] == active_id for p in existing):
        store.save_global_settings({"persona": existing[0]["id"]})


def list_personas() -> list[dict]:
    directory = _dir()
    items = []
    for path in sorted(directory.glob("*.json")):
        persona = _read(path)
        if persona:
            items.append(persona)
    items.sort(key=lambda p: (p["id"] != "default", p["name"].lower(), p["id"]))
    return items


def get_persona(persona_id: str) -> dict | None:
    if not persona_id:
        return None
    return _read(_path(persona_id))


def get_active() -> dict:
    ensure_seeded()
    active_id = str(store.get_global_settings().get("persona") or "default")
    persona = get_persona(active_id)
    if persona:
        return persona
    personas_all = list_personas()
    if personas_all:
        store.save_global_settings({"persona": personas_all[0]["id"]})
        return personas_all[0]
    # secours ultime
    fallback = {
        "id": "default",
        "name": "Pocket",
        "prompt": config.DEFAULT_SYSTEM_PROMPT,
        "description": "Assistant Pocket par défaut.",
    }
    _write(fallback)
    store.save_global_settings({"persona": "default"})
    return fallback


def resolve_prompt(persona_id: str | None = None) -> str:
    if persona_id:
        persona = get_persona(persona_id)
        if persona:
            return persona["prompt"]
    return get_active()["prompt"]
