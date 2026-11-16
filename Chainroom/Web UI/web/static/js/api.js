import { config } from './config.js';
import { createMockApi } from './mock-api.js';
import { createRealApi } from './real-api.js';

export const api = config.MODE === 'mock'
  ? createMockApi({ scenario: config.MOCK_SCENARIO, delayMs: config.MOCK_DELAY_MS })
  : createRealApi({ baseUrl: config.API_BASE_URL, timeoutMs: config.REQUEST_TIMEOUT_MS });
