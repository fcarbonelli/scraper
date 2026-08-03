# Revistas: botón de chequeo manual + cron propio a las 10:00

> Escrito el 2026-07-30. Diagnóstico medido contra la base de prod (todo read-only).
>
> **Estado al 2026-08-03 — Partes 1 y 3 implementadas, Parte 2 pendiente.**
>
> | Pieza | Estado |
> |---|---|
> | §1.1 `preview.ts` + `findCurrentMagazineInSeries` | ✅ hecho |
> | §1.2 predicado único `wouldProcess` | ✅ hecho — vive en `src/revistas/decide.ts`, no en `preview.ts`, para que `pipeline.ts` y `preview.ts` lo compartan sin ciclo de imports |
> | §1.3 `POST /v1/revistas/check` | ✅ hecho |
> | §1.5 docs + tests | ✅ `docs/REVISTA_CHECK_BUTTON.md`, `period.test.ts`, `decide.test.ts`, `series-golden.test.ts` |
> | §1.6 guarda de re-subida | ✅ hecho, **acotada a `html-pdf-links`** (ver abajo) |
> | §3.3 alerta de falla silenciosa | ✅ `src/revistas/health.ts` — y suma una segunda alerta por revistas trabadas en `processing`, que el plan no cubría |
> | **Parte 2 — `REVISTA_CRON` a las 10:00** | ⏸ **pendiente a propósito.** Con el botón, errarle a la hora deja de ser crítico: se aprieta y listo. Se hace cuando prod esté sano. |
> | §3.2 arreglar el `.env` de EC2 | ⏸ necesita SSH |
> | §3.4 desactivar `maxicomodin` | ✅ hecho — `is_active: false` en `scripts/setup-db.ts`, **no solo por SQL**: el seed re-upsertea `is_active` en cada deploy, así que un `UPDATE` suelto se revertía solo |
>
> **Tres correcciones al plan original, encontradas al implementarlo:**
>
> 1. **La guarda de §1.6 tenía que acotarse por estrategia.** Definida para todas
>    las cadenas, en `pubhtml5` habría salteado **ediciones reales**: el label de
>    Rosental sale del `title` del `config.js`, cuyo fallback es la constante
>    `'Revista'` (en la base hay una guardada como `"PubHTML5 flipbook"`). Además
>    ahí la guarda no hace falta: ese hash ya es content-based. Un falso negativo
>    en Rosental cuesta 144 páginas de visión.
> 2. **Comparar labels crudos era frágil; se modela el período.** Migración 023 +
>    `src/revistas/period.ts`. El label de Vital trae el sufijo de sucursal, que
>    rota (`| RESTO` → `| MALVINAS - ABASTO`) — y como el `series_key` sale del
>    mismo string, la edición nueva **no supersedeaba** a la vieja y el folleto
>    vencido seguía emitiendo precios. Se arregla en `series.ts` +
>    `scripts/revistas-rekey-series.ts`.
> 3. **El re-key NO puede re-derivar todo.** Muchos `series_key` guardados vienen
>    del `CASE` en SQL de la migración 015 y ya no coinciden con lo que deriva el
>    TypeScript (`jul2mm.pdf` está guardado `mm` y deriva `jul2mm-pdf`). El script
>    solo toca las filas donde la regla vieja y la nueva discrepan; ese drift es
>    previo y queda fuera de alcance.
>
> Y un hallazgo operativo: la CDN de Vital **dejó de mandar `content-length` en
> HEAD**, lo que dejaba ciega a la guarda justo en la cadena que motivó todo. Se
> recupera con un GET de 1 byte leyendo `Content-Range` (`sources.ts:rangedSize`).

## Contexto

Tres problemas conectados: uno operativo, uno de producto y uno que apareció al medir.

**1. El chequeo de revistas dejó de producir resultados en prod.** `scrape_runs` completa todos los
días a las 06:00 ART, pero `revista_check_log` no tiene filas desde el 27/07 y hay 5
`revista_magazines` trabadas en `status='processing'`.

**2. Los folletos se publican después de las 6am.** El 30/07 Makro subió PDFs a las 07:56 y 09:57
ART — el chequeo de las 6am no los podía ver. No es un bug del scraper: es el horario. Hoy no hay
perilla: `src/orchestrator/index.ts:200-202` encadena el chequeo de revistas al scrape de tiendas
con un `.then()` sobre el único `SCRAPE_CRON`.

**3. El dedupe toma re-exportaciones como ediciones nuevas.** Descubierto al medir (§3.1-bis): Vital
re-sube sus PDFs varias veces por día sobre la misma URL, mismo período, tamaño casi idéntico. El
hash cambia y el pipeline los reprocesa a costo completo, supersedeando lo ya curado. **Esto es
bloqueante para reactivar el cron.**

