const tests = [];
const test = (name, run) => tests.push({ name, run });
const assert = (ok, message = 'Assertion failed') => { if (!ok) throw new Error(message); };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const json = (data, status = 200) => new Response(JSON.stringify(data), { status });
let frame, chain, pending, calls, mineDelay, mineError, peersError, pendingError, peerDetails;
const tx = (sender, receiver, amount) => ({ id: crypto.randomUUID(), sender, receiver, amount, timestamp: '2026-10-15T03:04:05+00:00' });
window.captureCopy = () => Promise.resolve();
window.fixtureFetch = (url, options) => {
  calls.push({ url, ...options });
  if (url === '/api/peers/details') return Promise.resolve(peerDetails ? json({ node: 'A', peers: peerDetails }) : json({ message: 'Not found' }, 404));
  if (url === '/api/chain') return Promise.resolve(json({ node: 'A', length: chain.length, chain }));
  if (url === '/api/pending') return Promise.resolve(pendingError ? json({ message: 'Pending unavailable' }, 500) : json({ count: pending.length, pending }));
  if (url === '/api/peers') return Promise.resolve(peersError ? json({ message: 'Peers unavailable' }, peersError) : json({ node: 'A', peers: ['http://localhost:5000', '<img src=x onerror="window.xss=1">'] }));
  assert(url === '/api/mine' && options.method === 'POST', 'Unexpected request');
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (mineError === 'offline') { reject(new TypeError('Failed to fetch')); return; }
      if (mineError) { resolve(json({ message: 'Mine unavailable' }, mineError)); return; }
      const body = JSON.parse(options.body);
      const block = { previous_hash: chain.at(-1).hash, hash: 'b'.repeat(64), timestamp: '2026-10-15T03:04:05+00:00', nonce: 125, transactions: [tx('SYSTEM', body.miner_address, 100), ...pending] };
      chain.push(block); pending = [];
      resolve(json({ message: 'Block mined', block }, 201));
    }, mineDelay);
    options.signal.addEventListener('abort', () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); }, { once: true });
  });
};
const doc = () => frame.contentDocument;
const win = () => frame.contentWindow;
async function until(check, timeout = 2500) {
  const start = Date.now();
  while (!check()) { if (Date.now() - start > timeout) throw new Error('Wait timed out'); await sleep(20); }
}
const ready = () => until(() => doc()?.querySelector('#view')?.getAttribute('aria-busy') === 'false');
async function open(mode = 'mock', page = 'mining', scenario = 'success') {
  frame?.remove(); calls = []; mineDelay = 0; mineError = null; peersError = null; pendingError = false; peerDetails = null;
  chain = [{ previous_hash: '0', hash: 'a'.repeat(64), timestamp: '2026-04-04T04:44:44+00:00', nonce: 0, transactions: [] }];
  pending = [tx('Alice', 'Bob', 2)];
  frame = document.createElement('iframe'); frame.style.cssText = 'width:1200px;height:1000px;border:0';
  frame.src = `/tests/frame.html?mode=${mode}&scenario=${scenario}#${page}`;
  const loaded = new Promise(resolve => { frame.onload = resolve; });
  document.querySelector('#frame-host').replaceChildren(frame); await loaded; await ready();
}
function address(value = ' Miner-A ') {
  const input = doc().querySelector('#miner-address'); input.value = value;
  input.dispatchEvent(new (win().Event)('input', { bubbles: true }));
}
function submit() { doc().querySelector('#mining-form').requestSubmit(); }
async function settled(timeout) { await until(() => doc().querySelector('#mining-form')?.getAttribute('aria-busy') === 'false', timeout); await ready(); }
async function navigate(page) {
  win().location.hash = page;
  await until(() => doc().querySelector(`[data-page="${page}"]`).hasAttribute('aria-current')); await ready();
}

