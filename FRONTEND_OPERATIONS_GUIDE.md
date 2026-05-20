# Frontend Operations Update Guide

This guide covers the scraper observability and recovery changes added for daily supermarket operations.

## What Changed

Runs now expose live progress before finalization. The backend no longer waits 90 minutes of silence once every product has a final outcome; a run completes when all planned products are either successful or finally failed, with no latest outcome still retrying. The finalizer now checks every minute.

The API also has product-level failure drilldown and recovery actions:

- View live run progress by supermarket.
- List failed products with product name, supermarket, URL, error details, attempts, and latest known snapshot.
- Retry selected failed products by creating a new recovery run.
- Manually enter a price snapshot when scraping failed but you know the correct price.
- Receive early supermarket alerts during a run when failures spike.

## New Endpoints

### `GET /v1/runs/:id/progress`

Use this for the live run screen. Poll every 10-30 seconds while `run.status === "running"`.

Response:

```ts
interface RunProgressResponse {
  data: {
    run: ScrapeRun;
    progress: {
      total_jobs: number;
      distinct_started: number;
      completed: number;
      pending: number;
      succeeded: number;
      failed: number;
      running_or_retrying: number;
      retried_products: number;
      latest_activity_at: string | null;
      ms_since_latest_activity: number | null;
      by_supermarket: Record<
        string,
        {
          total: number;
          pending: number;
          running_or_retrying: number;
          succeeded: number;
          failed: number;
        }
      >;
    };
  };
}
```

Recommended UI:

- Show global progress: `completed / total_jobs`.
- Show pending, retrying, succeeded, failed counts.
- Render one row/card per supermarket using `by_supermarket`.
- Use `latest_activity_at` to show whether the run is still moving.

### `GET /v1/runs/:id/failures`

Use this for the debugging table.

Query params:

- `page`, `limit`
- `supermarket=<id>`
- `error_type=<type>`

Each row includes:

```ts
interface RunFailureRow {
  job_execution_id: string;
  supermarket_product_id: string;
  attempts: number;
  final_attempt: number;
  status: "failed";
  error_type: string | null;
  error_message: string | null;
  error_stack: string | null;
  duration_ms: number | null;
  started_at: string;
  finished_at: string | null;
  supermarket: { id: string; name: string } | null;
  supermarket_product: {
    id: string;
    external_id: string;
    external_url: string | null;
  } | null;
  product: {
    id: string;
    name: string;
    brand: string | null;
    category: string | null;
    metadata: Record<string, unknown>;
  } | null;
  latest_snapshot: Snapshot | null;
}
```

Recommended UI:

- Columns: supermarket, product name, external id, error type, attempts, duration, last price, actions.
- Add filters for supermarket and error type.
- Show `error_message` in an expandable detail panel.
- Show `error_stack` only behind a "technical details" toggle.

### `POST /v1/runs/:id/retry-failed`

Creates a new recovery run from failed products in a previous run.

Body:

```ts
interface RetryFailedBody {
  supermarket?: string;
  error_type?: string;
  supermarket_product_ids?: string[];
  max?: number; // default 500, max 1000
}
```

Response:

```ts
interface RetryFailedResponse {
  data: {
    source_run_id: string;
    retry_run_id: string | null;
    total_enqueued: number;
    by_supermarket: Record<string, number>;
  };
}
```

Recommended UI actions:

- "Retry all failed for this supermarket"
- "Retry selected rows"
- "Retry all failed with this error type"

After a retry, navigate to `/runs/:retry_run_id` or start polling `GET /v1/runs/:retry_run_id/progress`.

### `POST /v1/snapshots/manual`

Use this when scraping failed but an operator manually verified the price.

Body:

```ts
interface ManualSnapshotBody {
  supermarket_product_id: string;
  scrape_run_id?: string;
  price: number;
  list_price?: number | null;
  unit_price?: number | null;
  unit_price_per?: string | null;
  in_stock?: boolean; // default true
  currency?: string; // default "ARS"
  promotions?: Array<Record<string, unknown>>;
  note?: string;
}
```

The inserted snapshot has `tier_used: "manual"`.

Recommended UI:

- Add a "Manual price" action on failed product rows.
- Prefill product/supermarket info from the failure row.
- Ask for price, stock status, optional list price, optional note.
- After saving, refetch product compare/history and the failed table.

## Type Updates

`Tier` now includes manual entries:

```ts
type Tier = "api" | "html" | "ai" | "manual";
```

`RunBreakdown.byTier` may include `manual`.

## Suggested Dashboard Flow

1. Recent runs page: call `GET /v1/runs?limit=10`.
2. Run detail page: call `GET /v1/runs/:id` for final/summary data.
3. If the run is active, poll `GET /v1/runs/:id/progress`.
4. If failures exist, call `GET /v1/runs/:id/failures`.
5. From the failure table, offer retry and manual price actions.
6. After retrying, treat the returned `retry_run_id` as a normal run and monitor it with the progress endpoint.

## Alert Behavior

Alerts can now appear before a run finishes. The frontend should not assume alerts only exist after `finished_at` is set. Early alerts include `context.early === true` and point to the current `run_id`.

