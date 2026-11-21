"""Serveur FastAPI : API, salle temps reel et interface PC en deux volets.

Lance avec :
  python -m uvicorn app.main:app --host 0.0.0.0 --port 8000

Le port est ouvert sur toutes les interfaces : les autres PC du reseau ouvrent
http://ADRESSE_IP_DU_SERVEUR:8000.
"""

import asyncio
import os
import socket
import subprocess
import sys
from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI, Request, Response, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles

from . import __version__, config, lm_client, model_mgr, personas, release, store
from .lm_client import FifoGate
from .service import answer
from .ws import Hub


@asynccontextmanager
async def lifespan(application: FastAPI):
    store.connect()
    personas.ensure_seeded()
    application.state.hub = Hub()
    application.state.client = httpx.AsyncClient()
    application.state.gate = FifoGate(store.get_global_settings().get("maxParallel", 2))
    application.state.release = release.initial_state()
    application.state.release_stop = asyncio.Event()
    application.state.admin_sessions = set()
    application.state.restart_code = 0

    async def on_release_change(state):
        await application.state.hub.broadcast({"type": "update", "update": release.public_state(state)})

    print_startup()
    prune_task = asyncio.create_task(prune_loop(application.state.hub))
    release_task = asyncio.create_task(
        release.loop(application.state.client, application.state.release, application.state.release_stop, on_change=on_release_change)
    )
    try:
        yield
    finally:
        application.state.release_stop.set()
        release_task.cancel()
        prune_task.cancel()
        await application.state.client.aclose()


async def prune_loop(hub):
    """Purge periodique des sessions inactives : pas de fantomes dans la salle."""
    while True:
        await asyncio.sleep(60)
        if hub.prune_stale():
            await hub.broadcast({"type": "activity", "activity": hub.participants()})


app = FastAPI(title="Pocket LAN", version=__version__, lifespan=lifespan)
app.mount("/static", StaticFiles(directory=str(config.STATIC_DIR), html=True), name="static")


@app.middleware("http")
async def revalidate_static(request: Request, call_next):
    """Force le navigateur a revalider les fichiers de l'interface.

    Sans en-tete de cache, Chrome applique une fraicheur heuristique et peut
    garder un ancien client.js : une mise a jour du serveur resterait invisible
    jusqu'a un vidage manuel du cache. "no-cache" garde le 304 (rapide en LAN)
    tout en verifiant la version a chaque chargement.
    """
    response = await call_next(request)
    if request.url.path.startswith("/static"):
        response.headers["Cache-Control"] = "no-cache"
    return response


# ---------------------------------------------------------------------------
# outillage commun
# ---------------------------------------------------------------------------


def hub():
    return app.state.hub


def gate():
    return app.state.gate


def client():
    return app.state.client


def local_ip():
    """Adresse reseau utilisable par les autres machines, sans rien envoyer."""
    try:
        probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        probe.settimeout(0.2)
        probe.connect(("10.255.255.255", 1))
        address = probe.getsockname()[0]
        probe.close()
        return address
    except OSError:
        return "127.0.0.1"


def session_id(request):
    sid = request.cookies.get(config.COOKIE_NAME) or request.query_params.get("sid") or ""
    return sid or store.new_id()


def cookie_header(sid):
    return config.COOKIE_NAME + "=" + sid + "; Path=/; SameSite=Lax; HttpOnly"


def json_ok(payload, sid=None):
    response = JSONResponse(payload)
    if sid:
        response.headers["Set-Cookie"] = cookie_header(sid)
    return response


def snapshot(sid):
    settings = store.effective_settings(sid)
    admins = getattr(app.state, "admin_sessions", set())
    rel = getattr(app.state, "release", {})
    return {
        "session": store.ensure_session(sid),
        "settings": settings,
        "conversations": store.list_conversations(sid),
        "participants": hub().participants(),
        "model": settings.get("model"),
        "cli": model_mgr.cli_available(),
        "gate": gate().snapshot(),
        "personas": personas.list_personas(),
        "active_persona": personas.get_active(),
        "update": release.public_state(rel) if rel else {},
        "is_admin": sid in admins,
        "admin_enabled": bool(config.ADMIN_TOKEN),
    }


def print_startup():
    address = local_ip()
    print("Pocket LAN " + __version__ + " sur :")
    print("  local      http://localhost:" + str(config.PORT))
    print("  reseau     http://" + address + ":" + str(config.PORT))
    print("  LM Studio  " + config.LM_BASE_URL)
    print("  CLI lms    " + (model_mgr.cli_path() or "absent (le modele doit etre charge dans LM Studio)"))
    print("  base       " + str(config.DB_PATH))


# ---------------------------------------------------------------------------
# cycle de vie
# ---------------------------------------------------------------------------


# ---------------------------------------------------------------------------
# API
# ---------------------------------------------------------------------------


