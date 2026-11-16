import json
from datetime import datetime, timezone
from hashlib import sha256
from math import isfinite
from uuid import uuid4


class Transaction:
    def __init__(self, sender, receiver, amount, transaction_id=None, timestamp=None):
        self.sender = sender
        self.receiver = receiver
        self.amount = amount
        self.timestamp = timestamp or datetime.now(timezone.utc).isoformat()
        self.id = transaction_id or uuid4().hex

    def validate(self, allow_system=False):
        if not all(
            isinstance(value, str) and value and value == value.strip()
            for value in (self.id, self.sender, self.receiver, self.timestamp)
        ):
            return False
        if self.sender == self.receiver:
            return False
        if self.sender == "SYSTEM" and not allow_system:
            return False
        if isinstance(self.amount, bool) or not isinstance(self.amount, (int, float)):
            return False
        return isfinite(self.amount) and self.amount > 0

    def to_dict(self):
        return {
            "id": self.id,
            "sender": self.sender,
            "receiver": self.receiver,
            "amount": self.amount,
            "timestamp": self.timestamp,
        }

    @classmethod
    def from_dict(cls, data):
        return cls(
            sender=data.get("sender"),
            receiver=data.get("receiver"),
            amount=data.get("amount", 0),
            transaction_id=data.get("id"),
            timestamp=data.get("timestamp"),
        )


class Block:
    def __init__(self, previous_hash, transactions, timestamp=None, nonce=0, block_hash=None):
        self.previous_hash = previous_hash
        self.transactions = transactions
        self.timestamp = timestamp or datetime.now(timezone.utc).isoformat()
        self.nonce = nonce
        self.hash = block_hash or self.calculate_hash()

    def calculate_hash(self):
        content = {
            "previous_hash": self.previous_hash,
            "timestamp": self.timestamp,
            "transactions": self.transactions,
            "nonce": self.nonce,
        }
        raw = json.dumps(content, sort_keys=True, separators=(",", ":"))
        return sha256(raw.encode()).hexdigest()

    def mine(self, difficulty):
        target = "0" * difficulty
        while not self.hash.startswith(target):
            self.nonce += 1
            self.hash = self.calculate_hash()

    def to_dict(self):
        return {
            "previous_hash": self.previous_hash,
            "timestamp": self.timestamp,
            "transactions": self.transactions,
            "nonce": self.nonce,
            "hash": self.hash,
        }

    @classmethod
    def from_dict(cls, data):
        return cls(
            previous_hash=data["previous_hash"],
            transactions=data["transactions"],
            timestamp=data["timestamp"],
            nonce=data["nonce"],
            block_hash=data["hash"],
        )


class Blockchain:
    def __init__(self, difficulty=2, mining_reward=100, initial_balance=1000):
        self.difficulty = difficulty
        self.mining_reward = mining_reward
        self.initial_balance = initial_balance
        self.pending_transactions = []
        self.chain = [self._create_genesis_block()]

    def _create_genesis_block(self):
        timestamp = "2026-04-04T04:44:44+00:00"
        start = [
            Transaction(
                "SYSTEM",
                address,
                self.initial_balance,
                transaction_id=f"genesis-{address.lower()}",
                timestamp=timestamp,
            ).to_dict()
            for address in ("A", "B", "C", "D", "E", "F")
        ]
        return Block(
            previous_hash="0",
            transactions=start,
            timestamp=timestamp,
        )

    def get_last_block(self):
        return self.chain[-1]

    def add_transaction(self, transaction):
        if not transaction.validate():
            return False
        if self.get_available_balance(transaction.sender) < transaction.amount:
            return False
        self.pending_transactions.append(transaction.to_dict())
        return True

    def mine_pending_transactions(self, miner_address):
        pending_total = sum(
            transaction["amount"] for transaction in self.pending_transactions
        )
        if pending_total <= self.mining_reward:
            raise ValueError(
                "Tổng giá trị giao dịch chờ phải lớn hơn phần thưởng mining"
            )

        reward_transaction = Transaction("SYSTEM", miner_address, self.mining_reward)
        if not reward_transaction.validate(allow_system=True):
            raise ValueError("Địa chỉ miner hoặc phần thưởng mining không hợp lệ")
        reward = reward_transaction.to_dict()
        block = Block(
            self.get_last_block().hash,
            [reward, *self.pending_transactions],
        )
        block.mine(self.difficulty)
        self.chain.append(block)
        self.pending_transactions = []
        return block

    def _validate_block_transactions(self, block, base_chain=None):
        if not isinstance(block.transactions, list) or not block.transactions:
            return False

        balances = self._balances_from_chain(base_chain)
        for index, transaction_data in enumerate(block.transactions):
            required = ("id", "sender", "receiver", "amount", "timestamp")
            if not isinstance(transaction_data, dict) or any(
                key not in transaction_data for key in required
            ):
                return False

            transaction = Transaction.from_dict(transaction_data)
            is_coinbase = transaction.sender == "SYSTEM"
            if index == 0:
                if not is_coinbase or transaction.amount != self.mining_reward:
                    return False
                if not transaction.validate(allow_system=True):
                    return False
                balances[transaction.receiver] = balances.get(transaction.receiver, 0) + transaction.amount
            elif is_coinbase or not transaction.validate():
                return False
            else:
                if balances.get(transaction.sender, 0) < transaction.amount:
                    return False
                balances[transaction.sender] -= transaction.amount
                balances[transaction.receiver] = balances.get(transaction.receiver, 0) + transaction.amount

        return True

    def _balances_from_chain(self, chain=None):
        balances = {}
        for block in self.chain if chain is None else chain:
            for transaction in block.transactions:
                if transaction["sender"] != "SYSTEM":
                    balances[transaction["sender"]] = balances.get(transaction["sender"], 0) - transaction["amount"]
                balances[transaction["receiver"]] = balances.get(transaction["receiver"], 0) + transaction["amount"]
        return balances

    def add_block(self, block):
        if block.previous_hash != self.get_last_block().hash:
            return False
        if block.hash != block.calculate_hash():
            return False
        if not block.hash.startswith("0" * self.difficulty):
            return False

        if not self._validate_block_transactions(block):
            return False

        self.chain.append(block)
        mined_ids = {transaction["id"] for transaction in block.transactions}
        self.pending_transactions = [
            transaction
            for transaction in self.pending_transactions
            if transaction["id"] not in mined_ids
        ]
        return True

    def is_valid(self):
        if not self.chain:
            return False

        for index in range(1, len(self.chain)):
            current = self.chain[index]
            previous = self.chain[index - 1]
            if current.hash != current.calculate_hash():
                return False
            if current.previous_hash != previous.hash:
                return False
            if not current.hash.startswith("0" * self.difficulty):
                return False
            if not self._validate_block_transactions(current, self.chain[:index]):
                return False
        return True

    def get_balance(self, address):
        balance = 0
        for block in self.chain:
            for transaction in block.transactions:
                if transaction["sender"] == address:
                    balance -= transaction["amount"]
                if transaction["receiver"] == address:
                    balance += transaction["amount"]
        return balance

    def get_available_balance(self, address):
        pending_outgoing = sum(
            transaction["amount"]
            for transaction in self.pending_transactions
            if transaction["sender"] == address
        )
        return self.get_balance(address) - pending_outgoing

    def to_list(self):
        return [block.to_dict() for block in self.chain]
