# API response fixtures

Realistic example responses matching the production API envelope exactly. Use these to build the frontend before the backend is deployed, or as test fixtures.

Each file is a complete response body — `data` + `meta` (and `pagination` for list endpoints), exactly as the live API returns.


| File                        | Endpoint                                  | Scenario                                                              |
| --------------------------- | ----------------------------------------- | --------------------------------------------------------------------- |
| `health.json`               | `GET /v1/health`                          | Healthy API                                                           |
| `products-list.json`        | `GET /v1/products?limit=20`               | 5 products with varied categories/brands, including one with no image |
| `products-list-empty.json`  | `GET /v1/products?search=xyzz`            | Empty search result (UI empty state)                                  |
| `product-detail.json`       | `GET /v1/products/:id`                    | Single product detail                                                 |
| `product-compare.json`      | `GET /v1/products/:id/compare`            | Same product across 3 supermarkets, with savings summary              |
| `product-history.json`      | `GET /v1/products/:id/history`            | 14 days of price history including a price drop with promotions       |
| `supermarkets-list.json`    | `GET /v1/supermarkets`                    | 3 supermarkets — one healthy, one degraded, one down                  |
| `supermarket-products.json` | `GET /v1/supermarkets/:id/products`       | Products mapped to a supermarket with latest snapshot                 |
| `runs-list.json`            | `GET /v1/runs?limit=10`                   | Mix of completed and one currently-running run                        |
| `run-detail.json`           | `GET /v1/runs/:id`                        | Run detail with per-supermarket breakdown and top errors              |
| `alerts-list.json`          | `GET /v1/alerts`                          | 4 alerts: one critical, one warning, one info, one resolved           |
| `error-401.json`            | (any auth-required endpoint with bad key) | Missing/invalid API key                                               |
| `error-404.json`            | `GET /v1/products/<bogus-uuid>`           | Resource not found                                                    |


## How to use during development

Fastest: import them directly in a stubbed API client.

```ts
// src/lib/api.dev.ts
import productsList from '../../scraper/examples/api/products-list.json';
import compare from '../../scraper/examples/api/product-compare.json';

export const api = {
  listProducts: async () => productsList,
  compareProduct: async (_id: string) => compare,
};
```

Or serve them with a 5-line static server (`npx serve examples/api/`) and point your dev API base URL at it.

## When the API is real

Swap your stubbed API client for the real one (the typed client in `API.md` is the suggested starting point). Response shapes are identical — no other changes needed.