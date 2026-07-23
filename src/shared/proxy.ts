/**
 * Optional Argentine egress proxy.
 *
 * A few regional sites sit behind a CDN/WAF edge that penalizes non-Argentine /
 * datacenter IPs: Super Mami and Maxiconsumo silently drop the connection (the
 * cloud worker hangs until timeout), La Anónima started returning a hard 403
 * (WAF block) to the EC2 IP, and Átomo Conviene refuses the TCP/TLS connection
 * outright (undici surfaces this as a bare `fetch failed`). When `AR_PROXY_URL`
 * is set, those (and ONLY those) adapters route their HTTP requests through it
 * via an undici ProxyAgent; every other supermarket keeps going direct.
 *
 * Environment:
 *   AR_PROXY_URL           Full proxy endpoint, e.g.
 *                          http://user:pass@geo.iproyal.com:12321
 *                          (country/city targeting, if any, is encoded by the
 *                          provider inside the username/password.)
 *   AR_PROXY_SUPERMARKETS  Optional comma-separated allowlist of supermarket
 *                          ids to route through the proxy. Defaults to
 *                          DEFAULT_PROXIED below.
 *
 * If `AR_PROXY_URL` is unset, `getProxyDispatcher()` always returns undefined
 * and behaviour is identical to before (direct connection).
 */

import { ProxyAgent, type Dispatcher } from 'undici';

const PROXY_URL = process.env.AR_PROXY_URL?.trim();

// NOTE: MercadoLibre is intentionally NOT here — the Ecomodico adapter reads
// prices from the official API (api.mercadolibre.com), which works from the
// datacenter IP, so it needs no residential proxy (and burns no proxy data).
const DEFAULT_PROXIED = ['mami', 'maxiconsumo', 'la-anonima', 'atomo'];

/** Supermarket ids whose traffic should egress through the AR proxy. */
const proxiedIds = new Set(
  process.env.AR_PROXY_SUPERMARKETS
    ? process.env.AR_PROXY_SUPERMARKETS.split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : DEFAULT_PROXIED,
);

// Build the ProxyAgent once and reuse it so connections are pooled (creating a
// new agent per request would leak sockets and defeat keep-alive).
let agent: ProxyAgent | undefined;

function proxyAgent(): ProxyAgent | undefined {
  if (!PROXY_URL) return undefined;
  if (!agent) agent = new ProxyAgent(PROXY_URL);
  return agent;
}

/**
 * Return an undici dispatcher that routes through the AR proxy for the given
 * supermarket, or `undefined` to use the default (direct) connection.
 *
 * Adapters pass the result as `fetch(url, { dispatcher })`; passing `undefined`
 * is a no-op, so callers don't need to branch.
 */
export function getProxyDispatcher(supermarketId: string): Dispatcher | undefined {
  if (!PROXY_URL || !proxiedIds.has(supermarketId)) return undefined;
  return proxyAgent();
}

/** Whether an AR proxy is configured AND enabled for this supermarket. */
export function usesProxy(supermarketId: string): boolean {
  return Boolean(PROXY_URL) && proxiedIds.has(supermarketId);
}

/** Playwright-shaped proxy config (server URL + split-out credentials). */
export interface PlaywrightProxy {
  server: string;
  username?: string;
  password?: string;
}

/**
 * Return a Playwright `proxy` launch/context option for the given supermarket,
 * or `undefined` to connect directly. Playwright wants the credentials split
 * out of the URL, so we parse `AR_PROXY_URL` (http://user:pass@host:port) into
 * `{ server, username, password }`.
 */
export function getPlaywrightProxy(supermarketId: string): PlaywrightProxy | undefined {
  if (!PROXY_URL || !proxiedIds.has(supermarketId)) return undefined;
  try {
    const u = new URL(PROXY_URL);
    const proxy: PlaywrightProxy = { server: `${u.protocol}//${u.host}` };
    if (u.username) proxy.username = decodeURIComponent(u.username);
    if (u.password) proxy.password = decodeURIComponent(u.password);
    return proxy;
  } catch {
    return undefined;
  }
}