**Resultado buscado:** (a) un botón en el panel que le diga al operador, en segundos y sin gastar un
peso de OpenAI, qué folletos hay hoy en cada cadena y cuáles no están en la base; (b) el chequeo
automático corriendo a las 10:00 en vez de las 6:00, sin mover los carry-forward; (c) el diagnóstico
de prod cerrado y el modo de falla silencioso eliminado.

**Decisiones ya tomadas:** endpoint + spec de frontend (no Telegram, no CLI); el botón **solo
muestra**, no ingesta; horario **10:00**; cadenas **vital, makro, rosental**; maxicomodín se
desactiva (§3.4).

---

## Parte 0 — Cómo funciona la corrida automática, y en qué orden se testea

### 0.1 Qué hace hoy la corrida de las 06:00

1. `cron.schedule(SCRAPE_CRON)` → `runDailyScrape()` **encola** los jobs de tiendas online y
   devuelve el `runId` (el scrapeo en sí lo hace el proceso `worker`).
2. `.then()` → `runRevistaCheckWithErrorHandling(runId)`: carry-forward de revista → carry-forward
   de in-store → `runRevistaCheck` con techo de 20 min.
3. `runRevistaCheck`: guardas de config → carga cadenas → arma el índice del catálogo → recorre las
   cadenas **de a una**.
4. Por cadena: discovery (techo 90 s) → por cada folleto, filtro de serie → `findMagazineByHash` →
   si ya está, saltea; si no, lo procesa.
5. Procesar = descargar PDF → renderizar cada página a PNG → **una llamada de visión GPT-4o por
   página** → matchear contra el catálogo → subir imágenes a Storage → crear la cola de review →
   `in_review` → supersedear la anterior de esa serie → alerta.
6. Recién ahí escribe la fila de `revista_check_log`.

Los pasos 1-4 son gratis. **Todo el costo y todo el riesgo está en el 5.**

### 0.2 Las cuatro capas de testeo

| Capa | Qué prueba | Escribe en prod | Costo AI |
|---|---|---|---|
| Offline — `npm test`, `revistas:dedupe-simulate` | lógica pura (series, dedupe, pricing) | no | no |
| Read-only — `revistas:doctor` **y el botón de la Parte 1** | pasos 1-4: detección y dedupe | no | no |
| Acotada — `scrape-revistas.ts --super=X --pages=1-3` | paso 5 de verdad, con 3 páginas | **sí** | bajo |
| Completa — `orchestrator:run-now` | la corrida entera, igual que el cron | **sí** | alto |

No hay base de staging: `.env` apunta a prod, así que de la capa 3 para abajo se escribe en la base
real. Esa es la restricción que ordena todo lo demás.

**El botón no es solo una feature, es el banco de pruebas.** Replica exactamente los pasos 1-4 sin
tocar el 5. O sea: contesta "¿qué haría el cron si corriera ahora?" antes de dejarlo correr.

### 0.3 Cómo probar el cron nuevo sin gastar un peso

El wiring del scheduling se prueba aparte de lo que la función hace adentro: correr el orchestrator
en local con `REVISTA_CRON` apuntando a dos minutos en el futuro y **`REVISTA_ENABLED=false`**. El
early-return loguea `revista: disabled via REVISTA_ENABLED=false` — con eso se verifica que disparó
a la hora correcta y que la rama de las 06:00 sigue haciendo solo los carry-forward, sin descargar
ni un PDF ni gastar visión.

### 0.4 Orden de trabajo

Hoy el chequeo está apagado en prod. Si se reactiva tal cual, la próxima corrida agarra de una:

- los folletos de Vital que el sitio re-exportó — que **no son ediciones nuevas** (§3.1-bis) → los
  reprocesa a costo completo y **supersedea los ya curados**, y lo repite cada día;
- las **5 revistas trabadas en `processing`** → el pipeline las reintenta por diseño;
- **maxicomodín**, que sigue activo como cadena de revista (§3.4);
- **Rosental "Julio segunda quincena"**, que la discovery no reconoce → y Rosental son **148
  páginas**, la corrida más cara de todas por lejos.

Todo eso junto, sin previsualización y sin decisión previa. De ahí el orden:

1. **Botón + guarda, escritos juntos** — comparten `findCurrentMagazineInSeries` (§1.1) y la misma
   lógica de clasificación. Pero **se sueltan en distinto momento**: el botón primero, porque es
   read-only; la guarda queda escrita y testeada pero no decide nada hasta el paso 3. Encender una
   decisión de "saltear" sin haberla visto funcionar sería meter a ciegas justo el tipo de cambio
   que este trabajo existe para evitar.
