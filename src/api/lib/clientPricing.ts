/**
 * Client-facing pricing contract.
 *
 * The external client integrates against `GET /v1/data/pricing` and expects a
 * specific envelope:
 *
 *   { ProcesadoOk, Error, PriceData[], Paginacion }
 *
 * This module owns that contract: the field mapping from the `client_base` SQL
 * view to the client's exact field names, value stringification (every value is
 * delivered as text), and the success/error envelope builders.
 *
 * It is shared by:
 *   - src/api/routes/data.ts            (success responses)
 *   - src/api/middleware/errorHandler.ts (error responses for this path, so auth
 *                                         and unexpected errors keep the same shape)
 */

import { suplenciaFor } from '../../shared/suplencias.js';
import { pesoEnCategoriaFor } from '../../shared/pesoEnCategoria.js';
import { nuevaCategorizacionFor } from '../../shared/nuevaCategorizacion.js';
import { ixTargetVsCompetenciaFor } from '../../shared/ixTargetVsCompetencia.js';
import { diffVsEdp, idxVsCompetencia } from '../../shared/priceIndicators.js';

/** Path of the client pricing endpoint, used to route error formatting. */
export const CLIENT_PRICING_PATH = '/v1/data/pricing';

/** Pagination metadata block included alongside the data. */
export interface Paginacion {
  Pagina: number;
  Limite: number;
  TotalRegistros: number;
  TotalPaginas: number;
}

/** A single pricing record, exactly as the client expects it (all strings). */
export interface PriceDataItem {
  Pricing_Id: string;
  Fecha_Creacion: string;
  Fecha_Modificacion: string;
  /** Date the price was captured (scraped_at::date). Usually same day as creation. */
  Fecha_Relevamiento: string;
  Provincia: string;
  Zona: string;
  Mes: string;
  Semana: string;
  Canal: string;
  Cadena: string;
  Categoria: string;
  Subcategoria: string;
  Fabricante: string;
  Marca: string;
  Formato: string;
  Variedad: string;
  /**
   * Client "SUPLENCIAS" flag for this EAN: 'TITULAR' (primary/reference item),
   * 'SUPLENTE' (stand-in), or '' when the client didn't tag the product.
   * Hardcoded reference data keyed by EAN (see src/shared/suplencias.ts).
   */
  Suplencias: string;
  Descripcion_Para_Forms: string;
  EAN: string;
  Desc_Sku_Sitio: string;
  /**
   * Real-world situation of the record: 'ok' (a real price), 'out_of_stock',
   * 'not_found', or 'delisted'. When not 'ok', the price fields come back empty.
   * The internal 'scrape_failed' marker is filtered out by the client_base view
   * and never reaches the client.
   */
  Estado: string;
  Precio_Regular: string;
  /** Price under the 1st active promotion. Empty when there's no promo. */
  Precio_c_Oferta_1: string;
  /** Price under a 2nd concurrent promotion. Empty when there's no 2nd promo. */
  Precio_c_Oferta_2: string;
  /** Human-readable description of the 1st promotion. */
  Promocion_1: string;
  /** Human-readable description of the 2nd promotion. */
  Promocion_2: string;
  /** Effective unit discount (0..1) derived from list vs. offer price. */
  Descuento_Unitario: string;
  URL: string;
  Precio_Mas_Bajo: string;
  /** Precio objetivo EDP del cliente para SUPERMERCADOS (canal SPM). Vacío en otras filas. */
  PRECIO_TGT_SPM: string;
  /**
   * Precio objetivo EDP del cliente para MAYORISTAS NACIONALES (canal MAY).
   * Antes se llamaba PRECIO_TGT_MAY. Vacío en supermercados y en mayoristas
   * regionales (ver PRECIO_TGT_WHS_REG).
   */
  PRECIO_TGT_WHS: string;
  /**
   * Precio objetivo EDP del cliente para MAYORISTAS REGIONALES (canal MAY REG).
   * Sólo se completa en filas de mayoristas regionales; vacío en el resto.
   */
  PRECIO_TGT_WHS_REG: string;
  /**
   * Precio_Regular vs. el precio objetivo EDP del cliente, como porcentaje
   * entero ("23%", "-5%"). Se toma el target del canal de la fila
   * (PRECIO_TGT_SPM | PRECIO_TGT_WHS | PRECIO_TGT_WHS_REG). Vacío si no hay
   * precio o no hay target (ver priceIndicators.ts).
   */
  DIFF_VS_EDP: string;
  /**
   * Índice de precio del competidor vs. el producto Ayudín equivalente, como
   * porcentaje entero. Se completa sólo en las filas de competidor
   * (NUEVA_CATEGORIZACION termina en "A1"), dividiendo por el precio del producto
   * Ayudín ("…A") en el MISMO supermercado y MISMA fecha. Vacío en los demás
   * casos (ver priceIndicators.ts).
   */
  IDX_VS_COMPETENCIA: string;
  /**
   * Índice "IX TARGET vs COMPETENCIA" provisto por el cliente, hardcodeado y
   * matcheado por EAN (ver src/shared/ixTargetVsCompetencia.ts). Vacío para los
   * EAN que el cliente no clasificó.
   */
  IX_TARGET_VS_COMPETENCIA: string;
  /**
   * Peso (participación) del producto dentro de su categoría (ratio 0..1).
   * Dato de referencia del cliente, hardcodeado y matcheado por EAN
   * (ver src/shared/pesoEnCategoria.ts). Vacío para EANs no clasificados.
   */
  PESO_PRODUCTO_EN_CATEGORIA: string;
  /**
   * Código de "nueva categorización" analítica del cliente (ej.
   * "LAVANDINAS_REG_1L_A1"). Dato de referencia hardcodeado y matcheado por EAN
   * (ver src/shared/nuevaCategorizacion.ts). Vacío para EANs no clasificados.
   */
  NUEVA_CATEGORIZACION: string;
  /** Legacy — reemplazado por IDX_VS_COMPETENCIA. Se mantiene vacío por compatibilidad. */
  Index_Competencia: string;
  /** Legacy — pendiente de definición. Se mantiene vacío por compatibilidad. */
  Marca_Competencia: string;
}

