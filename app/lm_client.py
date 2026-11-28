"""Client de chat : liste des modeles, streaming, file d'attente.

LM Studio et Ollama exposent la meme API OpenAI compatible. Le client recoit
l'URL et le backend en parametre : un seul chemin de code pour les deux.
Plusieurs utilisateurs peuvent interroger le meme modele en meme temps, mais
chaque prediction coute du temps : on passe donc par une file FIFO dont la
taille est reglable (maxParallel).
"""

import asyncio
import json
import time

import httpx

from . import config, uploads


class LmError(Exception):
    """Erreur du serveur LM Studio, message pret a afficher."""


async def list_models(client, base_url=None, backend=None, include_not_loaded=True):
    """Liste des modeles du backend choisi, avec etat et fenetre de contexte."""
    url = (base_url or config.LM_BASE_URL).rstrip("/")
    is_ollama = backend == "ollama"
    name = "Ollama" if is_ollama else "LM Studio"

    if not is_ollama:
        # Route native LM Studio : given plus de details (etat, quantification).
        try:
            response = await client.get(url + "/api/v0/models", timeout=10)
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

    # Route OpenAI compatible : /v1/models fonctionne pour les deux serveurs.
    try:
        response = await client.get(url + "/v1/models", timeout=10)
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
        raise LmError(name + " est injoignable sur " + url) from err


async def resolve_model(client, model, base_url=None, backend=None):
    """Rend un identifiant de modele qui existe vraiment sur le backend choisi.

    Apres une bascule LM Studio <-> Ollama, le modele enregistre peut etre un
    identifiant de l'autre serveur (ex. ``google/gemma-4-12b`` n'existe pas dans
    Ollama) : on retombe alors sur le premier modele disponible au lieu de
    laisser le serveur repondre 404. Rend (modele, change).
    """
    wanted = str(model or "").strip()
    try:
        models = await list_models(client, base_url=base_url, backend=backend)
        ids = [str(item.get("id") or "") for item in models if item.get("id")]
    except Exception:  # noqa: BLE001 - serveur eteint : le chat donnera l'erreur exacte
        return wanted, False

    if wanted and wanted in ids:
        return wanted, False
    # Un modele d'embedding ne sait pas discuter : on l'ecarte du repli.
    usable = [
        item for item in ids
        if not any(mark in item.lower() for mark in ("embed", "bge", "nomic-embed"))
    ]
    if usable:
        return usable[0], True
    if backend == "ollama":
        if ids:
            raise LmError(
                "Aucun modele de chat dans Ollama : seuls des modeles d'embedding sont installes."
            )
        raise LmError(
            "Aucun modele installe dans Ollama. Installe-en un avec : ollama pull <modele>."
        )
    return wanted, False


async def supports_vision(client, model, base_url=None, backend=None):
    """True/False si le modele lit les images, None si on ne sait pas.

    Ollama expose ses capacites via /api/show ; LM Studio marque les modeles
    vision avec le type "vlm" dans /api/v0/models. En cas de doute on renvoie
    None pour ne pas bloquer une requete qui pourrait marcher.
    """
    name = str(model or "").strip()
    if not name:
        return None
    url = (base_url or config.LM_BASE_URL).rstrip("/")

    if backend == "ollama":
        try:
            response = await client.post(
                url + "/api/show", json={"model": name}, timeout=10
            )
            if response.status_code == 200:
                capabilities = response.json().get("capabilities")
                if isinstance(capabilities, list):
                    return "vision" in capabilities
        except Exception:  # noqa: BLE001 - serveur ancien ou eteint
            return None
        return None

    try:
        response = await client.get(url + "/api/v0/models", timeout=10)
        if response.status_code == 200:
            for item in response.json().get("data") or []:
                if item.get("id") == name:
                    kind = str(item.get("type") or "").lower()
                    return "vlm" in kind or "vision" in kind
    except Exception:  # noqa: BLE001 - detection best-effort
        return None
    return None


