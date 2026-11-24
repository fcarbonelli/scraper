import { afterEach, describe, expect, it, vi } from 'vitest';

/** proxy.ts reads its env at import time, so each case re-imports it. */
async function loadProxy(url: string | undefined, list?: string) {
  vi.resetModules();
  vi.stubEnv('AR_PROXY_URL', url ?? '');
  vi.stubEnv('AR_PROXY_SUPERMARKETS', list ?? '');
  return import('./proxy.js');
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('getPlaywrightProxy', () => {
  it('pins an iProyal sticky session onto the password', async () => {
    const { getPlaywrightProxy } = await loadProxy('http://user:pass_country-ar@geo.iproyal.com:12321');
    expect(getPlaywrightProxy('mercadolibre', { stickySession: 'abcd1234', lifetimeMinutes: 30 })).toEqual({
      server: 'http://geo.iproyal.com:12321',
      username: 'user',
      password: 'pass_country-ar_session-abcd1234_lifetime-30m',
    });
  });

  it('leaves the password alone without a session, for other providers, or when already pinned', async () => {
    let mod = await loadProxy('http://user:pass@geo.iproyal.com:12321');
    expect(mod.getPlaywrightProxy('mercadolibre')?.password).toBe('pass');

    mod = await loadProxy('http://user:pass@proxy.example.com:8080');
    expect(mod.getPlaywrightProxy('mercadolibre', { stickySession: 'abcd1234' })?.password).toBe('pass');

    mod = await loadProxy('http://user:pass_session-zzzz9999_lifetime-1h@geo.iproyal.com:12321');
    expect(mod.getPlaywrightProxy('mercadolibre', { stickySession: 'abcd1234' })?.password).toBe(
      'pass_session-zzzz9999_lifetime-1h',
    );
  });

  it('is off for chains outside the allowlist or without a proxy', async () => {
    let mod = await loadProxy('http://user:pass@geo.iproyal.com:12321', 'mami');
    expect(mod.getPlaywrightProxy('mercadolibre')).toBeUndefined();
    mod = await loadProxy(undefined);
    expect(mod.getPlaywrightProxy('mercadolibre')).toBeUndefined();
  });

  it('makes 8-char alphanumeric session ids', async () => {
    const { newProxySessionId } = await loadProxy(undefined);
    expect(newProxySessionId()).toMatch(/^[a-z0-9]{8}$/);
  });
});
