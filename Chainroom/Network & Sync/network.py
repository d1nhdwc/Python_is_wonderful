import json
from pathlib import Path
import sys
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from http.client import HTTPException
from time import perf_counter
from urllib.parse import urlsplit
from urllib.request import Request, urlopen
from flask import Flask, jsonify, request

PROJECT_ROOT = Path(__file__).resolve().parents[1]
CORE_DIR = PROJECT_ROOT / "Blockchain Core"
sys.path.insert(0, str(CORE_DIR))
from core_sys import Transaction, Block, Blockchain


class NodeState:
    def __init__(self, node_name, host=False):
        self.node_name = node_name
        self.host = host
        self.blockchain = Blockchain()
        self.peers = []


def create_app(node_name="A/B", host=False):
    app = Flask(__name__)
    state = NodeState(node_name, host)
    app.config["NODE_STATE"] = state

    @app.get("/api/node")
    def get_node():
        return jsonify({
            "node": state.node_name,
            "role": "bootstrap" if state.host else "full",
        })

    @app.get("/api/chain")
    def get_chain():
        return jsonify(
            {
                "node": state.node_name,
                "length": len(state.blockchain.chain),
                "chain": state.blockchain.to_list(),
            }
        )

    @app.get("/api/pending")
    def get_pending_transactions():
        return jsonify(
            {
                "count": len(state.blockchain.pending_transactions),
                "pending": state.blockchain.pending_transactions,
            }
        )

    @app.get("/api/balance")
    def get_balance():
        address = request.args.get("address", "").strip()
        if not address:
            return jsonify({"message": "Thiếu địa chỉ"}), 400

        confirmed = state.blockchain.get_balance(address)
        pending_outgoing = sum(
            transaction["amount"]
            for transaction in state.blockchain.pending_transactions
            if transaction["sender"] == address
        )
        pending_incoming = sum(
            transaction["amount"]
            for transaction in state.blockchain.pending_transactions
            if transaction["receiver"] == address
        )
        return jsonify({
            "address": address,
            "confirmed_balance": confirmed,
            "pending_outgoing": pending_outgoing,
            "pending_incoming": pending_incoming,
            "available_balance": state.blockchain.get_available_balance(address),
        })

    @app.post("/api/transaction")
    def receive_transaction():
        payload = request.get_json(silent=True)
        if not isinstance(payload, dict):
            return jsonify({"message": "Dữ liệu JSON phải là một đối tượng"}), 400
        transaction = Transaction.from_dict(payload)

        for pending in state.blockchain.pending_transactions:
            if pending["id"] == transaction.id:
                return jsonify({"message": "Giao dịch đã tồn tại"}), 200

        for block in state.blockchain.chain:
            for confirmed in block.transactions:
                if confirmed["id"] == transaction.id:
                    return jsonify({"message": "Giao dịch đã tồn tại"}), 200

        if request.headers.get("X-From-Peer") != "1" and transaction.sender != state.node_name:
            return jsonify({"message": "Bạn chỉ được gửi tiền của chính node này"}), 403

        if not state.blockchain.add_transaction(transaction):
            return jsonify({"message": "Giao dịch không hợp lệ hoặc không đủ số dư"}), 400

        if request.headers.get("X-From-Peer") != "1":
            broadcast_transaction(state, transaction.to_dict())

        return jsonify({
            "message": "Đã thêm giao dịch",
            "transaction": transaction.to_dict(),
        }), 201

    @app.post("/api/block")
    def receive_block():
        payload = request.get_json(silent=True)
        if not isinstance(payload, dict):
            return jsonify({"message": "Dữ liệu JSON phải là một đối tượng"}), 400
        try:
            block = Block.from_dict(payload)
        except (KeyError, TypeError):
            return jsonify({"message": "Block không hợp lệ"}), 400

        if any(old_block.hash == block.hash for old_block in state.blockchain.chain):
            return jsonify({"message": "Block đã tồn tại"}), 200

        if block.previous_hash != state.blockchain.get_last_block().hash:
            if sync_chain(state):
                sync_pending(state)

            if any(old_block.hash == block.hash for old_block in state.blockchain.chain):
                return jsonify({"message": "Đã nhận block thông qua đồng bộ"}), 200

        if not state.blockchain.add_block(block):
            return jsonify({"message": "Block không nối được với chuỗi hiện tại"}), 409

        if request.headers.get("X-From-Peer") != "1":
            broadcast_block(state, block.to_dict())

        return jsonify({
            "message": "Đã thêm block",
            "block": block.to_dict(),
        }), 201

    @app.get("/api/peers")
    def get_peers():
        return jsonify({
            "node": state.node_name,
            "peers": state.peers,
        })

    @app.post("/api/peer")
    def receive_peer():
        address = request.get_json()["address"].rstrip("/")

        if address not in state.peers:
            state.peers.append(address)

        return jsonify({"peers": state.peers})

    @app.get("/api/peers/details")
    def get_peer_details():
        addresses = list(state.peers)
        with ThreadPoolExecutor(max_workers=8) as executor:
            peers = list(executor.map(identify_peer, addresses))
        response = jsonify({"node": state.node_name, "peers": peers})
        response.headers["Cache-Control"] = "no-store"
        return response

    @app.post("/api/mine")
    def mine_block():
        data = request.get_json(silent=True)
        if not isinstance(data, dict):
            return jsonify({"message": "Dữ liệu JSON phải là một đối tượng"}), 400
        miner_address = data.get("miner_address")

        if not isinstance(miner_address, str) or not miner_address.strip():
            return jsonify({"message": "Thiếu địa chỉ nhận thưởng mining"}), 400

        miner_address = miner_address.strip()
        if miner_address != state.node_name:
            return jsonify({"message": "Địa chỉ nhận thưởng phải thuộc node hiện tại"}), 403

        try:
            block = state.blockchain.mine_pending_transactions(miner_address)
        except ValueError as error:
            return jsonify({"message": str(error)}), 400
        broadcast_block(state, block.to_dict())

        return jsonify({
            "message": "Đã mine block",
            "block": block.to_dict(),
        }), 201

    if host:
        @app.post("/register")
        def register_node():
            address = request.get_json()["address"].rstrip("/")

            if address not in state.peers:
                old_peers = list(state.peers)
                state.peers.append(address)

                for peer in old_peers:
                    data = json.dumps({"address": address}).encode()
                    peer_request = Request(
                        peer + "/api/peer",
                        data=data,
                        headers={"Content-Type": "application/json"},
                    )

                    try:
                        urlopen(peer_request, timeout=3).close()
                    except OSError:
                        pass

            return jsonify({
                "message": "Đã đăng ký node",
                "peers": state.peers,
            }), 201
    return app


