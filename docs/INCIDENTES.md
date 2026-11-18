# Incidentes: qué avisa Telegram y cómo se arregla

Telegram avisa solo cuando una cadena está **realmente rota**. Que todos los días falte un porcentaje de productos (sin stock, deslistados, no están en esa sucursal) es normal y no avisa nunca.

Cada aviso es un **incidente** guardado en `alerts` con su evidencia. Para arreglarlo alcanza con decirle a un agente:

> Revisá los incidentes abiertos (`npm run incidents`) y arreglalos siguiendo docs/INCIDENTES.md.

## Cuándo avisa

Se evalúa una vez por cadena, cuando termina la corrida (`src/orchestrator/finalize.ts` → `src/alerts/aggregate.ts`). Nunca a mitad de corrida. Las reglas viven en `src/alerts/policy.ts` (con tests):

| Tipo | Regla | Severidad |
| --- | --- | --- |
| `supermarket_down` | 10% o menos de los productos con precio | critical |
| `supermarket_blocked` | Al menos 25% de la cadena con un error que no se arregla solo: `auth_required`, `selector_failed`, `parse_failed`, o `not_run` (jobs que nunca terminaron: worker o cola caídos). En una corrida de recuperación también cuentan los errores transitorios (timeout, 429, 5xx) que el reintento no arregló | critical |
| `supermarket_drop` | La tasa de éxito cayó a menos de la mitad de la mediana de las últimas 7 corridas de esa cadena. Necesita al menos 3 corridas de historial | warning |

Siempre hace falta un mínimo de 3 productos fallidos.

Si la mayoría de las fallas son transitorias (red, 429, 5xx), primero se agenda **un** reintento automático a los 20 minutos (`src/orchestrator/recovery.ts`) y no se avisa. La corrida de recuperación se evalúa sumada a la original. Si sigue rota, ahí sí avisa.

## Una vez por incidente

El incidente se identifica por `fingerprint = scrape:<supermarket_id>`.

- **Abre**: manda un mensaje con botones (Retry failed / Fill yesterday / Acknowledge).
- **Se repite** al día siguiente: no manda nada. Solo suben `occurrences` y `last_seen_at`, y se refresca `evidence`.
- **Empeora** (de warning a critical): manda otro mensaje.
- **Se arregla**: la próxima corrida sana lo resuelve sola y manda un "✅ Resuelto" **silencioso**, sin sonido.

"Acknowledge" lo deja abierto pero callado hasta que se resuelva.

## La evidencia

`alerts.evidence` (migración 038):

```json
{
  "run_id": "…",
  "kind": "blocked",
  "dominant_error": "auth_required",
  "success_rate": 0.62,
  "baseline_success_rate": 0.97,
  "error_counts": { "auth_required": 70, "product_not_found": 3 },
  "samples": [
    {
      "error_type": "auth_required",
      "external_url": "https://…",
      "error_message": "…",
      "job_execution_id": "…",
      "supermarket_product_id": "…"
    }
  ],
  "card": "docs/CADENAS.md (Maxi Carrefour)"
}
```

## Cómo se arregla (playbook para el agente)

1. `npm run incidents`. Opciones: `--super=<id>` para una sola cadena, `--json` para las filas crudas.
2. Para cada incidente:
   1. Leer la tarjeta de la cadena en [CADENAS.md](./CADENAS.md). La mayoría de los modos de fallo ya pasaron antes: cookie vencida, WAF, sucursal, JSON atrasado.
   2. Reproducir con una URL de `samples`, sin base ni Redis: `npm run test:adapter -- "<url>"`.
   3. Si hace falta más contexto, mirar `job_executions` de ese `run_id` (`error_type`, `error_message`, `error_stack`).
   4. Arreglar: el adapter, la config en `supermarkets.config` o la cookie/token. Si el arreglo cambia el comportamiento del adapter, actualizar su tarjeta en CADENAS.md.
   5. Verificar con `npm run scrape:url -- "<url>"`.
3. Cerrar el incidente:
   - Esperar a la próxima corrida (se resuelve solo), o
   - cerrarlo a mano después de verificar: `npx tsx --env-file=.env scripts/incidents.ts --resolve=<id> --note="qué se hizo"`.
4. Si el problema necesita algo que solo puede hacer una persona (login desde IP residencial, reCAPTCHA), dejarlo abierto y decirlo.

`npm run incidents` también muestra las alertas de revistas abiertas: `revista_failed`, `revista_stuck`, `revista_disabled`. Esas no se resuelven solas: cerralas con `--resolve` una vez arregladas.

## Qué no avisa más

- Las alertas "tempranas" a mitad de corrida. Antes salía una por cada producto fallido a partir del décimo, por un bug de deduplicación.
- `supermarket_unstable` (30–80% de fallas): para varias cadenas ese es su estado normal de todos los días.
- Los resúmenes `info` (barrido semanal, revistas nuevas para revisar) siguen filtrados por `TELEGRAM_MIN_SEVERITY=warning`.

## Ajustar umbrales

Las constantes están arriba de `src/alerts/policy.ts`. Si cambiás una, agregá el caso real a `policy.test.ts`.
