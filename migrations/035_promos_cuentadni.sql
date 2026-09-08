-- =============================================================================
-- Promotions module — register Cuenta DNI / Banco Provincia
-- (Phase 7 — see docs/BANK_PROMOS.md / docs/BANK_PROMOS_ROADMAP.md)
--
-- Why:
--   Cuenta DNI is Banco Provincia's wallet (the only wishlist issuer NOT covered
--   by MODO). Its benefits page is a CMS grid, but it's backed by a plain
--   ASP.NET JSON API (no WAF, no auth — a normal server-side `fetch` works):
--     GET /cuentadni/Home/GetBeneficioByRubro?idRubro=<id>
--   There is no "all" call, and the active rubro-id set is sparse, so the adapter
--   (src/promos/cuentadni.ts) discovers active rubro ids from the benefits page
--   (server-rendered `filtrarPorRubro(<id>)`), fetches each, and keeps only
--   current (not hidden / not expired) benefits — the raw feed carries stale
--   rows. These are category-level wallet promos; issuer='Cuenta DNI' (mig 031).
--
-- Unlike Galicia/Macro/Santander/ICBC, this provider needs NO Playwright.
--
-- Idempotent: safe to re-run.
-- =============================================================================

INSERT INTO promo_providers (id, name, base_url, active)
VALUES (
  'cuentadni',
  'Cuenta DNI',
  'https://www.bancoprovincia.com.ar/cuentadni/Home',
  true
)
ON CONFLICT (id) DO NOTHING;
