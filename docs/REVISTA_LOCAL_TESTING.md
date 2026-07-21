# Local testing notes for the revista control-view / edit work

## Offline (no DB) — start here

```bash
npm test -- src/revistas/pricing.test.ts
npm run revistas:dedupe-simulate
```

The simulator walks `examples/revistas/dedupe-cases.json` (copied from real
Rosental export screenshots) and prints keep/drop/collision decisions.

## Against a shared / prod-like Supabase (read-only first)

1. Apply migration `migrations/013_revista_edit_dedupe.sql` in the Supabase
   SQL editor (adds `scraped_on`, `approved_override`, and
   `revista_items_enriched` — **no** unique index; defence is the control view).
2. Report recent duplicates / collisions (no writes). Default window for the
   API is last 3 BA days; the CLI script can go wider:
   ```bash
   npx tsx --env-file=.env scripts/revistas-dedupe-cleanup.ts --days=3
   npx tsx --env-file=.env scripts/revistas-dedupe-cleanup.ts --super=rosental
   ```
3. Prefer resolving from the control view once the API is up:
   - `GET /v1/revistas/duplicates` (default last 3 BA days)
   - `POST /v1/revistas/duplicates/resolve` (one group per click)
   The CLI `--apply` path remains available for ops, but is not required.
4. Smoke the rest of the API (needs `npm run dev:api` + an API key):
   - `GET /v1/revistas/items?status=approved`
   - `GET /v1/revistas/ean-collisions`
   - `PATCH /v1/revistas/items/:id` / `DELETE /v1/revistas/items/:id`

## Deploy order

1. Apply migration 013 in Supabase SQL editor.
2. Merge this backend to `main` → EC2 auto-deploys via GitHub Actions.
3. Deploy scraper-dashboard after the API is live (so PATCH/DELETE/duplicates
   don't 404).

## Out of scope for this pass

A full Docker/local Supabase e2e harness is optional. Offline tests + the
report / view-resolve path against the shared DB cover the regression risk
for the duplicate / edit paths.
