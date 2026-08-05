# Revistas — botón "¿Qué folletos faltan?" (spec de frontend)

> Compañero de [`REVISTA_REVIEW.md`](./REVISTA_REVIEW.md) (el modal de aprobación) y
> de [`REVISTA_DEBUG.md`](./REVISTA_DEBUG.md) (la vista de análisis). **Este** doc
> describe un botón que contesta una sola pregunta, en segundos y sin gastar un
> peso de OpenAI:
>
> _"¿Qué folletos hay hoy en cada cadena, y qué haría el chequeo automático si
> corriera ahora?"_

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

1. **Traerla a mano** — es lo único que fuerza el re-escaneo:
   ```
   npm run revistas:run -- --super=vital --force
   ```
   El botón nunca ingesta (ver abajo).
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

- **No ingesta.** Solo muestra. Traer un folleto sigue siendo
  `npm run revistas:run -- --super=<id>`, que es donde está el costo de visión.
- **No escribe en `revista_check_log`.** Esa tabla es el libro mayor de la
  corrida *automática* y es la señal con la que se diagnostica si el cron corrió.
  Ensuciarla con clicks manuales rompería ese diagnóstico.
- **No tiene rate limiting.** No existe middleware para eso en la API. Cada click
  son hasta 3 ráfagas concurrentes contra los sitios de los súper: barato, pero
  clickear en loop les pega. Si molesta, un cache en memoria de 30 s alcanza.
