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
 * Vital data-name: "Folder 20.07 al 26.07 | RESTO" → "folder-resto"
 * Keeps the branch suffix (RESTO/TODAS) so locality variants stay distinct.
 */
export function seriesKeyFromVitalDataName(dataName: string): string {
  const cleaned = stripDateNoise(dataName);
  const slug = slugify(cleaned);
  if (slug) return slug;
  return 'default';
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
