// PM2 ecosystem configuration.
//
// Start everything:   pm2 start ecosystem.config.cjs
// Reload (zero-DT):   pm2 reload ecosystem.config.cjs
// Logs:               pm2 logs                # tail all
//                     pm2 logs worker         # tail one
// Status:             pm2 status
// Persist on reboot:  pm2 save && pm2 startup
//
// File is .cjs (not .js) because package.json has "type": "module" and PM2
// loads its config as CommonJS. Don't rename it.

const path = require('node:path');

/** Relative paths to compiled JS entry points. Build with `npm run build`. */
const ENTRY = {
  orchestrator: 'dist/src/orchestrator/index.js',
  worker:       'dist/src/worker/index.js',
  api:          'dist/src/api/server.js',
};

/** Common settings applied to every app. */
const common = {
  cwd: __dirname,
  // Each process loads .env via Node's native flag — same as our npm scripts.
  node_args: ['--env-file=' + path.join(__dirname, '.env')],
  // PM2 will auto-restart on crash, with backoff. Cap restart attempts so a
  // truly broken process doesn't loop forever and burn CPU.
  max_restarts: 10,
  restart_delay: 5_000,        // 5s between restarts
  exp_backoff_restart_delay: 100,
  // Memory ceilings — PM2 restarts the process if exceeded.
  // These are conservative for t3.medium (4GB total).
  max_memory_restart: '900M',  // mostly relevant for the worker (Playwright)
  // Logs go to PM2's default location: ~/.pm2/logs/
  error_file: undefined,       // use defaults
  out_file:   undefined,
  merge_logs: true,
  log_date_format: 'YYYY-MM-DD HH:mm:ss.SSS Z',
  env: {
    NODE_ENV: 'production',
  },
};

module.exports = {
  apps: [
    {
      ...common,
      name: 'orchestrator',
      script: ENTRY.orchestrator,
      // Single instance — orchestrator is essentially stateless cron logic.
      instances: 1,
      exec_mode: 'fork',
      // Lower memory ceiling — orchestrator does very little.
      max_memory_restart: '300M',
    },
    {
      ...common,
      name: 'worker',
      script: ENTRY.worker,
      // Single instance for now. Multi-instance is possible with BullMQ but
      // requires care around per-supermarket concurrency arithmetic.
      instances: 1,
      exec_mode: 'fork',
    },
    {
      ...common,
      name: 'api',
      script: ENTRY.api,
      // API can be reloaded with zero downtime via `pm2 reload api`.
      // Single instance is fine for v1; bump if traffic grows.
      instances: 1,
      exec_mode: 'fork',
      max_memory_restart: '300M',
    },
  ],
};