async def chat_stream(
    client, model, messages,
    stop_event=None, base_url=None, backend=None,
):
    """Envoie une requete de chat et rend les morceaux au fur et a mesure.

    Rend des tuples (kind, text) avec kind = 'content', 'reasoning' ou 'usage'.

    Mesure sur qwen3-0.6b : la reponse arrive parfois dans reasoning_content
    avec content vide et finish_reason = length, meme avec thinking = false.
    On rend donc les deux, et l'appelant decide ce qu'il affiche.

    Pour eviter que le raisonnement ne pollue la reponse, on envoie
    reasoning_effort=none : LM Studio et Ollama le comprennent tous les deux.
    La longueur et la temperature sont laissees aux reglages du backend :
    aucun max_tokens ni temperature n'est envoye dans le payload.
    """
    url = (base_url or config.LM_BASE_URL).rstrip("/")
    is_ollama = backend == "ollama"
    name = "Ollama" if is_ollama else "LM Studio"
    payload = {
        "model": model,
        "messages": messages,
        "stream": True,
    }
    # "none" desactive le thinking sur les deux backends : Ollama le traduit en
    # think:false (voir openai.ThinkingFromReasoningEffort). Sans cette cle,
    # Ollama active le raisonnement par defaut et le texte peut fuir dans la
    # reponse. chat_template_kwargs n'est compris que par LM Studio.
    payload["reasoning_effort"] = "none"
    if not is_ollama:
        payload["chat_template_kwargs"] = {"thinking": False}

    try:
        async with client.stream(
            "POST",
            url + "/v1/chat/completions",
            json=payload,
            timeout=httpx.Timeout(15.0, read=180.0),
        ) as response:
            if response.status_code != 200:
                body = (await response.aread()).decode("utf-8", "replace")
                raise LmError(
                    name + " a refuse la requete (" + str(response.status_code) + ") : " + body[:200]
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
                    # LM Studio envoie reasoning_content, Ollama peut envoyer reasoning.
                    reasoning = delta.get("reasoning_content") or delta.get("reasoning") or ""
                    if content:
                        yield ("content", content)
                    elif reasoning:
                        yield ("reasoning", reasoning)

            if usage:
                yield ("usage", usage)
    except httpx.HTTPError as err:
        raise LmError(name + " est injoignable sur " + url) from err


def estimate_tokens(text):
    """Estimation approximative, pas un comptage exact."""
    return max(1, int(len(str(text or "")) / config.CHARS_PER_TOKEN))


def build_messages(system_prompt, history, budget_tokens):
    """Construit la requete : consigne + historique tronque au budget demande.

    Les pieces jointes textuelles sont injectees dans le message, les images
    envoyees comme parties image_url (format OpenAI, compris par les deux
    backends). On garde les messages les plus recents ; le dernier est toujours
    conserve, sinon le modele n'aurait rien a traiter.
    """
    budget = max(120, int(budget_tokens))
    used = estimate_tokens(system_prompt) + 12
    kept = []

    for message in reversed(history):
        content = str(message.get("content") or "").strip()
        attachments = message.get("attachments") or []
        if not isinstance(attachments, list):
            attachments = []

        text_parts = []
        image_parts = []
        for attachment in attachments:
            if not isinstance(attachment, dict):
                continue
            if attachment.get("kind") == "image":
                data_url = uploads.image_data_url(attachment.get("path"))
                if data_url and len(image_parts) < uploads.MAX_IMAGES:
                    image_parts.append({"type": "image_url", "image_url": {"url": data_url}})
            else:
                text = str(attachment.get("text") or "").strip()
                if text:
                    name = str(attachment.get("name") or "fichier joint")
                    text_parts.append("--- fichier : " + name + " ---\n" + text)

        if not content and not text_parts and not image_parts:
            continue

        # Une image coute environ 1000 tokens dans les modeles vision.
        cost = (
            estimate_tokens(content)
            + sum(estimate_tokens(part) for part in text_parts)
            + len(image_parts) * 1000
            + 4
        )
        if kept and used + cost > budget:
            break

        if image_parts or text_parts:
            parts = []
            if content:
                parts.append({"type": "text", "text": content})
            parts.extend({"type": "text", "text": part} for part in text_parts)
            parts.extend(image_parts)
            entry_content = parts
        else:
            entry_content = content

        kept.append({"role": message.get("role") or "user", "content": entry_content})
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
