const tests = [];
const test = (name, run) => tests.push({ name, run });
const assert = (value, message = 'Assertion failed') => { if (!value) throw new Error(message); };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const json = (data, status = 200) => new Response(JSON.stringify(data), { status });
const transaction = { id: '1'.repeat(32), sender: 'Alice', receiver: 'Bob', amount: 3, timestamp: '2026-10-15T02:00:00+00:00' };
function chain(length = 6) {
  return { node: 'B', length, chain: Array.from({ length }, (_, i) => ({
    previous_hash: i ? String(i).repeat(64) : '0', hash: String(i + 1).repeat(64), nonce: i * 10,
    timestamp: '2026-10-15T02:00:00+00:00', transactions: i ? [structuredClone(transaction)] : [],
  })) };
}
let frame;
let source;
let requests;
let copied;
let chainError;
let pendingError;
let slow;
let aborted;
window.fixtureFetch = (url, options) => {
  requests.push(url);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (url.endsWith('/api/chain')) resolve(chainError ? json({ message: 'Test chain error' }, 500) : json(source));
      else if (url.endsWith('/api/pending')) resolve(pendingError ? json({ message: 'Test pending error' }, 500) : json({ count: 1, pending: [transaction] }));
      else reject(new Error(`Unexpected endpoint: ${url}`));
    }, slow);
    options.signal.addEventListener('abort', () => { clearTimeout(timer); aborted++; reject(new DOMException('Aborted', 'AbortError')); }, { once: true });
  });
};
window.captureCopy = value => { copied = value; return Promise.resolve(); };
async function until(check, timeout = 1500) {
  const start = Date.now();
  while (!check()) { if (Date.now() - start > timeout) throw new Error('Wait timed out'); await sleep(20); }
}
const doc = () => frame.contentDocument;
const win = () => frame.contentWindow;
const ready = () => until(() => doc()?.querySelector('#view')?.getAttribute('aria-busy') === 'false');
async function open(page, length = 6) {
  frame?.remove();
  source = chain(length); requests = []; copied = null; chainError = false; pendingError = false; slow = 0; aborted = 0;
  frame = document.createElement('iframe');
  frame.style.cssText = 'width:1440px;height:1100px;border:0';
  frame.src = `/tests/frame.html?mode=real#${page}`;
  const loaded = new Promise(resolve => { frame.onload = resolve; });
  document.querySelector('#frame-host').replaceChildren(frame);
  await loaded; await ready();
}
async function refresh() { doc().querySelector('#refresh').click(); await ready(); }
async function navigate(page) {
  win().location.hash = page;
  await until(() => doc().querySelector(`[data-page="${page}"]`).getAttribute('aria-current') === 'page');
  await ready();
}
function polling(value) {
  const select = doc().querySelector('#refresh-interval');
  select.value = String(value); select.dispatchEvent(new (win().Event)('change'));
}

