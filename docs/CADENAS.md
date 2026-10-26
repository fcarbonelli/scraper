# Cadenas — ficha operativa

Una ficha por cadena, para arreglar un corte sin reconstruir el diseño desde el código. El encabezado de `src/adapters/<id>.ts` sigue siendo el detalle de implementación; esta página es el mapa. Si cambiás el comportamiento de un adapter, actualizá la ficha en el mismo cambio.

Cómo encaja en el día: [COMO_FUNCIONA.md](./COMO_FUNCIONA.md). Cómo dar de alta una cadena nueva: [ADDING_SUPERMARKETS.md](./ADDING_SUPERMARKETS.md).

El seed (activa o no, zona, canal, config de folleto/tienda) vive en `scripts/setup-db.ts`. El id de ahí es el id del adapter y el de las alertas.

## Cómo reproducir

Sin base y sin Redis, contra el sitio real:

```bash
npm run test:adapter -- "https://…url de un producto…"
```

Imprime el `ScrapeResult` (precio, stock, EAN) o el `ScrapeError`. En una cadena VTEX, `--all-zones` recorre las zonas de `src/adapters/zones.ts`.

Para escribir snapshot de una sola URL: `npm run scrape:url -- "<url>"`.

En PowerShell, si `npm run … --` se traga los flags: `npx tsx --env-file=.env scripts/test-adapter.ts "<url>"`.

Orden cuando hay una alerta: `error_type` en `job_executions` → esta ficha → el archivo del adapter → `test:adapter`. La tabla de reintentos está en [COMO_FUNCIONA.md](./COMO_FUNCIONA.md).

## Proxy residencial

Algunos sitios cortan la IP del datacenter de EC2. Esas cadenas salen por un proxy argentino **solo si** `AR_PROXY_URL` está seteada. Si no está, van directo (igual que antes de existir el proxy).

No pasan por el validador de `src/shared/env.ts`. Se leen en `src/shared/proxy.ts`:

| Variable | Qué es |
| --- | --- |
| `AR_PROXY_URL` | `http://user:pass@host:port` |
| `AR_PROXY_SUPERMARKETS` | Lista opcional de ids. Si falta, el default es `mami`, `maxiconsumo`, `la-anonima`, `atomo` |

Mercado Libre no va por el proxy: usa la API oficial, que responde desde EC2.

La Anónima, además, rota la IP de salida cuando un exit del proxy recibe 403 (`fetchLaAnonimaHtml`). El agent común es sticky; un solo exit bloqueado dejaba toda la cadena en 403.

## VTEX — la fábrica

Carrefour, Vea, Jumbo, Disco, Día, Cordiez, Supertop, Comodín, Changomas, Josimar y El Abastecedor hablan el mismo idioma. La lógica está en `src/adapters/vtex.ts` (`createVtexAdapter`). El archivo de la cadena solo pasa id, host y, a veces, una excepción.

Cómo se lee un producto:

1. La URL pública es `/<slug>/p` y **no** trae el id. La primera vez, `GET /api/catalog_system/pub/portal/pagetype/<slug>/p` devuelve el `productId`. Eso queda en `external_id`.
2. Cada día: `GET /api/catalog_system/pub/products/search?fq=productId:<id>`.
3. Búsqueda por EAN: `fq=alternateIds_Ean:<ean>`.

Decisiones que ya están en la fábrica y aplican a todas, salvo que la ficha diga otra cosa:

- **User-Agent de Chrome.** El WAF de Cencosud (Vea, Jumbo, Disco) responde 429 al UA de un bot, en el primer request. Si una cadena nueva hace lo mismo, el problema es el WAF, no el `rate_limit_ms`.
- **`listPrice` basura.** A veces viene un número enorme (un “99% de descuento”). Se descarta si es más de 10 veces el precio de venta (`MAX_LIST_PRICE_RATIO`).
- **Stock por zona.** Si el canal default vuelve sin precio o sin stock, se recorren los códigos postales de `src/adapters/zones.ts` (CABA 1414, GBA, La Plata, Córdoba, Rosario, Mendoza, Mar del Plata, Bahía Blanca, Tucumán, Neuquén). Se puede achicar por cadena con `supermarkets.config.geoRetry` / `config.zones`, sin deploy.
- **Precio tachado vs promoción.** Tachado + precio más bajo van a `list_price` y `price`. `promotions[]` es solo para promos con nombre (medio de pago, 2x1). Un `promotions: []` en un producto con descuento es lo esperado.
- **Carrefour** (`src/adapters/carrefour.ts`) es la copia anterior a la fábrica. Hace lo mismo y tiene sus tests. Las cadenas nuevas no se copian de ahí: usan `createVtexAdapter`.

