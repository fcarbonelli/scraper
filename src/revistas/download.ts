/**
 * PDF discovery helpers for the `html-pdf-links` strategy (Makro, Vital).
 *
 * Finds the PDF links on a chain's "ofertas" page and downloads them into
 * memory. No disk writes — the orchestrator/worker is stateless.
 *
 * Each link carries an optional human `label` (Vital data-name / Makro title)
 * and a stable `seriesKey` so supersede / carry-forward scope per flyer series.
 */

import path from 'node:path';
import { logger } from '../shared/logger.js';
import { fetchRetry } from './retry.js';
import { UA } from './sources-shared.js';
import { deriveSeriesKey } from './series.js';

export interface PdfLink {
  url: string;
  filename: string;
  /** Human-readable label (Vital data-name or Makro title). Falls back to filename. */
  label: string;
  /** Stable series for supersede / carry-forward. */
  seriesKey: string;
}

function toPdfLink(
  url: string,
  extras: { dataName?: string; title?: string } = {},
): PdfLink {
  const filename = decodeURIComponent(path.basename(new URL(url).pathname));
  const label = extras.dataName ?? extras.title ?? filename;
  const seriesKey = deriveSeriesKey({
    dataName: extras.dataName,
    title: extras.title,
    filename,
    label,
    strategy: 'html-pdf-links',
  });
  return { url, filename, label, seriesKey };
}

/**
 * "Displayed" folletos: anchors that carry both a `.pdf` href and a `data-name`.
 * Sites like Vital embed EVERY branch's PDFs in a hidden dump for a dropdown;
 * the ones actually shown (one locality) are the anchors with `data-name`. The
 * products are the same across localities, so we keep only those (deduped).
 */
function findDisplayedFolletos(html: string, base: string): PdfLink[] {
  const byName = new Map<string, PdfLink>();
  const anchorRe = /<a\b([^>]*)>/gi;
  let a: RegExpExecArray | null;
  while ((a = anchorRe.exec(html)) !== null) {
    const attrs = a[1] ?? '';
    const name = attrs.match(/data-name="([^"]+)"/i)?.[1];
    const pdf = attrs.match(/(https?:\/\/[^"'\s]+?\.pdf)/i)?.[1];
    if (!name || !pdf) continue;
    try {
      if (!byName.has(name)) {
        byName.set(name, toPdfLink(new URL(pdf, base).href, { dataName: name }));
      }
    } catch {
      /* invalid URL → skip */
    }
  }
  // Also catch <button data-name="..."> siblings that share the same name via
  // WhatsApp share links already covered above — Map dedupes.
  return [...byName.values()];
}

/**
 * Makro-style: <a href="….pdf" title="Ofertas semanales del 23/07 al 29/07">.
 * Prefer title as the human label; fall back to filename.
 */
function findTitledPdfLinks(html: string, base: string): PdfLink[] {
  const byUrl = new Map<string, PdfLink>();
  const anchorRe = /<a\b([^>]*)>/gi;
  let a: RegExpExecArray | null;
  while ((a = anchorRe.exec(html)) !== null) {
    const attrs = a[1] ?? '';
    const href = attrs.match(/href="([^"]+\.pdf[^"]*)"/i)?.[1];
    if (!href) continue;
    const title = attrs.match(/title="([^"]+)"/i)?.[1];
    try {
      const abs = new URL(href, base).href;
      if (!byUrl.has(abs)) byUrl.set(abs, toPdfLink(abs, { title: title ?? undefined }));
    } catch {
      /* invalid URL → skip */
    }
  }
  return [...byUrl.values()];
}

/**
 * Parse PDF links out of one offers-page HTML body.
 * Prefer Vital data-name anchors → Makro titled anchors → bare .pdf URLs.
 */
function parsePdfLinksFromHtml(html: string, baseUrl: string): PdfLink[] {
  const displayed = findDisplayedFolletos(html, baseUrl);
  if (displayed.length > 0) return displayed;

  const titled = findTitledPdfLinks(html, baseUrl);
  if (titled.length > 0) return titled;

  const found = new Set<string>();
  const re = /['"(]([^'"()\s]+?\.pdf)(?:\?[^'"()\s]*)?['")]/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const href = m[1];
    if (!href) continue;
    try {
      found.add(new URL(href, baseUrl).href);
    } catch {
      /* invalid URL → skip */
    }
  }
  return [...found].map((url) => toPdfLink(url));
}

/**
 * Fetch offers-page HTML. BunnyCDN (Makro) often serves a stale cached copy of
 * `/ofertas/` that is missing newly uploaded PDFs. We therefore:
 *   1. fetch the plain URL, and
 *   2. fetch a cache-busted URL (`?v=<random>` + Cache-Control: no-cache),
 * then UNION the PDF links (dedupe by URL). That way neither the stale nor the
 * fresh page alone can hide an issue.
 *
 * The cache-busted request goes to Makro's origin, which some afternoons takes
 * ~145 s to answer (measured 30/10/2026) while the CDN copy answers in ~1 s.
 * Waiting for it blew the 90 s discovery budget and failed the whole chain,
 * even though the cached page already listed the new flyer. So the bust is
 * best-effort with its own budget: if it's slow we go with the cached page and
 * the next check gets another chance at the fresh one.
 */
const CACHE_BUST_TIMEOUT_MS = 20_000;

export async function findPdfLinks(offersUrl: string): Promise<PdfLink[]> {
  const headers = {
    'User-Agent': UA,
    'Cache-Control': 'no-cache',
    Pragma: 'no-cache',
  };

  const bustedUrl = (() => {
    const u = new URL(offersUrl);
    u.searchParams.set('v', String(Date.now()));
    return u.href;
  })();

  const signal = AbortSignal.timeout(CACHE_BUST_TIMEOUT_MS);
  const [plainRes, bustedHtml] = await Promise.all([
    fetchRetry(offersUrl, { headers }, offersUrl),
    // The body is read inside the same budget: the origin can stall mid-body too.
    fetchRetry(bustedUrl, { headers, signal }, bustedUrl)
      .then(async (res) =>
        res.ok ? { ok: true, text: await res.text() } : { ok: false, text: `HTTP ${res.status}` },
      )
      .catch((err: unknown) => {
        logger.warn(
          { offersUrl, err: err instanceof Error ? err.message : String(err) },
          'revista: cache-busted offers page too slow, using the cached copy only',
        );
        return { ok: false, text: 'timeout' };
      }),
  ]);

  if (!plainRes.ok && !bustedHtml.ok) {
    throw new Error(
      `Could not read ${offersUrl}: HTTP ${plainRes.status} / cache-bust ${bustedHtml.text.slice(0, 40)}`,
    );
  }

  const byUrl = new Map<string, PdfLink>();
  if (plainRes.ok) {
    for (const link of parsePdfLinksFromHtml(await plainRes.text(), offersUrl)) {
      byUrl.set(link.url, link);
    }
  }
  if (bustedHtml.ok) {
    for (const link of parsePdfLinksFromHtml(bustedHtml.text, offersUrl)) {
      byUrl.set(link.url, link);
    }
  }
  return [...byUrl.values()];
}

/** Download a PDF into memory. */
export async function downloadPdf(link: PdfLink): Promise<Buffer> {
  const res = await fetchRetry(link.url, { headers: { 'User-Agent': UA } }, link.filename);
  if (!res.ok) throw new Error(`Could not download ${link.url}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}
