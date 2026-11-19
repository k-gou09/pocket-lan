"""Detection silencieuse des releases.

Le serveur peut verifier periodiquement si une nouvelle version est publiee
sur GitHub. La verification est cachee et silencieuse : aucun message n'est
envoye aux utilisateurs, le resultat est conserve cote serveur pour un usage
ulterieur (ex. page admin).

La detection est desactivee si aucun depot GitHub n'est configure.
"""

import asyncio
import re
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
    }


async def check_once(client: httpx.AsyncClient, state: dict[str, Any]) -> dict[str, Any]:
    """Effectue une verification. Met a jour et renvoie l'etat."""
    if not config.GITHUB_REPO:
        state.update(initial_state())
        return state

    url = "https://api.github.com/repos/" + config.GITHUB_REPO + "/releases/latest"
    headers = {
        "Accept": "application/vnd.github+json",
        "User-Agent": "pocket-lan/" + __version__,
    }
    try:
        response = await client.get(url, headers=headers, timeout=15.0)
        response.raise_for_status()
        payload = response.json()
        latest = str(payload.get("tag_name") or payload.get("name") or "").strip()
        html_url = str(payload.get("html_url") or "").strip()
        state.update(
            {
                "enabled": True,
                "repo": config.GITHUB_REPO,
                "current": __version__,
                "latest": latest,
                "update_available": _newer(latest, __version__) if latest else False,
                "url": html_url,
                "checked_at": int(time.time()),
                "error": "",
            }
        )
    except Exception as err:  # noqa: BLE001 - silencieux : on conserve l'erreur sans bruit
        state["enabled"] = True
        state["repo"] = config.GITHUB_REPO
        state["current"] = __version__
        state["checked_at"] = int(time.time())
        state["error"] = str(err)
    return state


async def loop(client: httpx.AsyncClient, state: dict[str, Any], stop: asyncio.Event):
    """Boucle periodique, silencieuse. S'arrete quand stop est signale."""
    await asyncio.sleep(STARTUP_DELAY_SECONDS)
    while not stop.is_set():
        await check_once(client, state)
        try:
            await asyncio.wait_for(stop.wait(), timeout=CHECK_INTERVAL_SECONDS)
        except asyncio.TimeoutError:
            pass
