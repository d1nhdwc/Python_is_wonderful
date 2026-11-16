import { ApiError, abortError, transactionPayload } from './errors.js';
import { normalizeBalance, normalizeStatus } from './normalize.js';

const copy = value => structuredClone(value);
const hash = digit => digit.repeat(64);
const seedTx = (id, sender, receiver, amount, timestamp) => ({ id: id.repeat(32), sender, receiver, amount, timestamp });
const newId = () => crypto.randomUUID().replaceAll('-', '');
const newTx = (sender, receiver, amount) => ({ id: newId(), sender, receiver, amount, timestamp: new Date().toISOString() });
function initialState(empty) {
  const chain = [
    { previous_hash: '0', timestamp: '2026-04-04T04:44:44+00:00', transactions: [
      seedTx('a', 'SYSTEM', 'A', 1000, '2026-04-04T04:44:44+00:00'),
      seedTx('b', 'SYSTEM', 'B', 1000, '2026-04-04T04:44:44+00:00'),
      seedTx('c', 'SYSTEM', 'C', 1000, '2026-04-04T04:44:44+00:00'),
    ], nonce: 0, hash: hash('a') },
    { previous_hash: hash('a'), timestamp: '2026-10-15T02:10:00+00:00', transactions: [seedTx('1', 'Alice', 'Bob', 12, '2026-10-15T02:08:00+00:00')], nonce: 148, hash: hash('b') },
    { previous_hash: hash('b'), timestamp: '2026-10-15T02:15:00+00:00', transactions: [seedTx('2', 'Bob', 'Charlie', 4.5, '2026-10-15T02:12:00+00:00'), seedTx('3', 'Alice', 'Diana', 8, '2026-10-15T02:13:00+00:00')], nonce: 306, hash: hash('c') },
  ];
  return {
    chain: empty ? chain.slice(0, 1) : chain,
    pending: empty ? [] : [seedTx('4', 'Charlie', 'Alice', 2.5, '2026-10-15T02:18:00+00:00'), seedTx('5', 'Diana', 'Bob', 6, '2026-10-15T02:19:00+00:00')],
    peers: empty ? [] : [
      { name: 'B', role: 'Full node', address: 'http://127.0.0.1:5002', status: 'Online · mẫu' },
      { name: 'C', role: 'Bootstrap + Full node', address: 'http://127.0.0.1:5000', status: 'Online · mẫu' },
    ],
  };
}
function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(abortError()); return; }
    const stop = () => { clearTimeout(timer); reject(abortError()); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', stop); resolve(); }, ms);
    signal?.addEventListener('abort', stop, { once: true });
  });
}
export function createMockApi({ scenario = 'success', delayMs = 300 } = {}) {
  if (!['success', 'empty', 'error', 'offline'].includes(scenario) || !Number.isFinite(delayMs) || delayMs < 0) throw new ApiError('CONFIG', 'Cấu hình mock không hợp lệ.');
  const state = initialState(scenario === 'empty');
  const chainData = () => ({ node: 'A', length: state.chain.length, chain: state.chain });
  const pendingData = () => ({ count: state.pending.length, pending: state.pending });
  const balanceData = address => {
    let confirmed = 0;
    for (const block of state.chain) {
      for (const transaction of block.transactions) {
        if (transaction.sender === address) confirmed -= transaction.amount;
        if (transaction.receiver === address) confirmed += transaction.amount;
      }
    }
    const pendingOutgoing = state.pending.filter(transaction => transaction.sender === address)
      .reduce((total, transaction) => total + transaction.amount, 0);
    const pendingIncoming = state.pending.filter(transaction => transaction.receiver === address)
      .reduce((total, transaction) => total + transaction.amount, 0);
    return normalizeBalance({
      address,
      confirmed_balance: confirmed,
      pending_outgoing: pendingOutgoing,
      pending_incoming: pendingIncoming,
      available_balance: confirmed - pendingOutgoing,
    });
  };
  async function run(action, { signal } = {}) {
    await delay(delayMs, signal);
    if (signal?.aborted) throw abortError();
    if (scenario === 'offline') throw new ApiError('NETWORK', 'MOCK: mô phỏng mất kết nối.');
    if (scenario === 'error') throw new ApiError('HTTP', 'MOCK: mô phỏng lỗi máy chủ HTTP 500.', { status: 500 });
    // Mutations đồng bộ sau delay: không mất TX khi submit/mine đồng thời.
    return copy(action());
  }
  return Object.freeze({
    getChain: options => run(chainData, options),
    getPending: options => run(pendingData, options),
    getBalance: (address, options) => {
      const value = typeof address === 'string' ? address.trim() : '';
      if (!value) throw new ApiError('VALIDATION', 'Cần nhập địa chỉ để xem số dư.');
      return run(() => balanceData(value), options);
    },
    getStatus: options => run(() => normalizeStatus(chainData(), pendingData()), options),
    getPeers: options => run(() => ({ node: 'A', peers: state.peers }), options),
    submitTransaction: (data, options) => run(() => {
      const { sender, receiver, amount } = transactionPayload(data);
      const transaction = newTx(sender, receiver, amount);
      state.pending.push(transaction);
      return { message: 'MOCK: giao dịch đã thêm tại node hiện tại.', transaction };
    }, options),
    mine: (minerAddress, options) => run(() => {
      if (typeof minerAddress !== 'string' || !minerAddress.trim()) throw new ApiError('VALIDATION', 'Cần địa chỉ nhận thưởng.');
      const pendingTotal = state.pending.reduce((total, transaction) => total + transaction.amount, 0);
      if (pendingTotal <= 100) throw new ApiError('VALIDATION', 'Tổng giá trị giao dịch chờ phải lớn hơn phần thưởng mining (100).');
      // Chỉ mô phỏng chuyển state UI; không hash, không PoW, không broadcast.
      const reward = newTx('SYSTEM', minerAddress.trim(), 100);
      const block = { previous_hash: state.chain.at(-1).hash, timestamp: new Date().toISOString(), transactions: [reward, ...copy(state.pending)], nonce: 0, hash: newId() + newId() };
      state.chain.push(block);
      state.pending = [];
      return { message: 'MOCK: đã mô phỏng tạo block, không thực hiện PoW.', block };
    }, options),
  });
}
