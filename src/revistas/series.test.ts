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
  it('detects MM / GT / SPONSOR / MAKRONETA / ESPECIAL', () => {
    expect(seriesKeyFromMakroFilename('1-MM-JUL4.pdf')).toBe('mm');
    expect(seriesKeyFromMakroFilename('1-GT-V5-1.pdf')).toBe('gt');
    expect(seriesKeyFromMakroFilename('SPONSOR-JUL-3.pdf')).toBe('sponsor');
    expect(seriesKeyFromMakroFilename('MAKRONETTA-V6-17al19.pdf')).toBe('makroneta');
    expect(seriesKeyFromMakroFilename('ESPECIAL-dia-del-amigo-MK-V4-16al26.pdf')).toBe('especial');
    expect(seriesKeyFromMakroFilename('Flyer-MM-CORREGIDO-JUNIO-4.pdf')).toBe('mm');
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
  it('strips date ranges and keeps branch suffix', () => {
    expect(seriesKeyFromVitalDataName('Folder 20.07 al 26.07 | RESTO')).toBe('folder-resto');
    expect(seriesKeyFromVitalDataName('Folder Nonfood 20.07 al 26.07 | RESTO')).toBe(
      'folder-nonfood-resto',
    );
    expect(seriesKeyFromVitalDataName('Especial Frescos 20.07 al 26.07 | TODAS')).toBe(
      'especial-frescos-todas',
    );
    expect(seriesKeyFromVitalDataName('Aviso Marca Propia 20.07 al 26.07 | TODAS')).toBe(
      'aviso-marca-propia-todas',
    );
    expect(seriesKeyFromVitalDataName('Aviso Solo por JUEVES 23/7 (RESTO)')).toBe(
      'aviso-solo-jueves-resto',
    );
  });
});

describe('deriveSeriesKey', () => {
  it('prefers Vital data-name over filename', () => {
    expect(
      deriveSeriesKey({ dataName: 'Folder 20.07 al 26.07 | RESTO', filename: '112642.pdf' }),
    ).toBe('folder-resto');
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
