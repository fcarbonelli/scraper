# Mega Analytics — Monitoreo de Precios en Supermercados

## Qué hace

Monitoreamos todos los días los **precios y promociones** del catálogo de un cliente en
**decenas de cadenas de supermercados y mayoristas de Argentina**, guardamos el
**historial completo** y se lo mostramos en un **dashboard web propio**, más una
exportación a Excel y una API para integrar con sus sistemas.

Le decimos al cliente a cuánto se vende su producto (y el de la competencia) en cada
cadena, cada día, sin que nadie tenga que mirar sitio por sitio.

## Qué recibe el cliente

- **Dashboard web** a medida: sus productos, precio por cadena, comparación, historial,
  promociones y qué falta cubrir. **Cada cliente tiene su propio dashboard.**
- **Exportación a Excel**: una fila por producto por cadena, con precio regular, precio
  con oferta, descuento, estado (disponible / sin stock / discontinuado / sin precio) y,
  si el cliente pasa su lista de precios objetivo, la comparación contra ese objetivo.
- **API**: para clientes con equipo técnico que quieran cruzar los datos con los suyos.

## Cobertura

Más de 35 cadenas configuradas, con más de 30 activas hoy. Clasificadas por canal
(súper vs. mayorista, nacional vs. regional) y por provincia/zona.

- **Súper nacionales:** Coto, Carrefour, Jumbo, Disco, Vea, Día, La Anónima, Changomas,
  Super MercadoLibre.
- **Mayoristas nacionales:** Maxiconsumo, Carrefour Maxi, Makro, Vital.
- **Regionales:** Átomo, Cordiez, Supertop, La Gallega, La Genovesa, La Reina, Super
  Mami, Josimar, El Abastecedor, El Cóndor, California, Comodín, Parodi, La Coope en
  Casa, Rosental, y más.
- **Mayoristas de mostrador (relevados en persona):** Diarco, Yaguar, Nini, Don Gastón,
  Oscar David.

El diferencial es la cobertura del **interior** y de **mayoristas**, canales que la
mayoría de las herramientas no mide. Sumar una cadena nueva es un trabajo acotado: se
escribe el módulo de esa cadena y el resto del sistema no se toca.

## Cómo obtenemos los precios (3 métodos)

1. **Scraping web automático** (la mayoría): un proceso lee la web de la cadena todos
   los días y extrae precio, oferta, stock y promociones. Sin intervención humana.
2. **Folletos/revistas con IA** (Makro, Vital, Rosental): cadenas que no publican precios
   online los sacan en un PDF. El sistema detecta el folleto nuevo, una IA lee las
   páginas y cruza los productos contra el catálogo, y una persona revisa y aprueba antes
   de publicar.
3. **Relevamiento en tienda** (Diarco, Yaguar, Nini, Don Gastón, Oscar David): un
   relevador va a la sucursal, escanea el código de barras con una herramienta móvil y
   carga precio de góndola, precio mayorista y observaciones. Pasa por revisión de
   back-office antes de publicarse.

En los tres casos el cliente ve el mismo dato limpio y comparable.

## Cuándo corre

- **Todos los días automáticamente** (madrugada, horario Argentina).
- **Historial permanente:** evolución de cada precio día a día.
- **Barrido semanal** que recupera productos que faltaban (p. ej. volvieron a stock).
- Los folletos se chequean a diario; si no hay novedad, no se hace nada.

## Cómo funciona por dentro

- **Motor + adaptadores.** Un motor central construido una vez (programa las corridas,
  reintenta, guarda datos, alerta). Cada cadena tiene su adaptador propio. Sumar una
  cadena = un adaptador nuevo; el motor no cambia. Por eso el sistema es agnóstico:
  sirve para cualquier producto y cualquier cliente.
- **Reintentos y alertas.** Si una cadena falla o cambia su web, el sistema reintenta y
  nos avisa por Telegram al instante, agrupado (una alerta por cadena, no spam).
- **Control de calidad.** Se marcan precios sospechosos (p. ej. $1 por estar sin stock),
  y todo lo que viene de IA o de relevamiento pasa por aprobación humana.
- **Infraestructura.** Servidor propio en AWS, base de datos administrada (Postgres),
  despliegue automático, acceso protegido por claves de API.

## Multi-cliente

El sistema está preparado para servir a varios clientes a la vez, cada uno con su
catálogo, su dashboard, sus cadenas de interés y su lista de precios objetivo. Hoy
tenemos un cliente, pero la arquitectura permite sumar más sin reconstruir nada: como
el motor es el mismo y las cadenas ya están mapeadas, incorporar un cliente nuevo es
configurar su catálogo, conectar las cadenas y darle acceso. Se construye una vez y se
puede revender muchas.

## Onboarding de un cliente nuevo

1. **Catálogo a monitorear**, idealmente con **código de barras (EAN)** — es la llave
   para cruzar el mismo producto entre cadenas.
2. **Qué cadenas le interesan** (o "todas las que tengan"). Si pide una que no cubrimos,
   se evalúa sumarla.
3. **(Opcional) Lista de precios objetivo** por canal, para la comparación real vs.
   objetivo.
4. **(Si aplica) Relevamiento en tienda** para mayoristas de mostrador.

El trabajo pesado —mapear las cadenas— ya está hecho. Un cliente que pide cadenas que ya
cubrimos puede ver datos rápido.

## Cliente actual: Ayudín

Hoy está en producción con Ayudín: monitoreamos su catálogo en las cadenas de arriba,
con un dashboard a medida donde su equipo ve y revisa todo (incluida la pantalla de
revisión diaria para aprobar folletos y relevamiento antes de publicar), más la
exportación para sus equipos comerciales. Es la prueba de que el sistema funciona
end-to-end; el siguiente paso es replicarlo para nuevos clientes.

## Preguntas frecuentes

- **¿De dónde salen los precios? ¿Es legal?** De información pública: los mismos precios
  que ve cualquier consumidor en webs, folletos y góndolas. Nada privado de las cadenas.
- **¿Cada cuánto se actualiza?** Todos los días, con historial permanente.
- **¿Cubren interior y mayoristas?** Sí, es el diferencial.
- **¿Y si una cadena cambia su web o se cae?** El sistema lo detecta, reintenta y nos
  alerta al instante.
- **¿Pueden sumar una cadena nueva?** Sí, es un trabajo acotado.
- **¿Cada cliente ve lo de los demás?** No, la información está separada por cliente.
