/**
 * DB seed: supermarket configuration.
 *
 * Run after migrations have been applied. Upserts all known supermarkets
 * with geography/channel metadata for the client's "Estructura de Base".
 *
 * Chains with a working adapter are seeded as `is_active: true`.
 * Chains without an adapter yet are `is_active: false` — they exist in the
 * DB for reference but don't get enqueued in daily scraping runs.
 *
 * Usage:
 *   npx tsx scripts/setup-db.ts
 */

import { db } from '../src/shared/db.js';
import { logger } from '../src/shared/logger.js';

interface SupermarketSeed {
  id: string;
  name: string;
  base_url: string;
  rate_limit_ms: number;
  concurrency: number;
  /** Whether a working adapter exists and the chain should be scraped. */
  is_active: boolean;
  provincia: string | null;
  zona: string | null;
  canal: string;
  cadena_display_name: string;
  /**
   * Adapter-specific config (jsonb). Only set when needed — omit to leave the
   * existing DB config untouched. Used to flag magazine-sourced chains:
   *   config = { source_type: 'revista', revista: { strategy, offersUrl, ... } }
   * See src/revistas/ and docs/REVISTA_REVIEW.md.
   */
  config?: Record<string, unknown>;
}

/** config payload for a magazine-sourced (revista) chain. */
function revista(
  strategy: 'html-pdf-links' | 'pubhtml5' | 'publuu',
  offersUrl: string,
  pubhtml5Url?: string,
): Record<string, unknown> {
  const r: Record<string, unknown> = { strategy, offersUrl };
  if (pubhtml5Url) r.pubhtml5Url = pubhtml5Url;
  return { source_type: 'revista', revista: r };
}

// =============================================================================
// Supermarket catalog — sourced from client's "Clientes" sheet.
//
// Canal values:
//   MAY NACIONAL    — national wholesale chains
//   SPM NACIONAL    — national supermarket chains
//   SPM REGIONAL    — regional supermarket chains
//   MAY REGIONAL    — regional wholesale chains
// =============================================================================