test('MOCK mine chuyển pending vào block, Dashboard và Mempool cập nhật', async () => {
  await open(); address(); submit();
  assert(doc().querySelector('[type="submit"]').disabled && doc().querySelector('#mining-result').textContent.includes('mô phỏng'), 'Loading state');
  await settled(); assert(doc().querySelector('#mining-result').textContent.includes('MOCK: đã tạo block mẫu'), 'Mock success');
  doc().querySelector('#mining-result > button').click(); assert(doc().querySelector('#dialog-body').textContent.includes('Charlie'), 'Block transactions');
  doc().querySelector('#close-dialog').click();
  await navigate('dashboard'); assert([...doc().querySelectorAll('.stat-value')].map(n => n.textContent).join() === 'A,4,3,0', 'Updated dashboard');
  await navigate('mempool'); assert(doc().querySelector('#view').querySelector('.empty-state'), 'Empty mempool');
  assert(calls.length === 0, 'Mock should not fetch');
});
test('Địa chỉ trống bị chặn, giữ địa chỉ qua đổi view', async () => {
  await open(); address(' '); submit(); assert(doc().querySelector('#mining-result [role="alert"]'));
  address('Saved-miner'); await navigate('mempool'); await navigate('mining'); assert(doc().querySelector('#miner-address').value === 'Saved-miner');
});
test('MOCK cho mine pending rỗng và coinbase nằm trong block hiện tại', async () => {
  await open('mock', 'mining', 'empty'); address(); submit(); await settled();
  doc().querySelector('#mining-result > button').click(); assert(doc().querySelector('#dialog-body').textContent.includes('SYSTEM'));
});
test('LIVE đúng payload, chặn mine lặp kể cả chuyển view', async () => {
  await open('real'); mineDelay = 800; address(); submit(); submit();
  await navigate('mempool'); await navigate('mining'); submit(); await settled();
  const posts = calls.filter(c => c.method === 'POST'); assert(posts.length === 1 && posts[0].url === '/api/mine');
  assert(posts[0].body === JSON.stringify({ miner_address: 'Miner-A' }));
  assert(doc().querySelector('#mining-result').textContent.includes('Node hiện tại đã trả về block mới') && chain.length === 2);
});
test('LIVE 404 khóa mine; Làm mới cho thử lại; 500/offline hiện lỗi', async () => {
  await open('real'); mineError = 404; address(); submit(); await settled();
  assert(doc().querySelector('[type="submit"]').disabled && doc().querySelector('#mining-result').textContent.includes('/api/mine'));
  for (const error of [500, 'offline']) {
    mineError = error; doc().querySelector('#refresh').click(); await ready(); submit(); await settled();
    assert(doc().querySelector('#mining-result [role="alert"]') && !doc().querySelector('[type="submit"]').disabled);
  }
  mineError = null; submit(); await settled(); assert(chain.length === 2);
});
test('LIVE timeout không retry, nhắc kiểm tra chain/mempool', async () => {
  await open('real'); mineDelay = 11000; address(); submit(); await settled(12000);
  assert(calls.filter(c => c.method === 'POST').length === 1 && doc().querySelector('#mining-result').textContent.includes('chain và mempool'));
});
test('Đọc pending lỗi sau mine vẫn giữ kết quả block', async () => {
  await open('real'); pendingError = true; address(); submit(); await settled();
  assert(doc().querySelector('#mining-result').textContent.includes('block mới') && doc().querySelector('#load-warning').textContent.includes('Pending unavailable'));
});
test('Network mock A/B/C và kịch bản không có peer', async () => {
  await open('mock', 'network'); assert(doc().querySelectorAll('.peer-card').length === 3 && doc().querySelector('#view').textContent.includes('Online · mẫu'));
  await open('mock', 'network', 'empty'); assert(doc().querySelectorAll('.peer-card').length === 1 && doc().querySelector('#view').textContent.includes('Chưa có peer'));
});
test('Network LIVE unknown, không gọi register/pending, xử lý 404/500', async () => {
  await open('real', 'network');
  assert(calls.map(c => c.url).sort().join() === '/api/chain,/api/peers,/api/peers/details');
  assert(doc().querySelectorAll('.peer-card').length === 3 && doc().querySelector('#view').textContent.includes('Chưa xác định'));
  assert(!doc().querySelector('#view img') && !win().xss);
  peersError = 404; doc().querySelector('#refresh').click(); await ready(); assert(doc().querySelector('#view').textContent.includes('API_PENDING'));
  peersError = 500; doc().querySelector('#refresh').click(); await ready(); assert(doc().querySelector('#load-warning').textContent.includes('Peers unavailable'));
});
test('Mining kết quả và Network ở 390px không tràn ngang trang', async () => {
  await open(); frame.style.width = '390px'; address(); submit(); await settled();
  assert(doc().documentElement.scrollWidth <= doc().documentElement.clientWidth + 1);
  await navigate('network'); assert(doc().documentElement.scrollWidth <= doc().documentElement.clientWidth + 1);
});

test('Network hiển thị danh tính thực, độ trễ và peer không phản hồi', async () => {
  await open('real', 'network');
  peerDetails = [
    { address: 'http://localhost:5000', node: 'C', role: 'bootstrap', status: 'online', latency_ms: 4.2, checked_at: '2026-10-17T01:00:00Z' },
    { address: 'http://localhost:5002', node: null, role: null, status: 'unreachable', latency_ms: null, checked_at: '2026-10-17T01:00:00Z' },
  ];
  doc().querySelector('#refresh').click(); await ready();
  const cards = doc().querySelectorAll('.peer-card');
  assert(cards.length === 3 && cards[1].textContent.includes('Node C') && cards[1].textContent.includes('Bootstrap'));
  assert(cards[1].textContent.includes('4.2 ms') && cards[1].textContent.includes('Kiểm tra lúc'));
  assert(cards[2].textContent.includes('Không thể kết nối') && !cards[2].textContent.includes('Node B'));
  frame.style.width = '390px';
  assert(doc().documentElement.scrollWidth <= doc().documentElement.clientWidth + 1);
});

let failures = 0;
for (const { name, run } of tests) {
  const row = document.createElement('li');
  try { await run(); row.textContent = `PASS: ${name}`; }
  catch (error) { failures++; row.textContent = `FAIL: ${name} — ${error.message}`; }
  document.querySelector('#results').append(row);
}
frame?.remove();
document.querySelector('#summary').textContent = `${tests.length - failures}/${tests.length} PASS; ${failures} FAIL`;
document.documentElement.dataset.testResult = failures ? 'fail' : 'pass';
