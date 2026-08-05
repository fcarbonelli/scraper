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
 *                    Dedup hashes config.js content (page file list), not just
 *                    the book URL — Rosental often reuses the same URL across
 *                    quincenas.
 *   publuu         — Comodín: Publuu flipbook on CloudFront; Playwright finds
 *                    the image URL pattern, then plain fetch grabs the pages.
 */

import { createHash } from 'node:crypto';
import path from 'node:path';
import { logger } from '../shared/logger.js';
import { fetchRetry } from './retry.js';
import { findPdfLinks, downloadPdf, type PdfLink } from './download.js';
import { renderPdfToImages } from './render.js';
import { deriveSeriesKey } from './series.js';
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
  /**
   * Stable flyer-series key for supersede / carry-forward
   * (e.g. 'mm', 'gt', 'folder-resto'). Single-series chains use 'default'.
   */
  seriesKey: string;
  /**
   * Cheap facts kept from the discovery probe so the operator (and the
   * re-upload guard) can tell a new edition from a re-export WITHOUT
   * downloading anything. Previously these were folded into `hash` and thrown
   * away, which left the review UI with nothing to show but a label.
   */
  fileSize?: number | null;
  lastModified?: string | null;
  pageCount?: number | null;
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
export interface HeadInfo {
  /** The joined fingerprint that feeds the dedup hash. Empty when HEAD failed. */
  raw: string;
  contentLength: number | null;
  lastModified: string | null;
}

/**
 * Ask for a single byte to learn the full size when HEAD withheld it.
 * `Content-Range: bytes 0-0/22475835` carries the total; one byte crosses the
 * wire. Vital's CDN stopped sending `content-length` on HEAD, which silently
 * blinded the re-upload guard — the size is the only signal separating a
 * re-export from a new edition once the period matches.
 */
async function rangedSize(url: string): Promise<number | null> {
  let res: Response | undefined;
  try {
    res = await fetchRetry(
      url,
      { headers: { 'User-Agent': UA, Range: 'bytes=0-0' } },
      `RANGE ${url}`,
    );
    // Only a 206 honoured the range. A server that ignores it answers 200 with
    // the WHOLE file — tens of MB we must never read, and whose content-length
    // is the real size but arrives attached to a body we are about to drop.
    if (res.status !== 206) return null;
    const total = res.headers.get('content-range')?.split('/')[1];
    const n = total ? Number(total) : NaN;
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  } finally {
    // Always release the socket: an unread body keeps the connection alive
    // until GC, and this runs per PDF on every daily discovery.
    await res?.body?.cancel().catch(() => {});
  }
}