const SUPERMARKETS: SupermarketSeed[] = [
  // --- MAY NACIONAL (national wholesale) ------------------------------------
  {
    id: 'makro',
    name: 'Makro',
    base_url: 'https://www.makro.com.ar',
    rate_limit_ms: 500,
    concurrency: 3,
    // Magazine-sourced (no web price adapter): active so the daily revista
    // check picks it up. The daily URL scrape enqueues 0 jobs for it (no
    // supermarket_products), which is harmless.
    is_active: true,
    provincia: 'BUENOS AIRES',
    zona: 'CAPITAL Y GBA',
    canal: 'MAY NACIONAL',
    cadena_display_name: 'MAKRO',
    config: revista('html-pdf-links', 'https://makro.com.ar/ofertas/'),
  },
  {
    id: 'maxi-carrefour',
    name: 'Carrefour Maxi Pedido',
    base_url: 'https://comerciante.carrefour.com.ar',
    rate_limit_ms: 1000,
    concurrency: 2,
    is_active: true,
    provincia: 'BUENOS AIRES',
    zona: 'CAPITAL Y GBA',
    canal: 'MAY NACIONAL',
    cadena_display_name: 'MAXI CARREFOUR',
  },
  {
    id: 'maxiconsumo',
    name: 'Maxiconsumo',
    base_url: 'https://maxiconsumo.com',
    rate_limit_ms: 1500,
    concurrency: 2,
    is_active: true,
    provincia: 'BUENOS AIRES',
    zona: 'CAPITAL Y GBA',
    canal: 'MAY NACIONAL',
    cadena_display_name: 'MAXI CONSUMO',
  },
  {
    id: 'vital',
    name: 'Vital',
    base_url: 'https://www.vital.com.ar',
    rate_limit_ms: 500,
    concurrency: 3,
    // Magazine-sourced — see Makro note above.
    is_active: true,
    provincia: 'BUENOS AIRES',
    zona: 'CAPITAL Y GBA',
    canal: 'MAY NACIONAL',
    cadena_display_name: 'VITAL',
    config: revista('html-pdf-links', 'https://www.vital.com.ar/ofertas/'),
  },
  {
    id: 'rosental',
    name: 'Rosental',
    base_url: 'https://www.rosental.com.ar',
    rate_limit_ms: 500,
    concurrency: 2,
    // Magazine-sourced (PubHTML5 flipbook discovered from the home page).
    is_active: true,
    provincia: 'MISIONES',
    zona: 'NEA',
    canal: 'MAY REGIONAL',
    cadena_display_name: 'ROSENTAL',
    config: revista('pubhtml5', 'https://www.rosental.com.ar/', 'https://online.pubhtml5.com/oggo/ignq/'),
  },

  // --- SPM NACIONAL (national supermarkets) ---------------------------------
  {
    id: 'coto',
    name: 'Coto Digital',
    base_url: 'https://www.cotodigital.com.ar',
    rate_limit_ms: 250,
    concurrency: 4,
    is_active: true,
    provincia: 'BUENOS AIRES',
    zona: 'CAPITAL Y GBA',
    canal: 'SPM NACIONAL',
    cadena_display_name: 'COTO',
  },
  {
    id: 'carrefour',
    name: 'Carrefour Argentina',
    base_url: 'https://www.carrefour.com.ar',
    rate_limit_ms: 250,
    concurrency: 4,
    is_active: true,
    provincia: 'BUENOS AIRES',
    zona: 'CAPITAL Y GBA',
    canal: 'SPM NACIONAL',
    cadena_display_name: 'CARREFOUR',
  },
  {
    id: 'vea',
    name: 'Vea',
    base_url: 'https://www.vea.com.ar',
    rate_limit_ms: 250,
    concurrency: 4,
    is_active: true,
    provincia: 'BUENOS AIRES',
    zona: 'CAPITAL Y GBA',
    canal: 'SPM NACIONAL',
    cadena_display_name: 'VEA',
  },
  {
    id: 'jumbo',
    name: 'Jumbo',
    base_url: 'https://www.jumbo.com.ar',
    rate_limit_ms: 250,
    concurrency: 4,
    is_active: true,
    provincia: 'BUENOS AIRES',
    zona: 'CAPITAL Y GBA',
    canal: 'SPM NACIONAL',
    cadena_display_name: 'JUMBO',
  },
  {
    id: 'la-anonima',
    name: 'La Anónima',
    base_url: 'https://www.laanonima.com.ar',
    rate_limit_ms: 1000,
    concurrency: 2,
    is_active: true,
    provincia: 'BUENOS AIRES',
    zona: 'CAPITAL Y GBA',
    canal: 'SPM NACIONAL',
    cadena_display_name: 'LA ANONIMA',
  },
  {
    id: 'disco',
    name: 'Disco',
    base_url: 'https://www.disco.com.ar',
    rate_limit_ms: 250,
    concurrency: 4,
    is_active: true,
    provincia: 'BUENOS AIRES',
    zona: 'CAPITAL Y GBA',
    canal: 'SPM NACIONAL',
    cadena_display_name: 'DISCO',
  },
  {
    id: 'changomas',
    name: 'Changomas',
    base_url: 'https://www.masonline.com.ar',
    rate_limit_ms: 250,
    concurrency: 4,
    is_active: true,
    provincia: 'BUENOS AIRES',
    zona: 'CAPITAL Y GBA',
    canal: 'SPM NACIONAL',
    cadena_display_name: 'CHANGOMAS',
  },
  {
    id: 'dia',
    name: 'Dia',
    base_url: 'https://diaonline.supermercadosdia.com.ar',
    rate_limit_ms: 500,
    concurrency: 3,
    is_active: true,
    provincia: 'BUENOS AIRES',
    zona: 'CAPITAL Y GBA',
    canal: 'SPM NACIONAL',
    cadena_display_name: 'DIA',
  },
  {
    id: 'libertad',
    name: 'Libertad',
    base_url: 'https://www.hiperlibertad.com.ar',
    rate_limit_ms: 500,
    concurrency: 3,
    is_active: false,
    provincia: 'BUENOS AIRES',
    zona: 'CAPITAL Y GBA',
    canal: 'SPM NACIONAL',
    cadena_display_name: 'LIBERTAD',
  },
  {
    id: 'mercadolibre',
    name: 'Super MercadoLibre',
    base_url: 'https://www.mercadolibre.com.ar',
    rate_limit_ms: 500,
    concurrency: 3,
    is_active: true,
    provincia: 'BUENOS AIRES',
    zona: 'CAPITAL Y GBA',
    canal: 'SPM NACIONAL',
    cadena_display_name: 'SUPER MERCADOLIBRE',
  },

  // --- SPM REGIONAL (regional supermarkets) ---------------------------------
  {
    id: 'atomo',
    name: 'Átomo Conviene',
    base_url: 'https://atomoconviene.com',
    rate_limit_ms: 1000,
    concurrency: 2,
    is_active: true,
    provincia: 'MENDOZA',
    zona: 'OESTE',
    canal: 'SPM REGIONAL',
    cadena_display_name: 'ATOMO',
  },
  {
    id: 'cadena-dar',
    name: 'Cadena Dar',
    base_url: '',
    rate_limit_ms: 500,
    concurrency: 3,
    is_active: false,
    provincia: null,
    zona: null,
    canal: 'SPM REGIONAL',
    cadena_display_name: 'CADENA DAR',
  },
  {
    id: 'california',
    name: 'Supermercado California',
    base_url: 'https://www.californiasa.com.ar',
    rate_limit_ms: 1000,
    concurrency: 2,
    is_active: true,
    provincia: 'CORRIENTES',
    zona: 'NEA',
    canal: 'SPM REGIONAL',
    cadena_display_name: 'CALIFORNIA',
  },
  {
    id: 'cooperativa-obrera',
    name: 'Cooperativa Obrera',
    base_url: 'https://www.cooperativaobrera.coop',
    rate_limit_ms: 500,
    concurrency: 3,
    is_active: false,
    provincia: null,
    zona: null,
    canal: 'SPM REGIONAL',
    cadena_display_name: 'COOPERATIVA OBRERA',
  },
  {
    id: 'cordiez',
    name: 'Cordiez',
    base_url: 'https://www.cordiez.com.ar',
    rate_limit_ms: 500,
    concurrency: 3,
    is_active: true,
    provincia: 'CORDOBA',
    zona: null,
    canal: 'SPM REGIONAL',
    cadena_display_name: 'CORDIEZ',
  },
  {
    id: 'el-abastecedor',
    name: 'El Abastecedor',
    base_url: 'https://www.abastecedor.com.ar',
    rate_limit_ms: 500,
    concurrency: 3,
    is_active: true,
    provincia: 'BUENOS AIRES',
    zona: 'GBA',
    canal: 'SPM REGIONAL',
    cadena_display_name: 'EL ABASTECEDOR',
  },
  {
    id: 'el-condor',
    name: 'Súper El Cóndor',
    base_url: 'https://superelcondor.com.ar',
    rate_limit_ms: 1000,
    concurrency: 2,
    is_active: true,
    provincia: 'MISIONES',
    zona: 'INTERIOR',
    canal: 'SPM REGIONAL',
    cadena_display_name: 'EL CONDOR',
  },
  {
    id: 'josimar',
    name: 'Josimar',
    base_url: 'https://www.josimar.com.ar',
    rate_limit_ms: 500,
    concurrency: 3,
    is_active: true,
    provincia: 'BUENOS AIRES',
    zona: 'GBA',
    canal: 'SPM REGIONAL',
    cadena_display_name: 'JOSIMAR',
  },
  {
    id: 'supertop',
    name: 'Supertop',
    base_url: 'https://www.supertop.com.ar',
    rate_limit_ms: 500,
    concurrency: 3,
    is_active: true,
    provincia: 'CÓRDOBA',
    zona: 'RIO CUARTO',
    canal: 'SPM REGIONAL',
    cadena_display_name: 'SUPERTOP',
  },
  {
    id: 'la-gallega',
    name: 'La Gallega',
    base_url: 'https://www.lagallega.com.ar',
    rate_limit_ms: 1000,
    concurrency: 2,
    is_active: true,
    provincia: 'SANTA FE',
    zona: 'ROSARIO',
    canal: 'SPM REGIONAL',
    cadena_display_name: 'LA GALLEGA',
  },
  {
    id: 'la-genovesa',
    name: 'La Genovesa',
    base_url: 'https://www.lagenovesadigital.com.ar',
    rate_limit_ms: 1500,
    concurrency: 2,
    is_active: true,
    provincia: 'BUENOS AIRES',
    zona: 'ZONA SUR GBA',
    canal: 'SPM REGIONAL',
    cadena_display_name: 'LA GENOVESA',
  },
  {
    id: 'la-reina',
    name: 'La Reina Online',
    base_url: 'https://www.lareinaonline.com.ar',
    rate_limit_ms: 1000,
    concurrency: 2,
    is_active: true,
    provincia: 'SANTA FE',
    zona: 'INTERIOR',
    canal: 'SPM REGIONAL',
    cadena_display_name: 'LA REINA',
  },
  {
    id: 'mami',
    name: 'Super Mami',
    base_url: 'https://www.supermami.com.ar',
    rate_limit_ms: 1000,
    concurrency: 2,
    is_active: true,
    provincia: 'CORDOBA',
    zona: 'INTERIOR',
    canal: 'SPM REGIONAL',
    cadena_display_name: 'MAMI',
  },

  // --- MAY REGIONAL (regional wholesale) ------------------------------------
  {
    id: 'comodin',
    name: 'Comodín en Casa',
    base_url: 'https://www.comodinencasa.com.ar',
    rate_limit_ms: 500,
    concurrency: 3,
    is_active: true,
    provincia: 'JUJUY',
    zona: 'NOA',
    canal: 'MAY REGIONAL',
    cadena_display_name: 'COMODIN',
  },
  {
    id: 'maxicomodin',
    name: 'Maxicomodín',
    base_url: 'https://supermercadoscomodin.com',
    rate_limit_ms: 1000,
    concurrency: 2,
    // Magazine-sourced (Publuu flipbook). Kept SEPARATE from the retail
    // `comodin` VTEX chain on purpose — this is the wholesale (mayorista) tier.
    is_active: true,
    provincia: 'JUJUY',
    zona: 'NOA',
    canal: 'MAY REGIONAL',
    cadena_display_name: 'MAXICOMODIN',
    config: revista('publuu', 'https://supermercadoscomodin.com/maxicomodin/'),
  },
  {
    id: 'parodi',
    name: 'Parodi (DIPA)',
    base_url: 'https://cordoba.dipa.ar',
    rate_limit_ms: 1000,
    concurrency: 2,
    is_active: true,
    provincia: 'CORDOBA',
    zona: 'INTERIOR',
    canal: 'MAY REGIONAL',
    cadena_display_name: 'PARODI',
  },

  // --- Also keep La Coope en Casa (has adapter, not in client's Clientes sheet)
  {
    id: 'lacoopeencasa',
    name: 'La Coope en Casa',
    base_url: 'https://www.lacoopeencasa.coop',
    rate_limit_ms: 250,
    concurrency: 4,
    is_active: true,
    provincia: null,
    zona: null,
    canal: 'SPM REGIONAL',
    cadena_display_name: 'LA COOPE EN CASA',
  },
];

async function main(): Promise<void> {
  let ok = 0;
  let failed = 0;

  for (const sm of SUPERMARKETS) {
    // Only send `config` when the seed defines it, so we never clobber an
    // existing DB config (e.g. self-healed auth cookies) for chains that
    // manage their config at runtime.
    const row: Record<string, unknown> = {
      id: sm.id,
      name: sm.name,
      base_url: sm.base_url,
      rate_limit_ms: sm.rate_limit_ms,
      concurrency: sm.concurrency,
      is_active: sm.is_active,
      provincia: sm.provincia,
      zona: sm.zona,
      canal: sm.canal,
      cadena_display_name: sm.cadena_display_name,
    };
    if (sm.config) row.config = sm.config;

    const { error } = await db.from('supermarkets').upsert(row, { onConflict: 'id' });
    if (error) {
      logger.error({ err: error, supermarket: sm.id }, 'failed to upsert supermarket');
      failed++;
      continue;
    }
    ok++;
    logger.info(
      { supermarket: sm.id, canal: sm.canal, active: sm.is_active },
      'upserted supermarket',
    );
  }

  logger.info({ ok, failed, total: SUPERMARKETS.length }, 'supermarket seed complete');
  if (failed > 0) process.exitCode = 1;
}

void main();
