"""Persistance SQLite : sessions, conversations, messages, reglages.

La base est creee au premier lancement dans data/pocket.db. SQLite est dans la
bibliotheque standard, aucune dependance externe n'est necessaire.
"""

import json
import sqlite3
import threading
import time
import uuid

from . import config

_LOCK = threading.RLock()
_CONNECTION = None

SCHEMA = """
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  created_at REAL NOT NULL,
  last_seen REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT 'Nouvelle conversation',
  created_at REAL NOT NULL,
  updated_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conv_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at REAL NOT NULL,
  tokens INTEGER NOT NULL DEFAULT 0,
  attachments TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  conv_id TEXT NOT NULL DEFAULT '',
  message_id TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  mime TEXT NOT NULL,
  path TEXT NOT NULL,
  size INTEGER NOT NULL DEFAULT 0,
  text TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  created_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS session_settings (
  session_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (session_id, key)
);

CREATE TABLE IF NOT EXISTS global_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
"""


def connect():
    global _CONNECTION
    if _CONNECTION is not None:
        return _CONNECTION

    config.DATA_DIR.mkdir(parents=True, exist_ok=True)
    _CONNECTION = sqlite3.connect(str(config.DB_PATH), check_same_thread=False)
    _CONNECTION.row_factory = sqlite3.Row
    _CONNECTION.execute("PRAGMA journal_mode=WAL")
    _CONNECTION.executescript(SCHEMA)
    # Migration : une base creee avant les pieces jointes n'a pas la colonne.
    columns = {row[1] for row in _CONNECTION.execute("PRAGMA table_info(messages)")}
    if "attachments" not in columns:
        _CONNECTION.execute("ALTER TABLE messages ADD COLUMN attachments TEXT NOT NULL DEFAULT '[]'")
        _CONNECTION.commit()
    return _CONNECTION


def new_id():
    return uuid.uuid4().hex[:12]


def ensure_session(session_id, name=""):
    """Retourne le dossier d'une session, creee au premier passage."""
    now = time.time()
    with _LOCK:
        conn = connect()
        row = conn.execute("SELECT * FROM sessions WHERE id = ?", (session_id,)).fetchone()
        if row is None:
            conn.execute(
                "INSERT INTO sessions (id, name, created_at, last_seen) VALUES (?, ?, ?, ?)",
                (session_id, name or "", now, now),
            )
            conn.commit()
            return {"id": session_id, "name": name or "", "created_at": now, "last_seen": now}

        if name and name != row["name"]:
            conn.execute("UPDATE sessions SET name = ? WHERE id = ?", (name, session_id))
            conn.commit()
        conn.execute("UPDATE sessions SET last_seen = ? WHERE id = ?", (now, session_id))
        conn.commit()
        return {
            "id": row["id"],
            "name": row["name"],
            "created_at": row["created_at"],
            "last_seen": now,
        }


def set_name(session_id, name):
    clean = str(name or "").strip()[:48]
    now = time.time()
    with _LOCK:
        conn = connect()
        conn.execute("UPDATE sessions SET name = ?, last_seen = ? WHERE id = ?", (clean, now, session_id))
        conn.commit()
    return clean


def list_sessions():
    with _LOCK:
        rows = connect().execute(
            "SELECT id, name, created_at, last_seen FROM sessions ORDER BY last_seen DESC"
        ).fetchall()
    return [dict(row) for row in rows]


def list_conversations(session_id):
    with _LOCK:
        rows = connect().execute(
            "SELECT id, title, created_at, updated_at FROM conversations "
            "WHERE session_id = ? ORDER BY updated_at DESC",
            (session_id,),
        ).fetchall()
    return [dict(row) for row in rows]


def create_conversation(session_id, title="Nouvelle conversation"):
    now = time.time()
    conv_id = new_id()
    clean = str(title or "").strip()[:60] or "Nouvelle conversation"
    with _LOCK:
        conn = connect()
        conn.execute(
            "INSERT INTO conversations (id, session_id, title, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?)",
            (conv_id, session_id, clean, now, now),
        )
        conn.commit()
    return {"id": conv_id, "session_id": session_id, "title": clean, "created_at": now, "updated_at": now}


