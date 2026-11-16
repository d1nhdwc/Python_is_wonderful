"""Smoke checks bằng Edge/Chromium, không cần npm/Flask hoặc node thật.

Chạy từ workspace: py "Web UI/tests/run_checks.py"
BROWSER_PATH có thể trỏ đến browser Chromium khác. HTTP fixture chỉ tồn tại
trong server loopback tạm thời của bài test; không thay đổi backend dự án.
"""
import functools
import http.server
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
from html import unescape
from urllib.parse import urlsplit

WEB_UI_DIR = Path(__file__).resolve().parents[1]
WEB_ROOT = WEB_UI_DIR / "web"
BROWSER = os.environ.get(
    "BROWSER_PATH", r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
)


class Handler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_GET(self):
        if urlsplit(self.path).path == "/tests/frame.html":
            # Test-only bootstrap before the app module is imported.
            html = (WEB_ROOT / "index.html").read_text(encoding="utf-8")
            # Absolute assets without <base>: hash links must stay inside this test frame.
            html = html.replace('href="static/', 'href="/web/static/').replace('src="static/', 'src="/web/static/')
            bootstrap = '''<script>
window.addEventListener('error', event => parent.captureBrowserError?.(event.message || 'Resource error'), true);
window.addEventListener('unhandledrejection', event => parent.captureBrowserError?.(String(event.reason)));
const originalError = console.error;
console.error = (...args) => { parent.captureBrowserError?.(args.join(' ')); originalError.apply(console, args); };
window.fetch=(...args)=>parent.fixtureFetch(...args);
Object.defineProperty(navigator,"clipboard",{value:{writeText:value=>parent.captureCopy(value)}});
</script>'''
            data = html.replace("<head>", "<head>" + bootstrap, 1).encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            self.wfile.write(data)
            return
        fixtures = {
            "/api/chain": {
                "node": "B", "length": 1,
                "chain": [{"previous_hash": "0", "timestamp": "2026-04-04T04:44:44+00:00",
                           "transactions": [], "nonce": 0, "hash": "d" * 64}],
            },
            "/api/pending": {"count": 1, "pending": [{
                "id": "9" * 32, "sender": '<img src=x onerror="window.xss=1">',
                "receiver": "Test receiver", "amount": 2,
                "timestamp": "2026-10-15T02:00:00+00:00",
            }]},
        }
        if self.path in fixtures:
            data = json.dumps(fixtures[self.path]).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        super().do_GET()


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    server = http.server.ThreadingHTTPServer(
        ("127.0.0.1", 0), functools.partial(Handler, directory=str(WEB_UI_DIR))
    )
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{server.server_port}"
    # Profile riêng trong OS temp; không truy cập profile trình duyệt người dùng.
    profile = tempfile.mkdtemp(prefix="chainroom-m2-check-")
    flags = [BROWSER, "--headless", "--disable-gpu", "--no-first-run",
             "--no-default-browser-check", "--disable-background-networking",
             f"--user-data-dir={profile}", "--virtual-time-budget=6000"]

    def dom(path, budget=6000):
        result = subprocess.run(flags + [f"--virtual-time-budget={budget}", "--dump-dom", base + path], capture_output=True,
                                encoding="utf-8", errors="replace", timeout=35)
        if result.returncode:
            raise AssertionError(result.stderr[-2000:])
        return result.stdout

    try:
        output = dom("/tests/")
        if 'data-test-result="pass"' not in output:
            print(output)
            raise AssertionError("Adapter tests failed or did not finish")
        start = output.index('<h2 id="summary"')
        print(unescape(output[start:output.index("</h2>", start) + 5]), flush=True)
        output = dom("/tests/explorer-tests.html", budget=65000)
        if 'data-test-result="pass"' not in output:
            print(output)
            raise AssertionError("M3 explorer tests failed or did not finish")
        start = output.index('<h2 id="summary"')
        print("M3: " + unescape(output[start:output.index("</h2>", start) + 5]), flush=True)
        output = dom("/tests/transaction-tests.html", budget=30000)
        if 'data-test-result="pass"' not in output:
            print(output)
            raise AssertionError("M4 transaction tests failed or did not finish")
        start = output.index('<h2 id="summary"')
        print("M4: " + unescape(output[start:output.index("</h2>", start) + 5]), flush=True)
        output = dom("/tests/mining-tests.html", budget=45000)
        if 'data-test-result="pass"' not in output:
            print(output)
            raise AssertionError("M5 mining/network tests failed or did not finish")
        start = output.index('<h2 id="summary"')
        print("M5: " + unescape(output[start:output.index("</h2>", start) + 5]), flush=True)
        output = dom("/tests/acceptance-tests.html", budget=45000)
        if 'data-test-result="pass"' not in output:
            print(output)
            raise AssertionError("M7 acceptance tests failed or did not finish")
        start = output.index('<h2 id="summary"')
        print("M7: " + unescape(output[start:output.index("</h2>", start) + 5]), flush=True)
        checks = [
            ("/web/#dashboard", "Block #2"),
            ("/web/#wallet", "Tiền khả dụng"),
            ("/web/#blockchain", "#0 · Genesis"),
            ("/web/#transactions", "Kết quả giao dịch"),
            ("/web/#mempool", "Charlie"),
            ("/web/#mining", "Mô phỏng mine"),
            ("/web/#network", "Node C"),
            ("/web/?scenario=empty#mempool", "Chưa có giao dịch chờ xác nhận"),
            ("/web/?scenario=error", "MOCK: mô phỏng lỗi máy chủ HTTP 500"),
            ("/web/?scenario=offline", "MOCK: mô phỏng mất kết nối"),
            ("/web/?mode=real#dashboard", "Node B"),
            ("/web/?mode=real#network", "API_PENDING"),
        ]
        for path, expected in checks:
            output = dom(path)
            assert 'aria-busy="false"' in output and expected in unescape(output), path
            if "mode=real" in path:
                assert "Mock sẵn sàng" not in output and "Block #2" not in output, path
            print(f"PASS render: {path}", flush=True)
        output = dom("/web/?mode=real#mempool")
        assert "&lt;img" in output and '<img src="x"' not in output
        print("PASS API text rendered as text, not injected HTML", flush=True)
        print("All checks passed. LIVE views used isolated HTTP fixtures, not real backend.", flush=True)
    finally:
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    main()
