/**
 * Magazine acquisition, split into two phases so we never pay for an unchanged
 * issue:
 *
 *   1. discoverCandidates(cfg) — CHEAP. A small fetch (and a quick HEAD for
 *      PDFs) yields a stable `hash` per issue. The pipeline checks the DB by
 *      this hash and skips everything below if it's already been processed.
 *   2. candidate.fetch()       — HEAVY. Only called for NEW issues: downloads +
 *      renders the pages so vision can read them.
 *
 * Each chain publishes differently, so there's a strategy per chain
 * (`config.revista.strategy`), but all normalize to {@link MagazineSource}.
 *
 *   html-pdf-links — Makro/Vital: direct .pdf links on the offers page.
 *   pubhtml5       — Rosental: PubHTML5 flipbook, page images from config.js.
 *   publuu         — Comodín: Publuu flipbook on CloudFront; Playwright finds
 *                    the image URL pattern, then plain fetch grabs the pages.
 */

import { createHash } from 'node:crypto';
import { logger } from '../shared/logger.js';
import { fetchRetry } from './retry.js';
import { findPdfLinks, downloadPdf } from './download.js';
import { renderPdfToImages } from './render.js';
import {
  UA,
  applySelection,
  type MagazineSource,
  type PageSelection,
  type RevistaStrategyConfig,
} from './sources-shared.js';

/** A discovered issue: cheap metadata + a thunk that does the heavy download. */
export interface MagazineCandidate {
  /** Stable dedup hash (no full download needed to compute it). */
  hash: string;
  label: string;
  sourceUrl: string;
  /** Download + render the pages (the expensive part). */
  fetch: () => Promise<MagazineSource>;
}

function hash(...parts: (string | number)[]): string {
  return createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 16);
}

function totalBytes(pages: Buffer[]): number {
  return pages.reduce((acc, p) => acc + p.length, 0);
}

// ---------------------------------------------------------------------------
// html-pdf-links (Makro, Vital)
// ---------------------------------------------------------------------------
/**
 * HEAD a PDF for a cheap change-fingerprint — lets us detect a republished
 * issue WITHOUT downloading it. Combines the strongest signals a CDN gives us:
 * `content-length`, `ETag`, and `Last-Modified`. Any of them changing means the
 * file changed → we reprocess. Falls back to just the URL if HEAD is blocked.
 */
async function headFingerprint(url: string): Promise<string> {
  try {
    const res = await fetchRetry(url, { method: 'HEAD', headers: { 'User-Agent': UA } }, `HEAD ${url}`);
    const len = res.headers.get('content-length') ?? '';
    const etag = res.headers.get('etag') ?? '';
    const lastModified = res.headers.get('last-modified') ?? '';
    return [len, etag, lastModified].join('|');
  } catch {
    return '';
  }
}

async function pdfLinkCandidates(
  cfg: RevistaStrategyConfig,
  sel?: PageSelection,
): Promise<MagazineCandidate[]> {
  if (!cfg.offersUrl) throw new Error('html-pdf-links strategy requires offersUrl');
  const links = await findPdfLinks(cfg.offersUrl);
  logger.info({ count: links.length, offersUrl: cfg.offersUrl }, 'revista: found PDF link(s)');
  return Promise.all(
    links.map(async (link) => {
      const fingerprint = await headFingerprint(link.url);
      const h = hash(link.url, fingerprint);
      return {
        hash: h,
        label: link.filename,
        sourceUrl: link.url,
        fetch: async (): Promise<MagazineSource> => {
          const buf = await downloadPdf(link);
          const all = await renderPdfToImages(buf);
          const { items: pages, firstPage } = applySelection(all, sel);
          return { id: h, label: link.filename, sourceUrl: link.url, pages, firstPage, fileSize: buf.length };
        },
      };
    }),
  );
}

// ---------------------------------------------------------------------------
// pubhtml5 (Rosental)
// ---------------------------------------------------------------------------
async function discoverPubhtml5Url(offersUrl: string, fallback?: string): Promise<string> {
  try {
    const html = await (
      await fetchRetry(offersUrl, { headers: { 'User-Agent': UA } }, offersUrl)
    ).text();
    const m = html.match(/https?:\/\/[a-z0-9-]*\.?pubhtml5\.com\/[a-z0-9]+\/[a-z0-9]+\/?/i);
    if (m) {
      const url = m[0].endsWith('/') ? m[0] : `${m[0]}/`;
      logger.info({ offersUrl, url }, 'revista: discovered PubHTML5 book');
      return url;
    }
    logger.warn({ offersUrl }, 'revista: no PubHTML5 flipbook found on page');
  } catch (err) {
    logger.warn({ err, offersUrl }, 'revista: could not read offers page');
  }
  if (fallback) return fallback;
  throw new Error(`Could not discover a PubHTML5 flipbook from ${offersUrl} and no fallback set.`);
}