def get_conversation(conv_id):
    with _LOCK:
        row = connect().execute("SELECT * FROM conversations WHERE id = ?", (conv_id,)).fetchone()
    return dict(row) if row else None


def delete_conversation(conv_id):
    """Supprime une conversation et rend les chemins de fichiers a nettoyer."""
    with _LOCK:
        conn = connect()
        rows = conn.execute("SELECT path FROM attachments WHERE conv_id = ?", (conv_id,)).fetchall()
        paths = [row["path"] for row in rows]
        conn.execute("DELETE FROM attachments WHERE conv_id = ?", (conv_id,))
        conn.execute("DELETE FROM messages WHERE conv_id = ?", (conv_id,))
        conn.execute("DELETE FROM conversations WHERE id = ?", (conv_id,))
        conn.commit()
    return paths


def derive_title(text):
    clean = " ".join(str(text or "").split()).strip()
    if not clean:
        return "Nouvelle conversation"
    return clean[:42] + "..." if len(clean) > 42 else clean


def add_message(conv_id, role, content, tokens=0, attachments=None):
    now = time.time()
    ids = [str(item) for item in (attachments or [])]
    message = {
        "id": new_id(),
        "conv_id": conv_id,
        "role": role,
        "content": str(content or "").strip(),
        "created_at": now,
        "tokens": int(tokens or 0),
    }
    with _LOCK:
        conn = connect()
        conn.execute(
            "INSERT INTO messages (id, conv_id, role, content, created_at, tokens, attachments) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (
                message["id"], conv_id, role, message["content"], now,
                message["tokens"], json.dumps(ids),
            ),
        )
        conn.execute("UPDATE conversations SET updated_at = ? WHERE id = ?", (now, conv_id))
        conn.commit()
    message["attachments"] = ids
    # On rend les fiches completes pour que l'evenement WS puisse afficher les
    # puces sans un second aller-retour vers le client.
    return _hydrate(message)


def _hydrate(row):
    """Remplace les ids de pieces jointes par leurs fiches completes."""
    data = dict(row)
    ids = _decode(data.get("attachments") or "[]")
    if not isinstance(ids, list) or not ids:
        data["attachments"] = []
        return data
    marks = ",".join("?" for _ in ids)
    with _LOCK:
        rows = connect().execute(
            "SELECT * FROM attachments WHERE id IN (" + marks + ")", tuple(ids)
        ).fetchall()
    by_id = {item["id"]: dict(item) for item in rows}
    data["attachments"] = [by_id[item] for item in ids if item in by_id]
    return data


def public_message(message):
    """Version d'un message safe pour le navigateur (sans texte ni chemin)."""
    data = dict(message)
    data["attachments"] = [
        {
            "id": item.get("id"),
            "name": item.get("name"),
            "kind": item.get("kind"),
            "mime": item.get("mime"),
            "size": int(item.get("size") or 0),
            "note": item.get("note") or "",
        }
        for item in (message.get("attachments") or [])
        if isinstance(item, dict)
    ]
    return data


def list_messages(conv_id, limit=200):
    with _LOCK:
        rows = connect().execute(
            "SELECT id, conv_id, role, content, created_at, tokens, attachments FROM messages "
            "WHERE conv_id = ? ORDER BY created_at ASC LIMIT ?",
            (conv_id, int(limit)),
        ).fetchall()
    return [_hydrate(row) for row in rows]


def save_attachment(session_id, meta):
    now = time.time()
    with _LOCK:
        conn = connect()
        conn.execute(
            "INSERT INTO attachments "
            "(id, session_id, conv_id, message_id, name, kind, mime, path, size, text, note, created_at) "
            "VALUES (?, ?, '', '', ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                meta["id"], session_id, meta["name"], meta["kind"], meta["mime"],
                meta["path"], int(meta.get("size") or 0), meta.get("text") or "",
                meta.get("note") or "", now,
            ),
        )
        conn.commit()
    return meta


def get_attachment(session_id, attachment_id):
    with _LOCK:
        row = connect().execute(
            "SELECT * FROM attachments WHERE id = ? AND session_id = ?",
            (str(attachment_id or ""), session_id),
        ).fetchone()
    return dict(row) if row else None


