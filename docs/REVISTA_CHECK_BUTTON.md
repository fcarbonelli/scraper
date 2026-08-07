# Revistas — botón "¿Qué folletos faltan?" (spec de frontend)

> Compañero de [`REVISTA_REVIEW.md`](./REVISTA_REVIEW.md) (el modal de aprobación) y
> de [`REVISTA_DEBUG.md`](./REVISTA_DEBUG.md) (la vista de análisis). **Este** doc
> describe dos botones que van juntos:
>
> 1. **Chequear** — contesta, en segundos y sin gastar un peso de OpenAI: _"¿Qué
>    folletos hay hoy en cada cadena, y qué haría el chequeo automático si
>    corriera ahora?"_
> 2. **Traer** — trae los que faltan, desde la plataforma. Ese es el que gasta
>    visión, y está descrito en la segunda mitad del doc.

---

## Por qué existe

El chequeo automático corre una vez por día. Los folletos se publican cuando la
cadena quiere — el 30/07 Makro subió PDFs a las 07:56 y a las 09:57, después de
la corrida de las 6am. Antes de este botón, la única forma de saber si faltaba
algo era entrar por SSH y correr `revistas:doctor`.

Con el botón, **la hora del cron deja de ser una decisión crítica**: si se le
erra, alguien lo aprieta.

Y tiene un segundo uso, menos obvio pero más importante: es el **banco de
pruebas** del pipeline. Replica exactamente los pasos baratos de la corrida
automática (descubrir, deduplicar, clasificar) sin tocar el paso caro (descargar,
leer con visión, matchear). O sea contesta "¿qué haría el cron?" **antes** de
dejarlo correr.

---

## Endpoint

```
POST /v1/revistas/check          X-API-Key: ...
Content-Type: application/json

{ "supermarket_ids": ["makro", "vital"] }   // omitir = todas las activas
```

Es `POST` aunque no escribe nada: cada click sale a los sitios de las cadenas en
vivo. Tarda unos segundos por cadena. **No cachear, no prefetchear, no llamarlo
en un `useEffect` que se re-dispara.**

Ojo con el plural: `GET /v1/revistas/checks` es otra cosa — el log de la corrida
automática. Este es el chequeo en vivo.

### Respuesta

```ts
interface CheckResponse {
  config: {
    revista_enabled: boolean;
    openai_key_present: boolean;
    chains_configured: number;
  };
  warnings: string[];
  chains: {
    supermarket_id: string;
    supermarket_name: string;
    strategy: 'html-pdf-links' | 'pubhtml5' | 'publuu';
    checked_at: string;
    duration_ms: number;
    error: string | null;
    candidates: Candidate[];
  }[];
}

interface Candidate {
  label: string;
  series_key: string;
  source_url: string;
  hash: string;
  state: 'nuevo' | 'nueva_edicion' | 're_subida' | 'ya_en_base' | 'reprocesable' | 'serie_ignorada';
  ingestable: boolean;
  period_start: string | null;        // YYYY-MM-DD
  period_end: string | null;
  period_confidence: 'exact' | 'inferred' | null;
  expired_days_ago: number | null;    // negativo = todavía vigente
  file_size: number | null;
  last_modified: string | null;
  page_count: number | null;          // solo pubhtml5 (sale gratis del config.js)
  size_delta_pct: number | null;      // contra la edición vigente de la serie; null en pubhtml5
  reason: string;                     // por qué cayó en ese estado, en español, listo para mostrar
  existing: { id: string; status: string; detected_at: string } | null;
  current_in_series: { id: string; label: string; detected_at: string } | null;
}
```

El arreglo de la guarda de re-subida del 05/08 **no cambió ni un campo de este
contrato** — cambió qué `state` y qué `reason` devuelve para los mismos folletos.
No hay campos nuevos que buscar.

---

## La pantalla

Un botón **"Chequear folletos ahora"** arriba de la vista de Revistas, con un
selector opcional de cadenas. Al apretarlo, spinner con el nombre de la cadena
que está probando (`duration_ms` ronda los 2-6 s por cadena).

### 1. Banda de configuración — va primero

Si `warnings[]` no está vacío, mostrarlo **arriba de todo, en ámbar**, antes de
la tabla. Los textos ya vienen redactados en español desde el backend.

