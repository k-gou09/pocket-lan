"""Client LM Studio : liste des modeles, chat en streaming, file d'attente.

Le serveur de LM Studio ecoute sur http://127.0.0.1:1234 et expose l'API
OpenAI compatible. Plusieurs utilisateurs peuvent interroger le meme modele en
meme temps, mais chaque prediction coute du temps : on passe donc par une file
FIFO dont la taille est reglable (maxParallel).
"""

import asyncio
import json

import httpx

from . import config


class LmError(Exception):
    """Erreur du serveur LM Studio, message pret a afficher."""


async def list_models(client, include_not_loaded=True):
    """Liste des modeles connus de LM Studio, avec etat et fenetre de contexte."""
    try:
        response = await client.get(config.LM_BASE_URL + "/api/v0/models", timeout=10)
        if response.status_code == 200:
            data = response.json().get("data") or []
            models = []
            for item in data:
                models.append(
                    {
                        "id": item.get("id"),
                        "type": item.get("type") or "llm",
                        "state": item.get("state") or "unknown",
                        "arch": item.get("arch") or "",
                        "quantization": item.get("quantization") or "",
                        "max_context_length": int(item.get("max_context_length") or 0),
                        "loaded_context_length": int(item.get("loaded_context_length") or 0),
                    }
                )
            if not include_not_loaded:
                models = [m for m in models if m["state"] == "loaded"]
            return models
    except (httpx.HTTPError, ValueError):
        pass

    # retombe sur l'API publique, qui ne liste que les modeles charges
    try:
        response = await client.get(config.LM_BASE_URL + "/v1/models", timeout=10)
        response.raise_for_status()
        models = []
        for item in response.json().get("data") or []:
            models.append(
                {
                    "id": item.get("id"),
                    "type": "llm",
                    "state": "loaded",
                    "arch": "",
                    "quantization": "",
                    "max_context_length": 0,
                    "loaded_context_length": 0,
                }
            )
        return models
    except (httpx.HTTPError, ValueError) as err:
        raise LmError("LM Studio est injoignable sur " + config.LM_BASE_URL) from err


async def chat_stream(client, model, messages, max_tokens, temperature, stop_event=None):
    """Envoie une requete de chat et rend les morceaux au fur et a mesure.

    Rend des tuples (kind, text) avec kind = 'content', 'reasoning' ou 'usage'.

    Mesure sur qwen3-0.6b : la reponse arrive parfois dans reasoning_content
    avec content vide et finish_reason = length, meme avec thinking = false.
    On rend donc les deux, et l'appelant decide ce qu'il affiche.

    Pour eviter que le raisonnement ne pollue la reponse, on envoie
    reasoning_effort=none (route OpenAI) ou reasoning=off (route native).
    """
    payload = {
        "model": model,
        "messages": messages,
        "max_tokens": int(max_tokens),
        "temperature": float(temperature),
        "stream": True,
        "reasoning_effort": "none",
        "chat_template_kwargs": {"thinking": False},
    }

    try:
        async with client.stream(
            "POST",
            config.LM_BASE_URL + "/v1/chat/completions",
            json=payload,
            timeout=httpx.Timeout(15.0, read=180.0),
        ) as response:
            if response.status_code != 200:
                body = (await response.aread()).decode("utf-8", "replace")
                raise LmError(
                    "LM Studio a refuse la requete (" + str(response.status_code) + ") : " + body[:200]
                )

            usage = {}
            async for line in response.aiter_lines():
                if stop_event is not None and stop_event.is_set():
                    break
                if not line.startswith("data:"):
                    continue
                data = line[5:].strip()
                if data == "[DONE]":
                    break
                try:
                    chunk = json.loads(data)
                except json.JSONDecodeError:
                    continue

                if chunk.get("usage"):
                    usage = chunk["usage"]

                for choice in chunk.get("choices") or []:
                    delta = choice.get("delta") or {}
                    content = delta.get("content") or ""
                    reasoning = delta.get("reasoning_content") or ""
                    if content:
                        yield ("content", content)
                    elif reasoning:
                        yield ("reasoning", reasoning)

            if usage:
                yield ("usage", usage)
    except httpx.HTTPError as err:
        raise LmError("LM Studio est injoignable sur " + config.LM_BASE_URL) from err


def estimate_tokens(text):
    """Estimation approximative, pas un comptage exact."""
    return max(1, int(len(str(text or "")) / config.CHARS_PER_TOKEN))


def build_messages(system_prompt, history, budget_tokens):
    """Construit la requete : consigne + historique tronque au budget demande.

    On garde les messages les plus recents. Le dernier message est toujours
    conserve, sinon le modele n'aurait rien a traiter.
    """
    budget = max(120, int(budget_tokens))
    used = estimate_tokens(system_prompt) + 12
    kept = []

    for message in reversed(history):
        content = str(message.get("content") or "").strip()
        if not content:
            continue
        cost = estimate_tokens(content) + 4
        if kept and used + cost > budget:
            break
        kept.append({"role": message.get("role") or "user", "content": content})
        used += cost

    kept.reverse()
    return [{"role": "system", "content": system_prompt}] + kept


class FifoGate:
    """File d'attente equitable : premier demande, premier servi."""

    def __init__(self, limit=2):
        self.limit = max(1, int(limit or 1))
        self.running = 0
        self.waiting = []

    def snapshot(self):
        return {"limit": self.limit, "running": self.running, "waiting": len(self.waiting)}

    def _advance(self):
        while self.running < self.limit and self.waiting:
            entry = self.waiting.pop(0)
            if entry["cancelled"]:
                continue
            self.running += 1
            entry["event"].set()
            return

    async def acquire(self):
        entry = {"event": asyncio.Event(), "cancelled": False}
        self.waiting.append(entry)
        self._advance()
        if not entry["event"].is_set():
            try:
                await entry["event"].wait()
            except asyncio.CancelledError:
                entry["cancelled"] = True
                self._advance()
                raise
        return entry

    def release(self, entry):
        if entry["cancelled"]:
            return
        self.running = max(0, self.running - 1)
        self._advance()