def bind_attachments(session_id, ids, conv_id, message_id):
    """Rattache des uploads en attente au message utilisateur qui les envoie."""
    if not ids:
        return []
    marks = ",".join("?" for _ in ids)
    with _LOCK:
        conn = connect()
        rows = conn.execute(
            "SELECT id FROM attachments WHERE session_id = ? AND message_id = '' "
            "AND id IN (" + marks + ")",
            (session_id, *ids),
        ).fetchall()
        valid = [row["id"] for row in rows]
        if valid:
            marks = ",".join("?" for _ in valid)
            conn.execute(
                "UPDATE attachments SET conv_id = ?, message_id = ? "
                "WHERE id IN (" + marks + ")",
                (conv_id, message_id, *valid),
            )
            conn.commit()
    return valid


def prune_pending_attachments(cutoff):
    with _LOCK:
        conn = connect()
        rows = conn.execute(
            "SELECT id, path FROM attachments WHERE message_id = '' AND created_at < ?",
            (float(cutoff),),
        ).fetchall()
        if rows:
            conn.executemany(
                "DELETE FROM attachments WHERE id = ?", [(row["id"],) for row in rows]
            )
            conn.commit()
    return [dict(row) for row in rows]


def get_global_settings():
    values = dict(config.GLOBAL_DEFAULTS)
    with _LOCK:
        rows = connect().execute("SELECT key, value FROM global_settings").fetchall()
    for row in rows:
        values[row["key"]] = _decode(row["value"])
    return values


def save_global_settings(patch):
    with _LOCK:
        conn = connect()
        for key, value in patch.items():
            if key not in config.GLOBAL_DEFAULTS:
                continue
            conn.execute(
                "INSERT INTO global_settings (key, value) VALUES (?, ?) "
                "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                (key, json.dumps(value)),
            )
        conn.commit()
    return get_global_settings()


def get_session_settings(session_id):
    values = dict(config.SESSION_DEFAULTS)
    with _LOCK:
        rows = connect().execute(
            "SELECT key, value FROM session_settings WHERE session_id = ?", (session_id,)
        ).fetchall()
    for row in rows:
        values[row["key"]] = _decode(row["value"])
    return values


def save_session_settings(session_id, patch):
    with _LOCK:
        conn = connect()
        for key, value in patch.items():
            if key not in config.SESSION_DEFAULTS:
                continue
            conn.execute(
                "INSERT INTO session_settings (session_id, key, value) VALUES (?, ?, ?) "
                "ON CONFLICT(session_id, key) DO UPDATE SET value = excluded.value",
                (session_id, key, json.dumps(value)),
            )
        conn.commit()
    return get_session_settings(session_id)


def effective_settings(session_id):
    """Reglages globaux + override de l'utilisateur."""
    merged = get_global_settings()
    session_values = get_session_settings(session_id)
    merged.update(session_values)
    if not session_values.get("contextBudget"):
        merged["contextBudget"] = get_global_settings()["contextBudget"]
    return merged


def _decode(raw):
    try:
        return json.loads(raw)
    except (TypeError, json.JSONDecodeError):
        return raw


def pop_last_assistant(conv_id):
    """Supprime le dernier message assistant d'une conversation et le renvoie."""
    with _LOCK:
        conn = connect()
        row = conn.execute(
            "SELECT id, conv_id, role, content, created_at, tokens FROM messages "
            "WHERE conv_id = ? AND role = 'assistant' ORDER BY created_at DESC, rowid DESC LIMIT 1",
            (conv_id,),
        ).fetchone()
        if row is None:
            return None
        conn.execute("DELETE FROM messages WHERE id = ?", (row["id"],))
        conn.commit()
    return dict(row)


def last_user_message(conv_id):
    with _LOCK:
        row = connect().execute(
            "SELECT id, conv_id, role, content, created_at, tokens, attachments FROM messages "
            "WHERE conv_id = ? AND role = 'user' ORDER BY created_at DESC, rowid DESC LIMIT 1",
            (conv_id,),
        ).fetchone()
    return _hydrate(row) if row else None
