# Production deployment

Source: `lizhengyi3003/race2-fore-end`, main.
Worker: `race-fore-end`, account `d08d42f9b1e53cc1648cdc9c1eab5a0e`.
Public URL: https://intellicoretech.cn. API alias: https://api.intellicoretech.cn.
The active production Worker is also reachable at https://race-fore-end.feichuan613.workers.dev.
Version-specific preview URLs are disabled.

Wrangler uploads `dist` as Workers Static Assets and deploys `site-worker.js`.
The frontend uses `/api/v1` on the same origin. `/api/*` and `/admin/*` are streamed to
`BACKEND_ORIGIN` (https://backend.intellicoretech.cn), including authenticated AI-review SSE.
API responses are not cached. Hash-named static assets have a one-year immutable cache policy.
`/healthz` is a frontend-only probe; check `/api/v1` functionality separately for backend acceptance.

`Frontend CI` builds, lints, tests gateway behavior and validates the Wrangler package.
A successful main push triggers `Deploy Cloudflare` for that exact SHA. After Wrangler deploys,
the workflow checks the Worker health response and the public dashboard API on both custom hostnames.
The build and deployment history is in GitHub Actions. Cloudflare Workers Builds has no trigger for this Worker.
The production environment requires `CLOUDFLARE_API_TOKEN`; repository variable
`CLOUDFLARE_ACCOUNT_ID` must match the configured account. Use an account-owned token restricted
to Worker deployment and the intellicoretech.cn zone, never a personal OAuth token in CI.

Local deployment: `npm ci`, `npm run test:worker`, `npm run deploy`.
The older `intellicore-worker/` directory is historical source; the production site gateway is
`site-worker.js`. No dev-backend route is created by this deployment.
