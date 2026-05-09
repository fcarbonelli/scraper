Full System Summary
What You're Building
A price scraping platform that monitors 100+ products across 30+ supermarkets daily, stores price history, and exposes everything through a clean API and dashboard UI.

Infrastructure
Vercel (free)          EC2 t3.medium (~$30/mo)        Supabase Pro (have it)
──────────────         ───────────────────────         ──────────────────────
Next.js frontend  ───► Express REST API           ───► PostgreSQL database
Admin dashboard        BullMQ worker                   price_snapshots
Product browser        Orchestrator (cron)              products
                        │                               supermarkets
                        ▼                               alerts
                   Upstash Redis (free tier)            scrape_runs
                   (job queue backbone)
Total new monthly cost: ~$30-35

The Scraping Pipeline
Every day at 6am:
EventBridge / node-cron fires
          │
          ▼
Orchestrator reads supermarket configs
Enqueues 3,000 jobs into Redis (30 queues × 100 products)
          │
          ▼
All 30 queues drain in parallel
Each queue respects its own rate limit
All done in ~1 hour
          │
          ▼
Results written to Supabase
Alerts generated for failures
Dashboard updates

Per-Job Fallback Logic
Every single product scrape follows this flow:
TIER 1: Structured API call
  └─ success → save snapshot, done
  └─ fail    →

TIER 2: Playwright HTML scraping
  └─ success → save snapshot, done
  └─ fail    →

TIER 3: AI-assisted scraping (Firecrawl)
  └─ success → save snapshot, done
  └─ fail    →

TIER 4: Re-queue with 2hr delay (max 2 retries)
  └─ still failing → create alert, save error state

Supermarket Config System
Every supermarket is a config object. No hardcoded scraping logic per site:
js{
  id: 'superx',
  name: 'SuperX',
  tier: 'api',                              // preferred tier
  rateLimitMs: 0,                           // no limit for APIs
  concurrency: 5,                           // parallel requests ok
  fallbackToHtml: true,
  apiUrlTemplate: '[https://api.superx.com/products/{id}](https://api.superx.com/products/{id})',
  htmlSelectors: {
    price: '.product-price',
    stock: '.availability-badge',
    name: '.product-title'
  },
  products: ['sku001', 'sku002', ...]       // 100 product IDs
}
Adding a new supermarket = adding one config object. No new code.

Database Schema (Supabase)
sqlsupermarkets        core config, tier preference, rate limits, selectors
products            one row per product per supermarket, external SKU
price_snapshots     one row per product per day — the core data table
scrape_runs         one row per daily pipeline run, success/fail counts
alerts              every detected problem, severity, resolved status
Storage estimate: ~2.4GB/year at full scale. 8GB Supabase Pro lasts 3+ years comfortably, especially if you only store raw_payload on failures.

Alert System
The system distinguishes between product-level and supermarket-level failures:
Product-level alerts
  PRODUCT_NOT_FOUND      → 404, product may have been deleted
  PRICE_MISSING          → page loaded but selector failed
  PRICE_ANOMALY          → price jumped >50% overnight
  OUT_OF_STOCK           → stock status change

Supermarket-level alerts (>80% of products failing)
  SUPERMARKET_DEGRADED   → site redesign or API change
  SELECTOR_BROKEN        → HTML structure changed
  RATE_LIMITED           → getting 429s
  AUTH_REQUIRED          → site started requiring login
Individual product failures get grouped into one supermarket alert when the whole site is down — no flood of 100 separate alerts.

