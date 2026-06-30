/**
 * Page image → structured products, via GPT-4 Vision (structured outputs).
 */

import OpenAI from 'openai';
import { zodResponseFormat } from 'openai/helpers/zod';
import { z } from 'zod';
import { revistaConfig, assertOpenAiKey } from './config.js';
import { detectImage } from './image.js';
import { withRetry } from './retry.js';

// OpenAI structured outputs don't allow .optional(), so use .nullable().
const ExtractedProduct = z.object({
  name: z.string().describe('Product name exactly as printed in the magazine'),
  brand: z.string().nullable().describe('Brand, if visible'),
  ean: z.string().nullable().describe('EAN/GTIN barcode if printed'),
  price: z.number().nullable().describe('Regular price as a number, no symbols'),
  promo_price: z.number().nullable().describe('Promotional/offer price if present'),
  promo_text: z.string().nullable().describe('Promo text (e.g. "2x1", "30% off", "lleva 3 paga 2")'),
  quantity: z.string().nullable().describe('Content/quantity (e.g. "1L", "500g", "x6")'),
  confidence: z.number().describe('How sure you are you read this item correctly (0 to 1)'),
});

const PageExtraction = z.object({ products: z.array(ExtractedProduct) });

export type ExtractedProduct = z.infer<typeof ExtractedProduct>;

const SYSTEM_PROMPT = `Sos un asistente experto en leer revistas de promociones de supermercados.
Recibís la imagen de UNA página y extraés ÚNICAMENTE los productos reales que están a la venta con su precio o promoción.

Reglas:
- Extraé un item por cada producto distinto que veas con su precio/oferta.
- Ignorá decoración, logos, banners institucionales, textos legales, condiciones, horarios y cualquier cosa que no sea un producto a la venta.
- Si un dato no está visible, devolvé null (no lo inventes).
- Precios como número, sin símbolo de moneda ni separador de miles (ej. 1299.99).
- Si ves una promo (2x1, 30%, "lleva 3 paga 2", precio tachado), capturala en promo_text y/o promo_price.
- confidence refleja qué tan claro se leía el item.
- Si la página no tiene productos (tapa, índice, legales), devolvé products: [].`;

let client: OpenAI | null = null;
function getClient(): OpenAI {
  if (!client) client = new OpenAI({ apiKey: assertOpenAiKey() });
  return client;
}

/** Extract products from one page image (PNG/JPEG/WebP) using GPT-4 Vision. */
export async function extractProductsFromPage(
  image: Buffer,
  pageNumber: number,
): Promise<ExtractedProduct[]> {
  const { mime } = detectImage(image);
  const base64 = image.toString('base64');

  const completion = await withRetry(
    () =>
      getClient().chat.completions.parse({
        model: revistaConfig.visionModel,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          {
            role: 'user',
            content: [
              { type: 'text', text: `Página ${pageNumber}. Extraé los productos en promoción.` },
              {
                type: 'image_url',
                image_url: { url: `data:${mime};base64,${base64}`, detail: 'high' },
              },
            ],
          },
        ],
        response_format: zodResponseFormat(PageExtraction, 'page_extraction'),
      }),
    { label: `vision p${pageNumber}` },
  );

  return completion.choices[0]?.message.parsed?.products ?? [];
}
