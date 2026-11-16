import { createMockApi } from '../web/static/js/mock-api.js';
import { createRealApi } from '../web/static/js/real-api.js';
import { normalizeBalance, normalizeChain, normalizePending } from '../web/static/js/normalize.js';

const tests = [];
const test = (name, run) => tests.push({ name, run });
function assert(value, message = 'Assertion failed') { if (!value) throw new Error(message); }
async function rejects(action, code, status) {
  try { await action(); } catch (error) {
    assert(error.code === code, `Expected ${code}, got ${error.code}: ${error.message}`);
    if (status !== undefined) assert(error.status === status);
    return error;
  }
  throw new Error(`Expected rejection ${code}`);
}
const mock = options => createMockApi({ delayMs: 0, ...options });
const json = (data, status = 200) => new Response(JSON.stringify(data), { status });
const stubReal = fetchImpl => createRealApi({ fetchImpl });
const stuck = (_url, { signal }) => new Promise((_resolve, reject) => {
  signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
});

test('Hai adapter có chung bảy methods', async () => {
  for (const api of [mock(), stubReal(() => { throw new Error('No fetch expected'); })]) {
    for (const name of ['getChain', 'getPending', 'getBalance', 'submitTransaction', 'getStatus', 'getPeers', 'mine']) assert(typeof api[name] === 'function');
  }
});
test('Mock tính tiền khả dụng từ chain và pending outgoing', async () => {
  const api = mock({ scenario: 'empty' });
  await api.mine('Miner-A');
  await api.submitTransaction({ sender: 'Miner-A', receiver: 'Bob', amount: 30 });
  const balance = await api.getBalance(' Miner-A ');
  assert(balance.address === 'Miner-A' && balance.confirmedBalance === 100);
  assert(balance.pendingOutgoing === 30 && balance.pendingIncoming === 0 && balance.availableBalance === 70);
  await rejects(() => api.getBalance(' '), 'VALIDATION');
});
test('Mock submit → pending → mine → chain; coinbase nằm trong block hiện tại', async () => {
  const api = mock({ scenario: 'empty' });
  const before = await api.getChain();
  const result = await api.submitTransaction({ sender: ' Alice ', receiver: ' Bob ', amount: 3 });
  assert(result.transaction.sender === 'Alice' && result.transaction.receiver === 'Bob');
  assert(Object.keys(result.transaction).sort().join() === 'amount,id,receiver,sender,timestamp');
  assert((await api.getPending()).pending[0].id === result.transaction.id);
  const mined = await api.mine('Miner-A');
  assert(mined.block.previous_hash === before.chain.at(-1).hash);
  assert(mined.block.transactions.length === 2 && mined.block.transactions[0].sender === 'SYSTEM');
  assert(mined.block.transactions[1].id === result.transaction.id);
  assert(Object.keys(mined.block).sort().join() === 'hash,nonce,previous_hash,timestamp,transactions');
  const pending = await api.getPending();
  assert(pending.count === 0);
  const status = await api.getStatus();
  assert(status.length === 2 && status.height === 1 && status.pendingCount === 0);
  const second = await api.mine('Miner-B');
  assert(second.block.transactions.length === 1 && second.block.transactions[0].receiver === 'Miner-B');
});
test('Mock trả bản sao và các instance không chia sẻ state', async () => {
  const api = mock();
  const raw = await api.getChain(); raw.chain[1].transactions[0].amount = 999;
  assert((await api.getChain()).chain[1].transactions[0].amount === 12);
  const tx = await api.submitTransaction({ sender: 'A', receiver: 'B', amount: 1 });
  tx.transaction.amount = 999;
  assert((await api.getPending()).pending.at(-1).amount === 1);
  assert((await mock().getPending()).count === 2);
});
test('Các submit đồng thời không mất giao dịch', async () => {
  const api = mock({ scenario: 'empty' });
  const txs = await Promise.all(Array.from({ length: 8 }, () => api.submitTransaction({ sender: 'A', receiver: 'B', amount: 1 })));
  const mined = await api.mine('Miner');
  assert(new Set(txs.map(t => t.transaction.id)).size === 8 && mined.block.transactions.length === 9);
});
test('Empty có genesis, pending và peer list rỗng', async () => {
  const api = mock({ scenario: 'empty' });
  assert((await api.getChain()).length === 1 && (await api.getPending()).count === 0 && (await api.getPeers()).peers.length === 0);
});
test('Mock HTTP error và offline dùng error code chung', async () => {
  await rejects(() => mock({ scenario: 'error' }).getChain(), 'HTTP', 500);
  await rejects(() => mock({ scenario: 'offline' }).getPending(), 'NETWORK');
});
test('Input không hợp lệ không thay đổi state mock hoặc gọi HTTP', async () => {
  let calls = 0;
  const real = stubReal(() => { calls++; });
  const api = mock({ scenario: 'empty' });
  for (const amount of [0, -1, '', '3', NaN, Infinity, null]) {
    for (const client of [api, real]) await rejects(() => client.submitTransaction({ sender: 'A', receiver: 'B', amount }), 'VALIDATION');
  }
  await rejects(() => api.submitTransaction({ sender: ' ', receiver: 'B', amount: 1 }), 'VALIDATION');
  for (const client of [api, real]) {
    await rejects(() => client.submitTransaction({ sender: ' A ', receiver: 'A', amount: 101 }), 'VALIDATION');
  }
  await rejects(() => api.mine(' '), 'VALIDATION');
  assert((await api.getPending()).count === 0 && calls === 0);
});
test('Hủy mock mutation không thêm giao dịch', async () => {
  const api = createMockApi({ delayMs: 15, scenario: 'empty' });
  const controller = new AbortController();
  const pending = api.submitTransaction({ sender: 'A', receiver: 'B', amount: 1 }, { signal: controller.signal });
  controller.abort();
  await rejects(() => pending, 'ABORTED');
  assert((await api.getPending()).count === 0);
});
test('Normalize tạo view model, không đổi raw và xử lý chain rỗng', async () => {
  const raw = await mock().getChain();
  const before = JSON.stringify(raw);
  const normalized = normalizeChain(raw);
  assert(normalized.chain[2].uiIndex === 2 && normalized.height === 2);
  normalized.chain[1].transactions[0].amount = 77;
  assert(JSON.stringify(raw) === before && !('index' in raw.chain[0]) && !('uiIndex' in raw.chain[0]));
  const empty = normalizeChain({ node: 'B', length: 0, chain: [] });
  assert(empty.height === 0 && empty.latestBlock === null);
});
test('Response sai schema/count bị từ chối', async () => {
  await rejects(() => normalizeChain({ node: 'B', length: 1, chain: [] }), 'INVALID_RESPONSE');
  await rejects(() => normalizePending({ count: 1, pending: [] }), 'INVALID_RESPONSE');
  await rejects(() => normalizeChain({ node: 'B', length: 1, chain: [{}] }), 'INVALID_RESPONSE');
  await rejects(() => normalizeBalance({ address: 'A', available_balance: '1' }), 'INVALID_RESPONSE');
});
test('Real getBalance encode địa chỉ và chuẩn hóa response', async () => {
  let requested;
  const api = stubReal(async (url, options) => {
    requested = url;
    assert(options.method === 'GET');
    return json({
      address: 'Alice/Bob?', confirmed_balance: 12, pending_outgoing: 2,
      pending_incoming: 3, available_balance: 10,
    });
  });
  const result = await api.getBalance(' Alice/Bob? ');
  assert(requested === '/api/balance?address=Alice%2FBob%3F');
  assert(result.availableBalance === 10 && result.pendingIncoming === 3);
  await rejects(() => api.getBalance(''), 'VALIDATION');
});
test('Real getStatus chỉ gọi chain/pending, các trường chưa biết để null', async () => {
  const chain = await mock().getChain(); chain.node = 'B';
  const pending = await mock().getPending();
  const calls = [];
  const api = createRealApi({ baseUrl: 'http://localhost:5002/', fetchImpl: async (url, options) => {
    calls.push(url); assert(options.method === 'GET');
    return json(url.endsWith('/chain') ? chain : pending);
  } });
  const status = await api.getStatus();
  assert(calls.sort().join() === 'http://localhost:5002/api/chain,http://localhost:5002/api/pending');
  assert(status.node === 'B' && status.length === 3 && status.pendingCount === 2);
  for (const key of ['peerCount', 'mining', 'difficulty', 'miningReward', 'uptime']) assert(status[key] === null);
});
test('Real POST gửi JSON number và chỉ sender/receiver/amount', async () => {
  const sample = (await mock().getPending()).pending[0];
  let calls = 0;
  const api = stubReal(async (url, options) => {
    calls++;
    assert(url === '/api/transaction' && options.method === 'POST');
    assert(options.headers['Content-Type'] === 'application/json');
    const data = JSON.parse(options.body);
    assert(typeof data.amount === 'number' && data.sender === 'Alice');
    assert(Object.keys(data).sort().join() === 'amount,receiver,sender');
    return json({ message: 'Transaction added', transaction: { ...sample, ...data } }, 201);
  });
  const result = await api.submitTransaction({ sender: ' Alice ', receiver: 'Bob', amount: 2.5, nonce: 10 });
  assert(result.transaction.amount === 2.5 && calls === 1);
});
test('HTTP 400 JSON và 500 HTML giữ status, không retry', async () => {
  let calls = 0;
  await rejects(() => stubReal(async () => { calls++; return json({ message: 'Invalid transaction' }, 400); }).getChain(), 'HTTP', 400);
  await rejects(() => stubReal(async () => new Response('<html>Error</html>', { status: 500 })).getPending(), 'HTTP', 500);
  assert(calls === 1);
});
test('JSON lỗi và schema lỗi không biến thành dữ liệu mẫu', async () => {
  await rejects(() => stubReal(async () => new Response('not json')).getChain(), 'INVALID_JSON');
  await rejects(() => stubReal(async () => json({})).getPending(), 'INVALID_RESPONSE');
});
test('Response 200 duplicate thiếu transaction không giả thành công mới', async () => {
  await rejects(() => stubReal(async () => json({ message: 'Transaction already exists' })).submitTransaction({ sender: 'A', receiver: 'B', amount: 1 }), 'NO_TRANSACTION_RESULT');
});
test('Offline real không fallback mock', async () => {
  await rejects(() => stubReal(async () => { throw new TypeError('Failed to fetch'); }).getChain(), 'NETWORK');
});
test('Timeout hủy request đang chờ', async () => {
  const api = createRealApi({ timeoutMs: 10, fetchImpl: stuck });
  await rejects(() => api.getChain(), 'TIMEOUT');
});
test('Timeout bao gồm lúc đọc response body', async () => {
  const api = createRealApi({ timeoutMs: 10, fetchImpl: async (url, options) => ({ ok: true, status: 200, text: () => stuck(url, options) }) });
  await rejects(() => api.getPending(), 'TIMEOUT');
});
test('Timeout POST chỉ gửi một lần và nhắc kiểm tra pending', async () => {
  let calls = 0;
  const api = createRealApi({ timeoutMs: 10, fetchImpl: (...args) => { calls++; return stuck(...args); } });
  const error = await rejects(() => api.submitTransaction({ sender: 'A', receiver: 'B', amount: 1 }), 'TIMEOUT');
  assert(calls === 1 && error.message.includes('mempool'));
});
test('Abort real trước và trong request', async () => {
  let calls = 0;
  const api = stubReal((...args) => { calls++; return stuck(...args); });
  const stopped = new AbortController(); stopped.abort();
  await rejects(() => api.getChain({ signal: stopped.signal }), 'ABORTED');
  assert(calls === 0);
  const active = new AbortController();
  const pending = api.getPending({ signal: active.signal }); active.abort();
  await rejects(() => pending, 'ABORTED');
  assert(calls === 1);
});
test('API_PENDING khi backend thiếu mine/peers; không gọi register', async () => {
  const calls = [];
  const api = stubReal(async url => { calls.push(url); return new Response('Not found', { status: 404 }); });
  await rejects(() => api.getPeers(), 'API_PENDING');
  await rejects(() => api.mine('Alice'), 'API_PENDING');
  assert(calls.join() === '/api/peers/details,/api/peers,/api/mine');
});
test('Mine real gửi miner_address và trả block đúng schema', async () => {
  const block = (await mock().getChain()).chain[1];
  const api = stubReal(async (url, options) => {
    assert(url === '/api/mine' && options.method === 'POST');
    assert(options.body === JSON.stringify({ miner_address: 'Alice' }));
    return json({ message: 'Block mined', block }, 201);
  });
  assert((await api.mine(' Alice ')).block.hash === block.hash);
  await rejects(() => api.mine(' '), 'VALIDATION');
  await rejects(() => stubReal(async () => json({ block: {} }, 201)).mine('Alice'), 'INVALID_RESPONSE');
});
test('Peers real chỉ lấy địa chỉ, không bịa health hay sửa raw', async () => {
  const raw = { node: 'B', peers: ['http://localhost:5000'] };
  const result = await stubReal(async (url, options) => {
    if (url === '/api/peers/details') return json({ message: 'Not found' }, 404);
    assert(url === '/api/peers' && options.method === 'GET'); return json(raw);
  }).getPeers();
  assert(result.peers[0].address === raw.peers[0] && result.peers[0].status === 'Chưa xác định');
  assert(typeof raw.peers[0] === 'string');
  await rejects(() => stubReal(async () => json({ node: 'B', peers: [null] })).getPeers(), 'INVALID_RESPONSE');
});

