import { describe, expect, it } from 'vitest';
import { parseFlyerPeriod, samePeriod } from './period.js';

/** Every label below is a real value read out of `revista_magazines`. */
const DETECTED = new Date('2026-08-03T13:00:00Z');

describe('parseFlyerPeriod — explicit ranges', () => {
  const cases: [string, string, string][] = [
    ['Folder 03.08 al 09.08 | MALVINAS - ABASTO', '2026-08-03', '2026-08-09'],
    ['Folder Nonfood 27.07 al 02.08 | RESTO', '2026-07-27', '2026-08-02'],
    ['Aviso Niñez del 03.08 al 09.08 | TODAS', '2026-08-03', '2026-08-09'],
    ['Ofertas semanales del 30/07 al 05/08', '2026-07-30', '2026-08-05'],
    ['Ofertas Gastronómicas del 30/07 al 12/08', '2026-07-30', '2026-08-12'],
    ['Especial día del amigo del 16/07 al 26/07', '2026-07-16', '2026-07-26'],
    ['Aviso 1 FDS 24.07 al 26.07 | RESTO', '2026-07-24', '2026-07-26'],
  ];

  for (const [label, start, end] of cases) {
    it(`reads "${label}"`, () => {
      const p = parseFlyerPeriod(label, DETECTED);
      expect(p).toEqual({ start, end, confidence: 'exact' });
    });
  }
});

describe('parseFlyerPeriod — single-day flyers', () => {
  it('treats a lone date as a one-day period', () => {
    expect(parseFlyerPeriod('Aviso Solo por LUNES 3/8 (RESTO)', DETECTED)).toEqual({
      start: '2026-08-03',
      end: '2026-08-03',
      confidence: 'exact',
    });
  });

  it('reads a zero-padded lone date', () => {
    expect(parseFlyerPeriod('Aviso Solo por JUEVES 23/7 (RESTO)', DETECTED)).toEqual({
      start: '2026-07-23',
      end: '2026-07-23',
      confidence: 'exact',
    });
  });
});

describe('parseFlyerPeriod — coarse phrases are inferred, never exact', () => {
  it('maps a first fortnight to days 1-15', () => {
    expect(parseFlyerPeriod('Agosto primera quincena', DETECTED)).toEqual({
      start: '2026-08-01',
      end: '2026-08-15',
      confidence: 'inferred',
    });
  });

  it('maps a second fortnight to day 16 through month end', () => {
    const p = parseFlyerPeriod('Agosto segunda quincena', DETECTED);
    expect(p).toEqual({ start: '2026-08-16', end: '2026-08-31', confidence: 'inferred' });
  });
});

describe('parseFlyerPeriod — returns null rather than guessing', () => {
  // These are the real labels that carry no period. Reading a date out of any
  // of them would be worse than admitting we do not know.
  const noPeriod = [
    'PubHTML5 flipbook',
    'Revista',
    '112141.pdf',
    'jul2mm.pdf',
    'sponjun4-2.pdf', // "4-2" must NOT be read as 4 February
    'MAKRONETTA-V6-17al19.pdf', // "17al19" has no day/month separator
    'Flyer-GT-JUNIO-3-Corregido.pdf',
    'Flyer-MM-CORREGIDO-JUNIO-4.pdf',
    'jun4etamakro.pdf',
    '',
  ];

  for (const label of noPeriod) {
    it(`returns null for "${label}"`, () => {
      expect(parseFlyerPeriod(label, DETECTED)).toBeNull();
    });
  }

  it('rejects an impossible day', () => {
    expect(parseFlyerPeriod('Folder 31.02 al 31.02', DETECTED)).toBeNull();
  });
});

describe('parseFlyerPeriod — year inference around the December wrap', () => {
  it('carries the end into the next year when it precedes the start', () => {
    const p = parseFlyerPeriod('Ofertas del 28/12 al 03/01', new Date('2026-12-28T13:00:00Z'));
    expect(p).toEqual({ start: '2026-12-28', end: '2027-01-03', confidence: 'exact' });
  });

  it('walks the year back when the flyer is seen in January', () => {
    const p = parseFlyerPeriod('Ofertas del 28/12 al 03/01', new Date('2027-01-02T13:00:00Z'));
    expect(p).toEqual({ start: '2026-12-28', end: '2027-01-03', confidence: 'exact' });
  });

  it('anchors to the detection date, not to today', () => {
    const p = parseFlyerPeriod('Folder 20.07 al 26.07', new Date('2025-07-23T13:00:00Z'));
    expect(p?.start).toBe('2025-07-20');
  });
});

describe('samePeriod', () => {
  const a = parseFlyerPeriod('Folder 03.08 al 09.08 | RESTO', DETECTED);

  it('matches two labels covering the same days', () => {
    const b = parseFlyerPeriod('Folder 03.08 al 09.08 | MALVINAS - ABASTO', DETECTED);
    expect(samePeriod(a, b)).toBe(true);
  });

  it('separates different periods', () => {
    const b = parseFlyerPeriod('Folder 27.07 al 02.08 | RESTO', DETECTED);
    expect(samePeriod(a, b)).toBe(false);
  });

  it('never claims a match when either side is unknown', () => {
    expect(samePeriod(a, null)).toBe(false);
    expect(samePeriod(null, null)).toBe(false);
  });
});