def identify_peer(address):
    result = {
        "address": address, "node": None, "role": None,
        "status": "unreachable", "latency_ms": None,
    }
    started = perf_counter()
    try:
        parsed = urlsplit(address)
        if (parsed.scheme not in ("http", "https") or not parsed.hostname
                or parsed.username or parsed.password or parsed.query or parsed.fragment):
            raise ValueError("Invalid peer address")
        with urlopen(address.rstrip("/") + "/api/node", timeout=2) as response:
            payload = response.read(65537)
        if len(payload) > 65536:
            raise ValueError("Peer identity response too large")
        data = json.loads(payload)
        if (not isinstance(data, dict) or not isinstance(data.get("node"), str)
                or not data["node"].strip() or data.get("role") not in ("bootstrap", "full")):
            raise ValueError("Invalid peer identity")
        result.update(node=data["node"], role=data["role"], status="online",
                      latency_ms=round((perf_counter() - started) * 1000, 1))
    except (OSError, HTTPException):
        pass
    except (ValueError, TypeError):
        result["status"] = "invalid_response"
    result["checked_at"] = datetime.now(timezone.utc).isoformat()
    return result


def join_network(state, port):
    my_address = f"http://127.0.0.1:{port}"
    data = json.dumps({"address": my_address}).encode()

    request = Request(
        "http://127.0.0.1:5000/register",
        data=data,
        headers={"Content-Type": "application/json"},
    )

    with urlopen(request, timeout=3) as response:
        result = json.load(response)

    state.peers = [
        address for address in result["peers"]
        if address != my_address
    ]
    state.peers.append("http://127.0.0.1:5000")


