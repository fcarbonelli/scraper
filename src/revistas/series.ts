/**
 * Derive a stable `series_key` for a magazine flyer so supersede / carry-forward
 * scope per SERIES, not per supermarket.
 *
 * Makro/Vital publish several concurrent series (MM weekly, GT gastronomic,
 * Folder, Nonfood, …). A new issue of MM must supersede only the previous MM,
 * not GT or Folder.
 */

/** Strip date ranges / day numbers so "Folder 20.07 al 26.07 | RESTO" → "Folder | RESTO". */
function stripDateNoise(raw: string): string {
  return raw
    .replace(/\b\d{1,2}[./-]\d{1,2}(?:[./-]\d{2,4})?\b/g, ' ') // 20.07 / 23/07/2026
    .replace(/\b\d{1,2}\b/g, ' ') // leftover day numbers like "23"
    .replace(/\b(?:del|al|de|por)\b/gi, ' ')
    .replace(/\b(?:enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiem?bre|octubre|noviembre|diciembre|jul|jun|ago|sep|oct|nov|dic)\b/gi, ' ')
    .replace(/[()]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s*\|\s*/g, ' | ')
    .trim();
}

/** Slug for DB storage: lowercase, ascii-ish, hyphenated. */
function slugify(raw: string): string {
  return raw
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9|]+/g, '-')
    .replace(/\|/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Makro filename tokens: 1-MM-JUL4.pdf, 1-GT-V5-1.pdf, SPONSOR-JUL-3.pdf,
 * ESPECIAL-dia-del-amigo-….pdf, MAKRONETTA-….pdf, Flyer-MM-….pdf
 */
export function seriesKeyFromMakroFilename(filename: string): string | null {
  const base = filename.replace(/\.pdf$/i, '');
  if (/\bmm\b/i.test(base) || /(?:^|-)mm(?:-|$)/i.test(base)) return 'mm';
  if (/\bgt\b/i.test(base) || /(?:^|-)gt(?:-|$)/i.test(base)) return 'gt';
  if (/sponsor/i.test(base)) return 'sponsor';
  // PROV and SPONSOR are the same weekly flyer ("Ofertas especiales"): Makro
  // just renames the file. `SPONSOR-JUL-3.pdf` (16/07), `4-PROV-JUL4.pdf`
  // (23/07), `prove5jul.pdf` (30/07 — no token matches, so the title decides),
  // `Flyer-PROV-AGO-1.pdf` (06/08). Supersede is per series, so two keys for
  // one flyer left the expired 30/07 issue current and still carrying prices
  // while the new one superseded an unrelated empty row. Mapping PROV to
  // 'sponsor' makes the filename agree with seriesKeyFromMakroTitle, which
  // already returns 'sponsor' for "Ofertas especiales".
  if (/\bprov\b/i.test(base) || /(?:^|-)prov(?:-|$)/i.test(base)) return 'sponsor';
  if (/makronet|neta/i.test(base)) return 'makroneta';
  if (/especial|dia.?del.?amigo/i.test(base)) return 'especial';
  return null;
}

/** Makro title: "Ofertas semanales del 23/07 al 29/07" → mm */
export function seriesKeyFromMakroTitle(title: string): string | null {
  const t = title
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  if (/semanal/.test(t)) return 'mm';
  if (/gastronom|gastron/.test(t)) return 'gt';
  if (/especiales/.test(t) && !/amigo/.test(t)) return 'sponsor';
  if (/makronet|neta/.test(t)) return 'makroneta';
  if (/amigo|especial/.test(t)) return 'especial';
  return null;
}

/**
 * Drop the branch marker Vital appends to every flyer name: "| RESTO",
 * "| TODAS", "| MALVINAS - ABASTO", "| AMBA MENOS LP", or a trailing "(RESTO)".
 *
 * Vital rotates which locality's flyer is on display, so keeping the marker
 * split one flyer line into a new series on every rotation — and a new series
 * supersedes nothing, which left the expired edition current and still feeding
 * prices into the export. `download.ts` already treats the localities as one
 * flyer ("the products are the same across localities"); this makes series_key
 * agree with that.
 */
function stripBranchSuffix(raw: string): string {
  return raw
    .replace(/\|.*$/, ' ')
    .replace(/\([^)]*\)\s*$/, ' ')
    .trim();
}

/**
 * Vital data-name: "Folder 20.07 al 26.07 | RESTO" → "folder"
 * Branch and dates are both noise; what identifies the series is what's left.
 */
export function seriesKeyFromVitalDataName(dataName: string): string {
  const cleaned = stripDateNoise(stripBranchSuffix(dataName));
  const slug = slugify(cleaned);
  if (slug) return slug;
  return 'default';
}

/**
 * The rule as it stood before the branch suffix was dropped.
 *
 * Kept for exactly one purpose: `scripts/revistas-rekey-series.ts` must be able
 * to tell which stored keys THIS change is responsible for, and re-key only
 * those. Many stored keys came from migration 015's SQL backfill and already
 * disagree with what the TypeScript derives (`jul2mm.pdf` is stored `mm` but
 * derives `jul2mm-pdf`); the re-key must leave that pre-existing drift alone
 * rather than "fixing" it and scrambling Makro's supersede chains.
 *
 * Not used by the pipeline. Delete once the re-key has run everywhere.
 */
export function legacySeriesKeyFromVitalDataName(dataName: string): string {
  const slug = slugify(stripDateNoise(dataName));
  return slug || 'default';
}

/**
 * Pick the best series key for an html-pdf-links candidate.
 * Prefer Vital data-name → Makro filename token → Makro title → slug of label → default.
 */
export function deriveSeriesKey(args: {
  dataName?: string | null;
  filename?: string | null;
  title?: string | null;
  label?: string | null;
  strategy?: 'html-pdf-links' | 'pubhtml5' | 'publuu';
}): string {
  if (args.strategy === 'pubhtml5' || args.strategy === 'publuu') return 'default';

  if (args.dataName) return seriesKeyFromVitalDataName(args.dataName);

  const fromFile = args.filename ? seriesKeyFromMakroFilename(args.filename) : null;
  if (fromFile) return fromFile;

  const fromTitle = args.title ? seriesKeyFromMakroTitle(args.title) : null;
  if (fromTitle) return fromTitle;

  const fromLabel = args.label ? seriesKeyFromMakroFilename(args.label) ?? seriesKeyFromMakroTitle(args.label) : null;
  if (fromLabel) return fromLabel;

  if (args.label) {
    const slug = slugify(stripDateNoise(args.label));
    if (slug) return slug;
  }
  return 'default';
}
