"""PeerChat launcher: starts the signaling/static server in a thread, then opens a desktop window."""
import argparse
import os
import socket
import sys
import threading
import time
from pathlib import Path
from urllib.parse import urlparse

import uvicorn

ROOT = Path(__file__).parent


def lan_ip() -> str:
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1))     # no packet is actually sent
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


def signal_url(v: str) -> str:
    v = v.strip()
    if "://" not in v:
        v = "ws://" + v
    v = v.replace("https://", "wss://", 1).replace("http://", "ws://", 1)
    if not urlparse(v).path.strip("/"):
        v = v.rstrip("/") + "/ws"
    return v


def main():
    ap = argparse.ArgumentParser(description="PeerChat - peer-to-peer chat desktop app")
    ap.add_argument("--host", default="0.0.0.0", help="interface for the local server (default: all)")
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--signal", help="use another laptop's signaling server, e.g. 192.168.1.20:8000")
    ap.add_argument("--dev", action="store_true", help="open the Vite dev server instead of the built UI")
    ap.add_argument("--dev-url", default="http://127.0.0.1:5173")
    ap.add_argument("--no-window", action="store_true", help="headless: run only the server")
    ap.add_argument("--gui", default=None, help="pywebview backend (qt, gtk, cocoa, edgechromium)")
    args = ap.parse_args()

    if args.signal:
        os.environ["PEERCHAT_SIGNAL"] = signal_url(args.signal)
    if not args.dev and not (ROOT / "dist" / "index.html").exists():
        sys.exit("UI not built yet. Run:  npm install && npm run build")

    import backend  # imported after env is set

    server = uvicorn.Server(uvicorn.Config(
        backend.app, host=args.host, port=args.port, log_level="warning", ws_max_size=65536))
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    for _ in range(100):
        if server.started:
            break
        if not thread.is_alive():
            sys.exit(f"Could not start the server on port {args.port} (already in use?)")
        time.sleep(0.1)
    else:
        sys.exit("Server did not start in time")

    ip = lan_ip()
    print(f"PeerChat server: http://127.0.0.1:{args.port}")
    if args.signal:
        print(f"Using signaling server: {os.environ['PEERCHAT_SIGNAL']}")
    else:
        print(f"This laptop is the signaling hub. Other laptops run:  python main.py --signal {ip}:{args.port}")

    if args.no_window:
        try:
            while True:
                time.sleep(1)
        except KeyboardInterrupt:
            pass
    else:
        import webview
        try:
            webview.settings["ALLOW_DOWNLOADS"] = True   # lets users save received files
        except Exception:
            pass
        url = args.dev_url if args.dev else f"http://127.0.0.1:{args.port}"
        webview.create_window("PeerChat", url, width=1280, height=820, min_size=(380, 520))
        webview.start(gui=args.gui)

    server.should_exit = True
    thread.join(timeout=3)


if __name__ == "__main__":
    main()