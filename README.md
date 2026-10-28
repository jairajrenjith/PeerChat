# PeerChat

A lightweight, modern, desktop **peer-to-peer chat application** with multiple rooms, real-time messaging, direct file sharing, and a built-in **P2P Details inspector** that shows what is actually happening on the wire.

- Messages and files travel **directly between devices** over WebRTC DataChannels.
- A small Python server is used **only** for signaling and temporary room presence. It never sees chat text or file contents.
- **No database, no accounts, no persistence.** Close the session and everything is gone.

---

## Table of contents

1. [Features](#features)
2. [Tech stack](#tech-stack)
3. [Project structure](#project-structure)
4. [How it works](#how-it-works)
5. [Requirements](#requirements)
6. [Installation](#installation)
7. [Running PeerChat](#running-peerchat)
8. [Command-line options](#command-line-options)
9. [Using the app](#using-the-app)
10. [P2P Details inspector](#p2p-details-inspector)
11. [Limits and defaults](#limits-and-defaults)
12. [Platform notes](#platform-notes)
13. [Troubleshooting](#troubleshooting)
14. [Privacy and security](#privacy-and-security)
15. [Testing checklist](#testing-checklist)
16. [Known limitations](#known-limitations)

---

## Features

**Sessions and rooms**
- Enter any display name. No registration, login or account.
- Join any room just by typing its name. Rooms are identified by name (case-insensitive) and need no creation step.
- Several users on different laptops/devices can share a room, and the active-user list is shown for each room.
- WhatsApp-style sidebar of rooms visited in the current session, with last-message preview, time and unread badges. Switch back and forth freely.
- Duplicate display names are supported. Every peer has a unique session-based peer ID, and duplicates are shown with a short `#xxxx` suffix.
- Leave a room at any time (its messages are discarded).
- Ending the session discards all rooms, messages and files from memory.

**Messaging and files**
- Real-time text messaging between everyone in the same room.
- File sharing of any type (images, PDFs, documents, archives and so on). Drag and drop, or use the attach button. Images get an inline preview.
- File cards show name, size, progress bar and completion or failure status, plus a cancel button during transfer.
- Chunked transfer over DataChannels with **backpressure handling** for large files.
- **SHA-256 integrity verification** (sender computes while sending, receiver recomputes while receiving and compares).
- Honest delivery status: a message is only marked **Delivered** after the receiver's acknowledgment, and a file only after the receiver confirms the SHA-256 check.
- Graceful handling of disconnected peers, interrupted transfers, unavailable recipients and failed connections.

**P2P transparency**
- Every message and file has an expandable **P2P Details** section (sender-side or receiver-side as appropriate).
- A right-hand **People and network** panel shows per-peer connection state, ICE path (direct or relayed) and candidate info.
- Unknown values are shown as `unavailable`. Nothing is fabricated.

**Interface**
- Premium messaging-app look: rounded bubbles, clean typography, file cards, subtle transitions.
- **Dark, Light and System** themes with a consistent design system and sufficient contrast.
- Responsive: collapsible sidebars/drawers on small windows.
- The UI stays usable while connections are being established or files are transferring.

**Networking**
- WebRTC DataChannels for all chat and file data.
- ICE + STUN for connection establishment (direct-only, **no TURN relay**).
- If a direct connection cannot be established, a clear error is shown with a **Retry** button.
- Automatic reconnection of the signaling socket, timeouts, cleanup of stale peers, and automatic retry of failed connections.

---

## Tech stack

| Layer | Technology |
|---|---|
| Frontend | Svelte 5 + Vite 6 |
| Styling | Tailwind CSS 4 |
| Icons | Lucide (`@lucide/svelte`, SVG-based) |
| Desktop window | pywebview |
| Backend | Python, FastAPI, WebSockets (served by Uvicorn) |
| P2P transport | WebRTC DataChannels |
| Discovery | WebRTC ICE + STUN (Google public STUN servers) |
| Database | None |

---

## Project structure

```text
peerchat/
├── main.py             # Desktop launcher: starts the server in a thread, opens the pywebview window
├── backend.py          # FastAPI app: signaling WebSocket, room presence, static file serving
├── requirements.txt    # Python dependencies
├── package.json        # Frontend dependencies and scripts
├── vite.config.js      # Vite config (Tailwind + Svelte plugins, dev proxy)
├── index.html          # Frontend entry point (applies saved theme before first paint)
├── dist/               # Built frontend (created by `npm run build`)
└── src/
    ├── main.js         # Mounts the Svelte app
    ├── App.svelte      # UI: rooms, chat, panels, settings, P2P Details
    ├── app.css         # Tailwind + light/dark theme tokens
    └── peer.js         # WebRTC, signaling client, messaging, file transfer, SHA-256
```

---

## How it works

```text
   Laptop A                         Laptop B
 ┌──────────────┐                ┌──────────────┐
 │ PeerChat UI  │◄══ WebRTC ════►│ PeerChat UI  │   chat text + files (direct)
 │ (peer.js)    │   DataChannel  │ (peer.js)    │
 └──────┬───────┘                └──────┬───────┘
        │  WebSocket (signaling only)   │
        └───────────►  FastAPI  ◄───────┘          presence + SDP/ICE only
                      (backend.py)
```

1. **Signaling hub.** One laptop's Python server acts as the hub. Every laptop serves its own UI on `localhost` (a secure context) and connects to the hub's WebSocket (`/ws`).
2. **Presence.** When you join a room, the server tells you who is in it and tells them about you. This state is in memory only.
3. **Offer/answer.** For each pair of peers, the peer with the lexicographically **lower peer ID** creates the WebRTC offer (this avoids "glare"). Offers, answers and ICE candidates are relayed by the server, which only forwards `offer`, `answer`, `candidate` and `reconnect` messages with a strict size limit.
4. **Direct connection.** ICE with STUN finds a direct path. Once the DataChannel is open, all messages and files go peer-to-peer. The server is no longer involved in data.
5. **Rooms over a shared connection.** There is one connection per remote peer, shared across rooms. Messages are tagged with their room, and a peer accepts a room message only if it shares that room with the sender. Every sender delivers directly to each room member (full mesh), so there is **no forwarding, no duplicates and no loops**.
6. **Messages.** A text message is a JSON frame. The receiver replies with an `ack`. Receivers de-duplicate by message ID.
7. **Files.**
   - Sender sends `file-offer`, the receiver answers `file-accept` (or `file-reject`).
   - Binary frames carry a 4-byte transfer number plus up to 16,000 bytes of payload.
   - The sender pauses when the channel buffer exceeds 1 MiB and resumes below 256 KiB (backpressure).
   - The sender sends `file-end` with the SHA-256, and the receiver compares it with its own computed hash and replies `file-done` (ok or failed).
8. **Resilience.**
   - The signaling socket reconnects with exponential backoff and re-joins rooms. Existing P2P connections stay alive during a signaling outage.
   - A peer that disappears from signaling gets an 8-second grace period before its connection is closed (handles short blips).
   - Connections time out after 15 seconds, failures retry automatically up to twice (offerer side), and you can retry manually.
   - Server heartbeat: clients ping every 15 s, and the server evicts peers silent for 60 s.

---

## Requirements

- **Python 3.10+**
- **Node.js 18+** (with npm)
- Windows 10/11, macOS, or Linux
- All laptops on the same Wi-Fi/LAN for the simplest setup

Platform-specific requirements:
- **Windows:** the Microsoft Edge **WebView2 runtime** (preinstalled on Windows 11, and on most up-to-date Windows 10).
- **Linux:** use the Qt backend (see [Platform notes](#platform-notes)).

---

## Installation

Run these in the project folder.

**Windows (PowerShell)**

```powershell
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
npm install
npm run build
```

**macOS / Linux**

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
npm install
npm run build
```

`npm run build` creates the `dist/` folder, which the app serves. Re-run it whenever you change anything in `src/`.

If PowerShell blocks activating the virtual environment, run this once and retry:

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

---

## Running PeerChat

### Single laptop

```bash
python main.py
```

A standalone PeerChat window opens. The terminal also prints the command other laptops should use.

### Two instances on the same PC (quick test)

Terminal 1 (the hub):

```bash
python main.py
```

Terminal 2 (a second instance on a different local port, using the hub on port 8000):

```bash
python main.py --port 8001 --signal 127.0.0.1:8000
```

> Note the `--port` flag: `python main.py 8001 ...` is rejected.

In both windows, use different display names and join the **same room name** (for example `general`).

### Multiple laptops on the same Wi-Fi

**1. Prepare every laptop.** Copy or clone the project and do the [Installation](#installation) steps. Do not copy `.venv` or `node_modules` between machines, since they must be created on each machine.

**2. Choose one laptop as the hub** and start it:

```bash
python main.py
```

The terminal prints the hub's LAN IP and the exact command for the others, for example:

```text
This laptop is the signaling hub. Other laptops run:  python main.py --signal 192.168.1.20:8000
```

**3. Allow the hub through the firewall.** Only the hub needs an inbound rule, for **TCP port 8000**. On Windows, click **Allow** (private networks) on the prompt, or run once in an *administrator* PowerShell:

```powershell
New-NetFirewallRule -DisplayName "PeerChat signaling" -Direction Inbound -Protocol TCP -LocalPort 8000 -Action Allow -Profile Private
```

**4. Start the other laptops** with the hub's IP:

```bash
python main.py --signal 192.168.1.20:8000
```

(Replace the IP with the one printed by your hub.) You do not need `--port` on other laptops because port 8000 is free there.

**5. Chat.** On every laptop, enter a display name and join the **same room name**. Each laptop should list the others in the **People and network** panel with a green **Direct** badge.

**Check hub reachability** from another laptop (Windows PowerShell):

```powershell
Test-NetConnection 192.168.1.20 -Port 8000
```

`TcpTestSucceeded : True` means the hub is reachable.

### Browser instead of the desktop window

While the server is running you can also open `http://127.0.0.1:8000` in a normal browser. Use the **Signaling server** field on the start screen to point a browser instance at another laptop's hub, for example `ws://192.168.1.20:8000/ws`.

### Development mode (hot reload)

```bash
npm run dev            # terminal 1: Vite dev server on http://127.0.0.1:5173
python main.py --dev   # terminal 2: backend + a window pointing at the Vite server
```

The Vite dev server proxies `/ws` and `/api` to the backend on port **8000**, so keep the default `--port` in dev mode.

### Headless hub

```bash
python main.py --no-window
```

Runs only the server (useful for a laptop or machine acting as a pure hub).

---

## Command-line options

| Option | Default | Description |
|---|---|---|
| `--host HOST` | `0.0.0.0` | Interface the local server binds to. Use `127.0.0.1` to keep it local-only. |
| `--port PORT` | `8000` | Local server port. Change it if 8000 is taken or for a second instance on the same PC. |
| `--signal ADDR` | *(this laptop)* | Use another laptop's signaling server, e.g. `192.168.1.20:8000`. Accepts `host:port`, `ws://…`, or `http://…`. |
| `--dev` | off | Open the Vite dev server instead of the built UI. |
| `--dev-url URL` | `http://127.0.0.1:5173` | Dev server URL used with `--dev`. |
| `--no-window` | off | Run only the server, no desktop window. |
| `--gui NAME` | auto | pywebview backend: `qt`, `gtk`, `cocoa`, `edgechromium`. |

Even with `--signal`, the local server still starts (it serves this laptop's UI), so a second instance on the same PC needs its own `--port`.

---

## Using the app

1. **Start screen:** enter a display name and a room, then click **Start session**. The optional **Signaling server** field lets you override the hub address.
2. **Join or search rooms:** the sidebar box filters visited rooms. Type a new name and press **Enter** (or click the *Join* button) to join it.
3. **Chat:** type and press **Enter** to send (**Shift+Enter** for a new line).
4. **Send files:** click the paperclip, or drag and drop files onto the chat. Cancel an in-progress transfer with the **X** button. Click the download icon on a received file to save it.
5. **People and network panel:** click the people icon in the chat header to see members, connection state, and ICE details. Failed peers get a **Retry direct connection** button.
6. **Leave a room:** use the leave icon in the chat header. This discards that room's messages.
7. **Settings:** choose Light, Dark or System theme, and use **End session** (click twice to confirm) to discard everything and return to the start screen.

### Delivery states

| Indicator | Meaning |
|---|---|
| Sending… | Waiting for the P2P channel, or data still being sent |
| Sent · awaiting acknowledgment | Written to the DataChannel, no receiver ack yet |
| Delivered | The receiver acknowledged (for files: and its SHA-256 check passed) |
| Delivered to X of Y · Z failed | Group room with mixed results |
| Failed | The connection failed, dropped, or the transfer was rejected or cancelled |
| Not sent, nobody else is in this room | No recipients |

---

## P2P Details inspector

Click **P2P Details** under any message or file.

- **Outgoing:** sender-side view per recipient, covering local and remote peer IDs and names, message or file ID, created time (local clock), payload size, status, time submitted to the DataChannel, ack received time (local clock), the receiver-reported ack time (explicitly labelled as the *remote clock, unverified*), file start/completion times, bytes transferred, SHA-256 computed by the sender, whether the receiver confirmed integrity, errors, and connection info.
- **Incoming:** receiver-side view with sender identity, received time (local clock), the sender-reported timestamp (labelled *remote clock, unverified*), payload size, bytes received, the declared vs. computed SHA-256 and integrity result, and connection info.
- **Connection info** (observed locally through `RTCPeerConnection.getStats()`): PeerConnection state, ICE connection state, DataChannel state, selected path (**Direct** or **Relayed**), local and remote candidate type (host / srflx / prflx), addresses, protocol, and round-trip time.

Browsers may hide local IPs behind mDNS names (`xxxx.local`) or omit addresses for privacy. In that case the field shows `hidden by browser` or `unavailable`. Remote timestamps, delivery confirmations and statistics are never invented.

---

## Limits and defaults

| Item | Value |
|---|---|
| Max file size | 500 MB (received files are assembled in memory) |
| Max text message length | 8,000 characters |
| Display name length | 32 characters |
| Room name length | 48 characters (normalised: trimmed, whitespace collapsed, lowercased) |
| Rooms per session | 50 |
| Peers per room | 64 |
| Simultaneous incoming transfers per peer | 8 |
| DataChannel chunk payload | 16,000 bytes (+4 byte header) |
| Backpressure thresholds | pause above 1 MiB buffered, resume below 256 KiB |
| Connection timeout | 15 s |
| Automatic connection retries (offerer side) | 2 |
| Signaling heartbeat | ping every 15 s, server evicts after 60 s of silence |
| Disappeared-peer grace period | 8 s |
| Max signaling message | 64 KB (signal payload capped at 32 KB) |
| Default server port | 8000 (Vite dev server: 5173) |
| STUN servers | `stun.l.google.com:19302`, `stun1.l.google.com:19302` |
| TURN | **Not used** (direct-only) |

---

## Platform notes

- **Windows:** uses the WebView2 (Chromium) engine through pywebview. This is the best-tested path for WebRTC.
- **macOS:** uses WKWebView. WebRTC DataChannels are supported.
- **Linux:** the default GTK WebKit build often has **no WebRTC support**. Use the Qt (Chromium-based) backend:

  ```bash
  pip install "pywebview[qt]"
  python main.py --gui qt
  ```

  The app shows a notice when WebRTC is unavailable in the window.
- **Saving received files:** the launcher enables pywebview's `ALLOW_DOWNLOADS` (pywebview 5+). If saving does nothing on your OS, open the app in a regular browser at `http://127.0.0.1:8000` as a fallback.
- **Theme persistence:** pywebview runs in private mode, so the theme resets to **System** on each launch in the desktop window. In a regular browser it is remembered.
- **Offline use:** on a LAN with no internet, same-network direct connections usually still work through host candidates, but STUN servers are unreachable, so cross-network discovery will not.

---

## Troubleshooting

**`[Errno 10048]` / "Could not start the server on port 8000 (already in use?)"**
Another PeerChat (or program) already uses the port. For a second instance on the same PC use a different port:
`python main.py --port 8001 --signal 127.0.0.1:8000`.
To see what holds the port on Windows: `netstat -ano | findstr :8000`.

**`unrecognized arguments: 8001`**
The port needs its flag: `--port 8001`, not just `8001`.

**"UI not built yet. Run: npm install && npm run build"**
The `dist/` folder is missing. Run `npm install` then `npm run build`.

**"Signaling offline" banner**
The app cannot reach the hub. Check that the hub is running, the IP is correct (it can change between networks), and the hub's firewall allows TCP 8000. Test with `Test-NetConnection <hub-ip> -Port 8000`.

**People appear in the room but the badge says Failed**
Signaling works but no direct route exists:
- The router may have **client/AP isolation** enabled (common on guest Wi-Fi). Try another network or a phone hotspot.
- A strict or symmetric NAT, or a VPN, may block direct paths. Since TURN is intentionally not used, such networks will fail. Use **Retry direct connection**.
- Firewalls blocking UDP can also prevent connections.

**Peer never appears in the room**
Make sure both used the exact same room name (names are case-insensitive but must otherwise match) and the same signaling hub.

**Window shows a notice about WebRTC (Linux)**
Install the Qt backend: `pip install "pywebview[qt]"`, then run with `--gui qt`.

**PowerShell refuses to activate the venv**
Run `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`, then activate again.

**File transfer fails with an integrity error**
The SHA-256 check failed, so the file is discarded rather than saved as corrupted. Send it again.

**Large file fails or the window slows down**
Files are held in memory on the receiving side (limit 500 MB). Send fewer or smaller files at a time.

---

## Privacy and security

- **Nothing is persisted.** There is no database, and no messages, files or room history are written to disk. State exists only in memory and is discarded when the session ends or the app is closed.
- **The server never relays chat or files.** The signaling server only sees display names, room names, peer IDs, connection IPs of clients, and SDP/ICE data needed to establish connections.
- **No authentication.** Anyone who can reach the hub and knows a room name can join that room. Keep the hub on a trusted network. Use `--host 127.0.0.1` for local-only use, and prefer a private LAN.
- **Transport encryption.** WebRTC DataChannels are encrypted by DTLS.
- **Input handling.** Message and file names are rendered as text (never as HTML). Incoming data is validated and room membership is checked before accepting messages or files. The server validates peer IDs, caps room/peer counts, rate-limits abusive clients, and only relays whitelisted signal fields.
- **Public STUN.** Using Google's public STUN servers reveals your public IP address to them, as with any STUN-based WebRTC app.

---

## Testing checklist

Test with multiple instances and, where possible, multiple physical laptops.

1. The application launches in a standalone desktop window.
2. Two or more instances join the same room and see each other in the active-user list.
3. Messages show **Sending → Sent → Delivered**, with "Delivered" appearing only after the receiver's acknowledgment.
4. Messages go over the DataChannel (the server only logs presence and signaling, so no chat text appears on the server).
5. Transfer a large file (100 MB or more) and confirm progress and "SHA-256 verified".
6. Kill one instance mid-transfer and confirm the other shows a failed transfer (not a silent hang).
7. Join several rooms, switch between them, return to earlier ones, and leave one.
8. Use identical display names on two peers and confirm they are distinguishable.
9. Compare **P2P Details** on the sender and receiver for the same message. They should show different, independently observed data.
10. Verify Light, Dark and System themes in both the start screen and the chat.
11. Confirm no database or history files are created.
12. Test on two physical laptops on the same Wi-Fi.
13. Test on different networks (for example, one laptop on a phone hotspot). Treat cross-network connectivity as **unknown until you have tested it**.

---

## Known limitations

- **Direct-only by design.** With no TURN relay, peers behind strict/symmetric NATs, client-isolated Wi-Fi, or restrictive firewalls cannot connect. Cross-network connectivity is **not guaranteed**.
- **One signaling hub.** All peers in a session must use the same hub. If the hub goes down, existing direct connections keep working but new peers cannot be discovered until it returns.
- **Full mesh.** Every peer connects to every other peer in a shared room, which suits small groups and gets heavier with large rooms.
- **In-memory files.** Received files are assembled in memory, hence the 500 MB limit.
- **No history.** Messages and joined rooms are lost when a session ends.
- **No end-to-end identity.** Display names are self-declared, and peer IDs are random per session.

---

By Jairaj R, Ham P R, Gautham V, Daniel Williams