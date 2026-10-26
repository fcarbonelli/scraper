# Cómo funciona hoy

Resumen operativo del sistema tal como está en el código, para alguien que llega sin el contexto en la cabeza. Si este archivo y el código se contradicen, gana el código: actualizá este doc en el mismo cambio.

El detalle de cada cadena está en [CADENAS.md](./CADENAS.md). El contrato HTTP está en [API.md](../API.md). El diseño y el schema están en [plan.md](../plan.md).

---

## Qué es

Un servicio que, para el catálogo de un cliente (hoy Ayudín), registra cada día el precio de esos productos en cada cadena que los vende. El cliente ve el dato por la API (`GET /v1/data/pricing` y la exportación Excel/CSV) recién después de que un operador publica el día.

Tres procesos, siempre (PM2 en producción):

| Proceso | Entrada | Hace |
| --- | --- | --- |
| orchestrator | `src/orchestrator/index.ts` | Dispara los cron, cierra las corridas, corre el chequeo de folletos |
| worker | `src/worker/index.ts` | Una cola BullMQ por supermercado; llama al adapter y persiste |
| api | `src/api/server.ts` | Express. Todo `/v1` pide `X-API-Key`, salvo `/v1/health` |

La base es Supabase (service role, solo en el server). La cola vive en Redis, en la misma EC2. Un deploy (`pm2 reload`) no vacía la cola.

El frontend no está en este repo.

## La idea que no hay que romper

El motor no sabe de sitios. El worker hace `getAdapter(supermarketId)` y llama `adapter.scrape(ctx)`. Sumar o arreglar una cadena es tocar `src/adapters/<id>.ts` (y, si es nueva, registrarla). La lógica de scraping no va en `src/worker/`.

Cada adapter devuelve un `ScrapeResult` o tira un `ScrapeError` con un `type`. Ese `type` decide si se reintenta (`src/worker/retryPolicy.ts`). Un fallo silencioso (`return null`) no existe: o hay precio, o hay un error clasificado.

## Tres formas de conseguir un precio

Las tres terminan en `price_snapshots`. El cliente las ve juntas, con el mismo formato.

1. **Web, automático.** La mayoría de las cadenas. Un adapter lee la página o una API pública. Corre en la corrida de la madrugada. Ficha: [CADENAS.md](./CADENAS.md).
2. **Folleto (revista).** Makro, Vital y Rosental no publican el precio en la web: sale en un PDF o un flipbook. El sistema detecta si el folleto cambió, una IA lee las páginas y una persona aprueba cada ítem antes de que exista un snapshot. Maxicomodín está mapeado con la misma idea y **desactivado**. Ver [REVISTA_REVIEW.md](./REVISTA_REVIEW.md).
3. **Relevamiento en tienda.** Diarco, Yaguar, Nini, Don Gastón y Oscar David no tienen adapter web. Una persona escanea el código de barras en la sucursal; otra aprueba la visita. El precio se publica el día de la aprobación, sin arrastre al día siguiente. Makro, Vital y Maxiconsumo además aceptan carga en tienda encima de su canal principal. Ver [IN_STORE_PRICE_ENTRY.md](./IN_STORE_PRICE_ENTRY.md).

Hay un cuarto módulo, aislado, que no mezcla con los precios de góndola: promociones de bancos y tarjetas (`src/promos/`, `/v1/promos/*`, scope de API key propio). Ver [BANK_PROMOS.md](./BANK_PROMOS.md).

## Un día normal

Zona horaria: `America/Argentina/Buenos_Aires` (`TZ`). Los horarios de abajo son los defaults de `src/shared/env.ts`; en el server pueden estar overrideados en `.env`.

