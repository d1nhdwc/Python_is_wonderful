from pathlib import Path
import sys

PROJECT_ROOT = Path(__file__).resolve().parents[1]
NETWORK_DIR = PROJECT_ROOT / "Network & Sync"
sys.path.insert(0, str(NETWORK_DIR))
from network import create_app


NODE_NAME = "C"
NODE_PORT = 5000


if __name__ == "__main__":
    application = create_app(node_name=NODE_NAME, host=True)
    application.run(host="0.0.0.0", port=NODE_PORT, debug=False)
