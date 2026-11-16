"""Peer API checks using isolated nodes on ephemeral ports."""
from contextlib import contextmanager
import io
import json
from pathlib import Path
import sys
import threading
import unittest
from unittest.mock import patch

PROJECT_ROOT = Path(__file__).resolve().parents[2]
WEB_UI_DIR = PROJECT_ROOT / "Web UI"
sys.path.insert(0, str(WEB_UI_DIR))
from run_web_node import create_web_app
from network import identify_peer
from werkzeug.serving import make_server, WSGIRequestHandler


class QuietHandler(WSGIRequestHandler):
    def log(self, *_args, **_kwargs):
        pass


@contextmanager
def serve(app):
    server = make_server('127.0.0.1', 0, app, threaded=True, request_handler=QuietHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f'http://127.0.0.1:{server.server_port}'
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=3)


class PeerApiTests(unittest.TestCase):
    def setUp(self):
        self.app = create_web_app('A')
        self.client = self.app.test_client()
        self.state = self.app.config['NODE_STATE']

    def test_node_identity_and_role(self):
        self.assertEqual(self.client.get('/api/node').get_json(), {'node': 'A', 'role': 'full'})
        self.assertEqual(create_web_app('C').test_client().get('/api/node').get_json(),
                         {'node': 'C', 'role': 'bootstrap'})

    def test_empty_and_legacy_contract(self):
        self.assertEqual(self.client.get('/api/peers/details').get_json(), {'node': 'A', 'peers': []})
        self.state.peers = ['http://127.0.0.1:5000']
        self.assertEqual(self.client.get('/api/peers').get_json(), {'node': 'A', 'peers': self.state.peers})

    def test_genesis_gives_each_node_initial_balance(self):
        for address in ('A', 'B', 'C'):
            balance = self.client.get(f'/api/balance?address={address}').get_json()
            self.assertEqual(balance['confirmed_balance'], 1000)
            self.assertEqual(balance['available_balance'], 1000)

    def test_self_transfer_is_rejected(self):
        response = self.client.post('/api/transaction', json={
            'sender': 'A', 'receiver': 'A', 'amount': 101,
        })
        self.assertEqual(response.status_code, 400)
        self.assertEqual(self.state.blockchain.pending_transactions, [])
        self.assertEqual(self.client.post(
            '/api/mine', json={'miner_address': 'A'}
        ).status_code, 400)

    def test_available_balance_endpoint(self):
        self.client.post('/api/mine', json={'miner_address': 'Miner-A'})
        self.client.post('/api/transaction', json={
            'sender': 'Miner-A', 'receiver': 'Bob', 'amount': 30,
        })
        self.client.post('/api/transaction', json={
            'sender': 'Alice', 'receiver': 'Miner-A', 'amount': 5,
        })

        response = self.client.get('/api/balance?address=Miner-A')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json(), {
            'address': 'Miner-A',
            'confirmed_balance': 100,
            'pending_outgoing': 30,
            'pending_incoming': 5,
            'available_balance': 70,
        })
        self.assertEqual(self.client.get('/api/balance').status_code, 400)

    def test_real_identity_does_not_guess_from_port(self):
        with serve(create_web_app('B')) as b, serve(create_web_app('C')) as c:
            self.state.peers = [b, c]
            response = self.client.get('/api/peers/details')
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.headers['Cache-Control'], 'no-store')
            peers = response.get_json()['peers']
            self.assertEqual([p['node'] for p in peers], ['B', 'C'])
            self.assertEqual([p['role'] for p in peers], ['full', 'bootstrap'])
            for peer in peers:
                self.assertEqual(peer['status'], 'online')
                self.assertGreaterEqual(peer['latency_ms'], 0)
                self.assertTrue(peer['checked_at'].endswith('+00:00'))
            self.assertEqual(self.state.peers, [b, c])

    def test_stopped_peer_does_not_hide_healthy_peer(self):
        with serve(create_web_app('B')) as stopped:
            pass
        with serve(create_web_app('C')) as healthy:
            self.state.peers = [healthy, stopped]
            peers = self.client.get('/api/peers/details').get_json()['peers']
        self.assertEqual(peers[0]['node'], 'C')
        self.assertEqual(peers[1]['status'], 'unreachable')
        self.assertIsNone(peers[1]['node'])
        self.assertIsNone(peers[1]['latency_ms'])

    def test_timeout_is_isolated_and_bounded(self):
        with patch('network.urlopen', side_effect=TimeoutError) as probe:
            result = identify_peer('http://localhost:5000')
        self.assertEqual(result['status'], 'unreachable')
        probe.assert_called_once_with('http://localhost:5000/api/node', timeout=2)

    def test_invalid_response_does_not_invent_identity(self):
        for payload in [b'not json', b'[]', b'{}', b'x' * 65537,
                        json.dumps({'node': 'B', 'role': 'unknown'}).encode()]:
            with self.subTest(payload=payload[:50]), patch('network.urlopen', return_value=io.BytesIO(payload)):
                result = identify_peer('http://localhost:5002')
                self.assertEqual(result['status'], 'invalid_response')
                self.assertIsNone(result['node'])

    def test_non_http_addresses_are_not_requested(self):
        with patch('network.urlopen') as probe:
            self.assertEqual(identify_peer('file:///etc/passwd')['status'], 'invalid_response')
            probe.assert_not_called()


if __name__ == '__main__':
    unittest.main(verbosity=2)