Esto no es decoración. El chequeo automático se apaga solo y sin dejar rastro
cuando falta `OPENAI_API_KEY` o `REVISTA_ENABLED=false` — estuvo así tres días en
producción y nadie se enteró. **El botón igual lista los folletos en ese caso**,
con el warning arriba diciendo que no se van a traer solos. Nunca mostrar un
éxito vacío.

### 2. Tabla de candidatos, agrupada por cadena

Una fila por folleto. Columnas: estado (badge), label, serie, período, vigencia,
tamaño/delta, y el motivo.

| `state` | Badge | Qué hacer |
|---|---|---|
| `nuevo` | 🟢 verde — "Nuevo" | El chequeo lo va a traer. |
| `nueva_edicion` | 🟢 verde — "Edición nueva" | Idem, y va a supersedear la anterior de esa serie. |
| `re_subida` | ⚪ gris — "Re-subida" | Mismo folleto re-exportado; se saltea. Mostrar la evidencia: `size_delta_pct` si existe, si no `page_count` (ver abajo). |
| `ya_en_base` | 🔵 azul — "Ya está" | Nada que hacer. |
| `reprocesable` | 🟠 ámbar — "Trabada" | Quedó a mitad de procesar; el chequeo la reintenta. |
| `serie_ignorada` | ⚪ gris — "Ignorada" | Filtrada por `skipSeries`. |

Detalles que importan:

- **Período**: mostrar `period_start → period_end`. Si `period_confidence` es
  `inferred`, marcarlo (un `~` o un tooltip) — viene de una frase gruesa tipo
  "Agosto primera quincena", no de fechas explícitas. Si es `null`, el label no
  trae período; eso es normal, no un error.
- **Vigencia**: `expired_days_ago` negativo = le quedan N días. Positivo = está
  **vencido hace N días**, y eso merece destacarse: un folleto vencido que sigue
  vigente en la base está emitiendo precios viejos al cliente.
- **`size_delta_pct`**: mostrarlo siempre que exista, sobre todo en `re_subida`.
  Es el número con el que el operador decide si una "re-subida" en realidad trae
  una corrección de precio (ver más abajo).
- **`size_delta_pct` en `null` NO es un dato faltante.** Rosental (`pubhtml5`)
  no tiene tamaño en la etapa de descubrimiento y nunca lo va a tener: su
  `config.js` da el título y la lista de páginas, no bytes. Ahí la evidencia del
  `re_subida` es `page_count` — mostrar "mismas 144 págs" en vez de un guión, o
  el operador va a leer "el sistema no sabe" cuando en realidad sabe.
- **`reason`**: en un tooltip o en una segunda línea chica. Viene **en español y
  redactado para mostrar tal cual** ("mismo período y misma URL (cambió 1,26% de
  tamaño) → re-exportación del folleto guardado"). No hay que traducirlo ni
  mapearlo a otro texto.
- **`error`** por cadena: si no es `null`, la fila de esa cadena va en rojo con el
  mensaje. Descubrimiento caído ≠ "no hay folletos".

### 3. Resumen

Arriba de la tabla: **"N folletos para traer"**, contando `ingestable === true`.
Es el único número que el operador realmente mira.

---

## Cómo se decide un `re_subida` (y su límite honesto)

Las cadenas re-exportan sus folletos sobre la misma URL sin que el contenido
cambie. El hash de deduplicación se mueve igual, y sin la guarda cada corrida
reprocesaría el folleto a costo completo de visión **y supersedearía lo que el
operador ya curó** — que es exactamente lo que pasó el 05/08: 178 páginas de
visión y 112 productos que se cayeron de la base del cliente ese día.

La guarda tiene **una regla por estrategia**, porque cada cadena da una señal
barata distinta:

| Estrategia | Es re-subida cuando… |
|---|---|
| `html-pdf-links` (Makro, Vital) | mismo período **exacto** en los dos lados **y misma `source_url`**. El tamaño se informa pero no decide. |
| `pubhtml5` (Rosental) | mismo título (y que **no** sea el genérico "Revista" / "PubHTML5 flipbook") **y misma cantidad de páginas**. |
| `publuu` | nunca: solo tiene la URL del embed, no hay con qué comparar. |

**Por qué la URL y no el tamaño:** las re-exportaciones reales medidas el 05/08
movieron **1,26% y 3,37%**, o sea muy por encima de cualquier tolerancia que
todavía las separe de una edición nueva. En cambio Vital le da un id de archivo
nuevo a cada edición real (`113476.pdf` contra `112964.pdf`), así que la URL
separa lo que el tamaño ya no separa. La regla **exige período exacto de los dos
lados a propósito**: una cadena que publique siempre en `/folleto-actual.pdf` con
un label sin fecha no debe congelarse nunca.

