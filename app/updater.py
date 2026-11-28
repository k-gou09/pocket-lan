"""Installation d'une release quand le dossier n'est pas un clone Git.

Le chemin Git reste le plus propre quand il est disponible. Pour les
installations faites depuis une archive ZIP, on telecharge l'archive de la
version cible et on remplace les fichiers de l'application, sans toucher a
`data/` (conversations, reglages, avatars) ni a `.venv/`.
"""

import shutil
import zipfile
from pathlib import Path
from urllib.parse import quote

from . import __version__, config

SKIP_TOP = {"data", ".venv", ".git", ".github", "__pycache__"}
SKIP_PARTS = {"__pycache__", ".git", ".github", ".venv", "data"}
SKIP_SUFFIXES = {".pyc", ".pyo", ".tmp"}


def safe_tag(tag):
    """Nom de dossier sur sans caracteres etranges."""
    cleaned = "".join(ch for ch in str(tag or "") if ch.isalnum() or ch in "-._")
    return cleaned.strip(".-_") or "update"


def archive_url(tag):
    """URL de l'archive GitHub d'un tag, sans token pour un depot public."""
    return (
        "https://github.com/"
        + config.GITHUB_REPO
        + "/archive/refs/tags/"
        + quote(str(tag or ""), safe="")
        + ".zip"
    )


def _source_root(extract_dir: Path) -> Path:
    """GitHub met tout dans un seul dossier racine ; on le retire."""
    items = [p for p in extract_dir.iterdir() if not p.name.startswith(".")]
    dirs = [p for p in items if p.is_dir()]
    files = [p for p in items if p.is_file()]
    if len(items) == 1 and len(dirs) == 1 and not files:
        return dirs[0]
    return extract_dir


def _skip(rel: Path) -> bool:
    parts = rel.parts
    if not parts or parts[0] in SKIP_TOP:
        return True
    if any(part in SKIP_PARTS for part in parts):
        return True
    return parts[-1].endswith(tuple(SKIP_SUFFIXES))


async def download(tag, client, report=None):
    """Telecharge l'archive de la version cible dans data/tmp."""
    if report:
        await report("Téléchargement de " + str(tag) + "...")
    work = config.DATA_DIR / "tmp" / ("update_" + safe_tag(tag))
    if work.exists():
        shutil.rmtree(work)
    work.mkdir(parents=True, exist_ok=True)
    zip_path = work / "update.zip"

    headers = {"User-Agent": "pocket-lan/" + __version__}
    if config.GITHUB_TOKEN:
        headers["Authorization"] = "Bearer " + config.GITHUB_TOKEN

    url = archive_url(tag)
    async with client.stream(
        "GET", url, headers=headers, timeout=120.0, follow_redirects=True
    ) as response:
        if response.status_code >= 400:
            raise RuntimeError(
                f"téléchargement de {tag} impossible (HTTP {response.status_code})"
            )
        with zip_path.open("wb") as handle:
            async for chunk in response.aiter_bytes():
                handle.write(chunk)
    return work, zip_path


def install(work: Path, zip_path: Path, tag):
    """Dézipe et copie les fichiers, avec sauvegarde et retour en arrière.

    Renvoie le dossier de sauvegarde des fichiers écrasés.
    """
    extract_dir = work / "src"
    if extract_dir.exists():
        shutil.rmtree(extract_dir)
    extract_dir.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(zip_path) as archive:
        archive.extractall(extract_dir)

    root = _source_root(extract_dir)
    backup = config.DATA_DIR / ("backup_" + safe_tag(tag))
    counter = 2
    while backup.exists():
        backup = config.DATA_DIR / (f"backup_{safe_tag(tag)}_{counter}")
        counter += 1

    backed_up = []
    created = []
    try:
        for src in sorted(root.rglob("*")):
            if not src.is_file():
                continue
            rel = src.relative_to(root)
            if _skip(rel):
                continue
            dest = config.BASE_DIR / rel
            if dest.is_dir():
                continue
            if dest.exists():
                saved = backup / rel
                saved.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(dest, saved)
                backed_up.append((dest, saved))
            else:
                created.append(dest)
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dest)
    except Exception:
        for dest in created:
            try:
                dest.unlink()
            except OSError:
                pass
        for dest, saved in backed_up:
            try:
                shutil.copy2(saved, dest)
            except OSError:
                pass
        raise
    return str(backup)