test('Peer details giữ danh tính và từ chối schema lỗi', async () => {
  const peer = { address: 'http://localhost:5000', node: 'C', role: 'bootstrap', status: 'online', latency_ms: 2.5, checked_at: '2026-10-17T01:00:00Z' };
  const raw = { node: 'A', peers: [peer] };
  const before = JSON.stringify(raw);
  const result = await stubReal(async url => { assert(url === '/api/peers/details'); return json(raw); }).getPeers();
  assert(result.peers[0].name === 'C' && result.peers[0].state === 'online' && result.peers[0].latencyMs === 2.5);
  assert(JSON.stringify(raw) === before);
  for (const invalid of [{ node: null }, { role: 'unknown' }, { latency_ms: -1 }, { checked_at: 'invalid' }, { status: 'unknown' }]) {
    await rejects(() => stubReal(async () => json({ node: 'A', peers: [{ ...peer, ...invalid }] })).getPeers(), 'INVALID_RESPONSE');
  }
});

test('Peer details HTTP 500 không bị che bằng fallback cũ', async () => {
  const calls = [];
  await rejects(() => stubReal(async url => { calls.push(url); return json({ message: 'Unavailable' }, 500); }).getPeers(), 'HTTP', 500);
  assert(calls.join() === '/api/peers/details');
});

