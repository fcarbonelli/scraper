/**
 * Unit tests for series_key derivation (Makro / Vital / default).
 * Offline — no DB, no network.
 */
import { describe, it, expect } from 'vitest';
import {
  deriveSeriesKey,
  seriesKeyFromMakroFilename,
  seriesKeyFromMakroTitle,
  seriesKeyFromVitalDataName,
} from './series.js';

describe('seriesKeyFromMakroFilename', () => {
  it('detects MM / GT / SPONSOR / PROV / MAKRONETA / ESPECIAL', () => {
    expect(seriesKeyFromMakroFilename('1-MM-JUL4.pdf')).toBe('mm');
    expect(seriesKeyFromMakroFilename('1-GT-V5-1.pdf')).toBe('gt');
    expect(seriesKeyFromMakroFilename('SPONSOR-JUL-3.pdf')).toBe('sponsor');
    expect(seriesKeyFromMakroFilename('MAKRONETTA-V6-17al19.pdf')).toBe('makroneta');
    expect(seriesKeyFromMakroFilename('ESPECIAL-dia-del-amigo-MK-V4-16al26.pdf')).toBe('especial');
    expect(seriesKeyFromMakroFilename('Flyer-MM-CORREGIDO-JUNIO-4.pdf')).toBe('mm');
  });

  // PROV and SPONSOR name the same weekly "Ofertas especiales" flyer, so they
  // must land on ONE series or the new issue supersedes the wrong row and the
  // expired one keeps carrying prices.
  it('maps the PROV token onto the sponsor series', () => {
    expect(seriesKeyFromMakroFilename('4-PROV-JUL4.pdf')).toBe('sponsor');
    expect(seriesKeyFromMakroFilename('Flyer-PROV-AGO-1.pdf')).toBe('sponsor');
    // Same flyer, third naming convention: no token at all → the title decides.
    expect(seriesKeyFromMakroFilename('prove5jul.pdf')).toBeNull();
    expect(seriesKeyFromMakroTitle('Ofertas especiales del 30/07 al 05/08')).toBe('sponsor');
  });
});

describe('seriesKeyFromMakroTitle', () => {
  it('maps Spanish titles to series', () => {
    expect(seriesKeyFromMakroTitle('Ofertas semanales del 23/07 al 29/07')).toBe('mm');
    expect(seriesKeyFromMakroTitle('Ofertas Gastronómicas del 16/07 al 29/07')).toBe('gt');
    expect(seriesKeyFromMakroTitle('Ofertas especiales del 16/07 al 22/07')).toBe('sponsor');
    expect(seriesKeyFromMakroTitle('Especial día del amigo del 16/07 al 26/07')).toBe('especial');
  });
});

describe('seriesKeyFromVitalDataName', () => {
  it('strips date ranges and the branch suffix', () => {
    expect(seriesKeyFromVitalDataName('Folder 20.07 al 26.07 | RESTO')).toBe('folder');
    expect(seriesKeyFromVitalDataName('Folder Nonfood 20.07 al 26.07 | RESTO')).toBe(
      'folder-nonfood',
    );
    expect(seriesKeyFromVitalDataName('Especial Frescos 20.07 al 26.07 | TODAS')).toBe(
      'especial-frescos',
    );
    expect(seriesKeyFromVitalDataName('Aviso Marca Propia 20.07 al 26.07 | TODAS')).toBe(
      'aviso-marca-propia',
    );
    expect(seriesKeyFromVitalDataName('Aviso Solo por JUEVES 23/7 (RESTO)')).toBe(
      'aviso-solo-jueves',
    );
  });

  it('gives one key to the same flyer line across branch rotations', () => {
    // Vital swaps which locality is on display; that must not fork the series,
    // or the new edition supersedes nothing and the expired one keeps paying out.
    expect(seriesKeyFromVitalDataName('Folder 27.07 al 02.08 | RESTO')).toBe(
      seriesKeyFromVitalDataName('Folder 03.08 al 09.08 | MALVINAS - ABASTO'),
    );
    expect(seriesKeyFromVitalDataName('Folder Nonfood 27.07 al 02.08 | RESTO')).toBe(
      seriesKeyFromVitalDataName('Folder Nonfood 03.08 al 09.08 | AMBA MENOS LP'),
    );
  });

  it('still separates distinct flyer lines', () => {
    expect(seriesKeyFromVitalDataName('Folder 03.08 al 09.08 | TODAS')).not.toBe(
      seriesKeyFromVitalDataName('Folder Nonfood 03.08 al 09.08 | TODAS'),
    );
  });
});

describe('deriveSeriesKey', () => {
  it('prefers Vital data-name over filename', () => {
    expect(
      deriveSeriesKey({ dataName: 'Folder 20.07 al 26.07 | RESTO', filename: '112642.pdf' }),
    ).toBe('folder');
  });

  it('uses Makro filename when no data-name', () => {
    expect(
      deriveSeriesKey({
        filename: '1-MM-JUL4.pdf',
        title: 'Ofertas semanales del 23/07 al 29/07',
      }),
    ).toBe('mm');
  });

  it('returns default for flipbook strategies', () => {
    expect(deriveSeriesKey({ strategy: 'pubhtml5', label: 'anything' })).toBe('default');
    expect(deriveSeriesKey({ strategy: 'publuu', label: 'anything' })).toBe('default');
  });
});
