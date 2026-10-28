"""PeerChat signaling service.

Only does: temporary room presence + relaying WebRTC connection-establishment data
(offer / answer / ICE candidates). Chat messages and files NEVER pass through here.
Everything lives in memory; nothing is written to disk.
"""
import asyncio
import json
import os
import re
import time
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles

PEER_RE = re.compile(r"[A-Za-z0-9_-]{8,64}")
MAX_ROOMS_PER_PEER = 50
MAX_PEERS_PER_ROOM = 64
STALE_AFTER = 60          # seconds without any message => evict
MAX_SIGNAL_BYTES = 32_000
SIGNAL_KINDS = {"offer", "answer", "candidate", "reconnect"}
SIGNAL_KEYS = ("kind", "gen", "sdp", "candidate")


def clean_name(v) -> str:
    v = "".join(ch for ch in str(v) if ch.isprintable())
    return re.sub(r"\s+", " ", v).strip()[:32] or "Anonymous"


def norm_room(v) -> str:
    if not isinstance(v, str):
        return ""
    v = re.sub(r"\s+", " ", v)
    v = "".join(ch for ch in v if ch.isprintable())
    return v.strip().lower()[:48].strip()


def err(message: str) -> dict:
    return {"type": "error", "message": message}


class Peer:
    def __init__(self, pid: str, name: str, ws: WebSocket):
        self.id, self.name, self.ws = pid, name, ws
        self.rooms: set[str] = set()
        self.last_seen = time.monotonic()
        self.lock = asyncio.Lock()      # one writer per socket
        self.dead = False
        self.win_start, self.win_count = self.last_seen, 0


class Hub:
    def __init__(self):
        self.peers: dict[str, Peer] = {}
        self.rooms: dict[str, set[str]] = {}

    # ---- sending -------------------------------------------------------
    async def send(self, peer: Peer, msg: dict):
        if peer.dead:
            return
        try:
            async with peer.lock:
                await asyncio.wait_for(peer.ws.send_json(msg), timeout=5)
        except Exception:
            await self.drop(peer, close_code=1011)   # unreachable/hung socket

    async def broadcast(self, targets: list[Peer], msg: dict):
        if targets:
            await asyncio.gather(*(self.send(p, msg) for p in targets), return_exceptions=True)

    def _others(self, room: str, me: str) -> list[Peer]:
        return [self.peers[p] for p in self.rooms.get(room, ()) if p != me and p in self.peers]

    # ---- lifecycle -----------------------------------------------------
    async def drop(self, peer: Peer, close_code: int | None = None):
        """Idempotent removal of a peer from every room; tells the others."""
        if peer.dead:
            return
        peer.dead = True
        owner = self.peers.get(peer.id) is peer
        notify: list[tuple[str, list[Peer]]] = []
        if owner:
            del self.peers[peer.id]
            for room in list(peer.rooms):
                members = self.rooms.get(room)
                if members is None:
                    continue
                members.discard(peer.id)
                if members:
                    notify.append((room, self._others(room, peer.id)))
                else:
                    del self.rooms[room]
        peer.rooms.clear()
        if close_code is not None:
            try:
                await peer.ws.close(code=close_code)
            except Exception:
                pass
        for room, others in notify:
            await self.broadcast(others, {"type": "peer-left", "room": room, "peerId": peer.id})

    async def join(self, peer: Peer, raw_room):
        room = norm_room(raw_room)
        if not room:
            return await self.send(peer, err("Invalid room name"))
        announce = False
        if room not in peer.rooms:
            if len(peer.rooms) >= MAX_ROOMS_PER_PEER:
                return await self.send(peer, err("Too many rooms joined"))
            if len(self.rooms.get(room, ())) >= MAX_PEERS_PER_ROOM:
                return await self.send(peer, err(f"Room '{room}' is full"))
            self.rooms.setdefault(room, set()).add(peer.id)
            peer.rooms.add(room)
            announce = True
        others = self._others(room, peer.id)
        await self.send(peer, {"type": "room-state", "room": room,
                               "peers": [{"id": p.id, "name": p.name} for p in others]})
        if announce:
            await self.broadcast(others, {"type": "peer-joined", "room": room,
                                          "peer": {"id": peer.id, "name": peer.name}})

    async def leave(self, peer: Peer, raw_room):
        room = norm_room(raw_room)
        if room not in peer.rooms:
            return
        peer.rooms.discard(room)
        members = self.rooms.get(room, set())
        members.discard(peer.id)
        others = self._others(room, peer.id)
        if not members:
            self.rooms.pop(room, None)
        await self.broadcast(others, {"type": "peer-left", "room": room, "peerId": peer.id})

    async def relay(self, peer: Peer, to, data):
        """Forward connection-establishment data to a peer we share a room with."""
        target = self.peers.get(to) if isinstance(to, str) else None
        if target is None or target is peer or not (peer.rooms & target.rooms):
            return await self.send(peer, {"type": "undeliverable", "to": to if isinstance(to, str) else None})
        if not isinstance(data, dict) or data.get("kind") not in SIGNAL_KINDS:
            return
        clean = {k: data[k] for k in SIGNAL_KEYS if k in data}
        if len(json.dumps(clean)) > MAX_SIGNAL_BYTES:
            return await self.send(peer, err("Signal too large"))
        await self.send(target, {"type": "signal", "from": peer.id, "data": clean})


hub = Hub()


@asynccontextmanager
async def lifespan(_: FastAPI):
    async def janitor():
        while True:
            await asyncio.sleep(15)
            try:
                cutoff = time.monotonic() - STALE_AFTER
                for p in [p for p in hub.peers.values() if p.last_seen < cutoff]:
                    await hub.drop(p, close_code=4002)
            except Exception:
                pass

    task = asyncio.create_task(janitor())
    yield
    task.cancel()


app = FastAPI(title="PeerChat signaling", lifespan=lifespan)


@app.get("/api/config")
async def config():
    return {"signal": os.environ.get("PEERCHAT_SIGNAL") or None}


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    await ws.accept()
    pid = ws.query_params.get("peer", "")
    if not PEER_RE.fullmatch(pid):
        await ws.close(code=4003)
        return
    peer = Peer(pid, clean_name(ws.query_params.get("name", "")), ws)
    old = hub.peers.get(pid)
    if old is not None:                       # same session reconnecting: replace stale socket
        await hub.drop(old, close_code=4000)
    hub.peers[pid] = peer
    await hub.send(peer, {"type": "welcome", "peerId": pid})
    try:
        while True:
            raw = await ws.receive_text()
            now = time.monotonic()
            peer.last_seen = now
            if now - peer.win_start > 10:
                peer.win_start, peer.win_count = now, 0
            peer.win_count += 1
            if peer.win_count > 600:          # flood protection
                await ws.close(code=4008)
                break
            try:
                msg = json.loads(raw)
            except ValueError:
                continue
            if not isinstance(msg, dict):
                continue
            t = msg.get("type")
            if t == "ping":
                await hub.send(peer, {"type": "pong"})
            elif t == "join":
                await hub.join(peer, msg.get("room"))
            elif t == "leave":
                await hub.leave(peer, msg.get("room"))
            elif t == "signal":
                await hub.relay(peer, msg.get("to"), msg.get("data"))
    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        await hub.drop(peer)


DIST = Path(__file__).parent / "dist"
if DIST.exists():
    app.mount("/", StaticFiles(directory=DIST, html=True), name="ui")
else:
    @app.get("/")
    async def no_ui():
        return HTMLResponse("<h3>PeerChat UI not built.</h3><p>Run <code>npm install && npm run build</code>.</p>")