### Sin trampa propia

Misma fábrica, solo cambia el host. Un bug de parseo acá se arregla en `vtex.ts` y afecta a todas.

| Id | Cadena | Host | Notas de catálogo |
| --- | --- | --- | --- |
| `vea` | Vea | `www.vea.com.ar` | Cencosud. WAF sensible al UA |
| `jumbo` | Jumbo | `www.jumbo.com.ar` | Cencosud. Igual que Vea |
| `disco` | Disco | `www.disco.com.ar` | Cencosud. Igual que Vea |
| `dia` | Día | `diaonline.supermercadosdia.com.ar` | El host no es `dia.com.ar` |
| `cordiez` | Cordiez | `www.cordiez.com.ar` | Córdoba |
| `supertop` | Supertop | `www.supertop.com.ar` | Río Cuarto y San Luis. La marca en el sitio es “Supermercados Top” |
| `carrefour` | Carrefour | `www.carrefour.com.ar` | Misma idea VTEX, archivo legado `carrefour.ts` |

### Changomas (`changomas`)

Host real: `www.masonline.com.ar` (el ecommerce que fue Walmart). El id sigue siendo `changomas` porque así está en la planilla del cliente.

El catálogo público solo devuelve el seller `"1"` (MasOnline, envío). Como la mitad de los productos que seguimos están en sucursal de retiro y no en ese seller, el día los marcaba sin stock. `regionId` en este sitio no mueve la aguja.

Por eso el adapter prende `storeSellerFallback` con CP `1414` (CABA): si el seller 1 no tiene precio, `src/adapters/vtex-sellers.ts` simula el checkout de las sucursales de esa zona y se queda con una que sí venda. El precio de sucursal queda con `inStock` solo cuando la sucursal lo puede vender. El CP se cambia en `src/adapters/changomas.ts`.

### Josimar (`josimar`)

VTEX de GBA, host `www.josimar.com.ar`. Las sucursales son **sales channels** (`sc=`), no códigos postales: el endpoint de regiones devuelve el mismo `regionId` vacío para cualquier CP, así que el geo-fallback de la fábrica no diferencia sucursales.

El precio es el mismo entre canales; lo que cambia es el stock. Canales que se barren, en este orden: `1, 3, 5, 6`.

- `sc=1` es el canal minorista de verdad. Desde 2026-09 el request **sin** `sc` volvía vacío para un montón de productos que `sc=1` sí tiene. Por eso `1` está en la lista y va primero después del default.
- Los canales `2` y `4` se dejaron afuera: en la muestra volvían vacíos y no se confirmó que usen la lista minorista. Sumar un canal es editar `salesChannels` en `src/adapters/josimar.ts` después de verificar el precio.

Síntoma típico: “missing price” masivo con el sitio abierto en un navegador. Casi siempre es el canal, no un producto dado de baja.

### El Abastecedor (`el-abastecedor`)

Host `www.abastecedor.com.ar`. La vidriera pide login para ver el precio; la Catalog API pública igual devuelve precio, stock y EAN. No hay auth.

Es mayorista de retiro: la disponibilidad es sales channel, no CP. Un request con `regionId` vuelve vacío.

- `sc=1` “Principal” tiene la mayoría.
- `sc=2` “Martin Fierro” y `sc=3` “La Reja” tienen productos que en `sc=1` no están. Esos dos se barren (`salesChannels: [2, 3]` en `src/adapters/el-abastecedor.ts`). Sin eso, el error es `region_unavailable`.

