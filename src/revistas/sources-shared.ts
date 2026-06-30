/** Shared bits for revista source strategies. */

/** Browser UA — some CDNs/flipbook hosts reject non-browser user agents. */
export const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

/** How a chain publishes its magazine, read from supermarkets.config.revista. */
export interface RevistaStrategyConfig {
  strategy: 'html-pdf-links' | 'pubhtml5' | 'publuu';
  /** Offers/home page to discover PDFs or the current flipbook from. */
  offersUrl?: string;
  /** Fixed PubHTML5 book URL (fallback when the home doesn't link one). */
  pubhtml5Url?: string;
}

/**
 * One magazine = a set of page images. PDFs and flipbooks both normalize to this.
 * `pages` are kept in memory; the pipeline uploads them to storage as it goes.
 */
export interface MagazineSource {
  /** Stable id for this issue (hash of its source), used for dedup + storage path. */
  id: string;
  /** Human-readable label (PDF filename or flipbook title). */
  label: string;
  /** Source URL the issue was discovered/downloaded from. */
  sourceUrl: string;
  /** Page images (PNG/JPEG/WebP). */
  pages: Buffer[];
  /** Real number of the first page in `pages` (1-based; >1 if a range was requested). */
  firstPage: number;
  /** Total byte size of the source (sum of page buffers), for the dedup hash. */
  fileSize: number;
}

/** Page selection (1-based, inclusive). `{start:1,end:N}` = first N pages. */
export interface PageSelection {
  start: number;
  end?: number;
}

/** Slice a list to the requested selection and report the real first page number. */
export function applySelection<T>(
  all: T[],
  sel?: PageSelection,
): { items: T[]; firstPage: number } {
  if (!sel) return { items: all, firstPage: 1 };
  const start = Math.max(1, sel.start);
  const end = sel.end ?? all.length;
  return { items: all.slice(start - 1, end), firstPage: start };
}
