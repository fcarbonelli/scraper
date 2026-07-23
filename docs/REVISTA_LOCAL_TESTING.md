# Local testing notes for the revista control-view / edit work

## Offline (no DB) — start here

```bash
npm test -- src/revistas/pricing.test.ts src/revistas/series.test.ts
npm run revistas:dedupe-simulate
```

The simulator walks `examples/revistas/dedupe-cases.json` (copied from real
Rosental export screenshots) and prints keep/drop/collision decisions.

## Series-scoped carry-forward (migration 015)

Apply **`migrations/015_revista_series.sql`** in the Supabase SQL editor first
(adds `series_key`, re-supersedes per series). Then:

```bash
# 1. Soft-reset Rosental for UI re-test (keeps scanned items; clears client export)
npm run revistas:reset -- --super=rosental --dry-run
npm run revistas:reset -- --super=rosental

# 2. Cheap discovery (no AI): confirm series keys + new Makro/Vital PDFs
npm run revistas:doctor

# 3. Process new Vital/Makro issues (use --pages to cap AI cost)
npx tsx --env-file=.env scripts/scrape-revistas.ts --super=makro --pages=1-3
npx tsx --env-file=.env scripts/scrape-revistas.ts --super=vital --pages=1-3

# Expect: one CURRENT magazine per series (not one-per-chain).
# 4. After approving items on 2 series, carry-forward must emit BOTH:
npx tsx --env-file=.env scripts/scrape-revistas.ts --carry-forward
npx tsx --env-file=.env scripts/revista-approved-count.ts

# 5. Client view parity (same day BA):
npx tsx --env-file=.env scripts/client-preview-count.ts --date=YYYY-MM-DD --chain=ROSENTAL
```

### Rosental UI smoke (after soft-reset)

With `npm run dev:api` + dashboard pointing at it:

1. `GET /v1/revistas/pending` → Rosental with pending items.
2. Approve / reject / pick other product / edit (`PATCH`) / undo (`DELETE`).
3. Confirm run-less snapshot (`scrape_run_id` null, `raw_data.source` =
   `revista`) and that the row appears in `client_base` / vista cliente.

Do **not** `--force` re-scan Rosental unless `config.js` actually changed (new
quincena). Dedup now fingerprints PubHTML5 `config.js` page list, not just URL.

### EC2 gap diagnosis (why new PDFs stop landing)

If `revistas:doctor` shows live PDFs as `NOT in DB yet` for several days:

1. SSH → `pm2 describe orchestrator` / `pm2 logs orchestrator --lines 200`
2. Confirm deploy is current (`git log -1` on the server, or last Actions deploy)
3. Look for `revista check` / `revista discovery` timeouts or errors
4. Magazines stuck in `status=processing` retry on the next run; or
   `--force` that hash once
5. Manual backfill: `npm run revistas:run` (or `--super=makro`) on the box /
   locally against the same DB

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

1. Apply migrations **013 + 014 + 015** in Supabase SQL editor (015 = `series_key`).
2. Merge this backend to `main` → EC2 auto-deploys via GitHub Actions.
3. Deploy scraper-dashboard after the API is live (so PATCH/DELETE/duplicates /
   `series_key` don't 404 / look stale).
4. Soft-reset Rosental + QA carry-forward per series (commands above).

## Out of scope for this pass

A full Docker/local Supabase e2e harness is optional. Offline tests + the
report / view-resolve path against the shared DB cover the regression risk
for the duplicate / edit paths.