### Comodín en Casa (`comodin`)

Host `www.comodinencasa.com.ar`. VTEX estándar (Grupo Alberdi, Jujuy/Salta). El canal default `sc=1` es el minorista y el geo-fallback por CP alcanza.

Hay un `sc=2` “Supermercado Mayorista” con **otra** lista de precios. No se barre, a propósito. El mayorista de esta marca es otra cadena: Maxicomodín, por folleto, y está desactivada (ver más abajo).

## Coto (`coto`)

Archivo: `src/adapters/coto.ts`. Host: `www.cotodigital.com.ar`.

Oracle Commerce / Endeca. Cualquier URL de producto con `?format=json` devuelve el JSON que la página pinta. Hay que **sacar** query y hash al canonicalizar: los parámetros de tracking (`Dy`, `assemblerContentCollection`) rompen ese endpoint.

- El id estable es el record de Endeca en `/_/R-<id>`. El slug es decorativo; `/_/R-<id>` alcanza.
- El endpoint sirve una sola lista nacional (`priceList200`). El stock por sucursal se resuelve en el checkout, no acá. Por eso el geo-retry está apagado salvo que alguien setee `supermarkets.config.cotoZoneParam` (y `zones[].code`) con el query param real de sucursal.
- Búsqueda por EAN: el buscador `?Ntt=` no indexa el código. Se usa `Ntk=product.eanPrincipal&Ntt=<ean>&Nty=1&format=json`, y se exige que el record matchee ese EAN. Si no, un carrusel de recomendados se come el alta.
- Descuentos con nombre (`dtoDescuentos`, medios de pago) van a `promotions`. El precio tachado es `list_price` / `price`. Hubo un backfill de columnas viejas: `scripts/backfill-coto-promos.ts`.

## Super Mami (`mami`)

Archivo: `src/adapters/mami.ts`. Host: `www.supermami.com.ar`. Misma familia Endeca que Coto, otra tienda (“Neticel” / Dinoonline). También `?format=json`.

Diferencias que ya mordieron:

- El EAN es el atributo `product.ean` (en Coto es `product.eanPrincipal`).
- La URL es `/super/producto/<slug>/_/A-<id>`. El id `A-…` es el `external_id`.
- **El precio que ve el cliente está en el HTML, no en el JSON.** `sku.activePrice` atrasa en las dos direcciones: a veces sigue en el precio viejo cuando ya hay oferta, a veces sigue en oferta cuando la oferta terminó. El número grande del PDP es `price`. El regular es el máximo entre la línea “antes” (si está) y el `activePrice`, cuando ese es mayor que el HTML. Si el fetch del HTML falla, se usa solo el JSON.
- El WAF responde 403 al UA default de Node. El adapter manda un UA de browser.
- Sale por el proxy residencial (default de `AR_PROXY_SUPERMARKETS`). Sin proxy, desde EC2 la conexión se cae hasta el timeout (`fetch failed`).

## La Anónima (`la-anonima`)

Archivo: `src/adapters/la-anonima.ts`. Host: `www.laanonima.com.ar`. Plataforma propia. El precio sale del JSON-LD `Product` de la página (`gtin`, `sku`, `offers.price`). No hay browser.

URL: `/<slug>/art_<id>/`. El `external_id` es ese número, que también es el `sku` del JSON-LD.

Esta es la cadena con más condiciones de entorno. Si “falla todo La Anónima”, recorrer en este orden:

1. **Cookie de sucursal, no código postal.** Sin `Id-Sucursal-Super` el sitio tiene `super: null` y responde 302 a la home en cada producto de súper, desde cualquier IP. El adapter manda `Id-Sucursal-Super`, `Id-Sucursal-Super-DisponibleYa` y `seleccionocp=1`.
2. **Sucursal primaria: 179 (Rada Tilly).** El catálogo online de súper lo cumplen sucursales de Patagonia/Sur, no CABA. Por eso el seed tiene `provincia: CHUBUT` y `zona: PATAGONIA`. Si la primaria no tiene el producto (redirect a home, sin precio, sin JSON-LD), se barren las demás de `SUCURSAL_FALLBACKS` (~28 sucursales que sí cumplen el súper, de ~180 físicas). El snapshot guarda cuál sucursal lo sirvió (`rawData.laAnonimaSucursal`).
3. **Un código de sucursal física no alcanza.** Ejemplo medido: 9 de Julio = 260 hace redirect a la home. Solo entran sucursales que cumplen el súper online. La lista se regenera con `npm run laanonima:coverage` (read-only, desde una máquina que sí llega) y se pisa con env.
4. **WAF.** Desde la IP de EC2, 403 a todo. Va por `AR_PROXY_URL`. Un exit residencial también recibe 403 de a ratos; el adapter abre hasta `MAX_PROXY_ROTATIONS` conexiones nuevas antes de darse por vencido. Esos 403 no se barren por sucursal: sería martillar la misma IP bloqueada.
5. **El `art_<id>` cambia y el EAN no.** El PDP viejo redirige a la home desde todas las sucursales. Ahí el error es `product_not_found` y `npm run rediscover` (script `scripts/rediscover-products.ts`) vuelve a resolver el EAN y reescribe la fila.

Env, leídas directo de `process.env` (no están en el schema de `env.ts`):

| Variable | Default |
| --- | --- |
| `LA_ANONIMA_SUCURSAL_SUPER` | el primer id de la lista (179) |
| `LA_ANONIMA_SUCURSAL_FALLBACKS` | lista curada en el archivo, separada por comas |

Búsqueda por EAN: `GET /buscar/<ean>`. Si no hay match, la página **igual** muestra un carrusel “Quizás podría interesarte”. Hay que ver el banner “No encontramos resultados” antes de tomar un link `art_<id>`. Si no, cada EAN faltante se mapea a un producto cualquiera.

## Átomo (`atomo`)

Archivo: `src/adapters/atomo.ts`. Host: `atomoconviene.com`. PrestaShop. Un GET y el JSON-LD `Product`. Sin JS y sin login.

URL: `/atomo-ecommerce/<categoria>/<id>-<slug>---<EAN>.html`. El `external_id` es el id de PrestaShop. El EAN también está en la URL y en `gtin13`.

- Un 302 a la home es `product_not_found`.
- Si el 301 es la misma ficha con el slug renombrado (mismo EAN), se sigue y se cura la URL. Si el id pasó a otro EAN, sigue siendo `product_not_found`.
- `brand.name` del theme viene literal como `"$shop.name"`. No se publica marca.
- El precio a veces llega con punto de miles (`"2.276"` = 2276). Tomarlo como decimal guarda $2.28. El parser trata como miles a los grupos de exactamente 3 dígitos.
- Desde EC2 la conexión TCP se rechaza (`fetch failed`). Va por el proxy (`atomo` está en el default).

Búsqueda: `?controller=search&s=<ean>`, y solo se acepta un resultado cuya URL termine en `---<EAN>.html`.

## Parodi / DIPA (`parodi`)

Archivo: `src/adapters/parodi.ts`. Host: `cordoba.dipa.ar`. PrestaShop, mismo esquema que Átomo: JSON-LD con `gtin13`.

URL: `/<categoria>/<id>-<slug>-<EAN>.html`. El `external_id` es el id numérico del principio.

PrestaShop redirige cuando cambian el slug o la categoría, con el mismo id. Durante un tiempo el adapter trataba **todo** redirect como `product_not_found`, y varios productos vivos se marcaron `lifecycle_status = delisted` a mano. Hoy el redirect se sigue solo si el destino es el mismo id (hasta 3 saltos). Un redirect a la home o a una categoría sigue siendo no encontrado.

Si quedan filas “Discontinuado” de esa época: `npx tsx --env-file=.env scripts/reset-parodi-delisted.ts` (dry-run) y `--apply` para volverlas a `active`. El día siguiente dice si hay precio de verdad.

UA de Chrome, para no comerse un WAF. Búsqueda por EAN con la search de PrestaShop, aceptando solo la URL que embebe ese EAN.

## La Coope en Casa (`lacoopeencasa`)

