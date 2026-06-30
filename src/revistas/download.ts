/**
 * PDF discovery helpers for the `html-pdf-links` strategy (Makro, Vital).
 *
 * Finds the PDF links on a chain's "ofertas" page and downloads them into
 * memory. No disk writes — the orchestrator/worker is stateless.
 */

import path from 'node:path';
import { fetchRetry } from './retry.js';
import { UA } from './sources-shared.js';

export interface PdfLink {
  url: string;
  filename: string;
}

function toPdfLink(url: string): PdfLink {
  return { url, filename: decodeURIComponent(path.basename(new URL(url).pathname)) };
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
      if (!byName.has(name)) byName.set(name, toPdfLink(new URL(pdf, base).href));
    } catch {
      /* invalid URL → skip */
    }
  }
  return [...byName.values()];
}

/** Fetch the offers page HTML and extract the PDF links. */
export async function findPdfLinks(offersUrl: string): Promise<PdfLink[]> {
  const res = await fetchRetry(offersUrl, { headers: { 'User-Agent': UA } }, offersUrl);
  if (!res.ok) throw new Error(`Could not read ${offersUrl}: HTTP ${res.status}`);
  const html = await res.text();

  // 1) If the page marks displayed folletos with data-name (Vital), use only those.
  const displayed = findDisplayedFolletos(html, offersUrl);
  if (displayed.length > 0) return displayed;

  // 2) Otherwise grab every .pdf in the HTML (Makro: direct CDN links).
  const found = new Set<string>();
  const re = /['"(]([^'"()\s]+?\.pdf)(?:\?[^'"()\s]*)?['")]/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const href = m[1];
    if (!href) continue;
    try {
      found.add(new URL(href, offersUrl).href);
    } catch {
      /* invalid URL → skip */
    }
  }
  return [...found].map(toPdfLink);
}

/** Download a PDF into memory. */
export async function downloadPdf(link: PdfLink): Promise<Buffer> {
  const res = await fetchRetry(link.url, { headers: { 'User-Agent': UA } }, link.filename);
  if (!res.ok) throw new Error(`Could not download ${link.url}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}
