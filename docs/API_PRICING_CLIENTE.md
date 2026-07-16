# API de Pricing — Guía de Integración

Documento de integración para el consumo de la información de precios relevados.
Describe el endpoint disponible, la autenticación, los parámetros de consulta, la
estructura de la respuesta y el detalle de cada campo.

> **Versión:** 1.0
> **Base URL:** `https://api.meganalytics.net`
> **Formato:** JSON (UTF-8)

---

## 1. Autenticación

Todas las solicitudes deben incluir una clave de API en el encabezado HTTP
`X-API-Key`. La clave es provista por nuestro equipo y es personal e intransferible.

```
X-API-Key: <clave-provista>
```

### Credencial asignada

```
X-API-Key: 0403c7bfe34b10fa28d7bc52d98b8a32b0605194d3925b65cf326ee3a1a3fa63
```

> **Confidencial:** esta clave es secreta. No debe compartirse públicamente ni
> publicarse en repositorios o sistemas de terceros. Ante una posible filtración,
> solicitar su rotación a nuestro equipo.

Si la clave falta o es inválida, el servicio responde con `ProcesadoOk: false` y el
detalle correspondiente en el campo `Error` (ver sección [Manejo de errores](#7-manejo-de-errores)).

---

## 2. Endpoint

```
GET /v1/data/pricing
```

Devuelve los registros de pricing relevados, ordenados de la fecha más reciente a la
más antigua. La respuesta admite **paginación** para permitir el consumo parcial de
grandes volúmenes de información.

### Prueba rápida (sin filtros)

Para verificar la conexión y la credencial, la forma más simple es pedir la primera
página **sin ningún filtro**: siempre devuelve los datos más recientes disponibles.

```bash
curl -H "X-API-Key: <clave-provista>" \
  "https://api.meganalytics.net/v1/data/pricing?page=1&limit=100"
```

### Ejemplo con filtro de fechas

Al filtrar por fecha, usar un rango **dentro del período disponible** (los datos
publicados son recientes). Ajustar `from` / `to` al período que se desea consultar:

```bash
curl -H "X-API-Key: <clave-provista>" \
  "https://api.meganalytics.net/v1/data/pricing?from=2026-07-14&to=2026-07-16&page=1&limit=100"
```

> **Importante:** un rango de fechas sin datos (por ejemplo, anterior al inicio del
> relevamiento) devuelve `ProcesadoOk: true` con `PriceData: []`. Esto **no es un
> error**: significa que no hay registros para ese filtro. Ver la sección
> [Solución de problemas](#71-solución-de-problemas-comunes).

### Cómo probar la API

- **Postman / Insomnia / código:** agregar el header `X-API-Key` con la clave provista
  (el nombre del header debe ser exactamente `X-API-Key`). Es la forma recomendada.
- **Navegador:** pegar la URL directamente en el navegador **no funciona**, porque no
  permite enviar el header `X-API-Key` y la respuesta será `401`. Usar Postman/Insomnia
  o `curl`.
- **PowerShell (Windows):** `curl` es un alias de `Invoke-WebRequest` y **no** entiende
  `-H`. Usar `curl.exe` y encerrar la URL entre comillas (el `&` de la query rompe el
  comando si no está entrecomillado):

```powershell
curl.exe -H "X-API-Key: <clave-provista>" "https://api.meganalytics.net/v1/data/pricing?page=1&limit=100"
```

---

## 3. Parámetros de consulta

Todos los parámetros son **opcionales**. Si no se envía ninguno, se devuelve la
primera página con el conjunto de datos más reciente.

| Parámetro | Tipo | Default | Descripción |
|-----------|------|---------|-------------|
| `page` | entero | `1` | Número de página a consultar. |
| `limit` | entero | `100` | Cantidad de registros por página (máximo `1000`). |
| `from` | fecha `YYYY-MM-DD` | — | Fecha de relevamiento desde (inclusive). |
| `to` | fecha `YYYY-MM-DD` | — | Fecha de relevamiento hasta (inclusive). |
| `supermarket` | texto | — | Cadena/s a filtrar. Admite múltiples separadas por coma, ej. `coto,carrefour`. |
| `canal` | texto | — | Canal a filtrar, ej. `SPM NACIONAL`, `SPM REGIONAL`, `MAY NACIONAL`. |
| `ean` | texto | — | Filtra por un EAN puntual. |

> **Particionamiento por período:** se recomienda combinar `from` / `to` con la
> paginación para procesar la información en bloques manejables (por ejemplo, un día
> o una semana por vez).

---

## 4. Estructura de la respuesta

La respuesta es un objeto con la siguiente estructura:

```json
{
  "ProcesadoOk": true,
  "Error": "",
  "PriceData": [
    {
      "Pricing_Id": "1024",
      "Fecha_Creacion": "2025-10-06T09:15:00.000Z",
      "Fecha_Modificacion": "2025-10-06T09:15:00.000Z",
      "Provincia": "MENDOZA",
      "Zona": "OESTE",
      "Mes": "Octubre del 2025",
      "Semana": "40",
      "Canal": "SPM REGIONAL",
      "Cadena": "ATOMO",
      "Categoria": "AERO",
      "Subcategoria": "DESINF",
      "Fabricante": "S.C. JOHNSON Y SON S.A.I.C.",
      "Marca": "LYSOFORM",
      "Formato": "360",
      "Variedad": "OR",
      "Descripcion_Para_Forms": "AERO DESINF LYSOFORM 360 OR",
      "EAN": "7790520995285",
      "Desc_Sku_Sitio": "DESINF.AMBIENTE LYSOFORM ORIGINAL 360 ML.",
      "Estado": "ok",
      "Precio_Regular": "3648",
      "URL": "https://www.atomoconviene.com/...",
      "Precio_Mas_Bajo": "3648",
      "Index_Competencia": "",
      "Marca_Competencia": ""
    },
    {
      "Pricing_Id": "1025",
      "Fecha_Creacion": "2025-10-06T09:16:00.000Z",
      "Fecha_Modificacion": "2025-10-06T09:16:00.000Z",
      "Provincia": "MENDOZA",
      "Zona": "OESTE",
      "Mes": "Octubre del 2025",
      "Semana": "40",
      "Canal": "SPM REGIONAL",
      "Cadena": "ATOMO",
      "Categoria": "AERO",
      "Subcategoria": "DESINF",
      "Fabricante": "S.C. JOHNSON Y SON S.A.I.C.",
      "Marca": "GLADE",
      "Formato": "360",
      "Variedad": "OR",
      "Descripcion_Para_Forms": "AERO DESINF GLADE 360 OR",
      "EAN": "7794000123456",
      "Desc_Sku_Sitio": "DESINF.AMBIENTE GLADE ORIGINAL 360 ML.",
      "Estado": "out_of_stock",
      "Precio_Regular": "",
      "URL": "https://www.atomoconviene.com/...",
      "Precio_Mas_Bajo": "",
      "Index_Competencia": "",
      "Marca_Competencia": ""
    }
  ],
  "Paginacion": {
    "Pagina": 1,
    "Limite": 100,
    "TotalRegistros": 3900,
    "TotalPaginas": 39
  }
}
```

### Campos del nivel raíz

| Campo | Tipo | Descripción |
|-------|------|-------------|
| `ProcesadoOk` | booleano | `true` si la consulta se procesó correctamente; `false` ante un error. |
| `Error` | texto | Mensaje de error. Cadena vacía (`""`) cuando `ProcesadoOk` es `true`. |
| `PriceData` | arreglo | Listado de registros de pricing (ver sección 5). Arreglo vacío si no hay datos. |
| `Paginacion` | objeto | Metadatos de paginación (ver sección 6). |

> **Importante:** todos los valores dentro de `PriceData` se entregan como **texto
> (string)**, incluso los numéricos (precios, semana, etc.), tal como fue solicitado.

---

## 5. Detalle de los campos de `PriceData`

| Campo | Obligatorio | Descripción | Ejemplo |
|-------|:-----------:|-------------|---------|
| `Pricing_Id` | Sí | Identificador único e incremental del registro. | `"1024"` |
| `Fecha_Creacion` | Sí | Fecha y hora de creación del registro (ISO 8601). | `"2025-10-06T09:15:00.000Z"` |
| `Fecha_Modificacion` | Sí | Fecha y hora de última actualización del registro (ISO 8601). | `"2025-10-06T09:15:00.000Z"` |
| `Provincia` | Sí | Provincia asociada a la cadena/sucursal relevada. | `"MENDOZA"` |
| `Zona` | Sí | Zona geográfica. | `"OESTE"` |
| `Mes` | Sí | Mes del relevamiento en formato legible. | `"Octubre del 2025"` |
| `Semana` | Sí | Número de semana del año. | `"40"` |
| `Canal` | Sí | Canal comercial. | `"SPM REGIONAL"` |
| `Cadena` | Sí | Nombre de la cadena. | `"ATOMO"` |
| `Categoria` | Sí | Categoría del producto. | `"AERO"` |
| `Subcategoria` | Sí | Subcategoría del producto. | `"DESINF"` |
| `Fabricante` | Sí | Empresa fabricante. | `"S.C. JOHNSON Y SON S.A.I.C."` |
| `Marca` | Sí | Marca del producto. | `"LYSOFORM"` |
| `Formato` | Sí | Formato/medida del producto. | `"360"` |
| `Variedad` | Sí | Variedad del producto. | `"OR"` |
| `Descripcion_Para_Forms` | Sí | Descripción normalizada del producto. | `"AERO DESINF LYSOFORM 360 OR"` |
| `EAN` | Sí | Código de barras (EAN-13). | `"7790520995285"` |
| `Desc_Sku_Sitio` | Sí | Descripción del producto tal como figura en el sitio relevado. | `"DESINF.AMBIENTE LYSOFORM ORIGINAL 360 ML."` |
| `Estado` | Sí | Estado del relevamiento del registro. `ok` indica un precio real; cualquier otro valor indica que ese día no hubo precio y explica el motivo (ver [Estados](#51-estados-del-registro-estado)). | `"ok"` |
| `Precio_Regular` | Sí | Precio regular (de lista). **Puede venir vacío (`""`)** cuando `Estado` ≠ `"ok"`. | `"3648"` |
| `URL` | Sí | URL de la página del producto relevada. | `"https://..."` |
| `Precio_Mas_Bajo` | Sí | Precio más bajo detectado (considerando ofertas vigentes). **Puede venir vacío (`""`)** cuando `Estado` ≠ `"ok"`. | `"3648"` |
| `Index_Competencia` | Sí | Índice de competencia. **Pendiente** (ver sección 8). | `""` |
| `Marca_Competencia` | Sí | Marca de competencia asociada. **Pendiente** (ver sección 8). | `""` |

### 5.1 Estados del registro (`Estado`)

Para que la serie histórica **no tenga huecos**, todo producto relevado genera un
registro por día, incluso cuando no se obtuvo un precio. El campo `Estado` indica
qué ocurrió en cada caso:

| `Estado` | Significado | Precio |
|----------|-------------|--------|
| `ok` | Precio relevado correctamente. | Presente |
| `out_of_stock` | Producto sin stock confirmado ese día. | Vacío (o último precio conocido) |
| `not_found` | La página del producto no existe / fue dada de baja en el sitio. | Vacío |
| `delisted` | Producto discontinuado o removido del catálogo de la cadena. | Vacío |

Todos los estados describen una **situación real del producto** (con precio, sin
stock, o dado de baja). Solo se publican registros ya verificados.

> **Recomendación:** filtrar por `Estado == "ok"` cuando solo se necesiten precios
> efectivos; conservar los demás estados para auditar la continuidad de la serie.

---

## 6. Paginación

El objeto `Paginacion` permite recorrer la totalidad de los registros de a bloques.

| Campo | Tipo | Descripción |
|-------|------|-------------|
| `Pagina` | entero | Página actual devuelta. |
| `Limite` | entero | Cantidad de registros por página. |
| `TotalRegistros` | entero | Cantidad total de registros que cumplen el filtro. |
| `TotalPaginas` | entero | Cantidad total de páginas disponibles. |

### Cómo recorrer todas las páginas

1. Realizar la primera consulta con `page=1` (y los filtros deseados).
2. Leer `Paginacion.TotalPaginas` en la respuesta.
3. Repetir la consulta incrementando `page` hasta alcanzar `TotalPaginas`.

```bash
# Página 1
curl -H "X-API-Key: <clave>" "https://api.meganalytics.net/v1/data/pricing?from=2026-07-16&to=2026-07-16&page=1&limit=500"
# Página 2
curl -H "X-API-Key: <clave>" "https://api.meganalytics.net/v1/data/pricing?from=2026-07-16&to=2026-07-16&page=2&limit=500"
```

> **Recomendación:** para relevamientos diarios completos, filtrar por un día
> (`from` = `to`) y paginar con un `limit` de entre 500 y 1000 registros.

---

## 7. Manejo de errores

Ante cualquier inconveniente, el servicio responde con `ProcesadoOk: false`, un
mensaje descriptivo en `Error` y `PriceData` como arreglo vacío.

```json
{
  "ProcesadoOk": false,
  "Error": "Parámetros de consulta inválidos: 'from' debe tener formato YYYY-MM-DD.",
  "PriceData": [],
  "Paginacion": {
    "Pagina": 1,
    "Limite": 100,
    "TotalRegistros": 0,
    "TotalPaginas": 0
  }
}
```

Códigos HTTP asociados:

| Código HTTP | Situación |
|-------------|-----------|
| `200 OK` | Consulta procesada correctamente (`ProcesadoOk: true`). |
| `400 Bad Request` | Parámetros de consulta inválidos. |
| `401 Unauthorized` | Falta la clave de API o es inválida. |
| `500 Internal Server Error` | Error inesperado del servicio. |

### 7.1 Solución de problemas comunes

| Síntoma | Causa probable | Solución |
|---------|----------------|----------|
| `401` con `"Error": "Missing X-API-Key header"` | No se envió el header (típico al pegar la URL en el navegador). | Enviar el header `X-API-Key` desde Postman/Insomnia o `curl`. El navegador no sirve para probar. |
| `401` con `"Error": "Invalid API key"` | Clave incorrecta o nombre de header mal escrito. | Verificar que la clave sea la provista y que el header se llame exactamente `X-API-Key`. |
| `ProcesadoOk: true` pero `PriceData: []` | El filtro (fechas, cadena o EAN) no coincide con ningún registro. **No es un error.** | Ampliar el rango de fechas o quitar filtros. Los datos publicados son recientes: un `from`/`to` fuera del período disponible devuelve vacío. Probar primero sin filtros. |
| En PowerShell: `Invoke-WebRequest : Missing an argument for parameter 'SessionVariable'` | `curl` es un alias de `Invoke-WebRequest`, que no entiende `-H`. | Usar `curl.exe` (no `curl`) y encerrar la URL entre comillas. |

---

## 8. Campos pendientes de definición

Los siguientes campos están **incluidos en la estructura** pero por el momento se
entregan **vacíos** (`""`), a la espera de la definición de su lógica de cálculo y/o
de la disponibilidad de la información de origen:

| Campo | Motivo |
|-------|--------|
| `Index_Competencia` | Indicador calculado de competencia. Pendiente de definición de la fórmula. |
| `Marca_Competencia` | Marca de competencia asociada a cada producto. Pendiente de la tabla de equivalencias por EAN. |

Estos campos se mantendrán presentes en la respuesta para no alterar la estructura;
únicamente se completará su valor cuando estén disponibles.

---

## 9. Consideraciones generales

- La estructura descripta representa el **conjunto mínimo de campos** acordado para la
  integración. De disponerse de información adicional (por ejemplo, precios de oferta o
  promociones), podrá incorporarse como campos extra **sin afectar** los campos
  obligatorios ya definidos.
- El servicio entrega únicamente la información de **días ya verificados y
  publicados** por nuestro equipo. Por eso "los datos más recientes" corresponden al
  último día publicado, que puede tener una breve demora respecto del relevamiento.
- Cada producto verificado tiene un registro por día. Cuando no hubo precio pero sí
  una situación real (sin stock, baja del catálogo), el registro se entrega igualmente
  con el `Estado` correspondiente (ver sección 5.1). Los inconvenientes operativos del
  relevamiento no se publican como registros.
- Todos los valores de `PriceData` se entregan como texto (string).
- Las fechas (`Fecha_Creacion`, `Fecha_Modificacion`) se expresan en formato ISO 8601
  (UTC).
- El servicio contempla **paginación** para facilitar el procesamiento de grandes
  volúmenes de información, según se detalla en la sección 6.

---

## 10. Resumen rápido

```
GET /v1/data/pricing?from=YYYY-MM-DD&to=YYYY-MM-DD&page=1&limit=500
Header: X-API-Key: <clave-provista>

→ { ProcesadoOk, Error, PriceData[], Paginacion }
```

Ante cualquier duda sobre la integración, contactar a nuestro equipo técnico.
