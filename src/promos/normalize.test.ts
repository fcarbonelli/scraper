/**
 * Unit tests for the promo normalization helpers (no DB, no network).
 * Focus: parseDiscountPct's guard against 100% (and other) false positives that
 * were flooding the dashboard (raffles, "100% online", financing, generic text).
 */

import { describe, it, expect } from 'vitest';
import { parseDiscountPct, parseInstallments } from './normalize.js';

describe('parseDiscountPct — legitimate discounts', () => {
  it('parses a plain "N% de descuento"', () => {
    expect(parseDiscountPct('25% de descuento en supermercados')).toBe(25);
  });

  it('parses "N% off"', () => {
    expect(parseDiscountPct('30% OFF en indumentaria')).toBe(30);
  });

  it('parses "ahorrá N%"', () => {
    expect(parseDiscountPct('Ahorrá 15% todos los martes')).toBe(15);
  });

  it('parses a reintegro (cashback) percentage', () => {
    expect(parseDiscountPct('20% de reintegro con tope de $8.000')).toBe(20);
  });

  it('takes the largest qualifying discount when several appear', () => {
    expect(parseDiscountPct('10% de descuento y hasta 40% de ahorro')).toBe(40);
  });

  it('accepts an explicitly worded 100% discount', () => {
    expect(parseDiscountPct('100% de descuento en tu primera compra')).toBe(100);
    expect(parseDiscountPct('100% OFF — Uber One primer mes')).toBe(100);
    expect(parseDiscountPct('Reintegro del 100% en transporte')).toBe(100);
  });
});

describe('parseDiscountPct — false positives that must NOT be read as discounts', () => {
  it('ignores "100% online" (channel, not a discount)', () => {
    expect(parseDiscountPct('Comprá 100% online con Cuenta DNI')).toBeNull();
  });

  it('ignores "100% digital"', () => {
    expect(parseDiscountPct('Gestión 100% digital')).toBeNull();
  });

  it('ignores raffles ("sorteo") that mention 100%', () => {
    expect(parseDiscountPct('Premio sorteo del millón: ganá el 100% de tu compra')).toBeNull();
  });

  it('ignores a bare 100% with no discount context (generic campaign)', () => {
    expect(parseDiscountPct('Día de la secretaria 100%')).toBeNull();
    expect(parseDiscountPct('Válido en el 100% del país')).toBeNull();
  });

  it('ignores an extreme 100% in a financing-rate context (TNA/TEA)', () => {
    expect(parseDiscountPct('Financiación TNA 100%')).toBeNull();
    expect(parseDiscountPct('Comprá con MODO — TEA 100%')).toBeNull();
  });

  it('returns null when there is no percentage at all', () => {
    expect(parseDiscountPct('3 cuotas sin interés')).toBeNull();
    expect(parseDiscountPct('')).toBeNull();
    expect(parseDiscountPct(null)).toBeNull();
  });
});

describe('parseInstallments (unchanged behaviour, sanity)', () => {
  it('parses "12 cuotas"', () => {
    expect(parseInstallments('12 cuotas sin interés')).toBe(12);
  });
  it('returns null without a cuotas token', () => {
    expect(parseInstallments('25% de descuento')).toBeNull();
  });
});
