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
  URL: string;
  Precio_Mas_Bajo: string;
  /** Campo pendiente de definición — se entrega vacío por ahora. */
  Index_Competencia: string;
  /** Campo pendiente de definición — se entrega vacío por ahora. */
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
export function toPriceData(row: Record<string, unknown>): PriceDataItem {
  return {
    Pricing_Id: str(row['ID']),
    Fecha_Creacion: str(row['Fecha_Creacion']),
    Fecha_Modificacion: str(row['Fecha_Actualizacion']),
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
    Descripcion_Para_Forms: str(row['Descripcion_para_Forms']),
    EAN: str(row['EAN']),
    Desc_Sku_Sitio: str(row['Desc_Sku_Sitio']),
    Estado: str(row['Estado']),
    Precio_Regular: str(row['Precio_Regular']),
    URL: str(row['URL']),
    Precio_Mas_Bajo: str(row['Precio_MasBajo']),
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
