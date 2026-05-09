# Roadmap

Orden de construcción del scraper: qué se hizo, qué se está haciendo y qué falta.

---

## Vista general

```
   ┌──────────────┐
   │  FASE 1      │
   │  Fundamentos │
   └──────┬───────┘
          ▼
   ┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐
   │  FASE 2  │ ─► │  FASE 4  │ ─► │  FASE 3  │ ─► │  FASE 5  │  ◄── acá estamos
   │  Motor + │    │  API     │    │  2do     │    │  Deploy  │
   │  Coto    │    │  REST    │    │  super   │    │  AWS     │
   └──────────┘    └──────────┘    └──────────┘    └────┬─────┘
                                                        │
                                          ┌─────────────┴─────────────┐
                                          ▼                           ▼
                                   ┌──────────┐                ┌──────────┐
                                   │  FASE 6  │   en paralelo  │  FASE 7  │
                                   │ Frontend │ ◄────────────► │   Más    │
                                   │Dashboard │                │  super   │
                                   └──────────┘                └────┬─────┘
                                                                    ▼
                                                              ┌──────────┐
                                                              │  FASE 8  │
                                                              │ Hardening│
                                                              │(continuo)│
                                                              └──────────┘
```

✓ listo · ◐ en curso · — pendiente

---

## Fases


| #   | Fase               | Estado | Qué                                                                                 | Por qué en este orden                                                                                                          |
| --- | ------------------ | ------ | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Fundamentos        | ✓      | Esquema de base, infra compartida (logs, colas, validación)                         | Todo lo demás depende de esto                                                                                                  |
| 2   | Motor + Coto       | ✓      | Pipeline completo (orquestador, worker, reintentos, alertas Telegram) + 1er adapter | Coto tiene una API JSON limpia: el target más fácil para probar que el motor funciona                                          |
| 4   | API REST           | ✓      | Endpoints documentados con auth por API key                                         | Adelantamos esta fase para tener un contrato estable contra el cual construir el frontend                                      |
| 3   | Carrefour          | ✓      | 2do adapter (basado en VTEX)                                                        | ~La mitad de los supermercados de la lista usan VTEX (Disco, Jumbo, Vea, Día, etc.), así que Carrefour funciona como plantilla |
| 5   | Deploy a AWS       | ◐      | Server EC2 con HTTPS y deploy automático en cada `git push`                         | Hasta que no esté en producción, el scraper diario no corre y el frontend no tiene API a la que apuntar                        |
| 6   | Frontend Dashboard | —      | UI para visualizar precios, comparativas, alertas                                   | Construir contra una API ya desplegada es mucho más rápido. Va en paralelo con Fase 7                                          |
| 7   | Más supermercados  | —      | Los ~15 restantes                                                                   | Con alertas ya en producción, sabemos cuándo se rompe alguno. Trabajo mecánico, en paralelo con Fase 6                         |
| 8   | Hardening          | —      | Rate limiting, detección de anomalías, métricas                                     | Se agrega de forma reactiva según lo que muestre la producción                                                                 |


---

## Tiempo estimado por supermercado nuevo (Fase 7)

- **Sitio VTEX** (Disco, Jumbo, Vea, Día...): ~30 min — copiar plantilla, cambiar dominio
- **API JSON propia** (como Coto): 1–2 horas — analizar respuesta, escribir parser
- **Sitio sin API** (requiere browser): medio día a un día — solo si aparece uno; ninguno en la lista actual lo necesita

---

## Resumen ejecutivo

Lo que queda es **un único bloqueante (deploy)** y después **dos streams en paralelo**:
frontend dashboard por un lado, sumar supermercados por el otro.

El diseño "motor + adapters" hace que sumar supermercados sea trabajo mecánico, no creativo: el motor (colas, alertas, API, deploy) ya está hecho una sola vez y no se vuelve a tocar.