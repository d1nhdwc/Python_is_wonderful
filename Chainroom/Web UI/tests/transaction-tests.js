const tests = [];
const test = (name, run) => tests.push({ name, run });
const assert = (ok, message = 'Assertion failed') => { if (!ok) throw new Error(message); };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const json = (data, status = 200) => new Response(JSON.stringify(data), { status });
let frame, pending, posts, postError, postDelay, pendingError;
window.captureCopy = () => Promise.resolve();
window.fixtureFetch = (url, options) => {
  if (url.endsWith('/chain')) return Promise.resolve(json({ node: 'A', length: 1, chain: [{ previous_hash: '0', hash: 'a'.repeat(64), timestamp: '2026-04-04T04:44:44+00:00', transactions: [], nonce: 0 }] }));
  if (url.endsWith('/pending')) return Promise.resolve(pendingError ? json({ message: 'Pending unavailable' }, 500) : json({ count: pending.length, pending }));
  assert(url === '/api/transaction' && options.method === 'POST', 'Unexpected request');
  const payload = JSON.parse(options.body); posts.push(payload);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (postError === 'offline') { reject(new TypeError('Failed to fetch')); return; }
      if (postError) { resolve(json({ message: `Test HTTP ${postError}` }, postError)); return; }
      const transaction = { ...payload, id: String(posts.length).repeat(32), timestamp: '2026-10-15T03:04:05+00:00' };
      pending.push(transaction); resolve(json({ message: 'Transaction added', transaction }, 201));
    }, postDelay);
    options.signal.addEventListener('abort', () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); }, { once: true });
  });
};
const doc = () => frame.contentDocument;
const win = () => frame.contentWindow;
async function until(check, timeout = 2000) {
  const start = Date.now();
  while (!check()) { if (Date.now() - start > timeout) throw new Error('Wait timed out'); await sleep(20); }
}
const ready = () => until(() => doc()?.querySelector('#view')?.getAttribute('aria-busy') === 'false');
async function open(mode = 'real') {
  frame?.remove(); pending = []; posts = []; postError = null; postDelay = 0; pendingError = false;
  frame = document.createElement('iframe'); frame.style.cssText = 'width:1200px;height:1000px;border:0';
  frame.src = `/tests/frame.html?mode=${mode}&scenario=empty#transactions`;
  const loaded = new Promise(resolve => { frame.onload = resolve; });
  document.querySelector('#frame-host').replaceChildren(frame); await loaded; await ready();
}
function fill(sender = ' Alice ', receiver = ' Bob ', amount = '2.5') {
  for (const [id, value] of Object.entries({ sender, receiver, amount })) {
    const input = doc().getElementById(id); input.value = value; input.dispatchEvent(new (win().Event)('input', { bubbles: true }));
  }
}
function submit() { doc().querySelector('#transaction-form').requestSubmit(); }
async function settled(timeout) { await until(() => doc().querySelector('#transaction-form')?.getAttribute('aria-busy') === 'false', timeout); await ready(); }
async function navigate(page) {
  win().location.hash = page;
  await until(() => doc().querySelector(`[data-page="${page}"]`).hasAttribute('aria-current')); await ready();
}

