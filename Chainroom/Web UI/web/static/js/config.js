const defaults = {
  MODE: 'mock',
  API_BASE_URL: '',
  REFRESH_INTERVAL_MS: 0,
  REQUEST_TIMEOUT_MS: 10000,
  MOCK_SCENARIO: 'success',
  MOCK_DELAY_MS: 300,
};
const params = new URLSearchParams(globalThis.location?.search ?? '');
const liveServer = globalThis.document?.querySelector('meta[name="chainroom-mode"]')?.content === 'real';
export const config = Object.freeze({
  ...defaults,
  MODE: liveServer ? 'real' : (['mock', 'real'].includes(params.get('mode')) ? params.get('mode') : defaults.MODE),
  MOCK_SCENARIO: ['success', 'empty', 'error', 'offline'].includes(params.get('scenario'))
    ? params.get('scenario') : defaults.MOCK_SCENARIO,
});
