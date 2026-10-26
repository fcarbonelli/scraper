# Scraper de precios — Mega Analytics

Backend en Node/TypeScript que, todos los días, junta precios de decenas de supermercados y mayoristas de Argentina, los guarda en Supabase y los sirve por una API REST. El frontend es otro repo y consume esa API.

Hoy corre en producción para el cliente Ayudín: EC2, PM2 (tres procesos: orchestrator, worker, api), Caddy, Redis en la misma máquina, Postgres en Supabase.

## Si entrás sin contexto, leé en este orden

1. [docs/COMO_FUNCIONA.md](docs/COMO_FUNCIONA.md) — cómo corre el sistema hoy: el día, las tres fuentes de precio, la publicación, y qué doc está viejo.
2. [docs/CADENAS.md](docs/CADENAS.md) — una ficha por cadena. Es lo que hay que abrir cuando “se rompió un supermercado”.
3. [AGENTS.md](AGENTS.md) — mapa del repo, convenciones y comandos, escrito para quien va a tocar código.
4. El doc del módulo que te toque (están listados en `AGENTS.md` → “Read these first”).

`plan.md` es el diseño canónico (schema, decisiones). El checklist de fases de ahí quedó atrás del código; el comportamiento actual está en `docs/COMO_FUNCIONA.md`.

## Correr en local

Hace falta Node 20+ (el proyecto se desarrolla en 22), un `.env` (ver `.env.example`) y, para la corrida diaria, Redis.

```bash
npm run dev:api          # API en http://localhost:3000/v1
npm run dev:worker       # necesita Redis
npm run dev:orchestrator # necesita Redis
npm run test:adapter -- "<url-de-un-producto>"   # prueba un adapter, sin DB
```

En PowerShell, `npm run … -- <flags>` a veces se traga el `--`. En ese caso invocá tsx directo: `npx tsx --env-file=.env scripts/test-adapter.ts "<url>"`.