async function headFingerprint(url: string): Promise<HeadInfo> {
  try {
    const res = await fetchRetry(url, { method: 'HEAD', headers: { 'User-Agent': UA } }, `HEAD ${url}`);
    const len = res.headers.get('content-length') ?? '';
    const etag = res.headers.get('etag') ?? '';
    const lastModified = res.headers.get('last-modified') ?? '';
    // `raw` must stay byte-identical to what it has always been: it feeds the
    // dedup hash, and folding a newly-available size into it would make every
    // stored issue look like a new one.
    return {
      raw: [len, etag, lastModified].join('|'),
      contentLength: len ? Number(len) : await rangedSize(url),
      lastModified: lastModified || null,
    };
  } catch {
    return { raw: '', contentLength: null, lastModified: null };
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
      const h = hash(link.url, fingerprint.raw);
      return {
        hash: h,
        label: link.label,
        sourceUrl: link.url,
        seriesKey: link.seriesKey,
        fileSize: fingerprint.contentLength,
        lastModified: fingerprint.lastModified,
        fetch: async (): Promise<MagazineSource> => {
          const buf = await downloadPdf(link);
          const all = await renderPdfToImages(buf);
          const { items: pages, firstPage } = applySelection(all, sel);
          return {
            id: h,
            label: link.label,
            sourceUrl: link.url,
            pages,
            firstPage,
            fileSize: buf.length,
          };
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
  const { title, files: allFiles } = await readPubhtml5Config(bookUrl);
  const { items: files, firstPage } = applySelection(allFiles, sel);
  if (files.length === 0) throw new Error(`Requested range falls outside ${allFiles.length} pages.`);

  const pages: Buffer[] = [];
  for (const f of files) {
    const u = new URL(`files/large/${f}`, bookUrl).href;
    const r = await fetchRetry(u, { headers: { 'User-Agent': UA, Referer: bookUrl } }, f);
    if (!r.ok) throw new Error(`Could not download page ${f}: HTTP ${r.status}`);
    pages.push(Buffer.from(await r.arrayBuffer()));
  }
  // Content-based id (same as discovery hash) so a republished book on the
  // same URL is treated as a new issue.
  const contentHash = hash(bookUrl, title, String(allFiles.length), allFiles.join(','));
  return {
    id: contentHash,
    label: title,
    sourceUrl: bookUrl,
    pages,
    firstPage,
    fileSize: totalBytes(pages),
  };
}

/**
 * Cheap PubHTML5 fingerprint: read javascript/config.js for title + page
 * filenames. If Rosental reuses the same book URL for a new quincena, the
 * page hashes in config.js change → we detect a new issue without downloading
 * every page.
 */
async function readPubhtml5Config(
  bookUrl: string,
): Promise<{ title: string; files: string[]; fingerprint: string; lastModified: string | null }> {
  const cfgUrl = new URL('javascript/config.js', bookUrl).href;
  const res = await fetchRetry(cfgUrl, { headers: { 'User-Agent': UA } }, cfgUrl);
  if (!res.ok) throw new Error(`Could not read PubHTML5 config (${cfgUrl}): HTTP ${res.status}`);
  const cfg = await res.text();

  const title = cfg.match(/"title":"([^"]*)"/)?.[1] ?? 'Revista';
  const files = [...cfg.matchAll(/"n":\[([^\]]*)\]/g)]
    .map((m) => (m[1] ?? '').match(/[a-f0-9]{32}\.webp/i)?.[0])
    .filter((f): f is string => Boolean(f));
  if (files.length === 0) throw new Error('No page images in the PubHTML5 config.');

  // CONTENT ONLY — deliberately not the ETag / Last-Modified / content-length of
  // this response. Those moved on 2026-08-05 while the book was byte-identical
  // (same title, same 144 page files, same 80,401,900 bytes downloaded), which
  // made the pipeline rescan the whole quincena and supersede a reviewed issue.
  // The page filenames are content hashes, so a real new edition still changes
  // the fingerprint. This now matches what `fetchPubhtml5Pages` computes as the
  // content id — the two used to disagree.
  const lastModified = res.headers.get('last-modified') ?? '';
  const fingerprint = [title, String(files.length), files.join(',')].join('|');
  return { title, files, fingerprint, lastModified: lastModified || null };
}

async function pubhtml5Candidates(
  cfg: RevistaStrategyConfig,
  sel?: PageSelection,
): Promise<MagazineCandidate[]> {
  const bookUrl = cfg.offersUrl
    ? await discoverPubhtml5Url(cfg.offersUrl, cfg.pubhtml5Url)
    : cfg.pubhtml5Url;
  if (!bookUrl) throw new Error('pubhtml5 strategy requires offersUrl or pubhtml5Url');

  // Content fingerprint (not URL alone): Rosental often keeps the same
  // pubhtml5.com/... path across quincenas and only swaps config.js pages.
  const { title, files, fingerprint, lastModified } = await readPubhtml5Config(bookUrl);
  const h = hash(bookUrl, fingerprint);

  return [
    {
      hash: h,
      label: title,
      sourceUrl: bookUrl,
      seriesKey: 'default',
      // Free from config.js — and the two numbers that actually tell a new
      // quincena apart from a re-parsed title.
      pageCount: files.length,
      lastModified,
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
  // Single-series chain → seriesKey 'default'.
  return [
    {
      hash: hash(embed),
      label: `Comodín revista ${bookId}`,
      sourceUrl: embed,
      seriesKey: 'default',
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

/**
 * Build a MagazineCandidate from an explicit PDF URL (bypasses discovery).
 * Used when the offers-page HTML is stale/cached and a known PDF must be
 * ingested by hand (e.g. Makro `4-PROV-JUL4.pdf`).
 */
export async function candidateFromPdfUrl(
  pdfUrl: string,
  opts: {
    pageSelection?: PageSelection;
    /** Override the human label (defaults to filename). */
    label?: string;
    /** Override the derived series_key. */
    seriesKey?: string;
  } = {},
): Promise<MagazineCandidate> {
  let parsed: URL;
  try {
    parsed = new URL(pdfUrl);
  } catch {
    throw new Error(`Invalid PDF URL: ${pdfUrl}`);
  }
  if (!parsed.pathname.toLowerCase().endsWith('.pdf')) {
    throw new Error(`URL does not look like a PDF: ${pdfUrl}`);
  }

  const filename = decodeURIComponent(path.basename(parsed.pathname));
  const label = opts.label?.trim() || filename;
  const seriesKey =
    opts.seriesKey?.trim() ||
    deriveSeriesKey({ filename, label, strategy: 'html-pdf-links' });

  const link: PdfLink = { url: pdfUrl, filename, label, seriesKey };
  const fingerprint = await headFingerprint(pdfUrl);
  const h = hash(pdfUrl, fingerprint.raw);

  return {
    hash: h,
    label,
    sourceUrl: pdfUrl,
    seriesKey,
    fileSize: fingerprint.contentLength,
    lastModified: fingerprint.lastModified,
    fetch: async (): Promise<MagazineSource> => {
      const buf = await downloadPdf(link);
      const all = await renderPdfToImages(buf);
      const { items: pages, firstPage } = applySelection(all, opts.pageSelection);
      return {
        id: h,
        label,
        sourceUrl: pdfUrl,
        pages,
        firstPage,
        fileSize: buf.length,
      };
    },
  };
}
