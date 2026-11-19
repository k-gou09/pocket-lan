"""Generation d'une reponse : troncature de l'historique, file d'attente, streaming.

La file est commune a tous les utilisateurs : LM Studio ne peut traiter qu'un
petit nombre de predictions a la fois. Une demande en attente n'est pas rejetee,
elle est jouee a son tour.

Une seule reponse par session a la fois (verrou du hub) : deux onglets de la
meme session se suivent au lieu de s'entrecouper.
"""

import time

from . import lm_client, store


async def answer(hub, client, gate, session_id, conv_id, user_text):
    if hub.session_lock(session_id).locked():
        await hub.send(
            session_id,
            {"type": "notice", "message": "Une reponse est deja en cours : ta demande attend sa fin."},
        )

    async with hub.session_lock(session_id):
        settings = store.effective_settings(session_id)

        conv = store.get_conversation(conv_id)
        if conv is None:
            conv = store.create_conversation(session_id)

        if not store.list_messages(conv["id"]):
            conv["title"] = store.derive_title(user_text)

        user_message = store.add_message(conv["id"], "user", user_text)
        await hub.send(session_id, {"type": "message", "conversation": conv, "message": user_message})

        history = store.list_messages(conv["id"])
        messages = lm_client.build_messages(settings["systemPrompt"], history, settings["contextBudget"])

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
                settings.get("model") or "qwen3.5-4b",
                messages,
                settings["maxTokens"],
                settings["temperature"],
                stop_event=stop_event,
            ):
                if stop_event.is_set():
                    break
                if kind == "usage":
                    usage = piece
                    continue
                if kind == "content":
                    content_parts.append(piece)
                    await hub.send(
                        session_id,
                        {"type": "chunk", "conv_id": conv["id"], "message_id": message_id, "kind": "content", "delta": piece},
                    )
                elif kind == "reasoning":
                    reasoning_parts.append(piece)
                    if settings.get("showReasoning"):
                        await hub.send(
                            session_id,
                            {"type": "chunk", "conv_id": conv["id"], "message_id": message_id, "kind": "reasoning", "delta": piece},
                        )
        except lm_client.LmError as err:
            error = str(err)
        finally:
            gate.release(entry)

        text = "".join(content_parts).strip()
        if not text:
            # Cas mesure sur qwen3-0.6b : le texte arrive dans reasoning_content et
            # content reste vide avec finish_reason = length. On ne simule rien : on
            # rend le texte reellement produit par le modele.
            text = "".join(reasoning_parts).strip()

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
