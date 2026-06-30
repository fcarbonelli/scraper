/**
 * Render a PDF (in memory) to one PNG buffer per page.
 *
 * Uses pdf-to-img (pure-JS pdfjs + prebuilt canvas) so there's no native
 * `canvas` build step. `scale` 2–3 gives enough resolution for the model to
 * read small prices.
 */

import { pdf } from 'pdf-to-img';

export async function renderPdfToImages(
  data: Buffer,
  scale = 2.5,
): Promise<Buffer[]> {
  const document = await pdf(data, { scale });
  const pages: Buffer[] = [];
  for await (const page of document) {
    pages.push(page);
  }
  return pages;
}