**El límite que queda:** una **corrección de precios** publicada sobre la misma
URL y dentro del mismo período se saltea. Es más chico que antes, pero existe.

Por eso el `state` es información, no una decisión final: **un `re_subida` mal
salteado siempre se recupera; una edición real salteada en silencio, no.** De ahí
que la guarda solo saltee y nunca procese de más.

### Sospecho que hay una corrección de precio

Dos cosas que el operador tiene:

1. **Traerla igual**, con el botón de Traer y `force: true` (ver más abajo). Es
   lo único que fuerza el re-escaneo, y por eso pide confirmación.
2. **La alerta automática.** Cuando la guarda saltea algo cuyo archivo se movió
   **más de 5%**, se abre un alerta `revista_review` de severidad `info` en el
   Daily Review, con el porcentaje y la URL — deduplicada por hash, así que
   aparece una vez y no una por día mientras la cadena deje ese archivo arriba.
   **Cubre solo `html-pdf-links`**: `pubhtml5` no tiene tamaño, así que en
   Rosental no hay magnitud que alertar. Es un hueco real, no una omisión.

### Rosental va a figurar `re_subida` todos los días (y está bien)

Su fila guardada conserva el `content_hash` de una fórmula anterior, así que el
hash nunca va a coincidir y el candidato cae siempre en la guarda. Badge gris,
`ingestable: false`, no suma al contador de "folletos para traer". **No es una
anomalía y no hay que destacarla.** Se limpia corriendo una vez
`scripts/revistas-undo-reupload.ts --rehash-pubhtml5 --apply`, y a partir de ahí
pasa a `ya_en_base`.

---

## Lo que este botón NO hace

- **No ingesta.** Solo muestra. Traer es el otro botón, el de acá abajo.
- **No escribe en `revista_check_log`.** Esa tabla es el libro mayor de la
  corrida *automática* y es la señal con la que se diagnostica si el cron corrió.
  Ensuciarla con clicks manuales rompería ese diagnóstico. Vale igual para el
  botón de Traer.
- **No tiene rate limiting.** No existe middleware para eso en la API. Cada click
  son hasta 3 ráfagas concurrentes contra los sitios de los súper: barato, pero
  clickear en loop les pega. Si molesta, un cache en memoria de 30 s alcanza.

---

# Traer un folleto (el segundo botón)

El chequeo contesta *qué falta*; esto lo trae, desde la plataforma y sin CLI.

**Es asincrónico y no se puede hacer sincrónico.** Traer un folleto es
descargarlo, renderizar cada página a imagen y leerlas con visión: minutos de
trabajo y cientos de MB. El proceso de la API está capado en 300M — el mismo
techo que del 28/07 al 03/08 mató al orchestrator 138 veces haciendo exactamente
esto, en silencio. Así que el request encola un job y devuelve al toque; el
trabajo corre en el orchestrator (1 G) y el panel pollea.

## Encolar

```
POST /v1/revistas/ingest          X-API-Key: ...
Content-Type: application/json

{
  "supermarket_id": "makro",
  "candidates": [
    { "hash": "bbeadb54cb79edee", "source_url": "https://…/Flyer-MM-AGO-1.pdf" }
  ]
}
```

- `candidates` sale tal cual de las filas del chequeo (`hash` y `source_url`).
  Máximo 20. **Omitirlo trae todo lo que traería el chequeo automático** — el
  equivalente a "traer los N".
- `force` (opcional, ver abajo).

Respuesta `201`:

```json
{ "jobId": "42", "supermarket_id": "makro", "requested": 1, "force": false, "status": "queued" }
```

**Se manda el `hash`, no la URL sola.** El job vuelve a descubrir en el sitio de
la cadena y solo ingesta lo que ese sitio está sirviendo; si aceptara una URL
suelta sería un "descargá y leé con visión lo que te mande". La `source_url` va
como clave de respaldo: el hash de `html-pdf-links` incluye el `content-length`,
y Vital re-sube el mismo archivo varias veces por día, así que el hash que viste
en la tabla puede estar viejo diez minutos después mientras la URL sigue siendo
la misma. Si no matchea ninguno de los dos, esa fila vuelve como `not_found`
("ya no está en el sitio de la cadena — volvé a chequear"), no como error.