def broadcast_transaction(state, transaction_data):
    data = json.dumps(transaction_data).encode()

    for peer in state.peers:
        peer_request = Request(
            peer + "/api/transaction",
            data=data,
            headers={
                "Content-Type": "application/json",
                "X-From-Peer": "1",
            },
        )

        try:
            urlopen(peer_request, timeout=3).close()
        except OSError:
            pass


def broadcast_block(state, block_data):
    data = json.dumps(block_data).encode()

    for peer in state.peers:
        peer_request = Request(
            peer + "/api/block",
            data=data,
            headers={
                "Content-Type": "application/json",
                "X-From-Peer": "1",
            },
        )

        try:
            urlopen(peer_request, timeout=3).close()
        except OSError:
            pass

def sync_chain(state):
    blockchain = state.blockchain
    best_chain = blockchain.chain

    for peer in state.peers:
        try:
            with urlopen(peer + "/api/chain", timeout=3) as response:
                data = json.load(response)

            if len(data["chain"]) <= len(best_chain):
                continue

            received_chain = [
                Block.from_dict(block_data)
                for block_data in data["chain"]
            ]

            checker = Blockchain(difficulty=blockchain.difficulty)
            checker.chain = received_chain

            same_genesis = (
                received_chain[0].to_dict()
                == blockchain.chain[0].to_dict()
            )

            if same_genesis and checker.is_valid():
                best_chain = received_chain

        except (OSError, KeyError, ValueError, TypeError, IndexError):
            pass
        
    if best_chain is blockchain.chain:
        return False

    old_transactions = list(blockchain.pending_transactions)

    for block in blockchain.chain[1:]:
        old_transactions.extend(block.transactions)

    confirmed_ids = {
        transaction["id"]
        for block in best_chain
        for transaction in block.transactions
    }

    blockchain.chain = best_chain
    blockchain.pending_transactions = []
    kept_ids = set(confirmed_ids)

    for transaction in old_transactions:
        transaction_id = transaction["id"]

        if transaction_id in kept_ids or transaction["sender"] == "SYSTEM":
            continue

        blockchain.pending_transactions.append(transaction)
        kept_ids.add(transaction_id)

    return True


def sync_pending(state):
    blockchain = state.blockchain

    known_ids = {
        transaction["id"]
        for block in blockchain.chain
        for transaction in block.transactions
    }
    known_ids.update(
        transaction["id"]
        for transaction in blockchain.pending_transactions
    )

    for peer in state.peers:
        try:
            with urlopen(peer + "/api/pending", timeout=3) as response:
                data = json.load(response)

            for transaction_data in data["pending"]:
                transaction = Transaction.from_dict(transaction_data)

                if transaction.id in known_ids:
                    continue

                if transaction.sender == "SYSTEM":
                    continue

                if blockchain.add_transaction(transaction):
                    known_ids.add(transaction.id)

        except (OSError, KeyError, TypeError, ValueError):
            pass


def recover_bootstrap(state):
    for port in (5001, 5002, 5003, 5004, 5005):
        address = f"http://127.0.0.1:{port}"

        try:
            with urlopen(address + "/api/peers", timeout=2) as response:
                data = json.load(response)

            if address not in state.peers:
                state.peers.append(address)

            for peer in data["peers"]:
                if peer != "http://127.0.0.1:5000" and peer not in state.peers:
                    state.peers.append(peer)

        except OSError:
            pass

    sync_chain(state)
    sync_pending(state)