2. **Mirar la lista del botón** → qué haría exactamente la corrida, caso por caso.
3. **Decidir y activar la guarda** con esa evidencia a la vista.
4. **Rosental**: decisión propia y explícita. La discovery ve "Julio segunda quincena" y en base hay
   una del 13/07 con label `"PubHTML5 flipbook"` — labels distintos, así que la guarda **no** la
   frena y se procesa: **148 páginas de visión, el gasto más grande de todo el plan**. Confirmar
   antes si es una quincena nueva de verdad o la misma con el título ahora parseado.
5. **Limpiar** las 5 trabadas y desactivar maxicomodín.
6. **Reactivar** el chequeo en EC2 (falla A) y recién ahí **mover el cron a las 10:00**.

---

## Parte 1 — Botón "¿qué folletos faltan?"

### 1.1 Núcleo reutilizable: `src/revistas/preview.ts` (nuevo)

Descubre y clasifica **sin escribir nada y sin llamar a OpenAI**. La discovery ya es barata y
AI-free en las tres cadenas elegidas (makro/vital = fetch de HTML + `HEAD`; rosental = dos fetch;
Playwright solo aparece en la *descarga* de publuu, no en la discovery).

```ts
export type CandidateState =
  | 'nuevo'          // no hay fila con ese hash NI revista vigente de esa serie
  | 'nueva_edicion'  // hay vigente de la misma serie, con otro label → edición nueva
  | 're_subida'      // hay vigente de la misma serie, MISMO label, otro hash → archivo recambiado
  | 'ya_en_base'     // hash hit, status in_review|reviewed → nada que hacer
  | 'reprocesable'   // hash hit pero status processing|failed → el pipeline lo reintentaría
  | 'serie_ignorada' // filtrado por config.revista.skipSeries
```

Firma: `previewRevistaChains(supermarketIds?: string[]): Promise<RevistaPreview>`, devolviendo por
cadena `{ supermarketId, supermarketName, strategy, checkedAt, durationMs, candidates[], error }` y
por candidato `{ label, seriesKey, sourceUrl, hash, state, ingestable, existing, currentInSeries }`.

**Reutilizar lo que ya existe (no reimplementar):**

- `loadRevistaSupermarkets()` — `src/revistas/pipeline.ts:64`. Es DB-driven (`is_active=true` +
  `config.source_type='revista'`), así que el selector nunca queda hardcodeado.
- `discoverCandidates(sm.strategy)` — `src/revistas/sources.ts:278`, envuelto en
  `withTimeout(..., revistaConfig.discoverTimeoutMs)` igual que `pipeline.ts:337-341`.
- `findMagazineByHash()` — `src/revistas/store.ts:39`.
- `mapPool` — `src/revistas/pool.ts`, concurrencia 3, para probar las cadenas en paralelo
  (secuencial serían hasta 4,5 min de peor caso; en paralelo ~90 s, y el caso normal son segundos).

**Dos piezas nuevas mínimas:**

- `findCurrentMagazineInSeries(supermarketId, seriesKey)` en `store.ts` — la fila vigente de esa
  serie: `superseded_by IS NULL` **AND `status IN ('in_review','reviewed')`**, ordenado por
  `detected_at DESC` y tomando la primera. Los dos filtros extra no son cosmética:
  `supersedePreviousMagazines` solo corre en la transición a `in_review` (`pipeline.ts:209`), así
  que **una fila trabada en `processing` nunca fue superseded ni supersede a nadie** — con el filtro
  ingenuo puede haber dos filas con `superseded_by IS NULL` en la misma serie (o una "vigente" que
  en realidad es un cadáver). Eso es estado real de prod hoy. Nada de `.maybeSingle()` acá, que
  tiraría error con el duplicado. Fuera de eso es el mismo filtro que `getCurrentMagazineIds`
  (`store.ts:179`), acotado a una serie. Es lo que permite distinguir `nueva_edicion`/`re_subida` de
  `nuevo` en vez de mostrar todo como "nuevo".
- Exportar `shouldProcessSeries` (`pipeline.ts:312`) para aplicar el mismo filtro de series.

### 1.2 Antidrift: un solo predicado de "¿esto se procesaría?"

Hoy la regla vive duplicada en `pipeline.ts:381-386` y `pipeline.ts:460-471`:

```ts
existing && existing.status !== 'processing' && existing.status !== 'failed' && !force  // → skip
```

