"""Generation d'une reponse : troncature de l'historique, file d'attente, streaming.

La file est commune a tous les utilisateurs : LM Studio ne peut traiter qu'un
petit nombre de predictions a la fois. Une demande en attente n'est pas rejetee,
elle est jouee a son tour.

Une seule reponse par session a la fois (verrou du hub) : deux onglets de la
meme session se suivent au lieu de s'entrecouper.
"""

import re
import time

from . import avatar_personas, backends, lm_client, store

# Certains modeles (qwen3, gemma3) ecrivent encore leur raisonnement dans le
# champ content quand thinking est desactive. On ne le laisse jamais atteindre
# la bulle : un texte de ce type n'est pas une reponse exploitable.
_REASONING_PREFIX = re.compile(
    r"^\s*(?:\*\*)?(?:thinking process|thought process|reasoning|analysis|"
    r"raisonnement|analyse)\s*(?:\*\*)?\s*[:：]\s*",
    re.IGNORECASE,
)
_REASONING_STEP = re.compile(
    r"^\s*(?:\d+[.)]|[-*])\s+"
    r"(?:analyze|analyse|analyser|identify|identifier|extraire|extract|"
    r"determine|déterminer|think|réfléchir|consider|considérer|review|"
    r"examiner|vérifier)\b",
    re.IGNORECASE,
)


def clean_answer(text):
    """Retire un titre de raisonnement et refuse une suite d'etapes internes."""
    cleaned = _REASONING_PREFIX.sub("", str(text or ""), count=1).strip()
    if not cleaned or _REASONING_STEP.match(cleaned):
        return ""
    return cleaned


