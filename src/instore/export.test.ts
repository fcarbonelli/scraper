/**
 * Unit tests for the in-store relevamiento CSV writer (no DB).
 */

import { describe, it, expect } from 'vitest';
import { toInStoreCsv, INSTORE_EXPORT_COLUMNS } from './exportFormat.js';

describe('toInStoreCsv', () => {
  it('writes a BOM + header + one data row with Spanish column names', () => {
    const csv = toInStoreCsv([
      {
        fecha: '2026-08-24',
        cadena: 'DIARCO',
        provincia: 'Buenos Aires',
        localidad: 'San Martín',
        direccion: 'Av. San Martín 1234',
        relevador: 'Juan Pérez',
        ean: '7790040999999',
        producto: 'Gaseosa Cola 2.25L',
        marca: 'COCA COLA',
        precio_regular: 2590,
        precio_mayorista: 2190,
        unidades_mayorista: 6,
        sin_precio: '',
        observaciones: 'Góndola, se agota',
        estado_revision: 'pending',
        visit_id: 'v1',
        entry_id: 'e1',
      },
    ]);

    expect(csv.startsWith('\uFEFF')).toBe(true);
    const lines = csv.replace(/^\uFEFF/, '').split('\r\n');
    expect(lines[0]).toBe(INSTORE_EXPORT_COLUMNS.map((c) => c.header).join(','));
    expect(lines[1]).toContain('DIARCO');
    expect(lines[1]).toContain('7790040999999');
    expect(lines[1]).toContain('"Góndola, se agota"');
  });

  it('leaves price cells empty for a sin-precio row', () => {
    const csv = toInStoreCsv([
      {
        fecha: '2026-08-24',
        cadena: 'NINI',
        provincia: null,
        localidad: null,
        direccion: null,
        relevador: 'Ana',
        ean: '7790001',
        producto: 'Lavandina 2 L',
        marca: 'AYUDIN',
        precio_regular: null,
        precio_mayorista: null,
        unidades_mayorista: null,
        sin_precio: 'si',
        observaciones: null,
        estado_revision: 'pending',
        visit_id: 'v2',
        entry_id: 'e2',
      },
    ]);
    const data = csv.replace(/^\uFEFF/, '').split('\r\n')[1] ?? '';
    expect(data).toContain(',si,');
    expect(data).toContain('7790001');
  });
});