Archivo: `src/adapters/lacoopeencasa.ts`. Host del sitio: `www.lacoopeencasa.coop`. API: `https://api.lacoopeencasa.coop`. Es el ecommerce de Cooperativa Obrera. La fila `cooperativa-obrera` del seed es otra cosa, inactiva, sin URL: no es esta cadena.

Angular + API Be2. `GET /api/articulo/detalle?cod_interno=<id>&simple=false`. Envelope `{ estado, mensaje, datos }`: `estado === 1` es OK, `estado === 3` es no encontrado.

URL: `/producto/<slug>/<id>`. El id del final es el `external_id`. El slug es cosmético.

El detalle **no** trae GTIN, así que un scrape no completa el EAN del maestro por sí solo. La búsqueda sí indexa el código: `POST /api/articulos/pagina_busqueda` con `termino` = EAN. Un EAN inventado vuelve con `cantidad_articulos: 0`, sin carrusel de recomendados, así que un resultado no vacío se toma como match exacto.

El precio es el de la sucursal default. Un barrido por sucursal solo se prende si `supermarkets.config.lcecZoneParam` está seteado (igual que `cotoZoneParam` en Coto).

## Maxiconsumo (`maxiconsumo`)

Archivo: `src/adapters/maxiconsumo.ts`. Host: `maxiconsumo.com`. Magento 2. El REST `/rest/V1/…` responde 403 a un invitado. Se lee el HTML: microdata (`itemprop=price`, `sku`, `name`) más el `dataLayer` de GA4 (marca y categoría).

URL: `/sucursal_<branch>/<categoria>/<slug>-<id>.html`. El `external_id` es el id numérico del final (el SKU público). Hoy la única sucursal con vidriera es `sucursal_moreno`. Los precios son de comerciante, sin login.

El HTML no trae código de barras. La búsqueda por EAN es indirecta: se busca la marca en el catálogo del cliente, se pagina el listado, y se acepta una ficha solo si el nombre matchea marca + tamaño + variedad **y** ninguna otra ficha de la misma marca matchea también. Si es ambiguo, devuelve null. Esos matches no están confirmados por EAN: hay que mirarlos antes de darlos por buenos.

Desde EC2 la conexión se cae. Está en el default del proxy.

Además del scrape web, la cadena acepta relevamiento en tienda (`config.instore`). Los mapeos cargados a mano no reemplazan a los de la web.

## Carrefour Maxi Pedido (`maxi-carrefour`)

Archivo: `src/adapters/maxi-carrefour.ts`, login en `maxi-carrefour-auth.ts`. Host: `comerciante.carrefour.com.ar`. **No es VTEX.** Es un PHP del portal comerciante. En `detectSupermarket` este host tiene que matchear antes que `carrefour.com.ar`.

```
GET /products?currentUrl=p/<EAN>&method=getProductBasicData
```

`currentUrl` va **sin** barra inicial. Con barra, el server ignora el parámetro y devuelve recomendaciones: el primer botón es siempre el mismo producto y se guardaba metadata cruzada.

La respuesta es un fragmento HTML. Nombre, marca, EAN y categoría están en `data-*` del `.cart_button` y son públicos. El precio es `data-price`. Sin sesión vale la cadena `"private"`.

`external_id` y la URL (`/p/<EAN>`) son el EAN. La búsqueda no necesita un buscador: se pide ese fragmento sin cookie y se exige que el primer `data-ean` sea el EAN pedido.

### Cómo se consigue el precio en producción

Cada `PHPSESSID` está atado a **una** sucursal, y no todas tienen todos los productos. El scrape prueba, en orden, las sesiones sembradas en `supermarkets.config`:

- `phpSessId` + `canaryEan` (la primaria)
- las extras de `maxiSessions` (otra sucursal cada una)

La primera que devuelve un número gana. Si el EAN no está en esa sucursal (fragmento vacío o `private`) se prueba la siguiente. El canario distingue “cookie muerta” de “esta sucursal no lo trabaja”.