Extraerla a `wouldProcess(existing, force): boolean` en `preview.ts` (devuelve *procesar*, no
*saltear*) y hacer que **`processSupermarket`, `ingestPdfUrl` y el preview la llamen**. Ojo con la
forma: `ingestPdfUrl` envuelve todo el bloque en `if (!opts.force)` mientras `processSupermarket`
mete el `!opts.force` dentro de la condición — misma tabla de verdad, distinta forma. Los dos call
sites tienen que colapsar al mismo llamado. Sin esto, el botón y el pipeline pueden divergir
silenciosamente — que es justo el error que el botón existe para evitar. De paso elimina una
duplicación real que ya está en el repo.

Consecuencia deliberada: las filas trabadas aparecen como **`reprocesable`**, no ocultas. Es estado
real de prod y el operador tiene que verlo.

### 1.3 Endpoint: `POST /v1/revistas/check`

En `src/api/routes/revistas.ts`, **registrado junto a `/checks` (~línea 256)**. Es obligatorio que
quede **antes** de `revistasRouter.get('/:magazineId')` (`revistas.ts:960`), o el catch-all se lo
come. Hereda `requireApiKey` gratis por el mount de `app.ts:61`. Envelope con el `success()` de
`src/api/lib/envelope.ts`.

```
POST /v1/revistas/check      X-API-Key: ...
{ "supermarket_ids": ["makro","vital"] }        // omitido = todas las activas
```

```jsonc
{
  "config": { "revista_enabled": true, "openai_key_present": true },
  "warnings": [],           // ver 1.4
  "chains": [ { "supermarket_id": "makro", "candidates": [ /* ... */ ] } ]
}
```

Es `POST` aunque no mute nada: dispara probes salientes en vivo contra las cadenas — lento y no
cacheable. Dejarlo dicho en el comentario de la ruta y en `API.md`, o el próximo que lo lea va a
pensar que escribe.

Sin rate limiting en la API (no existe middleware), cada click son hasta 3 ráfagas concurrentes de
`HEAD`+GET contra los sitios de los súper. Es barato, pero clickear en loop les pega. Si molesta, un
cache en memoria de 30 s alcanza; no se incluye de entrada.

**No escribe una fila en `revista_check_log`.** Ese log es el libro mayor del probe *automático* — es
literalmente la señal con la que se diagnostica "¿corrió el chequeo diario?". Ensuciarlo con clicks
manuales rompería ese diagnóstico. Dejar el motivo como comentario en el código.

### 1.4 El botón no puede heredar el bug que está diagnosticando

`runRevistaCheck` hace early-return **sin escribir nada** si `REVISTA_ENABLED=false` o falta
`OPENAI_API_KEY` (`pipeline.ts:482-489`). Si el botón se colgara de esa función, en prod hoy
respondería "no hay nada nuevo" — indistinguible de la verdad.

Por eso el preview **no llama a `runRevistaCheck`**: usa discovery directa, que no necesita OpenAI. Y
devuelve `config` + `warnings` explícitos: con el pipeline apagado el botón **igual lista los
folletos** y agrega `"El chequeo automático está deshabilitado (REVISTA_ENABLED=false): estos
folletos no se van a traer solos"`. Nunca un éxito vacío.

### 1.5 Docs y tests

- `docs/REVISTA_CHECK_BUTTON.md` — spec de UI al estilo de `docs/REVISTA_DEBUG.md`: selector de
  cadenas, tabla de resultados, badge por `state`, texto del warning de config.
- `API.md` — entrada nueva en la sección `## Revistas`, junto a `GET /v1/revistas/checks` (~1505).
- `src/revistas/preview.test.ts` — clasificación pura sobre tuplas (candidato, fila-por-hash,
  vigente-de-la-serie), al estilo de `series.test.ts`. Incluir un test que fije que `wouldProcess` es
  el predicado que usa `processSupermarket`, con tabla completa: `existing=null`, `force=true`, y los
  cuatro estados (`processing`, `failed`, `in_review`, `reviewed`).

### 1.6 Guarda de re-subida (bloqueante para reactivar el cron)

El problema medido en §3.1-bis: Vital re-exporta sus PDFs varias veces por día sobre la misma URL,
con el mismo período y prácticamente el mismo tamaño. El hash cambia, el pipeline lo toma como
edición nueva, y lo reprocesa a costo completo supersedeando lo ya curado.

**La guarda**, en `processSupermarket` (`pipeline.ts:378-396`), para un candidato cuyo hash **no**
está en la base:

1. Buscar la vigente de la misma serie — `findCurrentMagazineInSeries` (§1.1), o sea
   `superseded_by IS NULL` y `status IN ('in_review','reviewed')`.
