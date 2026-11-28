"""Pièces jointes : stockage local et extraction du texte.

Les fichiers restent sur le serveur dans ``data/uploads/<session>/``. Le texte
extrait est gardé en base avec la fiche de la pièce jointe ; les images sont
relues depuis le disque et converties en data URL au moment de construire la
requête vers le modèle (aucune image en base64 dans SQLite).
"""

import base64
import io
import re
import time
from pathlib import Path

from . import config, store

UPLOAD_DIR = config.DATA_DIR / "uploads"

MAX_FILE_BYTES = 5 * 1024 * 1024
MAX_TEXT_CHARS = 50_000
MAX_PDF_PAGES = 20
MAX_IMAGES = 4

TEXT_EXT = {".txt", ".md", ".markdown", ".csv", ".json", ".log"}
IMAGE_EXT = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"}
PDF_EXT = {".pdf"}

_MIME_EXT = {
    "text/plain": ".txt",
    "text/markdown": ".md",
    "text/csv": ".csv",
    "application/json": ".json",
    "application/pdf": ".pdf",
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/gif": ".gif",
    "image/webp": ".webp",
}


class UploadError(Exception):
    """Erreur d'upload, message prêt à afficher dans l'interface."""


def _safe_session(sid):
    clean = re.sub(r"[^A-Za-z0-9_-]", "", str(sid or ""))
    return clean[:64] or "invite"


def _extension(name, mime):
    ext = Path(str(name or "")).suffix.lower()
    if ext in TEXT_EXT | IMAGE_EXT | PDF_EXT:
        return ext
    return _MIME_EXT.get(str(mime or "").split(";")[0].strip().lower(), "")


def _decode_text(data):
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        return data.decode("latin-1", errors="replace")


def _extract_pdf(data):
    """Extrait le texte d'un PDF. PyMuPDF d'abord, pdfplumber en secours."""
    try:
        try:
            import pymupdf as fitz  # PyMuPDF (nom moderne)
        except ImportError:
            import fitz  # anciennes versions

        document = fitz.open(stream=data, filetype="pdf")
        try:
            pages = []
            for index in range(min(len(document), MAX_PDF_PAGES)):
                pages.append(document[index].get_text("text"))
            return "\n".join(pages).strip()
        finally:
            document.close()
    except Exception:  # noqa: BLE001 - bibliotheque absente ou PDF invalide
        pass

    try:
        import pdfplumber

        with pdfplumber.open(io.BytesIO(data)) as document:
            pages = []
            for page in document.pages[:MAX_PDF_PAGES]:
                pages.append(page.extract_text() or "")
            return "\n".join(pages).strip()
    except Exception:  # noqa: BLE001 - on laisse le message explicite a l'appelant
        return ""


def save_upload(sid, filename, data, mime=""):
    """Ecrit le fichier sur disque et retourne sa fiche (sans données brutes)."""
    data = bytes(data or b"")
    if not data:
        raise UploadError("Fichier vide.")
    if len(data) > MAX_FILE_BYTES:
        raise UploadError("Fichier trop gros (limite : 5 Mo).")

    name = Path(str(filename or "fichier")).name[:120] or "fichier"
    ext = _extension(name, mime)
    if ext in TEXT_EXT:
        kind = "text"
    elif ext == ".pdf":
        kind = "pdf"
    elif ext in IMAGE_EXT:
        kind = "image"
    else:
        raise UploadError("Format non pris en charge : txt, md, csv, PDF ou image.")

    if kind == "image":
        try:
            from PIL import Image

            with Image.open(io.BytesIO(data)) as image:
                image.verify()
        except ImportError:
            pass  # sans PIL on accepte l'image sur la foi de son extension
        except Exception as err:  # noqa: BLE001 - image corrompue
            raise UploadError("Image illisible ou corrompue.") from err

    note = ""
    if kind == "text":
        text = _decode_text(data)
    elif kind == "pdf":
        text = _extract_pdf(data)
        if not text:
            note = "PDF sans texte extractible (probablement scanné) : le modèle ne verra pas son contenu."
    else:
        text = ""

    att_id = store.new_id()
    rel = _safe_session(sid) + "/" + att_id + ext
    target = path_for(rel)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(data)

    return {
        "id": att_id,
        "name": name,
        "kind": kind,
        "mime": mime or "application/octet-stream",
        "size": len(data),
        "path": rel,
        "text": text[:MAX_TEXT_CHARS],
        "note": note,
    }


def public(meta):
    """Fiche envoyée au navigateur : jamais le texte extrait ni le chemin."""
    return {
        "id": meta.get("id"),
        "name": meta.get("name"),
        "kind": meta.get("kind"),
        "mime": meta.get("mime"),
        "size": int(meta.get("size") or 0),
        "note": meta.get("note") or "",
    }


def path_for(rel):
    """Résout un chemin relatif en restant strictement dans data/uploads."""
    root = UPLOAD_DIR.resolve()
    path = (root / str(rel or "")).resolve()
    if root != path and root not in path.parents:
        raise UploadError("Chemin de fichier invalide.")
    return path


def image_data_url(rel):
    """Data URL JPEG réduite à 1024 px, pour les backends vision."""
    try:
        path = path_for(rel)
    except UploadError:
        return ""
    if not path.exists():
        return ""

    try:
        from PIL import Image
    except ImportError:
        return ""

    try:
        with Image.open(path) as image:
            image = image.convert("RGB")
            image.thumbnail((1024, 1024))
            buffer = io.BytesIO()
            image.save(buffer, format="JPEG", quality=82)
        encoded = base64.b64encode(buffer.getvalue()).decode("ascii")
        return "data:image/jpeg;base64," + encoded
    except (OSError, ValueError):
        return ""


def remove(rel):
    try:
        path = path_for(rel)
    except UploadError:
        return
    try:
        path.unlink(missing_ok=True)
    except OSError:
        pass


def prune_pending(max_age_seconds=86400):
    """Supprime les fichiers uploadés mais jamais envoyés."""
    cutoff = time.time() - max_age_seconds
    stale = store.prune_pending_attachments(cutoff)
    for attachment in stale:
        remove(attachment.get("path"))
    return len(stale)
