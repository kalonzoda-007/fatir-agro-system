# FATIR MiniApp — GitHub Pages / Cloudflare Worker migration (STAGING ONLY)

This folder contains the original AppDeploy React frontend (UI and client functionality preserved), adjusted to use a configurable API URL instead of the AppDeploy client SDK, and a separate **non-production** Cloudflare Worker API gateway.

## Safety / current status

- This branch does **not** change the current Telegram bot launch URL, production Google Sheets, n8n workflows or AppDeploy deployment.
- No public Pages deployment is enabled automatically. Use GitHub Pages only after the staging API passes security tests.
- n8n **currently calls AppDeploy** `/api/internal-workflow-verify` for signed requests. That dependency must be migrated after a verified Worker has been deployed; changing only the website will not fix authentication.
- AppDeploy database stores discussion timelines, proposals, decisions and transaction locks. **Historical records and atomic updates are not yet migrated.** Discussion API endpoints deliberately fail closed in the staging Worker rather than silently lose functionality.
- Order writes are disabled by default (`ENABLE_ORDER_WRITES=false`) until end-to-end request-shape and idempotency tests pass.

## Frontend

```bash
cd migration/fatir-miniapp
npm install
cp .env.example .env.local
# Edit .env.local to set VITE_FATIR_API_BASE to your Worker URL.
npm run typecheck
npm run build
```

Serve `dist/` from GitHub Pages under a new test path. Existing Vite `base:'./'` supports a repo subpath. The **webpage is publicly accessible** on Pages, but all data endpoints require signed Telegram identity and authorized roles. Do not embed credentials or internal n8n URLs in this public repository.

## Worker prerequisites (Cloudflare account action required)

1. Create a Cloudflare Workers project and D1 database; bind it as `FATIR_DB` in `worker/wrangler.toml`.
2. Apply `worker/schema.sql` to the D1 database.
3. Enter `TELEGRAM_BOT_TOKEN` in Worker Secrets (never in GitHub or chat).
4. Enter original n8n production webhook URLs as Worker Secrets: `N8N_BOOTSTRAP_URL`, `N8N_SUBMIT_URL`, `N8N_STATUS_URL`.
5. Set `FRONTEND_ORIGIN` to the *exact* GitHub Pages browser origin.
6. Run `npx wrangler deploy --config worker/wrangler.toml` from `migration/fatir-miniapp`.
7. Change the n8n **staging copies**, not published production workflows, to use the Worker verifier URL and verify signature/replay protection (valid signature succeeds, expired/altered/replayed fails).
8. Test bootstrap with a fresh Telegram WebApp session; ensure inactive and unknown users cannot access orders.
9. Migrate AppDeploy discussion data to D1 and implement equivalent conditional, atomic proposal/decision operations **before any production cutover**.
10. Verify stock, role permissions, duplicate prevention, order creation/status, audit history, corrections and plant transfers. Only after acceptance change the Telegram bot's launch URL.

## API endpoints

`GET /api/health`: reports staging Worker health, not production readiness.
`POST /api/internal-workflow-verify`: checks HMAC, timestamp, exact payload and single-use nonce in D1.
`POST /api/bootstrap`: verifies Telegram initData and approved n8n catalog user (requires n8n signed verifier migration).
`POST /api/order-status`: checks valid session and order request ID.
`POST /api/orders`: deliberately blocked until write compatibility QA.
`POST /api/discussions/*`: deliberately blocked until transaction data migration.

## Rollback

Do not change the original Telegram bot URL before final approval. Rollback after cutover: restore the previously recorded Telegram launch URL. Do not delete AppDeploy data until reconciled and independently backed up.
