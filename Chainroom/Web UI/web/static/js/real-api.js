import { ApiError, abortError, transactionPayload } from './errors.js';
import { normalizeBalance, normalizeBlock, normalizeChain, normalizePending, normalizePeers, normalizeStatus, normalizeSubmission } from './normalize.js';

export function createRealApi({ baseUrl = '', timeoutMs = 10000, fetchImpl = globalThis.fetch.bind(globalThis) } = {}) {
  if (typeof baseUrl !== 'string' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new ApiError('CONFIG', 'Cấu hình API không hợp lệ.');
  const base = baseUrl.replace(/\/+$/, '');
  if (base && !/^https?:\/\//i.test(base)) throw new ApiError('CONFIG', 'API_BASE_URL phải rỗng hoặc là URL HTTP(S).');
  if (base) {
    const parsed = new URL(base);
    if (parsed.search || parsed.hash || parsed.username || parsed.password) throw new ApiError('CONFIG', 'Base URL không được chứa query, hash hoặc thông tin đăng nhập.');
  }
  async function request(path, { method = 'GET', body, signal } = {}) {
    if (signal?.aborted) throw abortError();
    const controller = new AbortController();
    let timedOut = false;
    const cancel = () => controller.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    try {
      const response = await fetchImpl(`${base}${path}`, {
        method, signal: controller.signal, cache: 'no-store',
        headers: body === undefined ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      // Timeout bao trùm đọc body, không chỉ giai đoạn nhận headers.
      const text = await response.text();
      let data;
      try { data = JSON.parse(text); }
      catch {
        if (!response.ok) throw new ApiError('HTTP', `API trả HTTP ${response.status}; nội dung không phải JSON.`, { status: response.status });
        throw new ApiError('INVALID_JSON', 'API trả nội dung không phải JSON hợp lệ.');
      }
      if (!response.ok) throw new ApiError('HTTP', typeof data?.message === 'string' ? data.message : `API trả HTTP ${response.status}.`, { status: response.status });
      return data;
    } catch (error) {
      if (timedOut) throw new ApiError('TIMEOUT', method === 'POST'
        ? `Hết thời gian chờ. Node có thể đã xử lý yêu cầu; hãy kiểm tra ${path === '/api/mine' ? 'chain và mempool' : 'mempool'} trước khi gửi lại.`
        : 'Hết thời gian chờ phản hồi API.');
      if (signal?.aborted) throw abortError();
      if (error instanceof ApiError) throw error;
      throw new ApiError('NETWORK', method === 'POST'
        ? `Mất kết nối khi gửi. Node có thể đã xử lý yêu cầu; hãy kiểm tra ${path === '/api/mine' ? 'chain và mempool' : 'mempool'} trước khi gửi lại.`
        : 'Không kết nối được API. Kiểm tra node, base URL và cấu hình CORS.');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
    }
  }
  const getChain = async options => {
    const raw = await request('/api/chain', options);
    normalizeChain(raw);
    return raw;
  };
  const getPending = async options => {
    const raw = await request('/api/pending', options);
    normalizePending(raw);
    return raw;
  };
  return Object.freeze({
    getChain,
    getPending,
    getBalance: async (address, options) => {
      const value = typeof address === 'string' ? address.trim() : '';
      if (!value) throw new ApiError('VALIDATION', 'Cần nhập địa chỉ để xem số dư.');
      const query = new URLSearchParams({ address: value });
      return normalizeBalance(await request(`/api/balance?${query}`, options));
    },
    submitTransaction: async (data, options) => {
      const raw = await request('/api/transaction', { ...options, method: 'POST', body: transactionPayload(data) });
      normalizeSubmission(raw);
      return raw;
    },
    getStatus: async options => {
      const [chain, pending] = await Promise.all([getChain(options), getPending(options)]);
      return normalizeStatus(chain, pending);
    },
    getPeers: async options => {
      try { return normalizePeers(await request('/api/peers/details', options)); }
      catch (error) {
        if (![404, 405].includes(error.status)) throw error;
      }
      try { return normalizePeers(await request('/api/peers', options)); }
      catch (error) {
        if ([404, 405].includes(error.status)) throw new ApiError('API_PENDING', 'Backend đang chạy chưa hỗ trợ GET /api/peers. Dùng bản Network & Sync để xem danh sách peer.');
        throw error;
      }
    },
    mine: async (minerAddress, options) => {
      if (typeof minerAddress !== 'string' || !minerAddress.trim()) throw new ApiError('VALIDATION', 'Cần địa chỉ miner.');
      try {
        const raw = await request('/api/mine', { ...options, method: 'POST', body: { miner_address: minerAddress.trim() } });
        normalizeBlock(raw?.block);
        return raw;
      } catch (error) {
        if ([404, 405].includes(error.status)) throw new ApiError('API_PENDING', 'Backend đang chạy chưa hỗ trợ POST /api/mine. Dùng bản Network & Sync để mine block.');
        throw error;
      }
    },
  });
}
