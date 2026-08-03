-- =============================================================================
-- Revista: period_start / period_end — la vigencia que el folleto declara.
--
-- Hasta ahora la tabla solo tenia `detected_at`, que es cuando NOSOTROS vimos el
-- folleto, no desde/hasta cuando vale. El periodo viene escrito en el titulo
-- ("Folder 03.08 al 09.08 | RESTO", "Ofertas semanales del 30/07 al 05/08") y el
-- unico uso que se le daba era tirarlo a la basura: stripDateNoise() lo borra
-- para derivar el series_key.
--
-- Guardarlo habilita tres cosas:
--   1. Distinguir una EDICION NUEVA de una RE-SUBIDA del mismo archivo. El hash
--      de dedupe sale de content-length/ETag/Last-Modified, asi que Vital
--      re-exportando el mismo PDF cambia el hash y el pipeline lo reprocesa a
--      costo completo supersedeando lo ya curado. Mismo periodo => re-subida.
--   2. Mostrarle al operador "vencido hace N dias" en el panel.
--   3. A futuro, vencer solo por fecha en vez de depender del supersede.
--
-- NULL es un valor normal, no un error: los titulos de Rosental ("PubHTML5
-- flipbook") y los nombres de archivo de Makro ("jul2mm.pdf") no traen periodo.
-- Ningun codigo puede asumir que estas columnas estan cargadas.
--
-- NO son clave de nada. La identidad de la fila sigue siendo content_hash.
--
-- Backfill: lo hace `scripts/revistas-rekey-series.ts`, que re-deriva desde el
-- label con el mismo TypeScript que usa el pipeline (parseFlyerPeriod). No se
-- reimplementa el parseo en SQL a proposito: seria una segunda fuente de verdad
-- que se desincroniza en cuanto cambie el parser.
--
-- Idempotente: safe to re-run.
-- =============================================================================

ALTER TABLE revista_magazines
  ADD COLUMN IF NOT EXISTS period_start      date,
  ADD COLUMN IF NOT EXISTS period_end        date,
  ADD COLUMN IF NOT EXISTS period_confidence text;

COMMENT ON COLUMN revista_magazines.period_start IS
  'Primer dia de vigencia declarado en el label. NULL = el label no trae periodo.';
COMMENT ON COLUMN revista_magazines.period_end IS
  'Ultimo dia de vigencia (inclusive). Igual a period_start en folletos de un dia.';
COMMENT ON COLUMN revista_magazines.period_confidence IS
  'exact = leido de fechas explicitas ("03.08 al 09.08"). inferred = deducido de una '
  'frase gruesa ("Agosto primera quincena"). Se guarda porque SIN el, releer la fila '
  'devolveria una quincena adivinada afirmando ser exacta, y la guarda de re-subida '
  'exige que ambos lados sean exact antes de saltear un folleto.';

-- Buscar la vigente de una serie y ordenar por vigencia en el panel.
CREATE INDEX IF NOT EXISTS idx_revista_mag_period
  ON revista_magazines (supermarket_id, series_key, period_end DESC)
  WHERE period_end IS NOT NULL;