@app.get("/")
async def index():
    return RedirectResponse("/static/index.html")


@app.get("/api/health")
async def health(request: Request):
    sid = session_id(request)
    error = ""
    try:
        models = await lm_client.list_models(client())
        loaded = [m for m in models if m["state"] == "loaded"]
        reachable = True
    except lm_client.LmError as err:
        models = []
        loaded = []
        reachable = False
        error = str(err)

    payload = {
        "ok": reachable,
        "url": config.LM_BASE_URL,
        "cli": model_mgr.cli_path(),
        "models": len(models),
        "loaded": [m["id"] for m in loaded],
        "gate": gate().snapshot(),
        "version": __version__,
    }
    if not reachable:
        payload["error"] = error
    return json_ok(payload, sid)


@app.get("/api/session")
async def get_session(request: Request):
    sid = session_id(request)
    return json_ok(snapshot(sid), sid)


@app.post("/api/session/name")
async def set_session_name(request: Request):
    sid = session_id(request)
    body = await request.json()
    name = store.set_name(sid, body.get("name", ""))
    hub().set_activity(sid, name=name)
    await hub().broadcast({"type": "activity", "activity": hub().participants()})
    return json_ok({"name": name}, sid)


@app.get("/api/models")
async def get_models(request: Request):
    sid = session_id(request)
    models = await lm_client.list_models(client())
    return json_ok({"models": models}, sid)

@app.get("/api/personas")
async def get_personas(request: Request):
    sid = session_id(request)
    return json_ok({"personas": personas.list_personas(), "active": personas.get_active()}, sid)


@app.get("/api/conversations")
async def get_conversations(request: Request):
    sid = session_id(request)
    return json_ok({"conversations": store.list_conversations(sid)}, sid)


@app.post("/api/conversations")
async def create_conversation(request: Request):
    sid = session_id(request)
    body = await request.json()
    conv = store.create_conversation(sid, body.get("title", ""))
    return json_ok({"conversation": conv}, sid)


@app.delete("/api/conversations/{conv_id}")
async def remove_conversation(conv_id: str, request: Request):
    sid = session_id(request)
    conv = store.get_conversation(conv_id)
    if conv is None or conv["session_id"] != sid:
        return json_ok({"error": "Conversation introuvable pour cette session."}, sid)
    store.delete_conversation(conv_id)
    return json_ok({"deleted": conv_id}, sid)


@app.get("/api/conversations/{conv_id}/messages")
async def get_messages(conv_id: str, request: Request):
    sid = session_id(request)
    conv = store.get_conversation(conv_id)
    if conv is None or conv["session_id"] != sid:
        return json_ok({"error": "Conversation introuvable pour cette session."}, sid)
    return json_ok({"messages": store.list_messages(conv_id)}, sid)


@app.post("/api/settings")
async def update_settings(request: Request):
    sid = session_id(request)
    body = await request.json()
    settings = store.save_session_settings(sid, body)
    await hub().send(sid, {"type": "settings", "session_id": sid, "settings": settings})
    return json_ok({"settings": settings}, sid)


@app.post("/api/global")
async def update_global(request: Request):
    sid = session_id(request)
    body = await request.json()
    settings = store.save_global_settings(body)
    gate().limit = max(1, int(settings.get("maxParallel", 2)))
    await hub().broadcast({"type": "global", "settings": settings})
    return json_ok({"settings": settings}, sid)





@app.post("/api/model/select")
async def select_model(request: Request):
    sid = session_id(request)
    body = await request.json()
    model_id = str(body.get("model", "")).strip()
    if not model_id:
        return json_ok({"error": "Identifiant de modele manquant."}, sid)

    settings = store.save_global_settings({"model": model_id})
    gate().limit = max(1, int(settings.get("maxParallel", 2)))

    result = {"model": model_id, "loaded": False}
    if not model_mgr.cli_available():
        result["note"] = "CLI lms absent : charge le modele dans LM Studio."
        return json_ok(result, sid)

    try:
        loaded = await model_mgr.load_model(
            model_id,
            context_length=body.get("context_length"),
            parallel=settings.get("maxParallel"),
            force=bool(body.get("force")),
        )
        result.update(loaded)
        result["loaded"] = True
    except Exception as err:  # noqa: BLE001 - message utile a afficher tel quel
        result["error"] = str(err)

    await hub().broadcast({"type": "model", "model": model_id, "result": result})
    return json_ok(result, sid)


def is_admin(sid: str) -> bool:
    return sid in getattr(app.state, "admin_sessions", set())


def require_admin(sid: str) -> str:
    if not config.ADMIN_TOKEN:
        return "Administration désactivée (jeton admin indisponible sur ce serveur)."
    if not is_admin(sid):
        return "Accès administrateur requis."
    return ""


