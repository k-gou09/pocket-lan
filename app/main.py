"""Serveur FastAPI : API, salle temps reel et interface PC en deux volets.

Lance avec :
  python -m uvicorn app.main:app --host 0.0.0.0 --port 8000

Le port est ouvert sur toutes les interfaces : les autres PC du reseau ouvrent
http://ADRESSE_IP_DU_SERVEUR:8000.
"""

import asyncio
import socket
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
    print_startup()
    prune_task = asyncio.create_task(prune_loop(application.state.hub))
    release_task = asyncio.create_task(
        release.loop(application.state.client, application.state.release, application.state.release_stop)
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