- Ninguna cookie configurada, o todas las que tienen canario vuelven `private` → `auth_required`. Hay que volver a sembrar.
- Alguna cookie vive y el EAN no está en ninguna sucursal sembrada → `product_not_found`. Hay que sumar la sucursal que sí lo tiene, no rotar la cookie.
- Una sesión sin `canaryEan` se toma como viva, para no alarmar `auth_required` cuando el producto simplemente no está. El keepalive no puede comprobarla: hay que resembrar con un canario.

Playwright **no** corre en la corrida de EC2. reCAPTCHA Enterprise le pone nota baja a la IP del datacenter. El re-login automático existe (`refreshCookie`) y solo se dispara si `supermarkets.config.maxiCarrefourLogin.autoLogin === true`. El default es `false`.

La cookie se fabrica en una máquina con IP residencial y después **sí** sirve para leer precios desde EC2 (el endpoint de precio no revalida la IP). PHP tira la sesión a los ~24 minutos sin uso (`gc_maxlifetime`), y el scrape es una vez por día, así que algo tiene que tocar la cookie cada ~10 minutos o amanece muerta.

De eso se encarga **el orchestrator**: corre `runMaxiKeepalive` en un cron (`MAXI_KEEPALIVE_CRON`, default `*/10 * * * *`, apagable con `MAXI_KEEPALIVE_ENABLED=false`) y una vez al arrancar. Toca **todas** las sesiones sembradas (primaria + `maxiSessions`), es un `fetch` plano (sin reCAPTCHA, corre bien en EC2) y nunca re-loguea. No hay que instalar nada: alcanza con deployar el orchestrator. Se mira con:

```
pm2 logs orchestrator --lines 200 | grep maxi-keepalive
```

> Antes esto era un crontab del sistema que **nunca se llegó a instalar** en EC2 — por eso las cookies se vencían de noche y Maxi amanecía en `auth_required` (perdimos 3 días en octubre 2026). Ahora vive en el código y se deploya solo. El mismo script queda como `scripts/maxi-carrefour-keepalive.ts` para correrlo a mano. Un crontab del SO sigue siendo un fallback válido sólo si se apaga el cron del orchestrator.

Si la sesión igual murió (p. ej. hard cap del server, o nadie la tocó porque el orchestrator estaba caído), el keepalive sólo loguea: un login headless en EC2 no pasa el captcha y pisaría una cookie buena. El síntoma de “Maxi entero en `auth_required`” es, casi siempre, el keepalive caído o una cookie vencida, no un cambio de HTML — y se arregla **resembrando desde una IP residencial** (abajo), no tocando el adapter.

Sembrar de nuevo, desde una máquina residencial (el flag `--edge` usa el navegador del sistema):

```bash
npx tsx --env-file=.env scripts/maxi-carrefour-login.ts --edge --headed "--probe=<eans>"
```

Otra sucursal, sin pisar la primaria: `--append --region="<REGION>" --seller=<ID>`. El seed de `setup-db.ts` no manda `config` para esta cadena, así que `db:setup` no borra las cookies.

`MAXI_CARREFOUR_PHPSESSID` en el env es solo fallback para una prueba local.

## Mercado Libre (`mercadolibre`)

Archivo: `src/adapters/mercadolibre.ts`, tokens en `mercadolibre-auth.ts`. Se trackea **únicamente** al vendedor Ecomodico (`seller_id` 179907718, tienda `ecomodico`). El precio de la buy box es de quien esté ganando, y casi nunca es Ecomodico, así que no se lee.

Todo sale de `api.mercadolibre.com` con OAuth. Sin browser y sin proxy.

- Descubrimiento: `GET /products/search?status=active&site_id=MLA&product_identifier=<ean>`. Devuelve como mucho un producto de catálogo (`MLA…`). Se guarda solo si Ecomodico lo ofrece.
- Precio: `GET /products/<catalogId>/items?seller_id=179907718`. 404 = Ecomodico no lo vende.
- `external_id`: el id de catálogo. URL: `https://www.mercadolibre.com.ar/p/<id>`.

El Client ID y el secret van en `ML_CLIENT_ID`, `ML_CLIENT_SECRET`, `ML_REDIRECT_URI` (tienen que coincidir con el DevCenter). Los tokens no son env: `npm run ml:auth` los crea y quedan en `supermarkets.config.mlTokens`, y se rotan solos con el refresh token.