async def broadcast_update_state():
    await hub().broadcast({"type": "update", "update": release.public_state(app.state.release)})


@app.get("/api/update")
async def get_update(request: Request):
    sid = session_id(request)
    return json_ok(
        {
            "update": release.public_state(app.state.release),
            "is_admin": is_admin(sid),
            "admin_enabled": bool(config.ADMIN_TOKEN),
        },
        sid,
    )


@app.post("/api/admin/login")
async def admin_login(request: Request):
    sid = session_id(request)
    body = await request.json()
    token = str(body.get("token") or "").strip()
    if not config.ADMIN_TOKEN:
        return json_ok({"error": "Administration désactivée (jeton admin indisponible sur ce serveur)."}, sid)
    if token != config.ADMIN_TOKEN:
        return json_ok({"error": "Jeton administrateur invalide."}, sid)
    app.state.admin_sessions.add(sid)
    await hub().send(sid, {"type": "admin", "is_admin": True})
    return json_ok({"is_admin": True}, sid)


@app.post("/api/admin/logout")
async def admin_logout(request: Request):
    sid = session_id(request)
    app.state.admin_sessions.discard(sid)
    await hub().send(sid, {"type": "admin", "is_admin": False})
    return json_ok({"is_admin": False}, sid)


def _git(args, cwd):
    return subprocess.run(["git"] + args, cwd=cwd, capture_output=True, text=True, timeout=180)


async def _apply_update_task(by_name: str):
    state = app.state.release
    repo_dir = str(config.BASE_DIR)
    try:
        state["applying"] = True
        state["apply_status"] = "running"
        state["apply_message"] = "Vérification du dépôt..."
        state["applied_by"] = by_name
        await broadcast_update_state()

        st = _git(["status", "--porcelain"], repo_dir)
        if st.returncode != 0:
            raise RuntimeError("git status a échoué: " + (st.stderr or st.stdout).strip()[-300:])
        tracked = [ln for ln in (st.stdout or "").splitlines() if ln and not ln.startswith("??")]
        if tracked:
            raise RuntimeError("Mise à jour refusée: des modifications locales suivies sont présentes.")

        tag = str(state.get("latest") or "").strip()
        if not tag:
            raise RuntimeError("Aucune version cible disponible.")

        state["apply_message"] = "Téléchargement (git fetch)..."
        await broadcast_update_state()
        r = _git(["fetch", "origin", "--tags", "--force"], repo_dir)
        if r.returncode != 0:
            raise RuntimeError("git fetch a échoué: " + (r.stderr or r.stdout).strip()[-400:])

        state["apply_message"] = f"Application de {tag}..."
        await broadcast_update_state()
        r = _git(["checkout", "--force", f"tags/{tag}"], repo_dir)
        if r.returncode != 0:
            r = _git(["checkout", "--force", tag], repo_dir)
        if r.returncode != 0:
            raise RuntimeError("git checkout a échoué: " + (r.stderr or r.stdout).strip()[-400:])

        req = config.BASE_DIR / "requirements.txt"
        if req.exists():
            state["apply_message"] = "Installation des dépendances..."
            await broadcast_update_state()
            pip = subprocess.run(
                [sys.executable, "-m", "pip", "install", "-r", str(req)],
                cwd=repo_dir,
                capture_output=True,
                text=True,
                timeout=900,
            )
            if pip.returncode != 0:
                err = (pip.stderr or pip.stdout or "").strip()
                raise RuntimeError("pip install a échoué: " + err[-500:])

        state["apply_status"] = "restarting"
        state["apply_message"] = f"Mise à jour {tag} appliquée. Redémarrage..."
        await broadcast_update_state()
        await asyncio.sleep(1.5)
        app.state.restart_code = 42
        os._exit(42)
    except Exception as err:  # noqa: BLE001
        state["applying"] = False
        state["apply_status"] = "error"
        state["apply_message"] = str(err)
        await broadcast_update_state()


@app.post("/api/update/apply")
async def apply_update(request: Request):
    sid = session_id(request)
    err = require_admin(sid)
    if err:
        return json_ok({"error": err}, sid)

    body = await request.json()
    force = bool(body.get("force"))

    state = app.state.release
    if state.get("applying"):
        return json_ok({"error": "Mise à jour déjà en cours."}, sid)
    if not state.get("update_available"):
        return json_ok({"error": "Aucune mise à jour disponible."}, sid)

    running = int(gate().snapshot().get("running", 0) or 0)
    if running > 0 and not force:
        return json_ok({"error": "Des réponses sont en cours. Réessaie quand c'est calme, ou relance avec force."}, sid)

    who = (store.ensure_session(sid) or {}).get("name") or sid[:8]
    state["applying"] = True
    state["apply_status"] = "starting"
    state["apply_message"] = f"Mise à jour lancée par {who}..."
    state["applied_by"] = who
    await broadcast_update_state()
    asyncio.create_task(_apply_update_task(who))
    return json_ok({"ok": True, "update": release.public_state(state)}, sid)



