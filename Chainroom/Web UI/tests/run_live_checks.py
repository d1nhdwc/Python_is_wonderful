"""M6: Flask + core/network thật, Edge, ba node RAM riêng; tự dừng sau kiểm tra.

Chỉ chạy khi cổng 5000–5002 đang trống. Không gọi node đang chạy của người dùng.
"""
import hashlib
from contextlib import ExitStack
from html import unescape
import json
import os
import socket
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
from urllib.error import HTTPError
from urllib.request import Request, urlopen

PROJECT_ROOT = Path(__file__).resolve().parents[2]
WEB_UI_DIR = PROJECT_ROOT / "Web UI"
sys.path.insert(0, str(WEB_UI_DIR))
from run_web_node import PORTS, create_web_app
from network import join_network, recover_bootstrap, sync_chain, sync_pending
from werkzeug.serving import WSGIRequestHandler, make_server


class QuietHandler(WSGIRequestHandler):
    def log(self, *_args, **_kwargs):
        pass


def request(node, path, payload=None, expected=200):
    data = None if payload is None else json.dumps(payload).encode()
    req = Request(f"http://127.0.0.1:{PORTS[node]}{path}", data=data,
                  headers={"Content-Type": "application/json"})
    try:
        response = urlopen(req, timeout=15)
    except HTTPError as error:
        response = error
    with response:
        assert response.status == expected, (path, response.status)
        return json.load(response)


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    # Windows can otherwise let Werkzeug reuse a port owned by a running node.
    # Verify exclusive access before sending any test request.
    with ExitStack() as reserved:
        for port in PORTS.values():
            probe = reserved.enter_context(socket.socket())
            if hasattr(socket, 'SO_EXCLUSIVEADDRUSE'):
                probe.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
            try:
                probe.bind(('127.0.0.1', port))
            except OSError:
                raise SystemExit(f'Không chạy kiểm tra LIVE: cổng {port} đang được sử dụng.')
    sources = list((PROJECT_ROOT / "Network & Sync").glob("*.py"))
    sources.extend((PROJECT_ROOT / "Blockchain Core").glob("*.py"))
    hashes = {p: hashlib.sha256(p.read_bytes()).hexdigest() for p in sources}
    apps, servers, threads = {}, [], []
    browser = os.environ.get("BROWSER_PATH", r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe")
    profile = tempfile.mkdtemp(prefix="chainroom-live-check-")

    def browser_check(node, action="read"):
        result = subprocess.run([
            browser, "--headless", "--disable-gpu", "--no-first-run",
            "--no-default-browser-check", "--disable-background-networking",
            f"--user-data-dir={profile}", "--virtual-time-budget=45000", "--dump-dom",
            f"http://127.0.0.1:{PORTS[node]}/__m6_check?action={action}",
        ], capture_output=True, encoding="utf-8", errors="replace", timeout=60)
        assert result.returncode == 0, result.stderr[-2000:]
        if 'data-test-result="pass"' not in result.stdout:
            raise AssertionError(result.stdout)
        start = result.stdout.index('<h1 id="result">') + len('<h1 id="result">')
        print(unescape(result.stdout[start:result.stdout.index('</h1>', start)]), flush=True)

    try:
        # Bind cả ba cổng trước mọi request. Cổng bận => dừng, không gọi API bên ngoài test.
        for node in ("C", "A", "B"):
            app = create_web_app(node)
            app.add_url_rule("/__m6_check", "m6_check", lambda: (
                (WEB_UI_DIR / "tests" / "live-tests.html").read_text(encoding="utf-8")))
            apps[node] = app
            servers.append(make_server("127.0.0.1", PORTS[node], app, threaded=True,
                                       request_handler=QuietHandler))
        for server in servers:
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            threads.append(thread)
        states = {node: app.config["NODE_STATE"] for node, app in apps.items()}
        join_network(states["A"], PORTS["A"])
        sync_chain(states["A"])
        sync_pending(states["A"])
        for node in PORTS:
            assert request(node, "/api/chain")["length"] == 1
            assert request(node, "/api/pending")["count"] == 0
            assert request(node, f"/api/balance?address={node}")["available_balance"] == 1000
            with urlopen(f"http://127.0.0.1:{PORTS[node]}/") as response:
                assert response.url.endswith('/ui/')
                assert 'name="chainroom-mode" content="real"' in response.read().decode()
        print("PASS genesis A/B/C, root redirect and LIVE configuration", flush=True)

        browser_check("A", "write")
        chain = request("A", "/api/chain")["chain"]
        reward, tx = chain[1]["transactions"]
        assert reward["sender"] == "SYSTEM" and reward["receiver"] == "M6-Miner-A"
        assert reward["amount"] == 100
        assert tx["sender"] == "M6-Alice" and tx["amount"] == 7.5
        assert chain == request("C", "/api/chain")["chain"]
        assert request("A", "/api/pending")["count"] == 0
        assert request("C", "/api/pending")["count"] == 0
        balance = request("A", "/api/balance?address=M6-Miner-A")
        assert balance["confirmed_balance"] == 100
        assert balance["available_balance"] == 100
        assert request("B", "/api/chain")["length"] == 1
        print("PASS transaction/block broadcast A → C; coinbase confirmed in mined block", flush=True)
        browser_check("B")

        join_network(states["B"], PORTS["B"])
        sync_chain(states["B"])
        sync_pending(states["B"])
        states["C"].peers = []
        recover_bootstrap(states["C"])
        for node in PORTS:
            assert request(node, "/api/chain")["chain"] == chain
            assert len(request(node, "/api/peers")["peers"]) == 2
            browser_check(node)
        print("PASS late join B: register, peer announcement and chain sync", flush=True)

        before = request("A", "/api/pending")
        assert request("A", "/api/transaction", tx)["message"] == "Transaction already exists"
        request("A", "/api/transaction", {"sender": "X", "receiver": "Y", "amount": 0}, 400)
        request("A", "/api/mine", {}, 400)
        assert request("A", "/api/pending") == before
        print("PASS actual HTTP 400 and duplicate: no additional transaction", flush=True)

        broadcast_tx = request("A", "/api/transaction", {
            "sender": "M6-Broadcast", "receiver": "M6-Receiver", "amount": 2,
        }, 201)["transaction"]
        for node in PORTS:
            assert broadcast_tx in request(node, "/api/pending")["pending"]
        print("PASS transaction broadcast to all three mempools", flush=True)

        # Cô lập B tạm thời để chứng minh UI không tự ghép hoặc tự đồng bộ chain.
        peers = states["B"].peers
        states["B"].peers = []
        request("B", "/api/mine", {"miner_address": "M6-Miner-B"}, 201)
        for node, expected in (("A", 2), ("B", 3), ("C", 2)):
            assert request(node, "/api/chain")["length"] == expected
            browser_check(node)
        states["B"].peers = peers
        sync_chain(states["A"])
        sync_chain(states["C"])
        for node in PORTS:
            assert states[node].blockchain.is_valid()
            assert request(node, "/api/chain")["chain"] == request("B", "/api/chain")["chain"]
        print("PASS different chains stay separate in UI; backend sync restores agreement", flush=True)
        assert all(hashlib.sha256(p.read_bytes()).hexdigest() == digest for p, digest in hashes.items())
        print("All M6 LIVE checks passed. Backend source unchanged.", flush=True)
    finally:
        for server, thread in zip(servers, threads):
            server.shutdown()
            thread.join(timeout=3)
        for server in servers:
            server.server_close()


if __name__ == "__main__":
    main()