## Pollear

```
GET /v1/revistas/ingest/:jobId
GET /v1/revistas/ingest?status=active|all&limit=20
```

```ts
interface IngestJob {
  jobId: string;
  supermarket_id: string;
  force: boolean;
  status: 'queued' | 'running' | 'completed' | 'failed';
  progress: {
    total: number;
    done: number;
    processed: number;
    skipped: number;
    failed: number;
    current: string | null;   // label del folleto que está leyendo AHORA
  };
  results: {
    hash: string;
    label: string;
    series_key: string;
    source_url: string;
    status: 'processed' | 'skipped' | 'failed' | 'not_found';
    reason: string;           // en español, listo para mostrar
    magazine_id: string | null;
    matched: number | null;   // productos con match, en 'processed'
    pages: number | null;
  }[];
  failed_reason: string | null;
  created_at: string;
  finished_at: string | null;
}
```

Pollear cada 3-5 s mientras `status` sea `queued` o `running`. `progress.current`
es lo único que se mueve durante minutos: mostrarlo. Un folleto de 18 páginas
tarda del orden de 3 minutos.

`GET /v1/revistas/ingest` (sin id) existe para **re-enganchar después de un
reload**: si el operador refresca el panel a mitad de una ingesta, la lista de
jobs activos devuelve el `jobId` que estaba mirando.

Cuando `status` es `completed`, la revista ya está en la cola de revisión: el
link natural del `results[].magazine_id` es la vista de aprobación
(`REVISTA_REVIEW.md`).

## Qué mostrar por cada resultado

| `status` | Qué pasó |
|---|---|
| `processed` | Entró. `matched` dice cuántos productos quedaron para aprobar — **`matched: 0` es normal y no es un error**: los folletos son de almacén y el catálogo es de limpieza. |
| `skipped` | La guarda lo frenó (ya está en base, re-subida, serie filtrada). El `reason` dice cuál. |
| `failed` | Falló el procesamiento; `reason` trae el detalle. La revista queda marcada `failed` y el chequeo la reintenta sola. |
| `not_found` | Ya no está en el sitio. Volver a chequear. |

## `force`

```json
{ "supermarket_id": "vital", "candidates": [ … ], "force": true }
```

Saltea la guarda: re-escanea aunque el folleto ya esté en base o parezca
re-subida. Es lo único que recupera una **corrección de precios** publicada sobre
la misma URL y el mismo período.

**Pedir confirmación explícita antes de mandarlo.** Forzar re-escanea a costo
completo de visión y supersedea lo que el operador ya curó: el 05/08 eso costó
178 páginas de visión y 112 mappings caídos de la base del cliente. La
confirmación tiene que decir eso, no un "¿estás seguro?".

Ofrecerlo solo en filas `re_subida` / `ya_en_base`. En una fila `nuevo` o
`nueva_edicion` no cambia nada y solo agrega riesgo.

## Detalles de operación

- **Un job por vez.** La cola corre con concurrencia 1: dos ingestas en paralelo
  renderizando PDFs en el mismo proceso es cómo se llega al techo de memoria.
  Encolar de a varias está bien; se procesan en fila.
- **Doble click es inofensivo.** Las guardas se re-evalúan adentro del job, no al
  encolar, así que el segundo termina en `skipped` con el motivo — nunca en dos
  revistas iguales. Vale igual si el click cae justo mientras corre el chequeo
  de las 6am.
- **Sin `OPENAI_API_KEY` el job falla fuerte**, con `status: 'failed'` y el
  motivo en `failed_reason`. A propósito: el chequeo automático en ese caso se
  apaga en silencio, y esa es justamente la falla que estos botones existen para
  mostrar.
- Los jobs terminados se retienen **24 h** (los fallidos, 7 días). Después, un
  `GET` con ese `jobId` devuelve 404: no es un error, es el historial que se
  vació. El historial real de revistas está en `GET /v1/revistas`.
- **Al deployar hay que reiniciar los DOS procesos**, no solo la API: la ruta
  vive en `api` y quien hace el trabajo vive en `orchestrator`
  (`npm run build && pm2 reload api orchestrator`). Si se reinicia solo la API,
  cada `POST` devuelve un `jobId` que se queda en `queued` para siempre — sin
  error, sin log, solo un spinner que no termina. La confirmación de que está
  bien es la línea `revista ingest worker ready` en el log del orchestrator.
