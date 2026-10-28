// peer.js — WebRTC mesh, messaging and file transfer for PeerChat.
// The signaling WebSocket carries presence + SDP/ICE only. Chat text and files travel over RTCDataChannels.
import { writable } from 'svelte/store';

/* ───────────── constants ───────────── */
const STUN = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }]; // direct-only: no TURN
const CONNECT_TIMEOUT = 15000;
const DISCONNECT_GRACE = 6000;
const PEER_GRACE = 8000;       // keep a peer that vanished from signaling (blip) this long
const MAX_AUTO_RETRY = 2;
const CHUNK = 16000;           // payload bytes per DataChannel message (+4 byte header < 16 KiB)
const READ_SLICE = 512 * 1024;
const HIGH_WATER = 1024 * 1024;
const LOW_WATER = 256 * 1024;
export const MAX_FILE = 500 * 1024 * 1024; // received files are assembled in memory
export const MAX_TEXT = 8000;

/* ───────────── helpers ───────────── */
const enc = new TextEncoder();
export const rid = (n = 8) =>
  Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => b.toString(16).padStart(2, '0')).join('');
export const normRoom = (r) =>
  typeof r === 'string' ? r.replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 48).trim() : '';
const cleanName = (n) => String(n ?? '').replace(/\s+/g, ' ').trim().slice(0, 32) || 'Anonymous';

export function fmtBytes(n) {
  if (!Number.isFinite(n)) return 'unknown';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < 3) { n /= 1024; i++; }
  return `${i ? n.toFixed(n < 10 ? 2 : 1) : n} ${u[i]}`;
}

function normSignal(v) {
  v = v.trim();
  if (!/^[a-z]+:\/\//i.test(v)) v = 'ws://' + v;
  v = v.replace(/^http/i, 'ws');
  try {
    const u = new URL(v);
    if (!u.pathname || u.pathname === '/') u.pathname = '/ws';
    return u.toString();
  } catch { return v; }
}

export async function defaultSignal() {
  try {
    const j = await (await fetch('/api/config')).json();
    if (j.signal) return j.signal;
  } catch { /* fall through */ }
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
}

/* Incremental SHA-256 (works without a secure context and without loading whole files). */
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

class Sha256 {
  constructor() {
    this.h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
    this.buf = new Uint8Array(64); this.n = 0; this.len = 0; this.w = new Uint32Array(64);
  }
  _block(b, o) {
    const w = this.w, h = this.h;
    for (let i = 0; i < 16; i++) { const j = o + i * 4; w[i] = ((b[j] << 24) | (b[j + 1] << 16) | (b[j + 2] << 8) | b[j + 3]) >>> 0; }
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15], y = w[i - 2];
      const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
      const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let a = h[0], b2 = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const t1 = (hh + S1 + ((e & f) ^ (~e & g)) + K[i] + w[i]) >>> 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const t2 = (S0 + ((a & b2) ^ (a & c) ^ (b2 & c))) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b2; b2 = a; a = (t1 + t2) >>> 0;
    }
    h[0] += a; h[1] += b2; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
  }
  update(d) {
    this.len += d.length;
    let i = 0;
    if (this.n) {
      while (i < d.length && this.n < 64) this.buf[this.n++] = d[i++];
      if (this.n === 64) { this._block(this.buf, 0); this.n = 0; }
    }
    while (i + 64 <= d.length) { this._block(d, i); i += 64; }
    while (i < d.length) this.buf[this.n++] = d[i++];
  }
  hex() {
    const bits = this.len * 8;
    const pad = new Uint8Array((this.n < 56 ? 56 - this.n : 120 - this.n) + 8);
    pad[0] = 0x80;
    const dv = new DataView(pad.buffer);
    dv.setUint32(pad.length - 8, Math.floor(bits / 2 ** 32));
    dv.setUint32(pad.length - 4, bits >>> 0);
    this.update(pad);
    return Array.from(this.h, (x) => x.toString(16).padStart(8, '0')).join('');
  }
}

/* wait until the DataChannel buffer drains (backpressure) */
function drain(dc) {
  return new Promise((resolve, reject) => {
    if (dc.readyState !== 'open') return reject(new Error('Connection closed'));
    const done = (e) => {
      clearTimeout(timer);
      dc.removeEventListener('bufferedamountlow', ok);
      dc.removeEventListener('close', bad);
      e ? reject(e) : resolve();
    };
    const ok = () => done();
    const bad = () => done(new Error('Connection closed during transfer'));
    const timer = setTimeout(() => done(new Error('Transfer stalled (receiver is not reading)')), 30000);
    dc.addEventListener('bufferedamountlow', ok);
    dc.addEventListener('close', bad);
  });
}

