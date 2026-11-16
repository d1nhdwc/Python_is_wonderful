import { api } from './api.js';
import { config } from './config.js';
import { normalizeChain, normalizePending } from './normalize.js';

const isMock = config.MODE === 'mock';
const modeLabel = isMock ? 'MOCK' : 'LIVE';
const dataLabel = isMock ? 'Dữ liệu mẫu' : 'Dữ liệu từ API node';

const pages = {
  dashboard: ['Dashboard', 'GIÁM SÁT BLOCKCHAIN', 'Theo dõi trạng thái node, hoạt động giao dịch và thông tin chuỗi khối.'],
  wallet: ['Số dư', 'TIỀN KHẢ DỤNG', 'Tra cứu số dư đã xác nhận và số tiền đang chờ theo địa chỉ.'],
  blockchain: ['Blockchain', 'KHÁM PHÁ CHUỖI', 'Theo dõi từng block và những giao dịch bên trong.'],
  transactions: ['Transactions', 'TẠO GIAO DỊCH', 'Bắt đầu một giao dịch tại node hiện tại.'],
  mempool: ['Mempool', 'GIAO DỊCH ĐANG CHỜ', 'Những giao dịch chờ được đưa vào block tiếp theo.'],
  mining: ['Mining', 'TẠO BLOCK MỚI', 'Chuẩn bị giao dịch và khám phá quy trình đào block.'],
  network: ['Network', 'CÁC NODE TRONG MẠNG', 'Góc nhìn từ node hiện tại tới các peer.'],
};
const view = document.querySelector('#view');
let snapshot;
let requestId = 0;
let toastTimer;
let activeRequest;
let renderedPage = null;
let refreshTimer;
const transactionDraft = { sender: '', receiver: '', amount: '' };
const transactionState = { busy: false, result: null, error: '' };
const balanceState = { address: '', busy: false, result: null, error: '' };
const miningState = { address: '', busy: false, result: null, error: '', unsupported: false };
let refreshInterval = Number.isFinite(config.REFRESH_INTERVAL_MS) && config.REFRESH_INTERVAL_MS > 0
  ? Math.max(1000, config.REFRESH_INTERVAL_MS) : 0;