/** Full client response envelope. */
export interface ClientPricingResponse {
  ProcesadoOk: boolean;
  Error: string;
  PriceData: PriceDataItem[];
  Paginacion: Paginacion;
}

/** Coerce any view value to a string; null/undefined become an empty string. */
function str(value: unknown): string {
  return value === null || value === undefined ? '' : String(value);
}

/**
 * Map one `client_base` view row to the client's PriceData item.
 * Note the deliberate renames (e.g. ID -> Pricing_Id, Fecha_Actualizacion ->
 * Fecha_Modificacion, Precio_MasBajo -> Precio_Mas_Bajo) and the two competitor
 * fields that are intentionally left empty until their logic is defined.
 */
export function toPriceData(
  row: Record<string, unknown>,
  /**
   * Prebuilt Ayudín price reference for IDX_VS_COMPETENCIA. Required to fill the
   * index (it needs cross-row context); when omitted, IDX_VS_COMPETENCIA is
   * left empty. The caller builds it once per request via `loadAyudinPriceRef`.
   */
  idxRef?: Map<string, number>,
): PriceDataItem {
  return {
    Pricing_Id: str(row['ID']),
    Fecha_Creacion: str(row['Fecha_Creacion']),
    Fecha_Modificacion: str(row['Fecha_Actualizacion']),
    Fecha_Relevamiento: str(row['Fecha_Relevamiento']),
    Provincia: str(row['Provincia']),
    Zona: str(row['Zona']),
    Mes: str(row['Mes']),
    Semana: str(row['Semana']),
    Canal: str(row['Canal']),
    Cadena: str(row['Cadena']),
    Categoria: str(row['Categoria']),
    Subcategoria: str(row['Subcategoria']),
    Fabricante: str(row['Fabricante']),
    Marca: str(row['Marca']),
    Formato: str(row['Formato']),
    Variedad: str(row['Variedad']),
    // Hardcoded client reference data, matched by EAN (not a view column).
    Suplencias: suplenciaFor(str(row['EAN'])),
    Descripcion_Para_Forms: str(row['Descripcion_para_Forms']),
    EAN: str(row['EAN']),
    Desc_Sku_Sitio: str(row['Desc_Sku_Sitio']),
    Estado: str(row['Estado']),
    Precio_Regular: str(row['Precio_Regular']),
    Precio_c_Oferta_1: str(row['Precio_c_Oferta_1']),
    Precio_c_Oferta_2: str(row['Precio_c_Oferta_2']),
    Promocion_1: str(row['Promocion_1']),
    Promocion_2: str(row['Promocion_2']),
    Descuento_Unitario: str(row['Descuento_Unitario']),
    URL: str(row['URL']),
    Precio_Mas_Bajo: str(row['Precio_MasBajo']),
    // Target prices come straight from the view (price_targets); the two
    // derived indicators are computed at the app layer (they depend on the
    // hardcoded NUEVA_CATEGORIZACION map, not on a view column).
    PRECIO_TGT_SPM: str(row['PRECIO_TGT_SPM']),
    PRECIO_TGT_WHS: str(row['PRECIO_TGT_WHS']),
    PRECIO_TGT_WHS_REG: str(row['PRECIO_TGT_WHS_REG']),
    DIFF_VS_EDP: diffVsEdp(
      row['Precio_Regular'],
      row['PRECIO_TGT_SPM'],
      row['PRECIO_TGT_WHS'],
      row['PRECIO_TGT_WHS_REG'],
    ),
    IDX_VS_COMPETENCIA: idxRef ? idxVsCompetencia(row, idxRef) : '',
    // Hardcoded client reference data, matched by EAN (not a view column).
    IX_TARGET_VS_COMPETENCIA: ixTargetVsCompetenciaFor(str(row['EAN'])),
    PESO_PRODUCTO_EN_CATEGORIA: ((): string => {
      const p = pesoEnCategoriaFor(str(row['EAN']));
      return p === null ? '' : String(p);
    })(),
    NUEVA_CATEGORIZACION: nuevaCategorizacionFor(str(row['EAN'])),
    // Legacy fields kept for backward compatibility; always empty.
    Index_Competencia: '',
    Marca_Competencia: '',
  };
}

/** Build the Paginacion block from page/limit and the total row count. */
export function buildPaginacion(page: number, limit: number, total: number): Paginacion {
  return {
    Pagina: page,
    Limite: limit,
    TotalRegistros: total,
    TotalPaginas: limit > 0 && total > 0 ? Math.ceil(total / limit) : 0,
  };
}

/** Build a successful client envelope. */
export function clientPricingSuccess(
  priceData: PriceDataItem[],
  paginacion: Paginacion,
): ClientPricingResponse {
  return { ProcesadoOk: true, Error: '', PriceData: priceData, Paginacion: paginacion };
}

/** Build an error client envelope (empty data, descriptive message). */
export function clientPricingError(message: string, limit = 100): ClientPricingResponse {
  return {
    ProcesadoOk: false,
    Error: message,
    PriceData: [],
    Paginacion: { Pagina: 1, Limite: limit, TotalRegistros: 0, TotalPaginas: 0 },
  };
}
