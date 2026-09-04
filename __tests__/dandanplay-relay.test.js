/* global describe, expect, it */

const {
  DANDANPLAY_RELAY_PATH_PREFIX,
  DANDANPLAY_RELAY_REQUEST_HEADER,
  isDandanplayPublicRelayEnabled,
  isDandanplayRelayPath,
  isDandanplayRelayRequest,
} = require('../src/lib/dandanplay-shared');

function makeRequest(headers = {}) {
  // 只用到 request.headers.get，用最小桩对象替代全局 Request（测试环境无 Request）
  return { headers: { get: (k) => (k in headers ? headers[k] : null) } };
}

describe('dandanplay relay helpers (edge safe)', () => {
  it('allows the danmu endpoint and its sub-routes to bypass auth', () => {
    expect(isDandanplayRelayPath('/api/danmu-external')).toBe(true);
    expect(isDandanplayRelayPath('/api/danmu-external/search')).toBe(true);
  });

  it('never allows unrelated routes to bypass auth', () => {
    expect(isDandanplayRelayPath('/api/search')).toBe(false);
    expect(isDandanplayRelayPath('/api/admin/config')).toBe(false);
    expect(isDandanplayRelayPath('/api/danmu-external-evil')).toBe(false);
    expect(isDandanplayRelayPath('/')).toBe(false);
  });

  it('only treats the exact relay header value as a relay request', () => {
    expect(
      isDandanplayRelayRequest(
        makeRequest({ [DANDANPLAY_RELAY_REQUEST_HEADER]: '1' }),
      ),
    ).toBe(true);
    expect(
      isDandanplayRelayRequest(
        makeRequest({ [DANDANPLAY_RELAY_REQUEST_HEADER]: 'true' }),
      ),
    ).toBe(false);
    expect(isDandanplayRelayRequest(makeRequest())).toBe(false);
  });

  it('keeps the relay prefix in sync with the guarded endpoint', () => {
    expect(DANDANPLAY_RELAY_PATH_PREFIX).toBe('/api/danmu-external');
  });

  it('enables the public relay unless explicitly disabled', () => {
    const original = process.env.DANDANPLAY_PUBLIC_RELAY_ENABLED;
    try {
      delete process.env.DANDANPLAY_PUBLIC_RELAY_ENABLED;
      expect(isDandanplayPublicRelayEnabled()).toBe(true);

      process.env.DANDANPLAY_PUBLIC_RELAY_ENABLED = 'false';
      expect(isDandanplayPublicRelayEnabled()).toBe(false);
    } finally {
      if (original === undefined) {
        delete process.env.DANDANPLAY_PUBLIC_RELAY_ENABLED;
      } else {
        process.env.DANDANPLAY_PUBLIC_RELAY_ENABLED = original;
      }
    }
  });
});