async function fetchPubhtml5Pages(bookUrl: string, sel?: PageSelection): Promise<MagazineSource> {
  const cfgUrl = new URL('javascript/config.js', bookUrl).href;
  const res = await fetchRetry(cfgUrl, { headers: { 'User-Agent': UA } }, cfgUrl);
  if (!res.ok) throw new Error(`Could not read PubHTML5 config (${cfgUrl}): HTTP ${res.status}`);
  const cfg = await res.text();

  const title = cfg.match(/"title":"([^"]*)"/)?.[1] ?? 'Revista';
  const allFiles = [...cfg.matchAll(/"n":\[([^\]]*)\]/g)]
    .map((m) => (m[1] ?? '').match(/[a-f0-9]{32}\.webp/i)?.[0])
    .filter((f): f is string => Boolean(f));
  if (allFiles.length === 0) throw new Error('No page images in the PubHTML5 config.');

  const { items: files, firstPage } = applySelection(allFiles, sel);
  if (files.length === 0) throw new Error(`Requested range falls outside ${allFiles.length} pages.`);

  const pages: Buffer[] = [];
  for (const f of files) {
    const u = new URL(`files/large/${f}`, bookUrl).href;
    const r = await fetchRetry(u, { headers: { 'User-Agent': UA, Referer: bookUrl } }, f);
    if (!r.ok) throw new Error(`Could not download page ${f}: HTTP ${r.status}`);
    pages.push(Buffer.from(await r.arrayBuffer()));
  }
  return { id: hash(bookUrl), label: title, sourceUrl: bookUrl, pages, firstPage, fileSize: totalBytes(pages) };
}

async function pubhtml5Candidates(
  cfg: RevistaStrategyConfig,
  sel?: PageSelection,
): Promise<MagazineCandidate[]> {
  const bookUrl = cfg.offersUrl
    ? await discoverPubhtml5Url(cfg.offersUrl, cfg.pubhtml5Url)
    : cfg.pubhtml5Url;
  if (!bookUrl) throw new Error('pubhtml5 strategy requires offersUrl or pubhtml5Url');
  // The book URL rotates per issue, so it's a sufficient dedup key on its own.
  return [
    {
      hash: hash(bookUrl),
      label: 'PubHTML5 flipbook',
      sourceUrl: bookUrl,
      fetch: () => fetchPubhtml5Pages(bookUrl, sel),
    },
  ];
}

// ---------------------------------------------------------------------------
// publuu (Comodín)
// ---------------------------------------------------------------------------
async function discoverPubluuEmbed(offersUrl: string): Promise<{ embed: string; bookId: string }> {
  const html = await (
    await fetchRetry(offersUrl, { headers: { 'User-Agent': UA } }, offersUrl)
  ).text();
  const fb = html.match(/publuu\.com\/flip-book\/(\d+)\/(\d+)/i);
  if (!fb) throw new Error(`No Publuu flipbook found at ${offersUrl}.`);
  return { embed: `https://publuu.com/flip-book/${fb[1]}/${fb[2]}/page/1?embed`, bookId: `${fb[1]}/${fb[2]}` };
}

async function fetchPubluuPages(embed: string, bookId: string, sel?: PageSelection): Promise<MagazineSource> {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  let template: string | null = null; // ".../txt/<n>" without the _<page>_<width>.webp suffix
  try {
    const page = await (await browser.newContext({ userAgent: UA })).newPage();
    page.on('request', (req) => {
      const m = req.url().match(/^(https?:\/\/[^/]+\/\d+\/\d+\/\d+\/txt\/\d+)_\d+_\d+\.webp/i);
      if (m && !template) template = m[1] ?? null;
    });
    await page.goto(embed, { waitUntil: 'networkidle', timeout: 60_000 }).catch(() => {});
    await page.waitForTimeout(3000);
  } finally {
    await browser.close();
  }
  if (!template) throw new Error('Could not discover Publuu flipbook images.');

  const firstPage = Math.max(1, sel?.start ?? 1);
  const lastPage = sel?.end ?? 500;
  const pages: Buffer[] = [];
  for (let p = firstPage; p <= lastPage; p++) {
    const r = await fetchRetry(`${template}_${p}_1200.webp`, { headers: { 'User-Agent': UA } }, `publuu p${p}`);
    if (!r.ok) break; // 404 = end of magazine
    pages.push(Buffer.from(await r.arrayBuffer()));
  }
  if (pages.length === 0) throw new Error('Downloaded no Publuu pages (range outside the issue?).');
  logger.info({ pages: pages.length, firstPage }, 'revista: Publuu pages downloaded');
  return { id: hash(embed), label: `Comodín revista ${bookId}`, sourceUrl: embed, pages, firstPage, fileSize: totalBytes(pages) };
}

async function publuuCandidates(
  cfg: RevistaStrategyConfig,
  sel?: PageSelection,
): Promise<MagazineCandidate[]> {
  if (!cfg.offersUrl) throw new Error('publuu strategy requires offersUrl');
  const { embed, bookId } = await discoverPubluuEmbed(cfg.offersUrl);
  return [
    {
      hash: hash(embed),
      label: `Comodín revista ${bookId}`,
      sourceUrl: embed,
      fetch: () => fetchPubluuPages(embed, bookId, sel),
    },
  ];
}

/** Cheap discovery of the current issue(s) for a chain. */
export async function discoverCandidates(
  cfg: RevistaStrategyConfig,
  sel?: PageSelection,
): Promise<MagazineCandidate[]> {
  switch (cfg.strategy) {
    case 'html-pdf-links':
      return pdfLinkCandidates(cfg, sel);
    case 'pubhtml5':
      return pubhtml5Candidates(cfg, sel);
    case 'publuu':
      return publuuCandidates(cfg, sel);
    default:
      throw new Error(`Unsupported revista strategy: ${String(cfg.strategy)}`);
  }
}
