/**
 * Pure parser for a MercadoLibre catalog PDP (`/p/<catalogId>?item_id=<itemId>`)
 * as rendered by a real browser. No env/db imports, so it is unit-testable.
 *
 * Three pieces of the server-rendered HTML are read:
 *   - The tracking blob `"item_id":"MLA…","catalog_product_id":"MLA…","seller_id":N`
 *     identifies WHICH offer the page is showing (the `item_id` pin can be
 *     ignored by ML when that listing is gone, and then another seller wins).
 *   - The JSON-LD `Product.offers` carries the displayed price, currency and
 *     availability.
 *   - The pricing blob `"price":X,"original_price":Y,"currency_id":"ARS"` gives
 *     the struck-through regular price when the offer is on sale (Y is null or
 *     absent otherwise). We only trust the blob whose `price` equals the
 *     JSON-LD price, so another seller's pricing elsewhere on the page can't leak.
 */

/** The offer a MercadoLibre PDP is displaying. */
export interface MlPdpOffer {
  itemId: string | undefined;
  catalogId: string | undefined;
  sellerId: number | undefined;
  price: number;
  /** Regular price when on sale (strictly greater than `price`). */
  originalPrice?: number;
  currency: string;
  inStock: boolean;
  name?: string;
  imageUrl?: string;
}

const ITEM_INFO_RE = /"item_id":"(ML[A-Z]\d+)","catalog_product_id":"(ML[A-Z]\w*)","seller_id":(\d+)/;
const LD_JSON_RE = /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g;
const PRICING_RE = /"price":([\d.]+),"original_price":([\d.]+|null),"currency_id":"([A-Z]{3})"/g;

interface LdOffer {
  price?: number | string;
  priceCurrency?: string;
  availability?: string;
}

interface LdProduct {
  name?: string;
  image?: string | string[];
  offers?: LdOffer | LdOffer[];
}

/** First JSON-LD block that carries an offer with a price. */
function findLdProduct(html: string): { product: LdProduct; offer: LdOffer } | undefined {
  for (const m of html.matchAll(LD_JSON_RE)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(m[1]!);
    } catch {
      continue;
    }
    const product = parsed as LdProduct;
    const offer = Array.isArray(product.offers) ? product.offers[0] : product.offers;
    if (offer && offer.price !== undefined && Number.isFinite(Number(offer.price))) {
      return { product, offer };
    }
  }
  return undefined;
}

/** Struck-through price from the pricing blob that matches `price`, if any. */
function findOriginalPrice(html: string, price: number): number | undefined {
  for (const m of html.matchAll(PRICING_RE)) {
    if (Number(m[1]) !== price) continue;
    const original = m[2] === 'null' ? NaN : Number(m[2]);
    return Number.isFinite(original) && original > price ? original : undefined;
  }
  return undefined;
}

/** Parse the displayed offer, or null when the page has no priced offer. */
export function parseMlPdp(html: string): MlPdpOffer | null {
  const ld = findLdProduct(html);
  if (!ld) return null;
  const price = Number(ld.offer.price);
  if (!Number.isFinite(price) || price <= 0) return null;

  const info = html.match(ITEM_INFO_RE);
  const originalPrice = findOriginalPrice(html, price);
  const image = Array.isArray(ld.product.image) ? ld.product.image[0] : ld.product.image;

  const offer: MlPdpOffer = {
    itemId: info?.[1],
    catalogId: info?.[2],
    sellerId: info?.[3] !== undefined ? Number(info[3]) : undefined,
    price,
    currency: ld.offer.priceCurrency || 'ARS',
    inStock: !/OutOfStock|SoldOut|Discontinued/i.test(ld.offer.availability ?? ''),
  };
  if (originalPrice !== undefined) offer.originalPrice = originalPrice;
  if (ld.product.name) offer.name = ld.product.name;
  if (image) offer.imageUrl = image;
  return offer;
}

/** True when the HTML is ML's anti-bot login wall or its generic error page. */
export function isMlBlockPage(html: string, url: string): boolean {
  return (
    url.includes('/gz/account-verification') ||
    html.includes('Hubo un error accediendo a esta pagina') ||
    html.includes('Para continuar, ingresa a tu cuenta')
  );
}