| Cuándo | Qué | Dónde |
| --- | --- | --- |
| Todos los días 06:00 | Encola un job por cada producto activo de cada cadena activa que sí tiene adapter web. Crea una fila `scrape_runs` en `running`. Las cadenas `source_type` `revista` o `instore` no se encolan: no tienen adapter y fallarían todas. | `SCRAPE_CRON`, `src/orchestrator/enqueue.ts` |
| Enseguida, en el mismo disparo | Chequeo de folletos. Primero un control de salud (config apagada, revistas trabadas en `processing`). Después el descubrimiento, que es barato: si el folleto no cambió, no hay costo de IA. Si cambió, visión + matching, con tope de 20 minutos para no colgar el orchestrator. | `REVISTA_ENABLED`, `OPENAI_API_KEY`, `src/revistas/pipeline.ts` |
| Después del chequeo | Marcadores “fantasma” para productos que el sistema ya sabe que no va a encontrar. | `src/orchestrator/phantomMarkers.ts` |
| Cada 1 minuto | El finalizer mira las corridas `running`. Cuando cada producto tiene un resultado final (o pasaron 6 horas), escribe stats, agrega alertas de Telegram (una por cadena, no una por producto), actualiza el health de la cadena y corre la supresión de precios anómalos. La corrida queda en `pending_review`. | `src/orchestrator/finalize.ts` |
| Domingos 02:00 | Barrido de cobertura: vuelve a buscar EANs del catálogo que esa cadena todavía no tiene, por si volvieron a stock. | `SWEEP_CRON` |
| Lunes 05:00 | Corrida semanal de promos bancarias, si `PROMOS_ENABLED` no está en `false`. | `PROMOS_CRON` |

El cron de folletos a las 10:00 que describe [REVISTAS_PLAN.md](./REVISTAS_PLAN.md) (Parte 2) está **pendiente a propósito**. Hoy el chequeo va pegado a las 06:00. Si se pierde esa ventana, el operador usa el botón “¿qué folletos faltan?” (`POST /v1/revistas/check`), que no gasta IA.

El worker, al arrancar, abre una cola por cada supermercado activo, con la concurrency y el `rate_limit_ms` de esa fila. Cada ~60 segundos reconcilia: una cadena que acabás de activar con `npm run db:setup` empieza a consumir jobs sin reiniciar el proceso.

Para disparar el día a mano (hace falta Redis):

```bash
npm run orchestrator:run-now
npm run orchestrator:run-now -- --supermarket=coto
```

Ese one-shot también corre el chequeo de folletos.

## Qué ve el cliente, y cuándo

Nada de la corrida web entra a `client_base` mientras `scrape_runs.review_status` sea `pending_review`. Un operador revisa el día y publica (`src/orchestrator/publish.ts`, rutas en [PUBLICATION_REVIEW.md](./PUBLICATION_REVIEW.md)). Al publicar:

- Cada producto que falló y nadie corrigió recibe un marcador, para que el día no tenga huecos.
- `product_not_found` se publica como no encontrado.
- Un lifecycle `delisted` / `out_of_stock` gana sobre el error del día.
- El resto de los fallos nuestros (`selector_failed`, timeouts, etc.) queda como `scrape_failed`, que **no** se muestra al cliente. Sirve para auditar.

Los folletos y el relevamiento tienen su propia aprobación, aparte de ese botón de “publicar la corrida”. Un ítem de revista aprobado y una visita de tienda aprobada escriben snapshots sin pasar por la cola de scraping. En tienda, la fecha del snapshot es el día de la aprobación.

Estados que el cliente sí entiende en la columna `Estado`: disponible, sin stock, no encontrado, discontinuado, en stock sin precio (el flag `no_price` del relevamiento).

## Si un job falla

El adapter tira `ScrapeError`. El worker guarda el intento en `job_executions` (siempre junto con el snapshot, cuando hay snapshot) y decide el reintento:

| `error_type` | Reintentos | Espera | Lectura |
| --- | --- | --- | --- |
| `network_timeout`, `network_error` | 3 | 1 min | Red, proxy, el sitio colgó |
| `rate_limited` | 3 | 30 min | WAF o 429. En Cencosud suele ser el User-Agent, no el throughput |
| `site_server_error` | 3 | 10 min | 5xx del sitio |
| `parse_failed` | 2 | 1 min | El HTML/JSON vino raro; si se repite, cambió el sitio |
| `unknown` | 3 | 10 min | Un error que no clasificamos |
| `selector_failed`, `price_missing` | ninguno | — | El parser no encuentra el precio. Hay que mirar el adapter |
| `product_not_found` | ninguno | — | 404, redirect a home, o la sucursal no lo tiene |
| `region_unavailable` | ninguno | — | El adapter ya recorrió las zonas/sucursales y no hay precio |
| `auth_required` | ninguno | — | Falta cookie o token. No se reintenta solo |

Telegram avisa a partir de severidad `warning` (`TELEGRAM_MIN_SEVERITY`), agrupado por cadena.

## Dónde está cada cosa