REST API
Base: [https://yourapi.com/v1](https://yourapi.com/v1)
Auth: X-API-Key header on every request
GET  /products                    list + filter by supermarket, category, stock
GET  /products/:id                single product + latest snapshot
GET  /products/:id/history        price history, supports date range + resolution

GET  /supermarkets                all supermarkets + current health status
GET  /supermarkets/:id/products   all products for one supermarket

GET  /snapshots                   raw snapshot feed with filters
GET  /runs                        scrape run history
GET  /runs/:id                    single run breakdown by tier

GET  /alerts                      active alerts, filterable by severity/supermarket
PATCH /alerts/:id                 acknowledge or resolve an alert
Pagination on all list endpoints: ?page=1&limit=50
Date filtering where relevant: ?from=2025-01-01&to=2025-04-22

Node.js Project Structure
app/
├── src/
│   ├── orchestrator/
│   │   └── index.js          cron, reads configs, enqueues all jobs
│   ├── worker/
│   │   ├── index.js          BullMQ worker, processes jobs
│   │   ├── tiers/
│   │   │   ├── tier1-api.js
│   │   │   ├── tier2-html.js
│   │   │   └── tier3-ai.js
│   │   └── fallback.js       drives tier 1→2→3→retry logic
│   ├── api/
│   │   ├── index.js          Express server
│   │   ├── middleware/
│   │   │   ├── auth.js       API key validation
│   │   │   └── pagination.js
│   │   └── routes/
│   │       ├── products.js
│   │       ├── supermarkets.js
│   │       ├── snapshots.js
│   │       ├── alerts.js
│   │       └── runs.js
│   ├── config/
│   │   └── supermarkets.js   all 30 supermarket configs
│   └── shared/
│       ├── db.js             Supabase client
│       ├── queue.js          BullMQ + Redis setup
│       └── alerts.js         alert creation logic
├── ecosystem.config.js       PM2 — defines 3 processes
├── .env
└── package.json

PM2 Process Management
Three processes running on EC2 at all times:
┌──────────────┬──────────┬──────────┬────────────────────────────┐
│ name         │ status   │ memory   │ role                       │
├──────────────┼──────────┼──────────┼────────────────────────────┤
│ orchestrator │ online   │ ~50mb    │ cron, fires once daily     │
│ worker       │ online   │ ~700mb   │ scraping, always watching  │
│ api          │ online   │ ~100mb   │ HTTP, always serving       │
└──────────────┴──────────┴──────────┴────────────────────────────┘
PM2 auto-restarts crashed processes and survives server reboots.

Admin Dashboard (Vercel / Next.js)
┌─────────────────────────────────────────────────────────────┐
│ OPERATIONS VIEW                                             │
│                                                             │
│ Last run: today 6:47am    ✓ 2,847 succeeded  ✗ 153 failed  │
│ Tier breakdown: API 2,100 / HTML 700 / AI 47 / Failed 153  │
│                                                             │
│ Supermarkets                          Health   Last run     │
│ ✓ SuperX                    100/100   ████████  6:32am      │
│ ✓ SuperY                     98/100   ███████░  6:41am      │
│ ✗ SuperZ                      3/100   █░░░░░░░  6:45am  🔴  │
│                                                             │
│ Active Alerts                                               │
│ 🔴 CRITICAL  SuperZ degraded — 97/100 products failing      │
│ 🟡 WARNING   SuperW price anomaly — Leche 1L jumped +340%   │
│ 🔵 INFO      SuperV out of stock — 12 products              │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│ CONSUMER VIEW                                               │
│                                                             │
│ [search products...]   [filter: supermarket ▼] [category ▼]│
│                                                             │
│ Leche La Serenísima 1L                                      │
│ SuperX  $1,250   SuperY $1,180 ← best   SuperZ unavailable  │
│ ↓ price history chart                                       │
│                                                             │
│ Yogur Ser x4                                                │
│ SuperX  $890    SuperY $920    SuperZ $875 ← best           │
└─────────────────────────────────────────────────────────────┘

EC2 Setup (One Time)
bash# Takes ~20 mins, never repeated
ssh -i key.pem ubuntu@your-ec2-ip
curl -o- [https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh](https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh) | bash
nvm install 20
npm install -g pm2
npx playwright install-deps
git clone [https://github.com/you/repo.git](https://github.com/you/repo.git) app
cd app && npm install
npx playwright install chromium
cp .env.example .env   # fill in Supabase + Redis + API keys
pm2 start ecosystem.config.js
pm2 save && pm2 startup

Deployment After Setup
bash# Every time you push new code
ssh -i key.pem ubuntu@your-ec2-ip
cd app && git pull && pm2 restart all

# Or automated via GitHub Actions — push to main, server updates itself

Build Order
Week 1
  ✓ Supabase schema (all 5 tables)
  ✓ Node project scaffold + shared DB/queue clients
  ✓ Orchestrator with cron + BullMQ enqueuing
  ✓ Tier 1 worker (API scraping) for easiest supermarkets

Week 2
  ✓ Tier 2 worker (Playwright HTML scraping)
  ✓ Fallback logic connecting all tiers
  ✓ Alert generation logic
  ✓ Retry queue for failed jobs

Week 3
  ✓ Express API — all routes, auth middleware, pagination
  ✓ EC2 setup + PM2 config
  ✓ Deploy and run first real scrape

Week 4
  ✓ Next.js admin dashboard (ops view)
  ✓ Next.js consumer frontend (product browser)
  ✓ Tier 3 AI fallback (add once you have real failure data)
  ✓ GitHub Actions auto-deploy