async def answer(
    hub, client, gate, session_id, conv_id, user_text,
    regenerate=False, attachment_ids=None,
):
    if hub.session_lock(session_id).locked():
        await hub.send(
            session_id,
            {"type": "notice", "message": "Une reponse est deja en cours : ta demande attend sa fin."},
        )

    async with hub.session_lock(session_id):
        settings = store.effective_settings(session_id)
        backend = backends.normalize(settings.get("backend"))
        base_url = backends.base_url(backend, settings)

        # On n'accepte que les uploads appartenant a la session et encore libres.
        attachments = []
        for att_id in list(attachment_ids or [])[:8]:
            found = store.get_attachment(session_id, att_id)
            if found and not found.get("message_id"):
                attachments.append(found)
        ids = [item["id"] for item in attachments]

        conv = store.get_conversation(conv_id)
        if conv is None:
            if regenerate:
                await hub.send(session_id, {"type": "error", "message": "Conversation introuvable."})
                return
            conv = store.create_conversation(session_id)

        # Le modele enregistre peut venir de l'autre backend : on le remplace
        # par un modele reellement present avant d'envoyer la requete.
        try:
            model, changed = await lm_client.resolve_model(
                client, settings.get("model"), base_url, backend
            )
        except lm_client.LmError as err:
            await hub.send(
                session_id,
                {"type": "error", "message": str(err), "conv_id": conv["id"]},
            )
            return
        if changed:
            store.save_global_settings({"model": model})
            await hub.broadcast({"type": "global", "settings": store.get_global_settings()})
            await hub.send(
                session_id,
                {
                    "type": "notice",
                    "message": "Modèle adapté à " + backends.label(backend) + " : " + model,
                },
            )

        if regenerate:
            last_user = store.last_user_message(conv["id"])
            if last_user is None:
                await hub.send(session_id, {"type": "error", "message": "Aucun message à régénérer.", "conv_id": conv["id"]})
                return
            # informe les onglets que la réponse précédente est retirée
            await hub.send(session_id, {"type": "regenerate_start", "conv_id": conv["id"]})
        else:
            title_source = user_text or (attachments[0]["name"] if attachments else "")
            if not store.list_messages(conv["id"]):
                conv["title"] = store.derive_title(title_source)

            user_message = store.add_message(conv["id"], "user", user_text, attachments=ids)
            store.bind_attachments(session_id, ids, conv["id"], user_message["id"])
            await hub.send(
                session_id,
                {
                    "type": "message",
                    "conversation": conv,
                    "message": store.public_message(user_message),
                },
            )

        # Une image jointe a un modele de texte serait ignoree en silence : on
        # l'annonce clairement, et la regeneration permettra de reessayer avec
        # un modele vision sans re-uploader le fichier.
        last_user = store.last_user_message(conv["id"])
        last_attachments = (last_user or {}).get("attachments") or []
        if any(item.get("kind") == "image" for item in last_attachments):
            vision = await lm_client.supports_vision(client, model, base_url, backend)
            if vision is False:
                note = (
                    "Je ne peux pas lire les images avec le modèle « " + model + " ». "
                    "Choisis un modèle vision dans les réglages, puis clique sur Régénérer."
                )
                saved = store.add_message(conv["id"], "assistant", note)
                await hub.send(
                    session_id,
                    {
                        "type": "done",
                        "conv_id": conv["id"],
                        "message_id": saved["id"],
                        "message": store.public_message(saved),
                        "usage": {},
                        "used_reasoning": False,
                        "elapsed_ms": 0,
                        "stopped": False,
                        "speak": False,
                    },
                )
                return

        history = store.list_messages(conv["id"])
        system_prompt = avatar_personas.system_prompt(
            settings.get("persona"), settings.get("avatar")
        )
        messages = lm_client.build_messages(system_prompt, history, settings["contextBudget"])

        stop_event = hub.stop_flag(session_id)
        stop_event.clear()
        usage = {}
        message_id = store.new_id()

        waiting = gate.snapshot()
        if waiting["waiting"] > 0:
            await hub.send(
                session_id,
                {"type": "notice", "message": "Attente de la file : " + str(waiting["waiting"]) + " demande(s) avant la tienne."},
            )

        hub.set_activity(session_id, state="thinking")
        await hub.broadcast({"type": "activity", "activity": hub.participants()})

        content_parts = []
        reasoning_parts = []
        started_at = time.time()
        error = None

        entry = await gate.acquire()
        try:
            async for kind, piece in lm_client.chat_stream(
                client,
                model,
                messages,
                stop_event=stop_event,
                base_url=base_url,
                backend=backend,
            ):
                if stop_event.is_set():
                    break
                if kind == "usage":
                    usage = piece
                    continue
                if kind == "content":
                    content_parts.append(piece)
                    await hub.send_stream(
                        session_id,
                        {"type": "chunk", "conv_id": conv["id"], "message_id": message_id, "kind": "content", "delta": piece},
                    )
                elif kind == "reasoning":
                    reasoning_parts.append(piece)
                    if settings.get("showReasoning"):
                        await hub.send_stream(
                            session_id,
                            {"type": "chunk", "conv_id": conv["id"], "message_id": message_id, "kind": "reasoning", "delta": piece},
                        )
        except lm_client.LmError as err:
            error = str(err)
        finally:
            gate.release(entry)

        text = clean_answer("".join(content_parts).strip())
        if not text:
            # Cas mesure sur qwen3-0.6b : le texte arrive dans reasoning_content et
            # content reste vide avec finish_reason = length. On ne simule rien : on
            # rend le texte reellement produit par le modele, sauf s'il s'agit
            # encore d'etapes de raisonnement (ex. "Thinking Process: 1. ...").
            text = clean_answer("".join(reasoning_parts).strip())

        if error:
            hub.set_activity(session_id, state="error")
            await hub.send(
                session_id,
                {"type": "error", "message": error, "conv_id": conv["id"]},
            )
            await hub.broadcast({"type": "activity", "activity": hub.participants()})
            return

        if not text:
            await hub.send(
                session_id,
                {"type": "error", "message": "Le modele n'a produit aucun texte exploitable.", "conv_id": conv["id"]},
            )
            hub.set_activity(session_id, state="idle")
            await hub.broadcast({"type": "activity", "activity": hub.participants()})
            return

        saved = store.add_message(conv["id"], "assistant", text, tokens=int(usage.get("total_tokens") or 0))
        await hub.send_done(
            session_id,
            {
                "type": "done",
                "conv_id": conv["id"],
                "message_id": message_id,
                "message": saved,
                "usage": usage,
                "used_reasoning": not bool(content_parts),
                "elapsed_ms": int((time.time() - started_at) * 1000),
                "stopped": stop_event.is_set(),
            },
        )

        hub.set_activity(session_id, state="idle")
        await hub.broadcast({"type": "activity", "activity": hub.participants()})