test('Gửi JSON number, trim, hiển thị ID/timestamp và cập nhật mempool', async () => {
  await open(); fill(); submit(); await settled();
  assert(posts.length === 1 && posts[0].amount === 2.5 && posts[0].sender === 'Alice' && posts[0].receiver === 'Bob');
  assert(Object.keys(posts[0]).sort().join() === 'amount,receiver,sender');
  const result = doc().querySelector('#transaction-result').textContent;
  assert(result.includes('1'.repeat(32)) && result.includes('2026-10-15T03:04:05+00:00'));
  assert(result.includes('Đã thêm giao dịch tại node hiện tại') && !result.includes('broadcast'));
  assert(doc().querySelector('#amount').value === '');
  await navigate('mempool'); assert(doc().querySelectorAll('tbody tr').length === 1 && doc().querySelector('#view').textContent.includes('Alice'));
});
test('Luồng MOCK trên giao diện chính: submit rồi mở Mempool', async () => {
  await open('mock'); fill('Alice', 'Bob', '4'); submit(); await settled();
  assert(posts.length === 0 && doc().querySelector('#transaction-result').textContent.includes('MOCK: Đã thêm giao dịch'));
  await navigate('mempool'); assert(doc().querySelectorAll('tbody tr').length === 1 && doc().querySelector('#view').textContent.includes('Alice'));
});
test('Input trống, zero, âm, text, Infinity bị chặn trước HTTP', async () => {
  await open();
  for (const value of ['', '0', '-1', 'abc', '1e309']) {
    fill('Alice', 'Bob', value); submit();
    assert(doc().querySelector('#transaction-result [role="alert"]') && posts.length === 0);
  }
  fill('   ', 'Bob', '1'); submit(); assert(posts.length === 0 && doc().querySelector('#sender').getAttribute('aria-invalid') === 'true');
  fill('Alice', '   ', '1'); submit(); assert(posts.length === 0);
});
test('Khóa gửi lặp kể cả đổi view rồi quay lại khi POST đang chạy', async () => {
  await open(); postDelay = 700; fill(); submit(); submit();
  assert(doc().querySelector('[type="submit"]').disabled && doc().querySelector('#refresh').disabled);
  await navigate('mempool'); await navigate('transactions'); submit();
  assert(posts.length === 1 && doc().querySelector('[type="submit"]').disabled);
  await settled(); assert(posts.length === 1 && pending.length === 1);
});
test('HTTP 400/500 và offline: báo lỗi, giữ input, có thể gửi lại', async () => {
  await open();
  for (const error of [400, 500, 'offline']) {
    postError = error; fill(); submit(); await settled();
    assert(doc().querySelector('#transaction-result [role="alert"]'));
    assert(doc().querySelector('#amount').value === '2.5' && !doc().querySelector('[type="submit"]').disabled && pending.length === 0);
  }
  postError = null; submit(); await settled(); assert(pending.length === 1);
});
test('Timeout POST không tự retry và nhắc kiểm tra mempool', async () => {
  await open(); postDelay = 11000; fill(); submit(); await settled(12000);
  assert(posts.length === 1 && doc().querySelector('#transaction-result').textContent.includes('mempool'));
});
test('POST thành công nhưng đọc pending lỗi vẫn giữ kết quả thành công', async () => {
  await open(); pendingError = true; fill(); submit(); await settled();
  assert(doc().querySelector('#transaction-result').textContent.includes('Đã thêm giao dịch'));
  assert(doc().querySelector('#load-warning').textContent.includes('Pending unavailable') && posts.length === 1);
});
test('Giữ bản nháp khi làm mới/chuyển view; mempool rỗng có thông báo', async () => {
  await open(); fill('Draft', 'Bob', '5'); doc().querySelector('#refresh').click(); await ready();
  assert(doc().querySelector('#sender').value === 'Draft');
  await navigate('mempool'); assert(doc().querySelector('#view').textContent.includes('Chưa có giao dịch chờ xác nhận'));
  await navigate('transactions'); assert(doc().querySelector('#amount').value === '5');
});
test('Text dài/HTML hiển thị an toàn; form 390px không tràn ngang', async () => {
  await open(); frame.style.width = '390px';
  fill('<img src=x onerror="window.xss=1">' + 'A'.repeat(400), 'Bob', '1'); submit(); await settled();
  assert(!doc().querySelector('#transaction-result img') && !win().xss);
  assert(doc().querySelector('#transaction-result').textContent.includes('<img'));
  assert(doc().documentElement.scrollWidth <= doc().documentElement.clientWidth + 1);
  await navigate('mempool'); assert(!doc().querySelector('#view img'));
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