2. Si existe **y el `label` es el mismo**, es una re-subida, no una edición nueva. **Saltear** (salvo
   `--force`).
3. Corroborar con el tamaño: el `content-length` ya viene en el fingerprint de discovery y
   `revista_magazines.file_size` tiene el guardado. Saltear **solo con coincidencia casi exacta**.
   Cualquier delta mayor sale como candidato y lo decide el operador.
4. **No tocar `content_hash`.** La tentación es adoptar el fingerprint nuevo para que al día
   siguiente sea un hash hit — pero esa fila tiene items aprobados colgando y las imágenes de página
   en Storage renderizadas del PDF **viejo**. Pisarle el hash la haría afirmar que es el archivo
   nuevo cuando su contenido extraído es el viejo: una mentira de procedencia en la tabla que lee el
   panel. El costo de no adoptar es un `HEAD` y un SELECT indexado por día — nada. Si algún día
   molesta, el lugar correcto es `metadata.seen_hashes[]`, no `content_hash`.
5. Dejarlo en el check-log (`detail`) para que sea visible que se salteó una re-subida.

**Por qué el label es señal suficiente para el caso común:** tanto Makro como Vital meten el período
en el título ("Ofertas semanales del 30/07 al 05/08", "Folder 27.07 al 02.08 | RESTO"). Una edición
nueva cambia el período ⇒ cambia el label ⇒ se detecta como nueva.

**Límite honesto de la heurística:** ni el label ni el tamaño distinguen una re-exportación cosmética
de una **corrección de precio** — si Vital arregla un precio en la página 9, el período no cambia y
el delta también es minúsculo. Los cinco deltas medidos están todos por debajo del 0,15%, así que
cualquier umbral por encima de eso sería inventado. **La mitigación real no es el umbral, es el
botón:** el operador ve el caso marcado como `re_subida` con el delta a la vista y decide traerlo.
Por eso la guarda no se activa antes de que el botón exista (§0.4).

---

## Parte 2 — `REVISTA_CRON` propio a las 10:00

### 2.1 La trampa

`runRevistaCheckWithErrorHandling` (`src/orchestrator/index.ts:62`) hace **tres** cosas en orden:
`carryForwardRevistaPrices()` → `carryForwardInStorePrices()` → `runRevistaCheck()`. Los dos
carry-forward están primero **a propósito** (comentario en `index.ts:65-70`: un discovery colgado
hizo desaparecer precios de revista al día siguiente de aprobar). Mover la función entera a las
10:00 se lleva los carry-forward con ella y abre una ventana de 4 h sin precios arrastrados.

### 2.2 El corte

En `src/orchestrator/index.ts`, partir en dos:

- `runCarryForwardsWithErrorHandling()` — los bloques de `index.ts:71-85`. **Sigue colgando de
  `SCRAPE_CRON`** (06:00).
- `runRevistaCheckWithErrorHandling(scrapeRunId)` — solo el bloque timeout-guardado de
  `index.ts:91-101`. Pasa a un cron propio.

```ts
// SCRAPE_CRON (06:00) — scrape + carry-forwards
cron.schedule(env.SCRAPE_CRON,
  () => void runScrapeWithErrorHandling().then(() => runCarryForwardsWithErrorHandling()),
  { timezone: env.TZ });

// REVISTA_CRON (10:00) — solo el chequeo de folletos
cron.schedule(env.REVISTA_CRON,
  () => void runRevistaCheckWithErrorHandling(null),
  { timezone: env.TZ });
```

- `src/shared/env.ts` (junto a `SCRAPE_CRON`, línea 32):
  `REVISTA_CRON: z.string().default('0 10 * * *')`.
- Guard de validación replicando `index.ts:177-184` (`cron.validate` + `process.exit(1)`).
- `.env.example` — documentar la var en el bloque de revistas, explicando el porqué de las 10:00.
- **`--run-now` no cambia de comportamiento**: sigue haciendo scrape → carry-forwards → chequeo de
  revistas (con el `runId` real) → finalizer, en ese orden.

### 2.3 Por qué 10:00 y no 8-9

El 30/07 Makro subió a las 07:56 y a las 09:57. Las 8:00 agarraban una; las 9:00, ninguna de las dos
que importaban. Y como el hash de dedupe incluye `content-length`/`ETag`/`Last-Modified`, una
corrección re-subida cuenta como edición nueva → una hora más tardía levanta las correcciones el
mismo día en lugar del siguiente. El botón manual baja el costo de equivocarse con la hora.

### 2.4 Consecuencias a asumir (explícitas)