const blank = () => ({ me: null, signal: { state: 'offline', url: '' }, rooms: {}, peers: {}, notice: null });

/* ───────────── client ───────────── */
export class PeerChat {
  constructor() {
    this.s = blank();
    this.store = writable(this.s);        // immutable updates; components subscribe with $store
    this.conns = new Map();               // peerId -> connection record (non-reactive internals)
    this.tx = new Map();                  // `${peerId}|${msgId}` -> outgoing transfer
    this.rx = new Map();                  // `${peerId}|${xn}`    -> incoming transfer
    this.seen = new Set();                // de-duplication of incoming message ids
    this.urls = new Set();                // blob URLs to revoke
    this.active = null; this.ws = null; this.closed = true; this.retry = 0; this.q = 0;
  }

  /* ── state helpers ── */
  _set(p) {
    this.s = { ...this.s, ...p };
    if (!this.q) this.q = setTimeout(() => { this.q = 0; this.store.set(this.s); }, 40);
  }
  _room(name, fn) {
    const r = this.s.rooms[name];
    if (!r) return;
    const n = fn(r);
    if (n !== r) this._set({ rooms: { ...this.s.rooms, [name]: n } });
  }
  _msg(room, key, fn) {
    this._room(room, (r) => {
      const i = r.messages.findLastIndex((m) => m.key === key);
      if (i < 0) return r;
      const m = fn(r.messages[i]);
      if (m === r.messages[i]) return r;
      const messages = r.messages.slice(); messages[i] = m;
      return { ...r, messages };
    });
  }
  _rpatch(room, key, pid, patch) {
    this._msg(room, key, (m) => {
      const cur = m.recips?.[pid];
      return cur ? { ...m, recips: { ...m.recips, [pid]: { ...cur, ...patch } } } : m;
    });
  }
  _add(room, msg) {
    this._room(room, (r) => {
      const visible = this.active === room && !document.hidden;
      return { ...r, messages: [...r.messages, msg], activity: msg.ts, unread: msg.dir === 'in' && !visible ? r.unread + 1 : r.unread };
    });
  }
  _sys(room, text) {
    this._room(room, (r) => ({ ...r, messages: [...r.messages, { key: 'sys-' + rid(4), kind: 'system', text, ts: Date.now() }] }));
  }
  _notice(text) {
    const id = rid(3);
    this._set({ notice: { id, text } });
    setTimeout(() => { if (this.s.notice?.id === id) this._set({ notice: null }); }, 5000);
  }
  _sig(state) { this._set({ signal: { ...this.s.signal, state } }); }
  _members(room) { return [...this.conns.values()].filter((c) => c.rooms.has(room)).map((c) => c.id); }
  _syncRoom(room) { this._room(room, (r) => ({ ...r, members: this._members(room) })); }
  _sync(c) {
    if (c.status === 'closed') return;
    const view = {
      id: c.id, name: c.name, status: c.status, error: c.error,
      pc: c.pc?.connectionState ?? 'none', ice: c.pc?.iceConnectionState ?? 'none', dc: c.dc?.readyState ?? 'none',
      ...(c.net || {}),
    };
    this._set({ peers: { ...this.s.peers, [c.id]: view } });
  }
  _snap(c) {
    return { pc: c.pc?.connectionState ?? 'none', ice: c.pc?.iceConnectionState ?? 'none', dc: c.dc?.readyState ?? 'none', ...(c.net || {}) };
  }
  _isInit(c) { return this.s.me.id < c.id; }   // lower id makes the offer (avoids glare)

  /* ── public API ── */
  async start(name, signalUrl) {
    if (!this.closed) return;
    this.closed = false; this.retry = 0;
    const me = { id: 'p-' + rid(8), name: cleanName(name) };
    this.signalUrl = signalUrl && signalUrl.trim() ? normSignal(signalUrl) : await defaultSignal();
    this.s = { ...blank(), me, signal: { state: 'connecting', url: this.signalUrl } };
    this.store.set(this.s);
    if (typeof RTCPeerConnection === 'undefined')
      this._notice('WebRTC is not available in this window. On Linux install pywebview[qt] and use --gui qt.');
    this._open();
  }

  join(room) {
    room = normRoom(room);
    if (!room || !this.s.me) return null;
    if (!this.s.rooms[room]) {
      const now = Date.now();
      this._set({ rooms: { ...this.s.rooms, [room]: { name: room, members: [], messages: [], unread: 0, activity: now, joinedAt: now } } });
      this._wsend({ type: 'join', room });   // if signaling is down it is re-sent on reconnect
    }
    return room;
  }