# ---------------------------------------------------------------------------
# salle temps reel
# ---------------------------------------------------------------------------


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    sid = websocket.query_params.get("sid") or websocket.cookies.get(config.COOKIE_NAME) or store.new_id()
    session = store.ensure_session(sid, websocket.query_params.get("name", ""))

    cookie_val = (config.COOKIE_NAME + "=" + sid + "; Path=/; SameSite=Lax").encode("latin-1")
    await websocket.accept(headers=[(b"set-cookie", cookie_val)])
    await hub().join(sid, websocket, session["name"])
    await hub().send(sid, {"type": "snapshot", "data": snapshot(sid)})
    await hub().broadcast({"type": "activity", "activity": hub().participants()})

    try:
        while True:
            data = await websocket.receive_json()
            await handle_message(sid, data, websocket)
    except WebSocketDisconnect:
        await hub().leave(sid, websocket)
        await hub().broadcast({"type": "activity", "activity": hub().participants()})
    except Exception as err:  # noqa: BLE001 - une socket cassee ne doit pas fermer le serveur
        print("[ws] connexion interrompue : " + str(err))
        await hub().leave(sid, websocket)


async def handle_message(sid, data, websocket=None):
    kind = data.get("type")

    if kind == "hello":
        name = store.set_name(sid, data.get("name", ""))
        hub().set_activity(sid, name=name)
        await hub().send(sid, {"type": "snapshot", "data": snapshot(sid)})
        await hub().broadcast({"type": "activity", "activity": hub().participants()})
        return

    if kind == "chat":
        text = str(data.get("text", "")).strip()
        if not text:
            await hub().send(sid, {"type": "error", "message": "Message vide."})
            return
        # C'est cet onglet-ci qui lira la reponse a voix haute.
        if websocket is not None:
            hub().mark_speaker(sid, websocket)
        asyncio.create_task(answer(hub(), client(), gate(), sid, data.get("conv_id") or "", text))
        return

    if kind == "regenerate":
        conv_id = str(data.get("conv_id") or "").strip()
        conv = store.get_conversation(conv_id)
        if conv is None or conv["session_id"] != sid:
            await hub().send(sid, {"type": "error", "message": "Conversation introuvable."})
            return
        removed = store.pop_last_assistant(conv_id)
        if removed is None:
            await hub().send(sid, {"type": "error", "message": "Aucune réponse à régénérer.", "conv_id": conv_id})
            return
        await hub().send(sid, {"type": "message_removed", "conv_id": conv_id, "message_id": removed["id"]})
        if websocket is not None:
            hub().mark_speaker(sid, websocket)
        asyncio.create_task(answer(hub(), client(), gate(), sid, conv_id, "", regenerate=True))
        return

    if kind == "state":
        hub().set_activity(sid, state=data.get("state"))
        await hub().broadcast({"type": "activity", "activity": hub().participants()})
        return

    if kind == "emotion":
        hub().set_activity(sid, emotion=data.get("emotion"))
        await hub().broadcast({"type": "activity", "activity": hub().participants()})
        return

    if kind == "typing":
        hub().set_activity(sid, typing=bool(data.get("on")))
        await hub().broadcast({"type": "activity", "activity": hub().participants()})
        return

    if kind == "settings":
        settings = store.save_session_settings(sid, data.get("patch") or {})
        await hub().send(sid, {"type": "settings", "session_id": sid, "settings": settings})
        return

    if kind == "global":
        settings = store.save_global_settings(data.get("patch") or {})
        gate().limit = max(1, int(settings.get("maxParallel", 2)))
        await hub().broadcast({"type": "global", "settings": settings})
        return

    if kind == "conv_create":
        conv = store.create_conversation(sid, data.get("title", ""))
        await hub().send(sid, {"type": "conversation", "conversation": conv})
        return

    if kind == "conv_delete":
        conv = store.get_conversation(data.get("conv_id") or "")
        if conv is None or conv["session_id"] != sid:
            await hub().send(sid, {"type": "error", "message": "Conversation introuvable."})
            return
        store.delete_conversation(conv["id"])
        await hub().send(sid, {"type": "conversation_deleted", "conv_id": conv["id"]})
        return

    if kind == "stop":
        hub().stop_flag(sid).set()
        hub().set_activity(sid, state="idle")
        await hub().broadcast({"type": "activity", "activity": hub().participants()})
        return

    if kind == "ping":
        hub().set_activity(sid)
        await hub().send(sid, {"type": "pong", "gate": gate().snapshot()})
        return

    await hub().send(sid, {"type": "error", "message": "Evenement inconnu : " + str(kind)})


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=config.PORT)