- Las revistas detectadas a las 10:00 quedan con **`scrape_run_id: null`**. Ya es contrato soportado:
  `scripts/scrape-revistas.ts:78` pasa `scrapeRunId: null` siempre, la FK es nullable
  (`migrations/006_revista_layer.sql`) y los snapshots de revista aprobados son run-less.
- **No hay corrimiento de día.** Los snapshots de revista aprobados son run-less y se fechan por día
  calendario BA, así que una revista detectada a las 10:00 sigue cayendo en el export del **mismo
  día**. Lo único que se mueve es el momento de la detección, no la fecha del precio.
- `revistaRunSummary()` se calcula **al publicar**, leyendo la DB en vivo. Si alguien publica el run
  del día antes de las 10:00, el resumen no va a incluir la revista de ese día. Los **precios** del
  export no se ven afectados: los carry-forward siguen a las 6:00.

---

## Parte 3 — Cerrar el diagnóstico de prod

### 3.1 Diagnóstico medido (2026-07-30, todo read-only contra prod)

Son **dos fallas distintas**, no una.

**Falla A — desde el 29/07 el chequeo no arranca: early-return por config en EC2.**
Los carry-forward corren **antes** del chequeo y **fuera** del flag `REVISTA_ENABLED`
(`orchestrator/index.ts:71-85`), así que sirven de sonda. Snapshots run-less con
`raw_data.source='revista-carry-forward'`: **28/07 → 90, 29/07 → 90, 30/07 → 89**. El orchestrator
estuvo vivo los tres días, encoló el scrape y completó ambos carry-forward. Llegó a `runRevistaCheck`
y esa función volvió sin escribir nada.

`runRevistaCheck` vuelve vacía sin escribir en exactamente tres casos (`pipeline.ts:482-495`):
`REVISTA_ENABLED=false`, `OPENAI_API_KEY` vacía, o cero cadenas revista. **El tercero está
descartado**: `loadRevistaSupermarkets()` lee la misma base de prod y `revistas:doctor` devolvió 4
cadenas configuradas y activas. Un timeout o una excepción tampoco explican: si llegara a
`processSupermarket`, un día sin novedades escribe `outcome='no_change'` (`pipeline.ts:401`) y una
discovery caída escribe `outcome='error'` (`pipeline.ts:346`). Cero filas ⇒ nunca entró al loop.

→ **Es `REVISTA_ENABLED=false` o `OPENAI_API_KEY` vacía en el `.env` de EC2.** Falta un comando en el
server para decir cuál de las dos.

**Falla B — los días que sí corrió, se muere a mitad del procesamiento.**
Hay **5 magazines trabadas en `status='processing'`** y las 5 fueron creadas a las **09:00-09:01Z**,
que es exactamente la hora del cron (03/07, 05/07, 16/07, 26/07, 28/07). **Ninguna corrida manual
quedó trabada.** `createMagazine` deja `status='processing'` y `recordRevistaCheck` se escribe recién
al final de `processSupermarket`: si el proceso muere en el medio queda justo eso — fila trabada y
cero check-log. No es una excepción común, porque el `catch` de `processCandidate` la marcaría
`'failed'` (`pipeline.ts:251`). **El proceso fue matado.** Sospechoso principal: **OOM** — el
orchestrator tiene `max_memory_restart: '300M'` (`ecosystem.config.cjs:59`) y el render de PDF a
imágenes + la visión corren **dentro de ese proceso**. Esta parte sigue siendo hipótesis.

**Cronología que encaja con las dos:** el 28/07 09:01 el pipeline estaba habilitado (creó una fila),
se murió procesando (falla B), y **después de eso** se apagó el flag o se sacó la key (falla A) — por
eso el 29 y el 30 ya no hay ni rastro.

### 3.1-bis Defecto del dedupe: Vital re-exporta sus PDFs

`content_hash` guardado contra el que calcula la discovery hoy, para **la misma URL**:

| serie | archivo | guardado | hoy |
|---|---|---|---|
| `folder-resto` | 112964.pdf | `aadcfa3b661a65dd` | `2e73e7e167081b35` ✗ |
| `folder-nonfood-resto` | 112966.pdf | `c6edc871ad1f8a94` | `96609fb703f27f49` ✗ |
| `especial-frescos-todas` | 112967.pdf | `77f862fae5fa9f84` | `bb4e9e795bbc3d81` ✗ |
| `aviso-marca-propia-todas` | 112968.pdf | `c8103f382d78e6f2` | `1454ca36fea64528` ✗ |
| `aviso-panales-todas` | 112969.pdf | `d0037243bf64deb1` | `d0037243bf64deb1` ✓ |