  leave(room) {
    const r = this.s.rooms[room];
    if (!r) return;
    this._wsend({ type: 'leave', room });
    for (const t of this.tx.values()) if (t.room === room) { t.cancelled = true; t.error = 'Left the room'; t.wait?.rej(new Error(t.error)); }
    for (const [k, x] of [...this.rx]) if (x.room === room) this.rx.delete(k);
    for (const m of r.messages) for (const u of [m.url, m.preview]) if (u) { URL.revokeObjectURL(u); this.urls.delete(u); }
    const rooms = { ...this.s.rooms }; delete rooms[room];
    this._set({ rooms });
    for (const c of [...this.conns.values()])
      if (c.rooms.delete(room) && !c.rooms.size) c.gTimer = setTimeout(() => this._drop(c), PEER_GRACE);
  }

  setActive(room) {
    this.active = room;
    if (room) this._room(room, (r) => (r.unread ? { ...r, unread: 0 } : r));
  }

  send(room, text) {
    const r = this.s.rooms[room];
    text = String(text ?? '').trim().slice(0, MAX_TEXT);
    if (!r || !text) return;
    const me = this.s.me, id = rid(6), ts = Date.now(), key = `${me.id}:${id}`;
    const frame = JSON.stringify({ t: 'msg', id, room, text, ts });
    const targets = [...this.conns.values()].filter((c) => c.rooms.has(room));
    const recips = {};
    for (const c of targets)
      recips[c.id] = { id: c.id, name: c.name, status: 'sending', snap: this._snap(c), sentAt: null, ackAt: null, remoteAckTs: null, error: null };
    this._add(room, { key, id, kind: 'text', dir: 'out', room, ts, text, size: enc.encode(frame).length, from: { id: me.id, name: me.name }, recips });
    for (const c of targets)
      this._whenOpen(c)
        .then(() => {
          c.dc.send(frame);
          this._rpatch(room, key, c.id, { status: 'sent', sentAt: Date.now(), snap: this._snap(c) });
        })
        .catch((e) => this._rpatch(room, key, c.id, { status: 'failed', error: e.message }));
  }

  sendFiles(room, files) { for (const f of files) this._sendFile(room, f); }

  cancel(room, key) {
    const m = this.s.rooms[room]?.messages.find((x) => x.key === key);
    if (!m || m.kind !== 'file') return;
    if (m.dir === 'out') {
      for (const t of this.tx.values()) if (t.key === key) { t.cancelled = true; t.error = 'Cancelled by you'; t.wait?.rej(new Error(t.error)); }
    } else {
      for (const [k, x] of [...this.rx]) if (x.msgKey === key) this._rxEnd(k, x, 'Cancelled by you', true);
    }
  }

  retryPeer(id) {
    const c = this.conns.get(id);
    if (!c) return;
    c.attempts = 0;
    this._connect(c);
    if (!this._isInit(c)) this._signal(id, { kind: 'reconnect' });   // ask the offerer to start over
  }

  refreshNet(ids) { for (const id of ids) { const c = this.conns.get(id); if (c?.pc) this._inspect(c); } }

  quit() {
    this.closed = true;
    clearTimeout(this.rt); clearInterval(this.hb);
    const ws = this.ws; this.ws = null;
    try { ws?.close(1000); } catch { /* ignore */ }
    for (const t of this.tx.values()) { t.cancelled = true; t.error = 'Session ended'; t.wait?.rej(new Error(t.error)); }
    for (const c of this.conns.values()) { clearTimeout(c.gTimer); this._teardown(c); c.status = 'closed'; for (const w of c.waiters.splice(0)) w.rej(new Error('Session ended')); }
    this.conns.clear(); this.tx.clear(); this.rx.clear(); this.seen.clear();
    this.urls.forEach((u) => URL.revokeObjectURL(u)); this.urls.clear();
    this.active = null;
    this.s = blank(); this.store.set(this.s);
  }

  /* ── signaling socket ── */
  _wsend(o) {
    if (this.ws?.readyState === 1) { this.ws.send(JSON.stringify(o)); return true; }
    return false;
  }
  _signal(to, data) { this._wsend({ type: 'signal', to, data }); }

