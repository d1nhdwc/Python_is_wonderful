const tests = [];
const test = (name, run) => tests.push({ name, run });
const assert = (ok, message) => { if (!ok) throw Error(message); };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const errors = [];
window.captureBrowserError = message => errors.push(message);
window.captureCopy = () => Promise.resolve();
window.fixtureFetch = () => { throw Error('MOCK không được gọi API'); };
let frame;
const doc = () => frame.contentDocument;
async function until(predicate) {
  for (let i = 0; i < 150; i++) {
    if (predicate()) return;
    await sleep(20);
  }
  throw Error('Hết thời gian chờ UI');
}
const ready = () => until(() => doc()?.querySelector('#view')?.getAttribute('aria-busy') === 'false');
async function open(page = 'dashboard', width = 1280) {
  frame?.remove();
  frame = document.createElement('iframe');
  frame.style.cssText = `width:${width}px;height:950px;border:0`;
  frame.src = `/tests/frame.html#${page}`;
  const loaded = new Promise(resolve => frame.onload = resolve);
  document.querySelector('#frame-host').replaceChildren(frame);
  await loaded; await ready();
}
async function navigate(page) {
  doc().querySelector(`[data-page="${page}"]`).click();
  await until(() => doc().querySelector(`[data-page="${page}"]`).getAttribute('aria-current') === 'page');
  await ready();
}

for (const width of [320, 390, 768, 1280]) {
  test(`Bảy màn hình ở ${width}px: không tràn ngang trang, form và nút có nhãn`, async () => {
    await open('dashboard', width);
    for (const page of ['dashboard', 'wallet', 'blockchain', 'transactions', 'mempool', 'mining', 'network']) {
      await navigate(page);
      assert(doc().documentElement.scrollWidth <= doc().documentElement.clientWidth + 1, `${page}: tràn ngang ở ${width}px`);
      for (const input of doc().querySelectorAll('#view input')) {
        assert(input.labels.length > 0, `${input.id}: thiếu label`);
      }
      for (const button of doc().querySelectorAll('button')) {
        assert(button.textContent.trim() || button.getAttribute('aria-label'), 'Nút không có nhãn');
      }
    }
    await navigate('blockchain');
    doc().querySelector('.block-link').click();
    const dialog = doc().querySelector('#block-dialog');
    const bounds = dialog.getBoundingClientRect();
    assert(bounds.left >= 0 && bounds.right <= width + 1, 'Modal vượt chiều rộng');
    assert(dialog.scrollWidth <= dialog.clientWidth + 1, 'Nội dung modal tràn ngang');
    doc().querySelector('#close-dialog').click();
  });
}
test('Trang số dư tính và hiển thị tiền khả dụng theo địa chỉ', async () => {
  await open('wallet');
  const address = doc().querySelector('#balance-address');
  address.value = ' Bob ';
  address.dispatchEvent(new frame.contentWindow.Event('input', { bubbles: true }));
  doc().querySelector('#balance-form').requestSubmit();
  await until(() => doc().querySelector('#balance-form').getAttribute('aria-busy') === 'false');
  const values = [...doc().querySelectorAll('.balance-summary .stat-value')].map(item => item.textContent);
  assert(values.join('|') === '7.5|7.5|0|6', 'Sai số dư Bob trong dữ liệu mock');
});
test('Skip link giữ màn hình và bản nháp, đưa focus đến nội dung', async () => {
  await open('transactions');
  const sender = doc().querySelector('#sender');
  sender.value = 'Draft-Alice';
  sender.dispatchEvent(new frame.contentWindow.Event('input', { bubbles: true }));
  const skip = doc().querySelector('.skip-link'); skip.focus();
  assert(skip.getBoundingClientRect().top >= 0, 'Skip link bị ẩn khi focus');
  skip.click(); await sleep(400);
  assert(frame.contentWindow.location.hash === '#transactions', 'Skip link đổi route');
  assert(doc().querySelector('#sender')?.value === 'Draft-Alice', 'Mất form đang nhập');
  assert(doc().activeElement === doc().querySelector('#main'), 'Focus chưa đến main');
});
test('Điều hướng đưa focus đến main; dialog cancel trả focus về nút mở', async () => {
  await open(); await navigate('blockchain');
  assert(doc().activeElement === doc().querySelector('#main'), 'Focus sau đổi view');
  const trigger = doc().querySelector('.block-link'); trigger.focus(); trigger.click();
  const dialog = doc().querySelector('#block-dialog');
  assert(dialog.contains(doc().activeElement), 'Focus không nằm trong modal');
  dialog.dispatchEvent(new frame.contentWindow.Event('cancel', { cancelable: true }));
  assert(!dialog.open && doc().activeElement === trigger, 'Cancel không trả focus');
  assert(frame.contentWindow.getComputedStyle(trigger).outlineStyle !== 'none', 'Thiếu dấu focus');
});
test('Bảng dài cuộn riêng, focus được và giữ đầy đủ hash', async () => {
  await open('blockchain', 320);
  const table = doc().querySelector('.table-scroll');
  table.focus();
  assert(doc().activeElement === table && table.getAttribute('aria-label'), 'Bảng chưa truy cập được bằng focus');
  assert(table.scrollWidth > table.clientWidth, 'Bảng phải cuộn ngang trong vùng riêng');
  const hash = doc().querySelector('.hash-cell code').title;
  doc().querySelector('.block-link').click();
  assert(doc().querySelector('.full-hash code').textContent === hash, 'Modal làm mất hash');
});
test('Module JavaScript tải/chạy không có error, unhandled rejection hoặc console.error', async () => {
  await sleep(100);
  assert(errors.length === 0, errors.join('\n'));
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