**Pero NO son folletos nuevos.** Comparando el `file_size` guardado contra el `content-length` de
hoy, todos los deltas están por debajo del 0,15%:

| archivo | guardado | hoy | delta | `Last-Modified` |
|---|---|---|---|---|
| 112964 Folder | 19.452.302 | 19.472.679 | +0,10% | 29/07 17:23 |
| 112966 Folder Nonfood | 4.580.786 | 4.587.119 | +0,14% | **30/07 16:49** |
| 112967 Especial Frescos | 8.792.298 | 8.797.671 | +0,06% | 28/07 18:49 |
| 112968 Marca Propia | 3.517.256 | 3.516.929 | −0,01% | 29/07 20:08 |
| 112969 Pañales | 3.178.071 | 3.178.071 | 0 | 24/07 20:46 |

Mismo período (27.07 al 02.08), mismas páginas, tamaño casi idéntico: son **re-exportaciones del
mismo PDF**. Y `112966` cambió **durante la sesión de diagnóstico** (daba 4.592.400 / 29-07 13:26
diez minutos antes) — o sea Vital re-publica sus archivos varias veces por día.

**Esto no es "faltan folletos", es un defecto del dedupe.** El fingerprint HTTP es estable entre
requests consecutivos (verificado con dos `HEAD` seguidos), así que el hash hace lo que promete — el
problema es que promete lo incorrecto para esta cadena. Consecuencia si se reactiva el chequeo tal
cual: **cada corrida ve los folletos de Vital como nuevos, los reprocesa a costo completo de visión,
y supersedea los que el operador ya curó.** Indefinidamente.

Ya está pasando: en la base hay `112141.pdf` dos veces (`791000c3` del 13/07 in_review/superseded y
`179f136e` del 16/07 processing), mismo archivo, dos filas, dos procesamientos.

→ Ver §1.6: guarda de re-subida. **Esto es bloqueante para reactivar el cron.**

### 3.2 Confirmación pendiente (en el server, todo read-only)

El doctor ya se corrió desde local (misma base de prod) y descartó la rama "cero cadenas": devolvió 4
cadenas activas y la discovery encuentra los folletos de las 4. Lo que **solo se puede ver en el
server** es el `.env` de EC2 (está en `.gitignore` y `deploy.yml` hace `git reset --hard` sin
tocarlo):

```bash
# Falla A — cuál de las dos vars es
grep -E "^REVISTA_ENABLED=|^OPENAI_API_KEY=" ~/scraper/.env
pm2 logs orchestrator --lines 500 | grep -i revista
#   → "revista: disabled via REVISTA_ENABLED=false"  ó  "revista: OPENAI_API_KEY not set"

# Falla B — confirmar o descartar el OOM
pm2 describe orchestrator | grep -iE "restarts|uptime|memory"
pm2 logs orchestrator --lines 1000 | grep -iE "out of memory|killed|SIGKILL|heap"
```

También revisar la tabla `alerts` por filas `revista_failed`.

**Fix según la rama:** falla A → corregir el `.env` de EC2 + `pm2 restart orchestrator`. Falla B →
subir `max_memory_restart` del orchestrator en `ecosystem.config.cjs:59` (300M es muy poco para
render + visión) y destrabar las 5 filas en `processing`.

### 3.3 Que no vuelva a ser silencioso

Los tres early-return de `runRevistaCheck` (`pipeline.ts:482-495`) no dejan rastro alguno. Agregar en
`runRevistaCheckWithErrorHandling` un pre-chequeo que levante una **alerta** (vía `createAlert`,
`src/alerts/createAlert.ts` — ya sale por Telegram y por `GET /v1/alerts`) cuando
`!revistaConfig.enabled`, falte `OPENAI_API_KEY`, o `loadRevistaSupermarkets()` devuelva 0 cadenas.
Es chico y es exactamente el agujero que costó tres días de folletos.

**Que no se convierta en ruido:** si `REVISTA_ENABLED=false` fuera un estado deliberado y largo, esto
sería una alerta por día. Antes de implementarlo, mirar si `createAlert` deduplica (la tabla `alerts`
tiene acknowledge/resolve vía `PATCH /v1/alerts/:id`). Si no colapsa repetidos, emitir solo **en el
cambio de estado** (alertar cuando pasa de OK a apagado, no en cada corrida). No tiene sentido tapar
un problema de silencio creando uno de ruido.

### 3.4 Maxicomodín: son dos cadenas distintas

**Maxicomodín nunca se dio de baja en la base.**

| id | nombre | tipo | activa | productos |
|---|---|---|---|---|
| `comodin` | Comodín en Casa | web (VTEX, `comodinencasa.com.ar`) | sí | 109 activos |
| `maxicomodin` | Maxicomodín | **revista** (publuu) | **sí** | **0** |

