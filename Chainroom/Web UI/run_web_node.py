import argparse
from pathlib import Path
import sys

PROJECT_ROOT = Path(__file__).resolve().parents[1]
WEB_UI_DIR = PROJECT_ROOT / "Web UI"
NETWORK_DIR = PROJECT_ROOT / "Network & Sync"
sys.path.insert(0, str(NETWORK_DIR))

from flask import Blueprint, Response, redirect
from network import create_app, join_network, recover_bootstrap, sync_chain, sync_pending

PORTS = {"A": 5001, "B": 5002, "C": 5000, "D": 5003, "E": 5004, "F": 5005}


def create_web_app(node_name):
    app = create_app(node_name=node_name, host=(node_name == "C"))
    ui = Blueprint("web_ui", __name__, url_prefix="/ui",
                   static_folder=str(WEB_UI_DIR / "web" / "static"), static_url_path="/static")

    @ui.get("/")
    def index():
        html = (WEB_UI_DIR / "web" / "index.html").read_text(encoding="utf-8")
        html = html.replace("<head>", '<head><meta name="chainroom-mode" content="real">', 1)
        return Response(html, content_type="text/html; charset=utf-8",
                        headers={"Cache-Control": "no-store"})

    app.register_blueprint(ui)

    @app.get("/")
    def home():
        return redirect("/ui/")

    return app


def main():
    parser = argparse.ArgumentParser(description="Chạy node blockchain cùng Web UI LIVE.")
    parser.add_argument("node", choices=PORTS)
    args = parser.parse_args()
    app = create_web_app(args.node)
    state = app.config["NODE_STATE"]
    if args.node == "C":
        recover_bootstrap(state)
    else:
        join_network(state, PORTS[args.node])
        sync_chain(state)
        sync_pending(state)
    app.run(host="127.0.0.1", port=PORTS[args.node], debug=False)


if __name__ == "__main__":
    main()