Después de activar, `npm run prune-ecomodico -- --apply` (o el tsx directo) apaga productos que Ecomodico no vende. Si quedaron maestros llamados “Unknown product”, fue porque en el alta todavía no había token y la API de catálogo de estos productos no trae GTIN: `scripts/heal-ml.ts` completa nombre y marca, y después `heal-eans` puede pegarles un EAN del catálogo.

## California (`california`)

Archivo: `src/adapters/california.ts`. Host: `www.californiasa.com.ar`. WooCommerce. El SKU **es** el EAN, y la Store API pública está abierta:

```
GET /wp-json/wc/store/v1/products?sku=<ean>
GET /wp-json/wc/store/v1/products/<id>
```

Sin HTML y sin login. El buscador de la vidriera (`?s=<ean>`) no indexa el SKU: aunque el EAN exista, dice que no hay resultados. El descubrimiento usa `?sku=`.

Los precios de la Store API vienen en centavos: `"288000"` con `currency_minor_unit: 2` es $2880.00. El `external_id` es el id numérico de WooCommerce, resuelto desde el slug `/producto/<slug>/`.

## El Cóndor (`el-condor`)

Archivo: `src/adapters/el-condor.ts`. Host: `superelcondor.com.ar` (Oberá, Misiones). WooCommerce, theme Porto. JSON-LD `Product` en la página. Sin JS y sin login.

URL: `/producto/<slug>/`. El `external_id` es el slug.

No hay `searchByEan`. El `sku` del JSON-LD es un código interno, no el código de barras, y la página no muestra GTIN. Los productos entran por URL (`scrape:url` / `scrape:bulk`). El barrido semanal de EANs saltea esta cadena.

## La Reina (`la-reina`)

Archivo: `src/adapters/la-reina.ts`. Host: `www.lareinaonline.com.ar`. ASP clásico, HTML de servidor, sin JSON-LD.

```
/productosdet.asp?Pr=<EAN>&P=1&producto=<slug>
```

`Pr` es el EAN, y es el `external_id`. Descubrir es armar esa URL y ver si renderiza. El precio está partido en el HTML: `<div class="TotPreTik">$4.006,<b>00</b></div>`. El nombre está en `h1.seo-title`. Un EAN que no existe renderiza la página sin esos bloques: eso es el no encontrado.

Misma familia de páginas que La Gallega, con una diferencia: acá `Pr` es el código de barras; en La Gallega `Pr` es un id interno.

## La Gallega (`la-gallega`)

Archivo: `src/adapters/la-gallega.ts`. Host: `www.lagallega.com.ar` (Rosario). Mismo ASP que La Reina.

URL: `/productosdet.asp?Pr=<idInterno>`. Ese `Pr` **no** es el EAN: es el `external_id`. El EAN y el nombre salen del `alt` de la imagen (`"7793… - nombre"`). El precio está en `.DetallPrec`.

El buscador (`productosnl.asp`, `TM=Bus`) indexa nombres, no códigos de barras. Buscar el EAN no devuelve nada. El descubrimiento hace otra cosa: toma la marca del catálogo del cliente, pagina esa búsqueda, y de cada resultado lee el EAN del `alt` hasta encontrar el que coincide. Cada marca se pagina una vez por corrida y se cachea.

## La Genovesa (`la-genovesa`)

Archivo: `src/adapters/la-genovesa.ts`. Host: `www.lagenovesadigital.com.ar`. ASP.NET Core Razor, sin API de producto y sin JSON-LD.

Hace falta cookie de sesión. Una visita en frío rebota a `/Home` para elegir sucursal. El adapter hace un GET a `/Home`, guarda el cookie y, si una ficha lo rebota, refresca una vez. Los precios son los de la zona invitada (el sitio usa `ClienteID=-573698` e `IDDom=1`).

Descubrimiento, el handler del lector de barras:

```
GET /LectorQR/?handler=ObtenerArticuloID&SCANNER=<ean>
```

