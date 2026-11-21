"""Detection silencieuse des releases.

Le serveur peut verifier periodiquement si une nouvelle version est publiee
sur GitHub. La verification est cachee et silencieuse : aucun message n'est
envoye aux utilisateurs, le resultat est conserve cote serveur pour un usage
ulterieur (ex. page admin).

La detection est desactivee si aucun depot GitHub n'est configure.
"""

import asyncio
import os
import re
import subprocess
import time
from typing import Any

import httpx

from . import __version__, config

# Intervalle entre deux verifications reussies ou tentees (6 heures).
CHECK_INTERVAL_SECONDS = 6 * 60 * 60
# Delai avant la premiere verification au demarrage, pour ne pas ralentir l'amorce.
STARTUP_DELAY_SECONDS = 20


def _parse_version(value: str) -> tuple[int, ...]:
    """Extrait les composantes numeriques d'une version (ex. v1.2.3, 1.2)."""
    numbers = re.findall(r"\d+", str(value or ""))
    if not numbers:
        return (0,)
    return tuple(int(n) for n in numbers)


def _newer(latest: str, current: str) -> bool:
    left = _parse_version(latest)
    right = _parse_version(current)
    # Compare sur la longueur commune, puis considere 1.2.1 > 1.2.
    width = max(len(left), len(right))
    left += (0,) * (width - len(left))
    right += (0,) * (width - len(right))
    return left > right


def _git_latest_tag() -> tuple[str, str]:
    """Lit le dernier tag distant via git, sans token GitHub.

    Les dépôts privés renvoient 404 sur l'API anonyme. Comme l'application
    dispose déjà des identifiants git (gestionnaire d'identifiants Windows,
    SSH, etc.), les tags locaux sont une source de détection fiable.
    """
    env = dict(os.environ)
    env["GIT_TERMINAL_PROMPT"] = "0"
    try:
        result = subprocess.run(
            ["git", "ls-remote", "--tags", "origin"],
            cwd=str(config.BASE_DIR),
            capture_output=True,
            text=True,
            timeout=20,
            env=env,
        )
    except (OSError, subprocess.SubprocessError):
        return "", ""
    if result.returncode != 0:
        return "", ""

    tags = []
    for line in (result.stdout or "").splitlines():
        ref = line.split("\t", 1)[-1].strip()
        if not ref.startswith("refs/tags/"):
            continue
        tag = ref[len("refs/tags/") :]
        if tag.endswith("^{}") or not re.fullmatch(r"v?\d+(?:\.\d+)*", tag):
            continue
        tags.append(tag)
    if not tags:
        return "", ""

    latest = max(tags, key=_parse_version)
    url = "https://github.com/" + config.GITHUB_REPO + "/releases/tag/" + latest
    return latest, url


def initial_state() -> dict[str, Any]:
    configured = bool(config.GITHUB_REPO)
    return {
        "enabled": configured,
        "repo": config.GITHUB_REPO,
        "current": __version__,
        "latest": "",
        "update_available": False,
        "url": "",
        "checked_at": 0,
        "error": "" if configured else "non configure",
        "applying": False,
        "apply_status": "",
        "apply_message": "",
        "applied_by": "",
    }


def public_state(state: dict[str, Any]) -> dict[str, Any]:
    return {
        "enabled": bool(state.get("enabled")),
        "repo": state.get("repo", ""),
        "current": state.get("current", __version__),
        "latest": state.get("latest", ""),
        "update_available": bool(state.get("update_available")),
        "url": state.get("url", ""),
        "checked_at": int(state.get("checked_at") or 0),
        "error": state.get("error", ""),
        "applying": bool(state.get("applying")),
        "apply_status": state.get("apply_status", ""),
        "apply_message": state.get("apply_message", ""),
        "applied_by": state.get("applied_by", ""),
    }


async def check_once(client: httpx.AsyncClient, state: dict[str, Any]) -> dict[str, Any]:
    """Effectue une verification. Met a jour et renvoie l'etat."""
    prev_available = bool(state.get("update_available"))
    prev_latest = str(state.get("latest") or "")
    if not config.GITHUB_REPO:
        base = initial_state()
        # conserver les champs d'application en cours si présents
        for k in ("applying", "apply_status", "apply_message", "applied_by"):
            if k in state:
                base[k] = state[k]
        state.clear()
        state.update(base)
        state["changed"] = (prev_available != state.get("update_available")) or (prev_latest != state.get("latest"))
        return state

    url = "https://api.github.com/repos/" + config.GITHUB_REPO + "/releases/latest"
    headers = {
        "Accept": "application/vnd.github+json",
        "User-Agent": "pocket-lan/" + __version__,
    }
    if config.GITHUB_TOKEN:
        headers["Authorization"] = "Bearer " + config.GITHUB_TOKEN

    error = ""
    latest = ""
    html_url = ""
    try:
        response = await client.get(url, headers=headers, timeout=15.0)
        response.raise_for_status()
        payload = response.json()
        latest = str(payload.get("tag_name") or payload.get("name") or "").strip()
        html_url = str(payload.get("html_url") or "").strip()
    except Exception as err:  # noqa: BLE001 - silencieux : on conserve l'erreur sans bruit
        error = str(err)
        # Depot prive : l'API anonyme renvoie 404. Les identifiants git deja
        # configures permettent de lire les tags sans jeton supplementaire.
        latest, html_url = await asyncio.to_thread(_git_latest_tag)
        if latest:
            error = ""

    state.update(
        {
            "enabled": True,
            "repo": config.GITHUB_REPO,
            "current": __version__,
            "latest": latest,
            "update_available": _newer(latest, __version__) if latest else False,
            "url": html_url,
            "checked_at": int(time.time()),
            "error": error,
        }
    )
    state["changed"] = (prev_available != bool(state.get("update_available"))) or (prev_latest != str(state.get("latest") or ""))
    return state


async def loop(client: httpx.AsyncClient, state: dict[str, Any], stop: asyncio.Event, on_change=None):
    """Boucle periodique. Notifie on_change(state) si l'état de mise à jour change."""
    await asyncio.sleep(STARTUP_DELAY_SECONDS)
    while not stop.is_set():
        await check_once(client, state)
        if on_change and state.get("changed"):
            try:
                await on_change(state)
            except Exception:
                pass
        try:
            await asyncio.wait_for(stop.wait(), timeout=CHECK_INTERVAL_SECONDS)
        except asyncio.TimeoutError:
            pass
