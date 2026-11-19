"""Salle temps reel : connexions WebSocket, presences, diffusion des evenements.

Un utilisateur peut avoir plusieurs onglets ouverts : on garde donc une liste de
sockets par session. Les conversations restent privees par session, la salle ne
diffuse que la presence et l'activite.
"""

import asyncio
import time
from collections import defaultdict


# Le client envoie un ping toutes les 25 s : une session sans nouvelle depuis ce
# delai est consideree partee et purgee pour ne pas laisser de fantomes dans la salle.
STALE_AFTER = 300.0


class Hub:
    def __init__(self):
        self.connections = defaultdict(set)
        self.names = {}
        self.activities = {}
        self.stop_flags = {}
        self._session_locks = {}
        self.speakers = {}

    async def join(self, session_id, websocket, name=""):
        self.connections[session_id].add(websocket)
        if name:
            self.names[session_id] = name
        self.activities.setdefault(
            session_id,
            {"id": session_id, "name": self.names.get(session_id, ""), "state": "idle", "typing": False, "last_seen": time.time()},
        )
        self.activities[session_id]["last_seen"] = time.time()

    async def leave(self, session_id, websocket):
        sockets = self.connections.get(session_id)
        if sockets:
            sockets.discard(websocket)
            if not sockets:
                del self.connections[session_id]
                self.activities.pop(session_id, None)
                self.stop_flags.pop(session_id, None)
                self._session_locks.pop(session_id, None)
                self.speakers.pop(session_id, None)
            elif self.speakers.get(session_id) is websocket:
                # L'onglet qui parlait est parti : on repasse la main.
                self.speakers.pop(session_id, None)

    def session_lock(self, session_id):
        """Un verrou par session : une seule generation a la fois par utilisateur.

        Deux onglets de la meme session se suivent au lieu de s'entrecouper :
        le drapeau stop etant partage par session, il ne peut plus etre annule
        par une autre reponse en cours.
        """
        lock = self._session_locks.get(session_id)
        if lock is None:
            lock = asyncio.Lock()
            self._session_locks[session_id] = lock
        return lock

    def prune_stale(self):
        """Retire les sessions inactives ; renvoie la liste des ids purgees."""
        now = time.time()
        stale = [
            session_id
            for session_id, entry in list(self.activities.items())
            if now - entry.get("last_seen", 0) > STALE_AFTER
        ]
        for session_id in stale:
            self.connections.pop(session_id, None)
            self.activities.pop(session_id, None)
            self.stop_flags.pop(session_id, None)
            self._session_locks.pop(session_id, None)
            self.speakers.pop(session_id, None)
        return stale

    def mark_speaker(self, session_id, websocket):
        """Retient l'onglet qui vient de poser la question.

        Le cookie de session est partage par tous les onglets du navigateur :
        la reponse est diffusee a tous, mais un seul doit la lire a voix haute.
        Sans cela, chaque onglet ouvert prononcait la meme phrase.
        """
        self.speakers[session_id] = websocket

    async def send_done(self, session_id, payload):
        """Envoie la fin de reponse a tous, la lecture vocale a un seul onglet."""
        speaker = self.speakers.get(session_id)
        sockets = list(self.connections.get(session_id, ()))
        if sockets and speaker not in sockets:
            # Onglet demandeur deconnecte : on confie la voix au premier reste.
            speaker = sockets[0]
            self.speakers[session_id] = speaker

        for websocket in sockets:
            body = dict(payload, speak=websocket is speaker)
            try:
                await websocket.send_json(body)
            except Exception:  # noqa: BLE001 - socket ferme en cours d'envoi
                self.connections[session_id].discard(websocket)

    async def send(self, session_id, payload):
        for websocket in list(self.connections.get(session_id, ())):
            try:
                await websocket.send_json(payload)
            except Exception:  # noqa: BLE001 - socket ferme en cours d'envoi
                self.connections[session_id].discard(websocket)

    async def broadcast(self, payload, exclude=None):
        targets = set(self.connections.keys())
        if exclude:
            targets.discard(exclude)

        for session_id in list(targets):
            await self.send(session_id, payload)

    def set_activity(self, session_id, state=None, emotion=None, typing=None, name=None):
        entry = self.activities.get(session_id)
        if entry is None:
            entry = {"id": session_id, "name": name or "", "state": "idle", "typing": False, "last_seen": time.time()}
            self.activities[session_id] = entry
        if name:
            entry["name"] = name
            self.names[session_id] = name
        if state is not None:
            entry["state"] = state
        if emotion is not None:
            entry["emotion"] = emotion
        if typing is not None:
            entry["typing"] = typing
        entry["last_seen"] = time.time()
        return entry

    def participants(self):
        return sorted(
            self.activities.values(),
            key=lambda item: item.get("last_seen", 0),
            reverse=True,
        )

    def stop_flag(self, session_id):
        flag = self.stop_flags.get(session_id)
        if flag is None:
            flag = asyncio.Event()
            self.stop_flags[session_id] = flag
        return flag