function el(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}
function button(label, action, className = 'button secondary') {
  const result = el('button', className, label);
  result.type = 'button';
  result.addEventListener('click', action);
  return result;
}
function link(label, page, className = 'text-link') {
  const result = el('a', className, label);
  result.href = `#${page}`;
  return result;
}
function badge(text, kind = '') { return el('span', `badge ${kind}`, text); }
function formatDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Không rõ thời gian' : new Intl.DateTimeFormat('vi-VN', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Asia/Ho_Chi_Minh' }).format(date);
}
function toast(message) {
  const target = document.querySelector('#toast');
  clearTimeout(toastTimer);
  target.textContent = message;
  target.hidden = false;
  toastTimer = setTimeout(() => { target.hidden = true; }, 3500);
}
function hashView(value) {
  const row = el('span', 'hash-cell');
  const text = el('code', '', value.length > 22 ? `${value.slice(0, 10)}…${value.slice(-8)}` : value);
  text.title = value;
  const copy = button('⧉', async () => {
    try { await navigator.clipboard.writeText(value); toast('Đã sao chép.'); }
    catch { toast('Không thể truy cập clipboard. Mở chi tiết để chọn và sao chép thủ công.'); }
  }, 'icon-button');
  copy.setAttribute('aria-label', `Sao chép ${value}`);
  row.append(text, copy);
  return row;
}
function panel(title, subtitle) {
  const card = el('section', 'panel');
  const header = el('div', 'panel-header');
  const group = el('div');
  group.append(el('h2', '', title));
  if (subtitle) group.append(el('p', 'muted small', subtitle));
  header.append(group);
  card.append(header);
  return card;
}
function empty(message) { return el('div', 'empty-state', message); }
function table(headers, rows) {
  const wrapper = el('div', 'table-scroll');
  const result = el('table');
  const head = el('thead');
  const headRow = el('tr');
  headers.forEach(label => { const th = el('th', '', label); th.scope = 'col'; headRow.append(th); });
  head.append(headRow);
  const body = el('tbody');
  rows.forEach(cells => {
    const row = el('tr');
    cells.forEach(content => { const cell = el('td'); cell.append(content instanceof Node ? content : document.createTextNode(String(content))); row.append(cell); });
    body.append(row);
  });
  result.append(head, body);
  wrapper.append(result);
  wrapper.tabIndex = 0;
  wrapper.setAttribute('role', 'region');
  wrapper.setAttribute('aria-label', 'Bảng dữ liệu, có thể cuộn ngang');
  return wrapper;
}
function txTable(transactions) {
  if (!transactions.length) return empty('Chưa có giao dịch trong danh sách này.');
  const result = table(['TRANSACTION ID', 'NGƯỜI GỬI', 'NGƯỜI NHẬN', 'SỐ LƯỢNG', 'THỜI GIAN (VN)'], transactions.map(tx => [hashView(tx.id), tx.sender, tx.receiver, tx.amount, formatDate(tx.timestamp)]));
  result.classList.add('transaction-table');
  return result;
}
function blockTable(chain, recent = false) {
  if (!chain.length) return empty('Chưa có block để hiển thị.');
  const rows = chain.map((block, index) => ({ block, index })).reverse();
  return table(['BLOCK', 'HASH', 'PREVIOUS HASH', 'THỜI GIAN (VN)', 'TX'], (recent ? rows.slice(0, 4) : rows).map(({ block, index }) => [
    button(index === 0 ? '#0 · Genesis' : `#${index}`, () => showBlock(block, index), 'block-link'),
    hashView(block.hash), hashView(block.previous_hash), formatDate(block.timestamp), badge(String(block.transactions.length)),
  ]));
}
function fields(items) {
  const list = el('dl', 'field-list');
  items.forEach(([name, value]) => {
    const row = el('div');
    const description = el('dd');
    description.append(value instanceof Node ? value : document.createTextNode(String(value)));
    row.append(el('dt', '', name), description); list.append(row);
  });
  return list;
}
function fullHash(value) {
  const group = el('div', 'full-hash');
  group.append(el('code', '', value), hashView(value).lastChild);
  return group;
}
function showBlock(block, index) {
  document.querySelector('#dialog-title').textContent = index >= 0 ? `Block #${index}${index === 0 ? ' · Genesis' : ''}` : 'Block vừa tạo';
  const body = document.querySelector('#dialog-body');
  body.replaceChildren(badge(modeLabel, isMock ? 'mock' : 'live'), fields([
    ['Hash', fullHash(block.hash)], ['Previous hash', fullHash(block.previous_hash)], ['Timestamp (gốc)', block.timestamp], ['Thời gian (VN)', formatDate(block.timestamp)], ['Nonce', block.nonce], ['Giao dịch', block.transactions.length],
  ]), el('h3', 'transactions-heading', 'Giao dịch trong block'), txTable(block.transactions));
  document.querySelector('#block-dialog').showModal();
  scheduleRefresh();
}
function dashboard() {
  const { chain, pending } = snapshot;
  const stats = el('div', 'stats');
  [['NODE HIỆN TẠI', snapshot.node, dataLabel], ['TỔNG SỐ BLOCK', chain.length, 'Bao gồm genesis block'], ['CHAIN HEIGHT', snapshot.height, chain.length ? 'Vị trí block mới nhất' : 'Chưa có block'], ['GIAO DỊCH CHỜ', pending?.length ?? '—', snapshot.pendingError ? 'Chưa đọc được mempool' : 'Trong mempool của node']].forEach(([label, value, note]) => {
    const card = el('section', 'stat-card');
    card.append(el('span', 'eyebrow', label), el('strong', 'stat-value', String(value)), el('span', 'muted small', note));
    stats.append(card);
  });
  const split = el('div', 'dashboard-split');
  const latest = chain.at(-1);
  const feature = el('section', 'feature-block');
  feature.append(el('div', 'eyebrow', 'BLOCK MỚI NHẤT'), el('div', 'block-art', '⬡'));
  if (latest) {
    feature.append(el('h2', '', `Block #${chain.length - 1}${chain.length === 1 ? ' · Genesis' : ''}`));
    const details = fields([
      ['Hash', hashView(latest.hash)], ['Previous hash', hashView(latest.previous_hash)],
      ['Thời gian (VN)', formatDate(latest.timestamp)], ['Nonce', latest.nonce], ['Giao dịch', latest.transactions.length],
    ]);
    details.classList.add('latest-fields'); feature.append(details);
    feature.append(button('Khám phá block ↗', () => showBlock(latest, chain.length - 1), 'button primary'));
  } else feature.append(empty('Chưa có block.'));
  const guide = panel('Từ giao dịch đến block', 'Ba bước trong một blockchain PoW');
  [['01', 'Tạo giao dịch', 'Giao dịch được kiểm tra tại node.'], ['02', 'Chờ trong mempool', 'Các giao dịch sẵn sàng cho lần mine tiếp theo.'], ['03', 'Thêm block vào chain', 'Node mine block và cập nhật chain local.']].forEach(([number, title, description]) => {
    const row = el('div', 'flow-step');
    const group = el('div'); group.append(el('strong', '', title), el('p', 'muted small', description));
    row.append(el('span', 'step-number', number), group); guide.append(row);
  });
  split.append(feature, guide);
  const recent = panel('Block gần đây', `${dataLabel} · bấm số block để xem chi tiết`);
  recent.firstChild.append(link('Xem tất cả ↗', 'blockchain'));
  recent.append(blockTable(chain, true));
  view.append(stats, split, recent);
}
function blockchain() {
  const card = panel('Chuỗi block', `${snapshot.chain.length} block · index hiển thị theo vị trí trong chain`);
  card.firstChild.append(badge(modeLabel, isMock ? 'mock' : 'live'));
  card.append(blockTable(snapshot.chain));
  view.append(card);
  if (isMock) view.append(el('p', 'muted small', 'Hash MOCK chỉ là chuỗi minh họa, không phải kết quả PoW.'));
}
function wallet() {
  if (!balanceState.address) balanceState.address = snapshot.node;
  const layout = el('div', 'balance-layout');
  const lookup = panel('Tra cứu địa chỉ', 'Nhập địa chỉ ví hoặc địa chỉ miner cần kiểm tra.');
  const form = el('form', 'transaction-form balance-form');
  form.id = 'balance-form';
  form.noValidate = true;
  form.append(inputField('Địa chỉ', 'balance-address', 'Ví dụ: Miner-A'));
  const address = form.elements['balance-address'];
  address.required = true;
  address.value = balanceState.address;
  address.addEventListener('input', () => {
    balanceState.address = address.value;
    address.removeAttribute('aria-invalid');
  });
  const submit = el('button', 'button primary', 'Xem tiền khả dụng');
  submit.type = 'submit';
  form.append(el('p', 'notice', 'Tiền khả dụng = số dư đã xác nhận − tổng tiền đang chờ gửi.'), submit);
  lookup.append(form);

  const resultPanel = panel('Số dư của địa chỉ', 'Tiền đang chờ nhận chỉ được cộng sau khi block xác nhận.');
  const result = el('div', 'balance-result');
  result.id = 'balance-result';
  result.setAttribute('aria-live', 'polite');
  resultPanel.append(result);
  layout.append(lookup, resultPanel);
  view.append(layout);

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (balanceState.busy) return;
    const value = address.value.trim();
    if (!value) {
      balanceState.error = 'Vui lòng nhập địa chỉ cần kiểm tra.';
      address.setAttribute('aria-invalid', 'true');
      address.focus();
      updateBalanceForm();
      return;
    }
    balanceState.address = value;
    balanceState.busy = true;
    balanceState.error = '';
    balanceState.result = null;
    updateBalanceForm();
    try {
      balanceState.result = await api.getBalance(value);
    } catch (error) {
      balanceState.error = error.message || 'Không đọc được số dư.';
    } finally {
      balanceState.busy = false;
      updateBalanceForm();
    }
  });
  updateBalanceForm();
}
function updateBalanceForm() {
  const form = document.querySelector('#balance-form');
  const result = document.querySelector('#balance-result');
  if (!form || !result) return;
  form.setAttribute('aria-busy', String(balanceState.busy));
  const address = form.elements['balance-address'];
  address.disabled = balanceState.busy;
  address.value = balanceState.address;
  const submit = form.querySelector('[type="submit"]');
  submit.disabled = balanceState.busy;
  submit.textContent = balanceState.busy ? 'Đang đọc số dư…' : 'Xem tiền khả dụng';
  document.querySelector('#refresh').disabled = balanceState.busy || view.getAttribute('aria-busy') === 'true';
  result.replaceChildren();
  if (balanceState.busy) {
    result.append(el('p', 'notice', 'Đang đọc dữ liệu từ node…'));
  } else if (balanceState.error) {
    const error = el('p', 'notice error-notice', balanceState.error);
    error.setAttribute('role', 'alert');
    result.append(error);
  } else if (balanceState.result) {
    const data = balanceState.result;
    const summary = el('div', 'balance-summary');
    [
      ['TIỀN KHẢ DỤNG', data.availableBalance, 'Có thể dùng sau khi trừ giao dịch chờ gửi'],
      ['ĐÃ XÁC NHẬN', data.confirmedBalance, 'Được tính từ các block trong chain'],
      ['ĐANG CHỜ GỬI', data.pendingOutgoing, 'Đã nằm trong mempool'],
      ['ĐANG CHỜ NHẬN', data.pendingIncoming, 'Chưa được cộng vào tiền khả dụng'],
    ].forEach(([label, value, note]) => {
      const card = el('section', 'stat-card');
      card.append(el('span', 'eyebrow', label), el('strong', 'stat-value', String(value)), el('span', 'muted small', note));
      summary.append(card);
    });
    result.append(summary, fields([['Địa chỉ', data.address]]));
  } else {
    result.append(el('p', 'muted balance-placeholder', 'Nhập địa chỉ để xem số dư.'));
  }
}
function inputField(label, name, placeholder, type = 'text') {
  const wrapper = el('div', 'form-field');
  const caption = el('label', '', label); caption.htmlFor = name;
  const input = el('input'); input.id = name; input.name = name; input.type = type; input.placeholder = placeholder;
  if (type === 'number') { input.min = '0'; input.step = 'any'; }
  wrapper.append(caption, input);
  return wrapper;
}
function transactions() {
  const layout = el('div', 'form-layout');
  const card = panel('Tạo giao dịch', 'Nhập người gửi, người nhận và số lượng.');
  const form = el('form', 'transaction-form');
  form.id = 'transaction-form';
  form.noValidate = true;
  form.append(inputField('Địa chỉ người gửi', 'sender', 'Ví dụ: Alice'), inputField('Địa chỉ người nhận', 'receiver', 'Ví dụ: Bob'), inputField('Số lượng', 'amount', '0.00', 'number'));
  for (const input of form.querySelectorAll('input')) {
    input.required = true;
    input.value = transactionDraft[input.name];
    input.addEventListener('input', () => {
      transactionDraft[input.name] = input.value;
      input.removeAttribute('aria-invalid');
    });
  }
  const submit = el('button', 'button primary', 'Gửi giao dịch ↗');
  submit.type = 'submit';
  const note = el('p', 'notice', isMock
    ? 'MOCK: giao dịch chỉ được thêm vào dữ liệu mẫu của trang này.'
    : 'Gửi giao dịch đến node hiện tại. Số lượng phải lớn hơn 0.');
  form.append(note, submit); card.append(form);
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (transactionState.busy) return;
    const sender = form.elements.sender;
    const receiver = form.elements.receiver;
    const amount = form.elements.amount;
    const invalid = !sender.value.trim() ? sender : !receiver.value.trim() ? receiver
      : !Number.isFinite(amount.valueAsNumber) || amount.valueAsNumber <= 0 ? amount : null;
    if (invalid) {
      transactionState.error = invalid === amount ? 'Số lượng phải là số hữu hạn lớn hơn 0.' : 'Vui lòng nhập người gửi và người nhận.';
      invalid.setAttribute('aria-invalid', 'true'); invalid.focus();
      updateTransactionForm(); return;
    }
    const payload = { sender: sender.value.trim(), receiver: receiver.value.trim(), amount: amount.valueAsNumber };
    transactionState.busy = true; transactionState.error = ''; transactionState.result = null;
    updateTransactionForm();
    try {
      // POST không gắn signal của việc đổi view: đổi màn hình không hủy giao dịch.
      const result = await api.submitTransaction(payload);
      transactionState.result = result.transaction;
      Object.assign(transactionDraft, { sender: payload.sender, receiver: payload.receiver, amount: '' });
    } catch (error) {
      transactionState.error = error.message || 'Không gửi được giao dịch.';
    } finally {
      transactionState.busy = false;
      updateTransactionForm();
    }
    if (transactionState.result && ['transactions', 'mempool', 'dashboard', 'mining'].includes(currentPage())) await render();
  });
  const info = panel('Kết quả giao dịch', 'Thông tin phản hồi từ node hiện tại');
  const result = el('div', 'transaction-result'); result.id = 'transaction-result';
  result.setAttribute('aria-live', 'polite');
  info.append(result, link('Xem giao dịch đang chờ →', 'mempool', 'button secondary mempool-link'));
  info.append(el('p', 'body-copy muted', snapshot.pendingError ? 'Chưa đọc được mempool.' : `Mempool hiện có ${snapshot.pending.length} giao dịch chờ.`));
  layout.append(card, info); view.append(layout);
  updateTransactionForm();
}
function updateTransactionForm() {
  const form = document.querySelector('#transaction-form');
  const result = document.querySelector('#transaction-result');
  if (!form || !result) return;
  form.setAttribute('aria-busy', String(transactionState.busy));
  for (const input of form.querySelectorAll('input')) {
    input.disabled = transactionState.busy;
    input.value = transactionDraft[input.name];
  }
  const submit = form.querySelector('[type="submit"]');
  submit.disabled = transactionState.busy;
  submit.textContent = transactionState.busy ? 'Đang gửi…' : 'Gửi giao dịch ↗';
  document.querySelector('#refresh').disabled = transactionState.busy || view.getAttribute('aria-busy') === 'true';
  result.replaceChildren();
  if (transactionState.busy) result.append(el('p', 'notice', 'Đang gửi giao dịch, vui lòng chờ…'));
  else if (transactionState.error) {
    const error = el('p', 'notice error-notice', transactionState.error);
    error.setAttribute('role', 'alert'); result.append(error);
  } else if (transactionState.result) {
    const tx = transactionState.result;
    result.append(el('p', 'notice success-notice', `${isMock ? 'MOCK: ' : ''}Đã thêm giao dịch tại node hiện tại.`), fields([
      ['Transaction ID', fullHash(tx.id)], ['Timestamp', tx.timestamp], ['Người gửi', tx.sender], ['Người nhận', tx.receiver], ['Số lượng', tx.amount],
    ]));
  } else result.append(el('p', 'muted', 'Chưa gửi giao dịch. Kết quả sẽ xuất hiện ở đây.'));
}
function mempool() {
  const card = panel('Giao dịch đang chờ', `Mempool riêng của Node ${snapshot.node} · ${dataLabel}`);
  card.firstChild.append(badge(`${snapshot.pending.length} pending`, isMock ? 'mock' : 'live'));
  card.append(snapshot.pending.length ? txTable(snapshot.pending) : empty('Chưa có giao dịch chờ xác nhận'));
  view.append(card);
}
function mining() {
  const layout = el('div', 'form-layout');
  const card = panel('Mine một block', isMock ? 'MOCK · Mô phỏng tạo block' : `Tạo block tại Node ${snapshot.node}`);
  const form = el('form', 'transaction-form');
  form.id = 'mining-form'; form.noValidate = true;
  form.append(inputField('Địa chỉ nhận thưởng', 'miner-address', 'Địa chỉ của node hiện tại'), fields([['Giao dịch chờ', snapshot.pending?.length ?? '—']]));
  const input = form.querySelector('input');
  const ownerAddress = snapshot.node;
  miningState.address = ownerAddress;
  input.required = true; input.readOnly = true; input.value = ownerAddress;
  input.title = 'Phần thưởng mining được nhận bởi node hiện tại';
  const mine = el('button', 'button primary'); mine.type = 'submit';
  form.append(el('p', 'notice', isMock
    ? 'MOCK: chỉ chuyển giao dịch chờ vào block mẫu, không thực hiện PoW.'
    : 'Phần thưởng được gửi về node hiện tại. Hãy chờ phản hồi trước khi mine tiếp.'), mine);
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (miningState.busy || miningState.unsupported) return;
    if (!ownerAddress) {
      miningState.error = 'Chưa xác định được địa chỉ của node.';
      input.setAttribute('aria-invalid', 'true'); input.focus(); updateMiningForm(); return;
    }
    miningState.address = ownerAddress;
    miningState.busy = true; miningState.error = ''; miningState.result = null;
    updateMiningForm();
    try {
      const result = await api.mine(miningState.address);
      miningState.result = result.block;
      balanceState.address = miningState.address;
    } catch (error) {
      miningState.error = error.message || 'Không tạo được block.';
      miningState.unsupported = error.code === 'API_PENDING';
    } finally {
      miningState.busy = false; updateMiningForm();
    }
    if (miningState.result && ['mining', 'dashboard', 'blockchain', 'mempool'].includes(currentPage())) await render();
  });
  card.append(form);
  const info = panel('Kết quả mining', 'Block trả về từ thao tác vừa thực hiện');
  const result = el('div', 'transaction-result'); result.id = 'mining-result'; result.setAttribute('aria-live', 'polite');
  info.append(result, el('p', 'body-copy muted', 'Coinbase được xác nhận ngay trong block vừa đào và có thể tra cứu tại trang Số dư.'));
  layout.append(card, info); view.append(layout);
  updateMiningForm();
}
function updateMiningForm() {
  const form = document.querySelector('#mining-form');
  const result = document.querySelector('#mining-result');
  if (!form || !result) return;
  form.setAttribute('aria-busy', String(miningState.busy));
  form.querySelector('input').disabled = miningState.busy || miningState.unsupported;
  const submit = form.querySelector('[type="submit"]');
  submit.disabled = miningState.busy || miningState.unsupported;
  submit.textContent = miningState.busy ? (isMock ? 'Đang mô phỏng…' : 'Đang chờ node…') : (isMock ? '◇ Mô phỏng mine' : '◇ Bắt đầu mine');
  document.querySelector('#refresh').disabled = miningState.busy || view.getAttribute('aria-busy') === 'true';
  result.replaceChildren();
  if (miningState.busy) result.append(el('p', 'notice', isMock ? 'Đang mô phỏng tạo block…' : 'Đã gửi yêu cầu. Đang chờ node trả kết quả mining…'));
  else if (miningState.error) {
    const error = el('p', 'notice error-notice', miningState.error);
    error.setAttribute('role', 'alert'); result.append(error);
    if (miningState.unsupported) result.append(el('p', 'muted small', 'Sau khi đổi backend, bấm Làm mới để thử lại.'));
  } else if (miningState.result) {
    const block = miningState.result;
    result.append(el('p', 'notice success-notice', isMock ? 'MOCK: đã tạo block mẫu, không thực hiện PoW.' : 'Node hiện tại đã trả về block mới.'), fields([
      ['Hash', fullHash(block.hash)], ['Timestamp', block.timestamp], ['Nonce', block.nonce], ['Số giao dịch', block.transactions.length],
    ]), button('Xem chi tiết block', () => showBlock(block, snapshot?.chain.findIndex(item => item.hash === block.hash) ?? -1)), link('Xem số dư →', 'wallet', 'button secondary'), link('Mở Blockchain →', 'blockchain', 'button secondary'));
  } else result.append(el('p', 'muted', 'Chưa tạo block. Kết quả sẽ xuất hiện ở đây.'));
}
function network() {
  if (snapshot.peerMessage) {
    view.append(el('div', 'notice', snapshot.peerMessage), fields([['Node hiện tại', snapshot.node], ['Trạng thái các peer', 'Chưa biết']]));
    return;
  }
  view.append(el('div', 'notice', isMock
    ? 'MOCK: địa chỉ và trạng thái dưới đây chỉ minh họa; chưa kiểm tra kết nối mạng.'
    : 'Thông tin nhận diện và kết nối của các peer đã đăng ký. Bấm Làm mới để kiểm tra lại trạng thái.'));
  const grid = el('div', 'peer-grid');
  const local = { name: snapshot.node, role: 'Node hiện tại', address: isMock ? 'http://127.0.0.1:5001' : config.API_BASE_URL || location.origin, status: isMock ? 'Online · mẫu' : 'API đã phản hồi' };
  [local, ...snapshot.peers].forEach((peer, index) => {
    const card = el('section', 'panel peer-card');
    card.append(el('span', 'peer-avatar', peer.name || '?'), el('h2', '', peer.name ? `Node ${peer.name}` : `Peer ${index}`), el('p', 'muted', peer.role), el('code', 'peer-address', peer.address), badge(peer.status, isMock ? 'mock' : peer.state === 'online' ? 'live' : ''));
    if (peer.latencyMs != null) card.append(el('p', 'muted small', `Thời gian phản hồi: ${peer.latencyMs} ms`));
    if (peer.checkedAt) card.append(el('p', 'muted small', `Kiểm tra lúc ${formatDate(peer.checkedAt)}`));
    grid.append(card);
  });
  view.append(grid);
  if (!snapshot.peers.length) view.append(empty(isMock ? 'Chưa có peer trong kịch bản mock này.' : 'Node chưa có peer trong danh sách.'));
  view.append(el('p', 'muted small', 'Node C hỗ trợ khám phá peer và đồng bộ; không quyết định chain đúng/sai cho toàn mạng.'));
}
const renderers = { dashboard, wallet, blockchain, transactions, mempool, mining, network };
function currentPage() { const page = location.hash.slice(1); return Object.hasOwn(pages, page) ? page : 'dashboard'; }
async function render() {
  clearTimeout(refreshTimer);
  const id = ++requestId;
  activeRequest?.abort();
  activeRequest = new AbortController();
  const options = { signal: activeRequest.signal };
  const page = currentPage();
  const keepContent = renderedPage === page && Boolean(snapshot);
  const warning = document.querySelector('#load-warning');
  warning.hidden = true;
  document.querySelector('#refresh-controls').hidden = !['dashboard', 'blockchain'].includes(page);
  document.querySelector('#refresh').disabled = true;
  const [title, kicker, description] = pages[page];
  document.title = `Chainroom · ${title}`;
  document.querySelector('#page-title').textContent = title;
  document.querySelector('#page-kicker').textContent = kicker;
  document.querySelector('#page-description').textContent = description;
  document.querySelectorAll('[data-page]').forEach(item => {
    if (item.dataset.page === page) item.setAttribute('aria-current', 'page');
    else item.removeAttribute('aria-current');
  });
  view.setAttribute('aria-busy', 'true');
  if (!keepContent) {
    renderedPage = null;
    snapshot = null;
    view.replaceChildren(empty(isMock ? 'Đang tải dữ liệu mẫu…' : 'Đang đọc API node…'));
  }
  else {
    warning.textContent = 'Đang làm mới; nội dung bên dưới là lần đọc thành công trước.';
    warning.hidden = false;
  }
  setConnection('Đang tải…', 'loading');
  try {
    const peerRequest = page === 'network' ? api.getPeers(options).catch(error => {
      if (error.code === 'API_PENDING') return { peers: [], message: error.message };
      throw error;
    }) : Promise.resolve({ peers: [] });
    // Explorer chỉ cần /api/chain. Dashboard vẫn xem được chain khi pending lỗi.
    const pendingRequest = ['blockchain', 'network', 'wallet'].includes(page) ? Promise.resolve(null)
      : api.getPending(options).then(normalizePending).catch(error => {
        if (!['dashboard', 'transactions', 'mining'].includes(page) || error.code === 'ABORTED') throw error;
        return { pending: null, pendingError: error.message };
      });
    const [chainData, pendingData, peerData] = await Promise.all([api.getChain(options), pendingRequest, peerRequest]);
    if (id !== requestId) return false;
    snapshot = { ...normalizeChain(chainData), pending: null, pendingError: null, ...pendingData, peers: peerData.peers, peerMessage: peerData.message };
    document.querySelector('.node-avatar').textContent = snapshot.node;
    document.querySelector('.node-identity strong').textContent = `Node ${snapshot.node}`;
    setConnection(isMock ? 'Mock sẵn sàng' : 'API node phản hồi', 'ready');
    view.replaceChildren(); renderers[page]();
    renderedPage = page;
    const warnings = [];
    if (snapshot.pendingError) warnings.push(`Chưa đọc được mempool: ${snapshot.pendingError} Số giao dịch chờ chưa xác định.`);
    if (!snapshot.chain.length) warnings.push('Chain đang rỗng, chưa có genesis. Hãy kiểm tra dữ liệu node; UI không tự tạo block.');
    warning.textContent = warnings.join(' ');
    warning.hidden = !warnings.length;
    if (snapshot.pendingError) setConnection('Chỉ đọc được chain', 'error');
    document.querySelector('#updated').textContent = `Lần tải ${modeLabel} thành công: ${new Date().toLocaleTimeString('vi-VN')}`;
    return true;
  } catch (error) {
    if (id !== requestId || error.code === 'ABORTED') return false;
    activeRequest.abort();
    setConnection(isMock ? 'Lỗi mô phỏng' : 'Lỗi đọc API', 'error');
    if (keepContent) {
      warning.textContent = `Không làm mới được: ${error.message} Đang hiển thị dữ liệu cũ từ lần đọc thành công trước.`;
      warning.hidden = false;
    } else {
      renderedPage = null;
      snapshot = null;
      const failure = empty(error.message || 'Không thể tải dữ liệu.');
      failure.setAttribute('role', 'alert');
      failure.append(button('Thử lại', render)); view.replaceChildren(failure);
    }
    return false;
  } finally {
    if (id === requestId) {
      view.setAttribute('aria-busy', 'false');
      document.querySelector('#refresh').disabled = (currentPage() === 'transactions' && transactionState.busy)
        || (currentPage() === 'wallet' && balanceState.busy)
        || (currentPage() === 'mining' && miningState.busy);
      scheduleRefresh();
    }
  }
}
// Một timeout sau mỗi lần đọc hoàn tất, không chồng request như setInterval.
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  const note = document.querySelector('#refresh-note');
  if (!refreshInterval || !['dashboard', 'blockchain'].includes(currentPage())) {
    note.textContent = 'Chỉ làm mới thủ công.';
    return;
  }
  if (document.hidden || document.querySelector('#block-dialog').open) {
    note.textContent = 'Tạm dừng khi tab bị ẩn hoặc đang xem chi tiết block.';
    return;
  }
  note.textContent = `Làm mới sau mỗi ${refreshInterval / 1000} giây; tạm dừng khi đang thao tác trong bảng.`;
  if (view.getAttribute('aria-busy') === 'true') return;
  refreshTimer = setTimeout(() => {
    if (view.contains(document.activeElement)) { scheduleRefresh(); return; }
    render();
  }, refreshInterval);
}
function setConnection(message, state) {
  const target = document.querySelector('.connection');
  target.replaceChildren(el('i'), document.createTextNode(message));
  target.dataset.state = state;
}
function setupMode() {
  document.querySelector('.topbar-actions > .badge').replaceWith(badge(modeLabel, isMock ? 'mock' : 'live'));
  document.querySelector('.node-identity strong').textContent = isMock ? 'Node A' : 'Đang xác định node';
  document.querySelector('.node-avatar').textContent = isMock ? 'A' : '?';
  document.querySelector('.node-identity div > span').textContent = dataLabel;
  const notice = document.querySelector('.preview-notice');
  notice.replaceChildren(badge(isMock ? 'MÔ PHỎNG' : 'API NODE', isMock ? 'mock' : 'live'), el('span', '', isMock
    ? `Nguồn dữ liệu mô phỏng · Kịch bản: ${config.MOCK_SCENARIO}.`
    : 'Dữ liệu được truy xuất từ node đã cấu hình.'));
  document.querySelector('#updated').textContent = isMock ? 'State mock được đặt lại khi tải lại trang' : 'Chưa có lần đọc API thành công';
  if (isMock) {
    const label = el('label', 'scenario-control', 'Kịch bản ');
    const select = el('select');
    select.setAttribute('aria-label', 'Kịch bản mock');
    for (const [value, title] of [['success', 'Thành công'], ['empty', 'Rỗng'], ['error', 'Lỗi HTTP 500'], ['offline', 'Mất kết nối']]) {
      const option = el('option', '', title); option.value = value; select.append(option);
    }
    select.value = config.MOCK_SCENARIO;
    select.addEventListener('change', () => {
      const url = new URL(location.href); url.searchParams.set('scenario', select.value); location.assign(url.href);
    });
    label.append(select); notice.append(label);
  }
}
const refreshSelect = document.querySelector('#refresh-interval');
if (![...refreshSelect.options].some(option => Number(option.value) === refreshInterval)) {
  const option = el('option', '', `Mỗi ${refreshInterval / 1000} giây (config)`);
  option.value = String(refreshInterval); refreshSelect.append(option);
}
refreshSelect.value = String(refreshInterval);
refreshSelect.addEventListener('change', () => { refreshInterval = Number(refreshSelect.value); scheduleRefresh(); });
function closeBlock() {
  document.querySelector('#block-dialog').close();
  scheduleRefresh();
}
document.querySelector('#close-dialog').addEventListener('click', closeBlock);
document.querySelector('#block-dialog').addEventListener('cancel', event => { event.preventDefault(); closeBlock(); });
document.querySelector('#block-dialog').addEventListener('close', scheduleRefresh);
document.querySelector('.skip-link').addEventListener('click', event => {
  event.preventDefault();
  document.querySelector('#main').focus();
});
document.querySelector('#refresh').addEventListener('click', () => {
  if (currentPage() === 'mining') miningState.unsupported = false;
  render();
});
window.addEventListener('hashchange', () => {
  document.querySelector('#block-dialog').close();
  render(); document.querySelector('#main').focus();
});
document.addEventListener('visibilitychange', scheduleRefresh);
window.addEventListener('pagehide', () => { clearTimeout(refreshTimer); activeRequest?.abort(); });
window.addEventListener('pageshow', scheduleRefresh);
setupMode();
render();