```
src/orchestrator/   cron, encolado, finalizer, publicación
src/worker/         processJob, reintentos, persistencia
src/adapters/       un archivo por cadena con web (más vtex.ts, la fábrica)
src/ingest/         detectar cadena por hostname, alta de URL, bind de EAN
src/discovery/      buscar un EAN en las cadenas que saben buscar
src/revistas/       folletos
src/instore/        relevamiento
src/promos/         bancos y tarjetas
src/api/            HTTP
src/alerts/         alertas + Telegram
scripts/setup-db.ts el seed de cadenas (id, zona, is_active, config de revista/tienda)
```

`npm run db:setup` hace upsert de esas filas en cada deploy. Si el seed trae `config`, pisa el `config` de la base. Las cadenas cuyo seed **no** manda `config` (Coto, Maxi Carrefour, Mercado Libre, …) conservan cookies y tokens que se escribieron en `supermarkets.config` en caliente. No les agregues un `config: {}` vacío al seed: los borrarías.

## Cuando se rompe una cadena

1. La alerta dice el `supermarket_id`.
2. En `job_executions`, el `error_type` y el `error_message` del intento.
3. La ficha de esa cadena en [CADENAS.md](./CADENAS.md): ahí está el modo de fallo que ya vimos (WAF, sucursal, cookie, JSON atrasado).
4. Reproducir sin base ni Redis:

```bash
npm run test:adapter -- "https://…url del producto…"
```

En VTEX, `--all-zones` recorre las zonas. Para escribir de verdad una sola URL: `npm run scrape:url -- "<url>"`.

5. El arreglo va en el adapter (o en una env / un JSON de `supermarkets.config` que la ficha nombre). El motor se toca cuando el bug es de encolado, reintento o publicación, no cuando un sitio cambió el HTML.

Logs en el server: `pm2 logs worker --lines 1000`. Excepciones no atrapadas: Sentry, si hay `SENTRY_DSN`.

## Día 1, según lo que te pidan

| Te piden | Leé |
| --- | --- |
| “Entendé el sistema” | Este archivo, después [CADENAS.md](./CADENAS.md) por arriba, después `AGENTS.md` |
| “Se cayó la cadena X” | La ficha en [CADENAS.md](./CADENAS.md), después el encabezado de `src/adapters/<id>.ts`, después `test:adapter` |
| “Sumá una cadena” | [ADDING_SUPERMARKETS.md](./ADDING_SUPERMARKETS.md). Si es VTEX, son ~10 líneas sobre `vtex.ts` |
| “Cambió un endpoint / una pantalla” | [API.md](../API.md) y el fixture en `examples/api/`. Al cambiar la forma de la respuesta, se actualizan los dos |
| “No aparecen folletos” | `npm run revistas:doctor`, después [REVISTA_CHECK_BUTTON.md](./REVISTA_CHECK_BUTTON.md) y [REVISTA_DEBUG.md](./REVISTA_DEBUG.md) |
| “El relevador / la aprobación de visitas” | [IN_STORE_PRICE_ENTRY.md](./IN_STORE_PRICE_ENTRY.md) |
| “Promos de bancos” | [BANK_PROMOS.md](./BANK_PROMOS.md) |
| “El server” | [DEPLOY.md](../DEPLOY.md). Maxi Carrefour además necesita el cron de keepalive: está en el día-2 de ese archivo y en su ficha |
| “Pausar un producto, cargar un EAN, descubrir faltantes” | [PRODUCT_MANAGEMENT.md](./PRODUCT_MANAGEMENT.md) |

## Docs que describen un diseño, no siempre el código de hoy

Leelos con el recuadro de estado que tienen arriba. Estos son los que más confunden:

| Doc | Qué creer |
| --- | --- |
| [plan.md](../plan.md) §10, fase 5 | El checklist de AWS sigue sin tildar. El servicio está en producción; este archivo es el comportamiento actual |
| [PUBLICATION_REVIEW.md](./PUBLICATION_REVIEW.md) §1 | Describe el problema de *antes* del gate. El gate (`pending_review` → publicar) ya está en el backend |
| [REVISTAS_PLAN.md](./REVISTAS_PLAN.md) Parte 2 | El cron propio de las 10:00 no se construyó, a propósito |
| [REVISTA_REVIEW.md](./REVISTA_REVIEW.md) | El contrato de la API de folletos sí está al día. Maxicomodín figura como cadena de folleto y está desactivada en el seed |
| `AGENTS.md`, sección de fases | El tracker histórico. La lista “Read these first” sí se mantiene |

`summary.md` es el planteo original del problema. Se lee una vez y se deja.