test('Dashboard: node/count/height/pending và tất cả trường latest block', async () => {
  await open('dashboard');
  assert([...doc().querySelectorAll('.stat-value')].map(item => item.textContent).join() === 'B,6,5,1');
  const text = doc().querySelector('.feature-block').textContent;
  for (const label of ['Block #5', 'Hash', 'Previous hash', 'Nonce', '50', 'Giao dịch', 'Thời gian (VN)']) assert(text.includes(label), label);
  assert(doc().querySelectorAll('.block-link').length === 4, 'Recent list must show 4');
});
test('Explorer chỉ gọi chain; index từ vị trí và thứ tự mới nhất trước', async () => {
  await open('blockchain');
  assert(requests.length === 1 && requests[0] === '/api/chain');
  assert([...doc().querySelectorAll('.block-link')].map(item => item.textContent).join() === '#5,#4,#3,#2,#1,#0 · Genesis');
});
test('Click chi tiết block, copy đủ hash, đóng modal trả focus', async () => {
  await open('blockchain');
  const trigger = doc().querySelector('.block-link'); trigger.focus(); trigger.click();
  assert(doc().querySelector('#block-dialog').open);
  assert(doc().querySelector('#dialog-body').textContent.includes('Alice'));
  assert(doc().querySelector('.full-hash code').textContent === source.chain[5].hash);
  doc().querySelector('.full-hash button').click(); await sleep(0);
  assert(copied === source.chain[5].hash);
  assert(doc().querySelector('#toast').textContent === 'Đã sao chép.');
  doc().querySelector('#close-dialog').click();
  assert(!doc().querySelector('#block-dialog').open && doc().activeElement === trigger);
});
test('Genesis: height 0 và modal không có giao dịch', async () => {
  await open('dashboard', 1);
  assert(doc().querySelectorAll('.stat-value')[2].textContent === '0');
  doc().querySelector('.feature-block .primary').click();
  assert(doc().querySelector('#dialog-title').textContent.includes('Genesis'));
  assert(doc().querySelector('#dialog-body').textContent.includes('Chưa có giao dịch'));
});
test('Chain rỗng không crash hoặc tự tạo block', async () => {
  await open('dashboard', 0);
  assert(doc().querySelector('#load-warning').textContent.includes('chưa có genesis'));
  assert(doc().querySelectorAll('.stat-value')[1].textContent === '0');
  assert(!doc().querySelector('.block-link'));
});
test('Pending lỗi không chặn chain; số lượng chưa biết là —', async () => {
  await open('dashboard'); pendingError = true; await refresh();
  assert(doc().querySelectorAll('.stat-value')[3].textContent === '—');
  assert(doc().querySelector('.feature-block').textContent.includes('Block #5'));
  assert(doc().querySelector('#load-warning').textContent.includes('Chưa đọc được mempool'));
});
test('Refresh lỗi giữ dữ liệu cũ có nhãn, phục hồi khi API hoạt động', async () => {
  await open('blockchain'); chainError = true; await refresh();
  assert(doc().querySelectorAll('.block-link').length === 6);
  assert(doc().querySelector('#load-warning').textContent.includes('dữ liệu cũ'));
  chainError = false; source = chain(2); await refresh();
  assert(doc().querySelectorAll('.block-link').length === 2);
  assert(doc().querySelector('#load-warning').hidden);
});
test('Schema chain sai bị báo lỗi, không dựng dữ liệu giả', async () => {
  await open('transactions'); source = { node: 'B', length: 5, chain: [] }; await navigate('blockchain');
  assert(doc().querySelector('[role="alert"]').textContent.includes('length không khớp chain'));
  assert(!doc().querySelector('.block-link'));
});
test('Loading, double refresh và hủy request khi đổi màn hình', async () => {
  await open('blockchain'); slow = 500;
  doc().querySelector('#refresh').click();
  assert(doc().querySelector('#refresh').disabled);
  doc().querySelector('#refresh').click();
  slow = 0; await navigate('dashboard');
  assert(aborted > 0 && doc().querySelector('#page-title').textContent === 'Dashboard');
  await sleep(550);
  assert(doc().querySelector('#page-title').textContent === 'Dashboard');
});
test('Timeout chain hiển thị lỗi có thể thử lại rồi phục hồi', async () => {
  await open('transactions'); slow = 11000;
  win().location.hash = 'blockchain';
  await until(() => doc().querySelector('[role="alert"]'), 12000);
  assert(doc().querySelector('[role="alert"]').textContent.includes('Hết thời gian chờ'));
  slow = 0; doc().querySelector('[role="alert"] button').click(); await ready();
  assert(doc().querySelectorAll('.block-link').length === 6);
});
test('Block nhiều giao dịch và chuỗi HTML được render an toàn', async () => {
  await open('blockchain');
  source.chain[5].transactions = Array.from({ length: 20 }, (_, i) => ({ ...transaction, id: `tx-${i}`, sender: '<img src=x onerror="window.xss=1">' }));
  await refresh(); doc().querySelector('.block-link').click();
  assert(doc().querySelectorAll('#dialog-body tbody tr').length === 20);
  assert(doc().querySelector('#dialog-body').textContent.includes('<img src=x'));
  assert(!doc().querySelector('#dialog-body img') && !win().xss);
});
test('Auto refresh lấy dữ liệu mới và dừng khi chuyển Transactions', async () => {
  await open('blockchain'); source = chain(2); polling(5000);
  await sleep(5200); await ready();
  assert(doc().querySelectorAll('.block-link').length === 2);
  await navigate('transactions'); const count = requests.length;
  await sleep(5200);
  assert(requests.length === count && doc().querySelector('#refresh-controls').hidden);
});
test('Auto refresh tạm dừng khi modal mở và khi focus trong bảng', async () => {
  await open('blockchain'); polling(5000);
  const trigger = doc().querySelector('.block-link'); trigger.focus(); trigger.click();
  const count = requests.length;
  await sleep(5200); assert(requests.length === count, 'Polling continued while modal open');
  doc().querySelector('#close-dialog').click();
  await sleep(5200); assert(requests.length === count, 'Polling continued while focus in table');
  doc().querySelector('#refresh-interval').focus();
  await sleep(5200); await ready(); assert(requests.length > count, `Polling did not resume: ${doc().querySelector('#refresh-note').textContent}; active=${doc().activeElement.id}`);
  polling(0);
});
test('Mobile 390px: Dashboard và modal không tràn ngang trang', async () => {
  await open('dashboard'); frame.style.width = '390px'; await sleep(50);
  assert(doc().documentElement.scrollWidth <= doc().documentElement.clientWidth + 1, 'Dashboard overflow');
  doc().querySelector('.feature-block .primary').click(); await sleep(50);
  const bounds = doc().querySelector('#block-dialog').getBoundingClientRect();
  assert(bounds.width <= 390 && bounds.left >= 0, 'Dialog overflow');
  assert(doc().documentElement.scrollWidth <= doc().documentElement.clientWidth + 1, 'Page overflow with dialog');
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