  _open() {
    const sep = this.signalUrl.includes('?') ? '&' : '?';
    const ws = new WebSocket(`${this.signalUrl}${sep}peer=${this.s.me.id}&name=${encodeURIComponent(this.s.me.name)}`);
    this.ws = ws;
    this._sig('connecting');
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.retry = 0; this.lastRx = Date.now();
      this._sig('online');
      for (const r of Object.keys(this.s.rooms)) this._wsend({ type: 'join', room: r });   // (re)join everything
      clearInterval(this.hb);
      this.hb = setInterval(() => {
        if (Date.now() - this.lastRx > 45000) { ws.close(); return; }   // server silent: reconnect
        this._wsend({ type: 'ping' });
      }, 15000);
    };
    ws.onmessage = (e) => {
      this.lastRx = Date.now();
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (m && typeof m === 'object') this._onServer(m);
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      clearInterval(this.hb); this.ws = null;
      this._sig('offline');
      if (this.closed) return;
      if (ev.code === 4003) { this._notice('Signaling server rejected this session.'); return; }
      this.retry++;
      this.rt = setTimeout(() => !this.closed && this._open(), Math.min(10000, 400 * 2 ** this.retry));
    };
    ws.onerror = () => { /* onclose follows */ };
  }

  _onServer(m) {
    switch (m.type) {
      case 'room-state': this._roomState(normRoom(m.room), Array.isArray(m.peers) ? m.peers : []); break;
      case 'peer-joined':
        if (m.peer && typeof m.peer.id === 'string' && this.s.rooms[normRoom(m.room)])
          this._peerJoined(m.peer.id, cleanName(m.peer.name), normRoom(m.room), true);
        break;
      case 'peer-left': if (typeof m.peerId === 'string') this._peerLeft(m.peerId, normRoom(m.room)); break;
      case 'signal': if (typeof m.from === 'string') this._onSignal(m.from, m.data); break;
      case 'undeliverable': {
        const c = this.conns.get(m.to);
        if (c && c.status === 'connecting') this._fail(c, 'Peer is not reachable through the signaling server');
        break;
      }
      case 'error': if (typeof m.message === 'string') this._notice(m.message); break;
    }
  }

  /* ── presence ── */
  _roomState(room, list) {
    if (!this.s.rooms[room]) return;
    const ids = new Set(list.filter((p) => p && typeof p.id === 'string').map((p) => p.id));
    for (const c of [...this.conns.values()]) if (c.rooms.has(room) && !ids.has(c.id)) this._peerLeft(c.id, room);
    for (const p of list) if (p && typeof p.id === 'string') this._peerJoined(p.id, cleanName(p.name), room, false);
  }

  _peerJoined(id, name, room, announce) {
    if (id === this.s.me.id) return;
    const fresh = !this.conns.has(id);
    let c = this.conns.get(id);
    if (!c) {
      c = { id, name, rooms: new Set(), status: 'connecting', error: null, pc: null, dc: null, gen: '', net: null, pendingIce: [],
        chain: Promise.resolve(), waiters: [], xn: 0, attempts: 0, timer: 0, dTimer: 0, rTimer: 0, gTimer: 0 };
      this.conns.set(id, c);
    }
    c.name = name;
    clearTimeout(c.gTimer);
    const isNew = !c.rooms.has(room);
    c.rooms.add(room);
    this._syncRoom(room);
    if (announce && isNew) this._sys(room, `${name} joined`);
    if (fresh || (c.status === 'failed' && !c.rTimer)) this._connect(c); else this._sync(c);
  }

  _peerLeft(id, room) {
    const c = this.conns.get(id);
    if (!c || !c.rooms.has(room)) return;
    c.rooms.delete(room);
    this._syncRoom(room);
    this._sys(room, `${c.name} left`);
    if (!c.rooms.size) c.gTimer = setTimeout(() => this._drop(c), PEER_GRACE);
  }

  _drop(c) {
    if (c.status === 'closed') return;
    clearTimeout(c.gTimer);
    this._teardown(c);
    c.status = 'closed';
    this._abortWork(c, 'Peer left');
    this.conns.delete(c.id);
    const peers = { ...this.s.peers }; delete peers[c.id];
    this._set({ peers });
  }

  /* ── connection lifecycle ── */
  _arm(c) {
    c.status = 'connecting'; c.error = null; c.net = null;
    clearTimeout(c.timer);
    c.timer = setTimeout(() => this._fail(c,
      'Timed out: no direct connection within 15 s. The laptops may be on networks that block direct (STUN-only) connections, or Wi-Fi client isolation is on.'), CONNECT_TIMEOUT);
  }

  _connect(c) {
    this._teardown(c);
    this._arm(c);
    c.gen = rid(4);
    this._sync(c);
    if (this._isInit(c)) this._offer(c).catch((e) => this._fail(c, `Could not start connection: ${e.message}`));
  }

  _teardown(c) {
    clearTimeout(c.timer); clearTimeout(c.dTimer); clearTimeout(c.rTimer); c.rTimer = 0;
    const { pc, dc } = c;
    c.pc = null; c.dc = null; c.pendingIce = [];
    try { dc?.close(); } catch { /* ignore */ }
    try { pc?.close(); } catch { /* ignore */ }
  }

  _fail(c, reason) {
    if (c.status === 'closed' || c.status === 'failed') return;
    this._teardown(c);
    c.status = 'failed'; c.error = reason;
    this._abortWork(c, reason);
    this._sync(c);
    if (c.rooms.size && this._isInit(c) && c.attempts < MAX_AUTO_RETRY) {
      c.attempts++;
      c.rTimer = setTimeout(() => { c.rTimer = 0; if (c.status === 'failed' && c.rooms.size) this._connect(c); }, 1500 * c.attempts);
    }
  }

  _abortWork(c, reason) {
    for (const w of c.waiters.splice(0)) w.rej(new Error(reason));
    for (const [k, t] of this.tx) if (k.startsWith(c.id + '|')) { t.cancelled = true; t.error = reason; t.wait?.rej(new Error(reason)); }
    for (const [k, x] of [...this.rx]) if (x.peerId === c.id) this._rxEnd(k, x, reason, false);
    // text messages that were sent but never acknowledged can no longer be confirmed
    let rooms = this.s.rooms, changed = false;
    for (const [name, r] of Object.entries(rooms)) {
      let touched = false;
      const messages = r.messages.map((m) => {
        const x = m.dir === 'out' && m.kind === 'text' && m.recips?.[c.id];
        if (!x || x.status !== 'sent') return m;
        touched = true;
        return { ...m, recips: { ...m.recips, [c.id]: { ...x, status: 'failed', error: 'Connection lost before the receiver acknowledged' } } };
      });
      if (touched) { rooms = { ...rooms, [name]: { ...r, messages } }; changed = true; }
    }
    if (changed) this._set({ rooms });
  }

  _whenOpen(c) {
    if (c.dc?.readyState === 'open') return Promise.resolve();
    if (c.status === 'failed' || c.status === 'closed')
      return Promise.reject(new Error(c.error || 'No direct connection to this peer'));
    return new Promise((res, rej) => c.waiters.push({ res, rej }));
  }

  _makePc(c) {
    const pc = new RTCPeerConnection({ iceServers: STUN, iceTransportPolicy: 'all' });
    const gen = c.gen;
    c.pc = pc;
    pc.onicecandidate = (e) => { if (e.candidate && c.pc === pc) this._signal(c.id, { kind: 'candidate', gen, candidate: e.candidate.toJSON() }); };
    pc.oniceconnectionstatechange = () => { if (c.pc === pc) this._sync(c); };
    pc.onconnectionstatechange = () => {
      if (c.pc !== pc) return;
      const st = pc.connectionState;
      if (st === 'failed') return this._fail(c, 'Connection failed: no direct route between the peers (NAT / firewall / Wi-Fi isolation?)');
      clearTimeout(c.dTimer);
      if (st === 'disconnected') {
        if (c.status === 'connected') c.status = 'unstable';
        c.dTimer = setTimeout(() => { if (c.pc === pc && pc.connectionState === 'disconnected') this._fail(c, 'Connection lost'); }, DISCONNECT_GRACE);
      } else if (st === 'connected' && c.status === 'unstable') c.status = 'connected';
      this._sync(c);
    };
    pc.ondatachannel = (e) => {
      if (c.pc !== pc) return;
      if (e.channel.label !== 'peerchat' || c.dc) { e.channel.close(); return; }
      this._attachDc(c, e.channel);
    };
    return pc;
  }

  _attachDc(c, dc) {
    dc.binaryType = 'arraybuffer';
    dc.bufferedAmountLowThreshold = LOW_WATER;
    c.dc = dc;
    const opened = () => {
      if (c.dc !== dc) return;
      clearTimeout(c.timer); clearTimeout(c.dTimer);
      c.status = 'connected'; c.error = null; c.attempts = 0;
      for (const w of c.waiters.splice(0)) w.res();
      this._sync(c);
      this._inspect(c);
      setTimeout(() => this._inspect(c), 1500);
    };
    dc.onopen = opened;
    dc.onclose = () => { if (c.dc === dc) this._fail(c, 'Data channel closed (peer left or the network dropped)'); };
    dc.onmessage = (e) => this._onData(c, e.data);
    if (dc.readyState === 'open') opened();
  }

  async _offer(c) {
    const pc = this._makePc(c);
    this._attachDc(c, pc.createDataChannel('peerchat', { ordered: true }));
    await pc.setLocalDescription(await pc.createOffer());
    if (c.pc !== pc) return;
    this._signal(c.id, { kind: 'offer', gen: c.gen, sdp: pc.localDescription.sdp });
  }

  _onSignal(from, data) {
    const c = this.conns.get(from);
    if (!c || !data || typeof data !== 'object') return;
    c.chain = c.chain.then(() => this._handleSignal(c, data)).catch((e) => this._fail(c, `Signaling error: ${e.message}`));
  }

  async _handleSignal(c, d) {
    if (c.status === 'closed') return;
    const init = this._isInit(c);
    if (d.kind === 'reconnect') { if (init) this._connect(c); return; }
    if (d.kind === 'offer') {
      if (init || typeof d.gen !== 'string' || d.gen.length > 16 || typeof d.sdp !== 'string') return;
      this._teardown(c); c.gen = d.gen; this._arm(c);
      const pc = this._makePc(c);
      this._sync(c);
      await pc.setRemoteDescription({ type: 'offer', sdp: d.sdp });
      if (c.pc !== pc) return;
      await pc.setLocalDescription(await pc.createAnswer());
      if (c.pc !== pc) return;
      this._signal(c.id, { kind: 'answer', gen: c.gen, sdp: pc.localDescription.sdp });
      await this._flushIce(c, pc);
      return;
    }
    if (d.gen !== c.gen || !c.pc) return;      // stale attempt
    const pc = c.pc;
    if (d.kind === 'answer') {
      if (init && typeof d.sdp === 'string' && pc.signalingState === 'have-local-offer') {
        await pc.setRemoteDescription({ type: 'answer', sdp: d.sdp });
        await this._flushIce(c, pc);
      }
    } else if (d.kind === 'candidate' && d.candidate && typeof d.candidate === 'object') {
      if (pc.remoteDescription) await pc.addIceCandidate(d.candidate).catch(() => {});
      else c.pendingIce.push(d.candidate);
    }
  }

  async _flushIce(c, pc) {
    for (const cand of c.pendingIce.splice(0)) await pc.addIceCandidate(cand).catch(() => {});
  }

  /* observed (not assumed) ICE info from this side's own getStats() */
  async _inspect(c) {
    const pc = c.pc;
    if (!pc) return;
    try {
      const stats = await pc.getStats();
      const by = {}; let sel = null;
      stats.forEach((r) => { by[r.id] = r; });
      stats.forEach((r) => { if (r.type === 'transport' && r.selectedCandidatePairId && by[r.selectedCandidatePairId]) sel = by[r.selectedCandidatePairId]; });
      if (!sel) stats.forEach((r) => { if (!sel && r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') sel = r; });
      if (!sel || c.pc !== pc) return;
      const l = by[sel.localCandidateId], r = by[sel.remoteCandidateId];
      const addr = (x) => (x ? (x.address || x.ip ? `${x.address || x.ip}:${x.port}` : 'hidden by browser') : null);
      const net = {
        path: l && r ? (l.candidateType === 'relay' || r.candidateType === 'relay' ? 'relayed' : 'direct') : null,
        localType: l?.candidateType ?? null, remoteType: r?.candidateType ?? null,
        local: addr(l), remote: addr(r), protocol: l?.protocol ?? null,
        rtt: typeof sel.currentRoundTripTime === 'number' ? Math.round(sel.currentRoundTripTime * 1000) : null,
      };
      if (JSON.stringify(net) !== JSON.stringify(c.net)) { c.net = net; this._sync(c); }
    } catch { /* stats unavailable: leave as unknown */ }
  }

  /* ── DataChannel protocol ── */
  _ctl(c, obj) { try { if (c.dc?.readyState === 'open') c.dc.send(JSON.stringify(obj)); } catch { /* ignore */ } }

  _onData(c, data) {
    if (typeof data !== 'string') { if (data instanceof ArrayBuffer) this._rxChunk(c, data); return; }
    let m; try { m = JSON.parse(data); } catch { return; }
    if (!m || typeof m.t !== 'string' || typeof m.id !== 'string' && m.t !== 'ack') { if (!m || typeof m.t !== 'string') return; }
    const tx = typeof m.id === 'string' ? this.tx.get(`${c.id}|${m.id}`) : null;
    switch (m.t) {
      case 'msg': this._rxMsg(c, m, data); break;
      case 'ack':
        if (typeof m.id === 'string')
          this._rpatch(normRoom(m.room), `${this.s.me.id}:${m.id}`, c.id, { status: 'delivered', ackAt: Date.now(), remoteAckTs: Number.isFinite(m.ts) ? m.ts : null });
        break;
      case 'file-offer': this._rxOffer(c, m); break;
      case 'file-end': this._rxFinish(c, m); break;
      case 'file-accept': if (tx?.wait?.kind === 'accept') tx.wait.res(); break;
      case 'file-reject':
      case 'file-cancel':
        if (tx) { tx.cancelled = true; tx.error = `Receiver: ${String(m.reason || 'cancelled').slice(0, 120)}`; tx.wait?.rej(new Error(tx.error)); }
        else { // receiver side: sender cancelled
          for (const [k, x] of [...this.rx]) if (x.peerId === c.id && x.id === m.id) this._rxEnd(k, x, `Sender: ${String(m.reason || 'cancelled').slice(0, 120)}`, false);
        }
        break;
      case 'file-done':
        if (tx?.wait?.kind === 'done') m.ok === true ? tx.wait.res() : tx.wait.rej(new Error(`Receiver rejected the file: ${String(m.reason || 'integrity check failed').slice(0, 120)}`));
        break;
    }
  }

  /* text */
  _rxMsg(c, m, raw) {
    const room = normRoom(m.room);
    if (!room || !c.rooms.has(room) || !this.s.rooms[room]) return;           // only rooms we share
    if (typeof m.id !== 'string' || m.id.length > 40 || typeof m.text !== 'string' || m.text.length > MAX_TEXT * 2) return;
    const ackAt = Date.now();
    this._ctl(c, { t: 'ack', id: m.id, room, ts: ackAt });                    // always (re)ack
    const k = `${c.id}|${m.id}`;
    if (this.seen.has(k)) return;                                              // no duplicates
    this.seen.add(k);
    this._add(room, {
      key: `${c.id}:${m.id}`, id: m.id, kind: 'text', dir: 'in', room, ts: ackAt, text: m.text,
      from: { id: c.id, name: c.name }, size: enc.encode(raw).length, remoteTs: Number.isFinite(m.ts) ? m.ts : null,
      ackAt, snap: this._snap(c),
    });
  }

  /* files — sender */
  _sendFile(room, file) {
    const r = this.s.rooms[room];
    if (!r || !file) return;
    if (file.size > MAX_FILE) return this._notice(`"${file.name}" is larger than the ${fmtBytes(MAX_FILE)} limit.`);
    const me = this.s.me, id = rid(6), key = `${me.id}:${id}`;
    const targets = [...this.conns.values()].filter((c) => c.rooms.has(room));
    const recips = {};
    for (const c of targets)
      recips[c.id] = { id: c.id, name: c.name, status: 'sending', bytes: 0, startedAt: null, sentAt: null, doneAt: null, sha256: null, verified: false, error: null, snap: this._snap(c) };
    let preview = null;
    if ((file.type || '').startsWith('image/')) { preview = URL.createObjectURL(file); this.urls.add(preview); }
    this._add(room, { key, id, kind: 'file', dir: 'out', room, ts: Date.now(), from: { id: me.id, name: me.name },
      file: { name: file.name, size: file.size, mime: file.type || '' }, size: file.size, preview, recips });
    for (const c of targets) this._txFile(c, key, id, room, file);
  }

  _wait(t, kind, ms) {
    return new Promise((res, rej) => {
      const timer = setTimeout(() => { t.wait = null; rej(new Error(`Receiver did not respond (${kind}) within ${ms / 1000} s`)); }, ms);
      t.wait = {
        kind,
        res: (v) => { clearTimeout(timer); t.wait = null; res(v); },
        rej: (e) => { clearTimeout(timer); t.wait = null; rej(e); },
      };
    });
  }

  async _txFile(c, key, id, room, file) {
    const tk = `${c.id}|${id}`;
    const t = { key, room, cancelled: false, error: null, wait: null };
    this.tx.set(tk, t);
    const P = (p) => this._rpatch(room, key, c.id, p);
    const check = () => { if (t.cancelled) throw new Error(t.error || 'Cancelled'); };
    let dc = null;
    try {
      await this._whenOpen(c); check();
      dc = c.dc;
      const xn = ++c.xn;
      P({ status: 'sending', startedAt: Date.now(), snap: this._snap(c) });
      dc.send(JSON.stringify({ t: 'file-offer', id, xn, room, name: file.name, size: file.size, mime: file.type || '', ts: Date.now() }));
      await this._wait(t, 'accept', 15000);
      const sha = new Sha256();
      let off = 0, last = 0;
      while (off < file.size) {
        check();
        const slice = new Uint8Array(await file.slice(off, off + READ_SLICE).arrayBuffer());
        if (!slice.length) throw new Error('File could not be read (moved or changed?)');
        sha.update(slice);
        for (let i = 0; i < slice.length; i += CHUNK) {
          check();
          if (dc.readyState !== 'open') throw new Error('Connection closed during transfer');
          if (dc.bufferedAmount > HIGH_WATER) await drain(dc);               // backpressure
          const part = slice.subarray(i, i + CHUNK);
          const frame = new Uint8Array(4 + part.length);
          new DataView(frame.buffer).setUint32(0, xn);
          frame.set(part, 4);
          dc.send(frame);
        }
        off += slice.length;
        const now = Date.now();
        if (now - last > 150) { last = now; P({ bytes: off }); }
      }
      check();
      const hash = sha.hex();
      dc.send(JSON.stringify({ t: 'file-end', id, xn, bytes: off, sha256: hash }));
      P({ status: 'verifying', bytes: off, sentAt: Date.now(), sha256: hash });
      await this._wait(t, 'done', 60000);                                    // receiver verifies SHA-256
      P({ status: 'delivered', bytes: off, doneAt: Date.now(), verified: true, snap: this._snap(c) });
    } catch (e) {
      if (dc?.readyState === 'open') this._ctl(c, { t: 'file-cancel', id, reason: e.message });
      P({ status: 'failed', error: e.message, doneAt: Date.now() });
    } finally {
      this.tx.delete(tk);
    }
  }

  /* files — receiver */
  _rxOffer(c, m) {
    const room = normRoom(m.room);
    if (typeof m.id !== 'string' || m.id.length > 40 || !Number.isInteger(m.xn)) return;
    const reject = (reason) => this._ctl(c, { t: 'file-reject', id: m.id, reason });
    if (!room || !c.rooms.has(room) || !this.s.rooms[room]) return reject('Not a member of that room');
    if (!Number.isFinite(m.size) || m.size < 0 || m.size > MAX_FILE) return reject(`File exceeds the ${fmtBytes(MAX_FILE)} limit`);
    if ([...this.rx.values()].filter((x) => x.peerId === c.id).length >= 8) return reject('Too many simultaneous transfers');
    const k = `${c.id}|${m.xn}`;
    if (this.rx.has(k)) return reject('Duplicate transfer');
    const name = String(m.name ?? 'file').slice(0, 200), mime = String(m.mime || '').slice(0, 100), msgKey = `${c.id}:${m.id}`, now = Date.now();
    this.rx.set(k, { id: m.id, peerId: c.id, room, msgKey, mime, size: m.size, bytes: 0, parts: [], sha: new Sha256(), last: 0 });
    this._add(room, {
      key: msgKey, id: m.id, kind: 'file', dir: 'in', room, ts: now, from: { id: c.id, name: c.name },
      file: { name, size: m.size, mime }, size: m.size, status: 'receiving', bytes: 0, startedAt: now, doneAt: null,
      remoteTs: Number.isFinite(m.ts) ? m.ts : null, sha256Remote: null, sha256Local: null, verified: null, error: null, url: null, snap: this._snap(c),
    });
    this._ctl(c, { t: 'file-accept', id: m.id });
  }

  _rxChunk(c, buf) {
    if (buf.byteLength <= 4) return;
    const x = this.rx.get(`${c.id}|${new DataView(buf).getUint32(0)}`);
    if (!x) return;
    const view = new Uint8Array(buf, 4);
    x.bytes += view.length;
    if (x.bytes > x.size) return this._rxEnd(`${c.id}|${new DataView(buf).getUint32(0)}`, x, 'Received more data than announced', true);
    x.parts.push(view);
    x.sha.update(view);
    const now = Date.now();
    if (now - x.last > 150) { x.last = now; const b = x.bytes; this._msg(x.room, x.msgKey, (m) => ({ ...m, bytes: b })); }
  }

  _rxFinish(c, m) {
    const k = `${c.id}|${m.xn}`, x = this.rx.get(k);
    if (!x || x.id !== m.id) return;
    this.rx.delete(k);
    const hash = x.sha.hex(), declared = String(m.sha256 ?? '').toLowerCase(), now = Date.now();
    const ok = x.bytes === x.size && m.bytes === x.size && hash === declared;
    if (!ok) {
      const why = x.bytes !== x.size ? `Size mismatch (${x.bytes} of ${x.size} bytes received)` : 'SHA-256 mismatch: file corrupted in transit';
      this._msg(x.room, x.msgKey, (mm) => ({ ...mm, status: 'failed', error: why, verified: false, bytes: x.bytes, sha256Local: hash, sha256Remote: declared, doneAt: now }));
      this._ctl(c, { t: 'file-done', id: x.id, ok: false, reason: why });
      return;
    }
    const url = URL.createObjectURL(new Blob(x.parts, { type: x.mime || 'application/octet-stream' }));
    this.urls.add(url);
    this._msg(x.room, x.msgKey, (mm) => ({ ...mm, status: 'done', url, verified: true, bytes: x.bytes, sha256Local: hash, sha256Remote: declared, doneAt: now, snap: this._snap(c) }));
    this._ctl(c, { t: 'file-done', id: x.id, ok: true });
  }

  _rxEnd(k, x, reason, notify) {
    this.rx.delete(k);
    this._msg(x.room, x.msgKey, (m) => ({ ...m, status: 'failed', error: reason, doneAt: Date.now() }));
    if (notify) { const c = this.conns.get(x.peerId); if (c) this._ctl(c, { t: 'file-cancel', id: x.id, reason }); }
  }
}