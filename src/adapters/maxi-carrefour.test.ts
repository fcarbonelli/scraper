/**
 * Maxi Carrefour price split: today's price stays `price`, the crossed-out
 * regular becomes `listPrice`, and the offer badge becomes the promotion name.
 */

import { describe, expect, it } from 'vitest';
import { parseMaxiCarrefourFragment } from './maxi-carrefour.js';

function card(opts: {
  dataPrice: string;
  saleName?: string;
  struck?: string;
  relatedStruck?: string;
}): string {
  const struck = opts.struck
    ? `<div class="p_item_card_discounted_number_price"><s>${opts.struck}</s></div>`
    : '';
  const related = opts.relatedStruck
    ? `<div class="p_header">Productos Relacionados: </div>
       <div class="p_item_card_discounted_number_price"><s>${opts.relatedStruck}</s></div>
       <div class="cart_button" data-price="1" data-saleName="Otra oferta" data-ean="1" data-description="otro">`
    : '';
  return `
    <div class="sale_name">${opts.saleName ?? ''}</div>
    <div class="p_item_card_number_price">$ ${opts.dataPrice}</div>
    ${struck}
    <div class="cart_button" data-ean="7791813888468"
         data-description="gaseosa"
         data-saleName="${opts.saleName ?? ''}"
         data-price="${opts.dataPrice}"
         data-sector="bebidas" data-section="Gaseosas" data-category="Gaseosas cola">
    </div>
    ${related}
  `;
}

describe('parseMaxiCarrefourFragment offers', () => {
  it('keeps the selling price and stores the crossed-out regular plus the badge', () => {
    const parsed = parseMaxiCarrefourFragment(
      card({
        dataPrice: '2,990.00',
        saleName: 'Ahorro al Máximo',
        struck: '$ 3.737,50',
      }),
      { externalId: '7791813888468' },
      { hasSession: true },
    );
    expect(parsed.kind).toBe('ok');
    if (parsed.kind !== 'ok') return;
    expect(parsed.result.price).toBe(2990);
    expect(parsed.result.listPrice).toBe(3737.5);
    expect(parsed.result.promotions).toEqual([
      { type: 'discount', description: 'Ahorro al Máximo' },
    ]);
  });

  it('leaves list price empty when the product is not on offer', () => {
    const parsed = parseMaxiCarrefourFragment(
      card({ dataPrice: '1455' }),
      { externalId: '7790132098459' },
      { hasSession: true },
    );
    expect(parsed.kind).toBe('ok');
    if (parsed.kind !== 'ok') return;
    expect(parsed.result.price).toBe(1455);
    expect(parsed.result.listPrice).toBeUndefined();
    expect(parsed.result.promotions).toEqual([]);
  });

  it('ignores a strikethrough that belongs to a related product', () => {
    const parsed = parseMaxiCarrefourFragment(
      card({ dataPrice: '1455', relatedStruck: '$ 9.999,00' }),
      { externalId: '7790132098459' },
      { hasSession: true },
    );
    expect(parsed.kind).toBe('ok');
    if (parsed.kind !== 'ok') return;
    expect(parsed.result.listPrice).toBeUndefined();
    expect(parsed.result.promotions).toEqual([]);
  });

  it('drops a list price more than 10× the selling price', () => {
    const parsed = parseMaxiCarrefourFragment(
      card({ dataPrice: '100', struck: '$ 5.000,00' }),
      { externalId: '1' },
      { hasSession: true },
    );
    expect(parsed.kind).toBe('ok');
    if (parsed.kind !== 'ok') return;
    expect(parsed.result.listPrice).toBeUndefined();
  });
});
