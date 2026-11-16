import { ApiError } from './errors.js';
function requireValue(condition, field) {
  if (!condition) throw new ApiError('INVALID_RESPONSE', `Dữ liệu API không đúng định dạng: ${field}.`);
}
const isText = value => typeof value === 'string' && value.length > 0;
const isCount = value => Number.isSafeInteger(value) && value >= 0;

export function normalizeTransaction(raw) {
  requireValue(raw && ['id', 'sender', 'receiver', 'timestamp'].every(key => isText(raw[key])), 'transaction');
  requireValue(typeof raw.amount === 'number' && Number.isFinite(raw.amount) && raw.amount > 0, 'transaction.amount');
  return { id: raw.id, sender: raw.sender, receiver: raw.receiver, amount: raw.amount, timestamp: raw.timestamp };
}
export function normalizeBlock(raw, uiIndex) {
  requireValue(raw && ['previous_hash', 'timestamp', 'hash'].every(key => isText(raw[key])), 'block');
  requireValue(isCount(raw.nonce) && Array.isArray(raw.transactions), 'block.nonce/transactions');
  return {
    previous_hash: raw.previous_hash, timestamp: raw.timestamp,
    transactions: raw.transactions.map(normalizeTransaction), nonce: raw.nonce, hash: raw.hash,
    uiIndex, // Chỉ view model, không thêm vào raw JSON hoặc request backend.
  };
}
export function normalizeChain(raw) {
  requireValue(raw && isText(raw.node) && Array.isArray(raw.chain), 'chain/node');
  requireValue(isCount(raw.length) && raw.length === raw.chain.length, 'length không khớp chain');
  const chain = raw.chain.map(normalizeBlock);
  return { node: raw.node, length: chain.length, height: Math.max(0, chain.length - 1), chain, latestBlock: chain.at(-1) ?? null };
}
export function normalizePending(raw) {
  requireValue(raw && Array.isArray(raw.pending), 'pending');
  requireValue(isCount(raw.count) && raw.count === raw.pending.length, 'count không khớp pending');
  return { count: raw.count, pending: raw.pending.map(normalizeTransaction) };
}
export function normalizeBalance(raw) {
  requireValue(raw && isText(raw.address), 'balance.address');
  const fields = ['confirmed_balance', 'pending_outgoing', 'pending_incoming', 'available_balance'];
  requireValue(fields.every(key => typeof raw[key] === 'number' && Number.isFinite(raw[key])), 'balance values');
  return {
    address: raw.address,
    confirmedBalance: raw.confirmed_balance,
    pendingOutgoing: raw.pending_outgoing,
    pendingIncoming: raw.pending_incoming,
    availableBalance: raw.available_balance,
  };
}
export function normalizeStatus(chainRaw, pendingRaw) {
  const chain = normalizeChain(chainRaw);
  const pending = normalizePending(pendingRaw);
  return {
    node: chain.node, length: chain.length, height: chain.height, pendingCount: pending.count,
    latestBlock: chain.latestBlock, peerCount: null, mining: null, difficulty: null, miningReward: null, uptime: null,
  };
}
export function normalizeSubmission(raw) {
  requireValue(raw && isText(raw.message), 'message');
  // Network backend có thể trả 200 chỉ với message cho giao dịch trùng.
  if (!raw.transaction) throw new ApiError('NO_TRANSACTION_RESULT', `${raw.message} — phản hồi không có giao dịch; cần làm mới mempool để kiểm tra.`);
  return { message: raw.message, transaction: normalizeTransaction(raw.transaction) };
}

export function normalizePeers(raw) {
  requireValue(raw && isText(raw.node) && Array.isArray(raw.peers), 'peers/node');
  return { node: raw.node, peers: raw.peers.map(peer => {
    if (isText(peer)) return { name: null, address: peer, role: 'Peer', status: 'Chưa xác định' };
    requireValue(peer && isText(peer.address), 'peer address');
    requireValue(['online', 'unreachable', 'invalid_response'].includes(peer.status), 'peer status');
    requireValue(isText(peer.checked_at) && Number.isFinite(Date.parse(peer.checked_at)), 'peer checked_at');
    if (peer.status === 'online') {
      requireValue(isText(peer.node) && ['bootstrap', 'full'].includes(peer.role), 'peer identity');
      requireValue(typeof peer.latency_ms === 'number' && Number.isFinite(peer.latency_ms) && peer.latency_ms >= 0, 'peer latency');
    }
    const online = peer.status === 'online';
    return {
      name: online ? peer.node : null, address: peer.address,
      role: online ? (peer.role === 'bootstrap' ? 'Bootstrap · Full node' : 'Full node') : 'Peer',
      status: { online: 'Đang kết nối', unreachable: 'Không thể kết nối', invalid_response: 'Phản hồi không hợp lệ' }[peer.status],
      state: peer.status, latencyMs: online ? peer.latency_ms : null, checkedAt: peer.checked_at,
    };
  }) };
}
