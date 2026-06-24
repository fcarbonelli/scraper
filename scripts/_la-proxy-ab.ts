/**
 * TEMP (run on EC2): A/B test La Anónima scraping DIRECT vs through the AR proxy.
 *
 * Decides whether routing La Anónima through AR_PROXY_URL recovers the products
 * that fail with price_missing / homepage-302 from the cloud egress IP.
 *
 * Usage (on EC2, where .env has AR_PROXY_URL):
 *   npx tsx --env-file=.env scripts/_la-proxy-ab.ts
 *   npx tsx --env-file=.env scripts/_la-proxy-ab.ts <url1> <url2> ...
 *
 * Delete after deciding.
 */
import { fetch as undiciFetch, ProxyAgent } from 'undici';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Default to the products seen failing in the last run; override via argv.
const DEFAULT_URLS = [
  'https://www.laanonima.com.ar/canasta-solida-para-inodoro-pato-marina-aparato-repuesto-27-5-g/art_3178500/',
  'https://www.laanonima.com.ar/repelente-para-mosquitos-off-extra-duracion-aerosol-170-cc/art_2887745/',
  // A known-good control product (should keep working both ways):
  'https://www.laanonima.com.ar/gaseosa-cola-coca-cola-pet-x-500-cc/art_0228620/',
];

const PROXY_URL = process.env.AR_PROXY_URL?.trim();

interface Probe {
  status: number;
  home: boolean;
  price: string | null;
  avail: string | null;
}

async function probe(url: string, viaProxy: boolean): Promise<Probe | string> {
  const dispatcher = viaProxy && PROXY_URL ? new ProxyAgent(PROXY_URL) : undefined;
  try {
    const res = await undiciFetch(url, {
      method: 'GET',
      headers: { 'User-Agent': UA, Accept: 'text/html,*/*', 'Accept-Language': 'es-AR,es;q=0.9' },
      redirect: 'follow',
      ...(dispatcher ? { dispatcher } : {}),
    });
    const body = await res.text();
    return {
      status: res.status,
      home: new URL(res.url).pathname.replace(/\/+$/, '') === '',
      price: body.match(/"price"\s*:\s*"?([0-9.]+)"?/)?.[1] ?? null,
      avail: body.match(/"availability"\s*:\s*"?([^",}]+)"?/)?.[1]?.split('/').pop() ?? null,
    };
  } catch (e) {
    return `ERR ${(e as Error).message}`;
  } finally {
    if (dispatcher) await dispatcher.close().catch(() => undefined);
  }
}

function fmt(p: Probe | string): string {
  if (typeof p === 'string') return p;
  return `http=${p.status} home=${p.home} price=${p.price ?? '-'} avail=${p.avail ?? '-'}`;
}

async function main(): Promise<void> {
  const urls = process.argv.slice(2).filter((a) => a.startsWith('http'));
  const list = urls.length ? urls : DEFAULT_URLS;
  console.log(`AR_PROXY_URL ${PROXY_URL ? 'is set' : 'NOT set (proxy column will be skipped)'}\n`);
  for (const url of list) {
    const art = url.match(/art_(\d+)/)?.[1] ?? url;
    const direct = await probe(url, false);
    const proxied = PROXY_URL ? await probe(url, true) : 'skipped';
    console.log(`art_${art}`);
    console.log(`  direct: ${fmt(direct)}`);
    console.log(`  proxy : ${typeof proxied === 'string' ? proxied : fmt(proxied)}\n`);
  }
}
void main();