Hit: `{ msj:"OK", articulo, promo, tipo, cliente, idpres, dom }`. Miss: un cuerpo de error (el stored procedure vuelve vacío). Con eso se arma el detalle:

```
GET /DetalleProducto?ArticuloID=…&PromID=…&Tipo=…&ClienteID=…&PresID=…&IDDom=…
```

Nombre en `p.titulo`, EAN en `.textDescripcionDetalle`, precio en `.textPrecioUnitario` (formato `$ 5.150,00`). El `external_id` es la composición `<ArticuloID>_<Tipo>_<PresID>_<PromID>`.

## Folletos

No tienen adapter en `src/adapters/`. El seed les pone `config.revista` y el pipeline de `src/revistas/` las atiende en el mismo disparo de las 06:00. Estrategia y URLs están en el seed; el comportamiento de cada estrategia, en el encabezado de `src/revistas/sources.ts`.

| Id | Estrategia | De dónde sale | Estado |
| --- | --- | --- | --- |
| `makro` | `html-pdf-links` | PDFs en `https://makro.com.ar/ofertas/` | Activa. También acepta relevamiento en tienda |
| `vital` | `html-pdf-links` | PDFs en `https://www.vital.com.ar/ofertas/` | Activa. También acepta relevamiento. Reexporta PDFs: la deduplicación no puede ser solo por URL |
| `rosental` | `pubhtml5` | Flipbook descubierto desde la home; fallback `online.pubhtml5.com` | Activa. Suele reutilizar la URL del libro entre quincenas: el hash es el contenido de `config.js` (lista de páginas), no la URL. Por cómo está armada la guarda, el botón de “qué falta” la va a marcar `re_subida` seguido; es esperable |
| `maxicomodin` | `publuu` | Flipbook en `https://supermercadoscomodin.com/maxicomodin/` | **Desactivada** (`is_active: false` en el seed, 2026-08-03). Nunca ingirió productos y cada día pagaba el descubrimiento, que en publuu usa Playwright para bajar. Reactivarla es volver ese flag a `true` y deployar (`db:setup` reescribe `is_active`; un `UPDATE` suelto se pierde en el próximo deploy) |

Makro y Vital pueden tener varias series (un PDF por sucursal / vigencia). La serie es la unidad: hay una revista vigente por serie, no una por cadena.

Comandos: `npm run revistas:doctor` (no gasta IA), `npm run revistas:run`. Specs: [REVISTA_REVIEW.md](./REVISTA_REVIEW.md), [REVISTA_CHECK_BUTTON.md](./REVISTA_CHECK_BUTTON.md), [REVISTA_DEBUG.md](./REVISTA_DEBUG.md).

Nada de un folleto llega al cliente sin aprobación de una persona.

## Relevamiento en tienda

Sin adapter y sin folleto. `source_type: 'instore'` en el seed, así el encolado diario las saltea. El precio lo carga un relevador (`/v1/in-store/*`) y lo publica un operador al aprobar la visita terminada. La fecha es el día de la aprobación. No hay carry-forward. Un producto visto sin poder leer el precio se marca `no_price` (no se tipea $1 ni $0).

| Id | Nombre |
| --- | --- |
| `diarco` | Diarco |
| `yaguar` | Yaguar |
| `nini` | Nini |
| `don-gaston` | Don Gastón |
| `oscar-david` | Oscar David |

También habilitadas para carga en tienda, además de su canal principal: `makro`, `vital`, `maxiconsumo`.

Spec: [IN_STORE_PRICE_ENTRY.md](./IN_STORE_PRICE_ENTRY.md).

## Sembradas, sin scrape

Están en `setup-db.ts` con `is_active: false`. No hay jobs.

| Id | Qué es |
| --- | --- |
| `libertad` | Hiper Libertad, `www.hiperlibertad.com.ar`. Se la menciona como VTEX en la fábrica y no tiene archivo de adapter |
| `cadena-dar` | Sin URL |
| `cooperativa-obrera` | Sin URL. La que sí se scrapea es `lacoopeencasa` |
| `maxicomodin` | Folleto publuu, apagado. Ver la tabla de folletos |