let failures = 0;
for (const { name, run } of tests) {
  const row = document.createElement('li');
  try { await run(); row.textContent = `PASS: ${name}`; }
  catch (error) { failures++; row.textContent = `FAIL: ${name} — ${error.message}`; }
  document.querySelector('#results').append(row);
}
document.querySelector('#summary').textContent = `${tests.length - failures}/${tests.length} PASS; ${failures} FAIL`;
document.documentElement.dataset.testResult = failures ? 'fail' : 'pass';
document.title = `M2: ${tests.length - failures}/${tests.length} PASS`;

const demo = mock({ scenario: 'empty', delayMs: 150 });
async function showDemo() {
  const state = await demo.getStatus();
  document.querySelector('#demo-state').textContent = `${state.length} block · height ${state.height} · ${state.pendingCount} pending`;
}
for (const [id, action] of [['demo-submit', () => demo.submitTransaction({ sender: 'Alice', receiver: 'Bob', amount: 3 })], ['demo-mine', () => demo.mine('Miner-A')]]) {
  document.getElementById(id).addEventListener('click', async () => {
    const buttons = document.querySelectorAll('button'); buttons.forEach(button => { button.disabled = true; });
    try { await action(); await showDemo(); }
    catch (error) { document.querySelector('#demo-state').textContent = error.message; }
    finally { buttons.forEach(button => { button.disabled = false; }); }
  });
}
await showDemo();