Comodín en Casa efectivamente se scrapea online — pero eso es `comodin`, otra fila. `maxicomodin`
sigue con `source_type='revista'` e `is_active=true`, y **nunca ingirió un solo producto**. Mientras
siga así, cada corrida diaria le hace discovery (publuu, que además usa Playwright para descargar) y
procesaría su folleto si el chequeo llegara a completar — tiempo y plata en una cadena que nadie
quiere.

→ Bajarle `is_active` a `maxicomodin` en `supermarkets`.

**Hecho el 03/08, pero no como decía acá.** El `UPDATE` por SQL no alcanza:
`scripts/setup-db.ts:577` manda `is_active` en cada upsert y `db:setup` corre en
cada deploy, así que se revertía solo en el próximo merge. El cambio real es
`is_active: false` en el seed; la SQL sirve únicamente para que tenga efecto
antes del deploy.

(Aparte: publuu hashea `hash(embed)` **sin** fingerprint HTTP (`sources.ts:268`), así que sus
re-subidas son invisibles al dedupe — el problema espejo del de Vital. Si algún día vuelve, hay que
arreglarlo; fuera de alcance ahora.)

---

## Archivos que se tocan

| Archivo | Cambio |
|---|---|
| `src/revistas/preview.ts` | **nuevo** — discovery + clasificación, sin escrituras ni OpenAI |
| `src/revistas/preview.test.ts` | **nuevo** — tests de clasificación + guard antidrift |
| `src/revistas/store.ts` | `findCurrentMagazineInSeries()` |
| `src/revistas/pipeline.ts` | exportar `shouldProcessSeries`; `wouldProcess` en `:381` y `:460`; guarda de re-subida |
| `src/api/routes/revistas.ts` | `POST /v1/revistas/check`, antes del catch-all `/:magazineId` |
| `src/orchestrator/index.ts` | partir en carry-forwards / chequeo; segundo `cron.schedule`; alerta de config |
| `src/shared/env.ts` | `REVISTA_CRON` (default `0 10 * * *`) |
| `.env.example` | documentar `REVISTA_CRON` |
| `API.md`, `docs/REVISTA_CHECK_BUTTON.md` | spec del endpoint y de la UI |
| `ecosystem.config.cjs` | solo si el diagnóstico confirma OOM |

---

## Verificación

**Local, sin tocar la base:**

1. `npm run typecheck` y `npm run test` (41 tests + los nuevos). `npm run lint` está roto de fábrica
   en el repo (ESLint 10 sin flat config) — ignorar, no es de este cambio.
2. `npm run revistas:doctor` — su salida es la fuente de verdad contra la que comparar el preview:
   los mismos candidatos, los mismos hashes, los mismos estados de DB.
3. Levantar la API (`npm run dev:api`) y pegarle al endpoint con una key de `npm run apikey:create`:
   ```bash
   curl -s -X POST localhost:3000/v1/revistas/check \
     -H "X-API-Key: $KEY" -H 'Content-Type: application/json' \
     -d '{"supermarket_ids":["makro","vital","rosental"]}' | jq
   ```
4. **Probar el modo degradado**: correr la API con `REVISTA_ENABLED=false` y confirmar que el
   endpoint **igual lista folletos** y devuelve el warning. Es el requisito de §1.4 y hay que verlo
   fallar bien, no asumirlo.
5. **Probar la guarda contra el caso real**: los folletos de Vital del período 27.07 al 02.08 tienen
   que salir como `re_subida`, no como `nuevo`. Es el caso que motivó §1.6 y está vivo en prod.
6. Cron: `cron.validate('0 10 * * *')` en los tests; arrancar el orchestrator en dev y confirmar en
   el log de arranque que schedulea los tres crons (scrape, sweep, revista).
7. `npm run orchestrator:run-now` **no** debe cambiar de comportamiento — el log tiene que mostrar
   scrape → los dos carry-forward → chequeo de revistas → finalizer, en ese orden.

**En prod, después de deployar:**

8. Correr primero el bloque de diagnóstico de §3.2 y **resolver la causa raíz antes** de confiar en
   el cron nuevo: si el proceso se muere procesando, moverle la hora no arregla nada.
9. Al día siguiente: `GET /v1/revistas/checks?latest=true` tiene que mostrar un chequeo por cadena
   con `checked_at` ~10:00 ART, y los folletos de Vital como salteados por re-subida.
10. Confirmar que los carry-forward siguen corriendo a las 6:00 (log del orchestrator) y que el
    export del día no perdió precios de revista.
