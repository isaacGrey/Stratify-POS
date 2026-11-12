# Crema — React TypeScript Coffee Shop SaaS POS

A full-stack **development foundation** for a coffee-shop SaaS: React 19 + TypeScript/TSX + Vite frontend, Express/Node API, and PostgreSQL with tenant-scoped row-level security (RLS).

## Included live (database-backed) workflows

- Register a new tenant/shop and its owner; login; forgot/reset password (SMTP required); invite employee by one-use link; role gates (owner, manager, cashier, staff); superadmin account.
- Subscription records with Free, Basic and Premium plan definitions, 14-day paid-tier trials, limits on branches and staff, expiration checks before checkout; admin can change subscription state.
- Shop dashboards, categories, products, variations, add-ons, ingredients, recipe-based ingredient deduction, suppliers, branch/table records, promo codes, expenses, attendance, audit records and analytics.
- POS: dine-in/takeout/delivery, server-priced cart, cash change, promo discounts, configurable tax/service charge and browser-printable receipt.
- Inventory adjustments and sales decrements are committed atomically in database transactions; stock cannot go negative.
- Multi-tenant business tables all carry a `tenant_id`, have RLS policies and are accessed from a transaction with `SET LOCAL`-equivalent `set_config(...,true)`.

## Explicit production gaps / not included

This is a substantial *runnable source foundation*, **not a certified or fully production-ready payment or accounting platform**. It does **not** integrate with payment gateways, perform actual GCash/Maya/card authorization or capture, bill or collect subscription payments, generate official Philippine BIR-compliant fiscal invoices, implement refunds/payment reconciliation, handle offline POS syncing, branch-specific inventory, provider webhooks, advanced profit calculation, real-time push events, automated backups, monitoring, or a comprehensive automated test suite. These require additional engineering, integration credentials and operational controls. For non-cash methods the sale is **recorded as externally confirmed by the cashier**, not electronically verified. Do not deploy to live cashiers for actual cashless payment processing without building those workflows.

## Requirements

Node 20+, PostgreSQL 15+ and npm. The project does not include package-lock files; install using npm. Run migrations with an administrative/migration database account. **For production**, use a separate, minimally privileged database login for the API (not a superuser and not the owner of tables), with only the required grants. RLS does not provide a trustworthy security boundary if the API runs as a superuser or a role with `BYPASSRLS`.

## Quick start

1. Create PostgreSQL database `coffeesaas` (e.g., `createdb coffeesaas`).
2. `cd server && cp .env.example .env` and enter `DATABASE_URL`, a long random `JWT_SECRET` (32+ characters), `CLIENT_URL`, and optionally SMTP. On Windows, copy `.env.example` to `.env` manually or use `Copy-Item`.
3. In `server`: `npm install`, then `npm run migrate`.
4. Set `SUPERADMIN_EMAIL` and `SUPERADMIN_PASSWORD` in `.env`; run `npm run seed` to create/update the superadmin user. **Use a unique password** and keep `.env` secret.
5. In `server`: `npm run dev`.
6. In `client`: copy `.env.example` to `.env`, then `npm install && npm run dev`.
7. Open `http://localhost:5173`; register a shop. To sign in as superadmin, first use the seeded credentials.

In a local development setup, `DATABASE_URL` can point to a Postgres migration owner so the schema and functions can be created. For hosted deployment, separate database users and explicitly apply SQL `GRANT` permissions to the API role. The invitation-token resolver is a `SECURITY DEFINER` function; restrict its execute privilege and audit it before deployment.

## Recommended initial workflow

1. Register shop, select plan.
2. Create `Coffee`, `Pastries`, etc. in Menu & Products.
3. Add ingredients and restock them through Inventory.
4. Create products and attach recipes specifying ingredient quantities per unit. Optionally create size variations and add-ons.
5. Create promotion codes and tables; adjust shop tax/service settings.
6. Add to cart in POS, choose branch and payment method, submit the sale; the backend verifies pricing and ingredient stock before posting the order and receipt.
7. View history, reports and the ingredient movement log.

### API overview

- `POST /api/auth/register`, `/api/auth/login`, `/api/auth/forgot`, `/api/auth/reset`, `/api/auth/accept-invite`
- `GET /api/me`, `GET /api/plans`
- `/api/shop/overview`, `/api/shop/settings`, `/api/shop/branches`, `/api/shop/categories`, `/api/shop/products`, `/api/shop/addons`, `/api/shop/ingredients`, `/api/shop/stock/adjust`, `/api/shop/stock/movements`, `/api/shop/suppliers`, `/api/shop/tables`, `/api/shop/promotions`, `/api/shop/expenses`, `/api/shop/staff`, `/api/shop/staff/invite`, `/api/shop/attendance`, `/api/shop/checkout`, `/api/shop/orders`, `/api/shop/reports`, `/api/shop/audit`, `/api/shop/subscription`
- `/api/admin/overview`, `/api/admin/tenants`, `/api/admin/tenants/:id`, `/api/admin/subscriptions/:id`, `/api/admin/plans/:id`

All `/api/shop/*` requests require `Authorization: Bearer <JWT>` and `X-Tenant-Id: <tenant UUID>`. These are validated against live memberships, and RLS applies inside the subsequent DB transaction. Never accept tenant ids from body payloads as authority.

### Role matrix

| Workflow | Owner | Manager | Cashier | Staff |
|---|---|---|---|---|
| POS checkout | Yes | Yes | Yes | No |
| Shop dashboard / own attendance | Yes | Yes | Yes | Yes |
| Products, stock, reports, settings, branches | Yes | Yes | No | No |
| Staff invites | Yes | Yes | No | No |
| Change staff roles | Yes | No | No | No |
| Subscription plan requests | Yes | No | No | No |
| Platform tenant administration | Separate seeded superadmin only | No | No | No |

## Security and deployment checklist

- Dedicated HTTPS reverse proxy, secure allowed CORS origin, trusted hosting, and platform secret management.
- A **non-superuser/non-owner** DB role without `BYPASSRLS`; with least-privilege SQL grants. Verify tenant A cannot see tenant B in integration tests.
- External secrets manager, connection pooling, rotation of auth/session secrets, refresh sessions, logout revocation and MFA for admins; consider email verification and identity proofing.
- SMTP with working transactional emails; password reset tests and invite abuse controls. Add CAPTCHA and tighter anti-enumeration/anti-automation measures.
- Integrate real provider APIs and webhooks for verified payments/refunds and recurring subscriptions; provide idempotency keys, webhook signature checks, reconciliation and dispute handling.
- Use compliant Philippine receipts/tax configurations for actual merchant circumstances after review with accountant/BIR requirements.
- Add tests (unit/integration/load/security), audit log retention, backups and restore drills, alerting, secrets scanning, error tracking, deploy pipelines, and data privacy policies.
- Add inventory per branch and robust ingredient reservation; sellable inventory is presently tracked globally per shop.

## Project structure

```
client/              React dashboard, POS and auth screens
server/src/index.js  Express routes and transactional business logic
server/src/db.js     PostgreSQL pool and tenant-scoped transaction helper
server/src/migrate.js, seed.js
server/sql/001_initial.sql    Database schema, RLS and seed plans
```

This code is provided as-is for local evaluation; a live PostgreSQL integration test and production infrastructure verification have not been performed in this environment.

## React TypeScript conversion (this package)

- Converted `client/src/main.jsx` to `client/src/main.tsx`, preserving the original app screens and backend API routes.
- Added `client/src/types.ts` for core shop, user, product, cart, receipt, and API type contracts.
- Added TypeScript and React type dependencies, `client/tsconfig.json`, `client/vite.config.ts`, and `client/src/vite-env.d.ts`.
- Updated `client/index.html` to load `/src/main.tsx`, plus `npm run typecheck` and a TypeScript-checked `npm run build` script.
- Existing UI is a large legacy component file; its props and responses remain gradually typed (not a strict full-model migration). `strict` is currently disabled in `tsconfig.json` to preserve compatibility during incremental typing.
- No `.env` secret files or `node_modules` are shipped. Copy `.env.example` to `.env` separately for the server and client, and set fresh credentials.

### Windows (PowerShell) start

```powershell
cd server
Copy-Item .env.example .env
# Set DATABASE_URL, JWT_SECRET, SUPERADMIN_EMAIL, SUPERADMIN_PASSWORD
npm install
npm run migrate
npm run seed
npm run dev
```

Open a second terminal:

```powershell
cd client
Copy-Item .env.example .env
npm install
npm run typecheck
npm run dev
```

Open http://localhost:5173. To create a deployment build from the client folder, run `npm run build`.

**Validation limitation:** This conversion was checked with local TypeScript syntax and a temporary type-checking shim because the execution environment cannot reach npm to install React/Vite type packages. Run `npm install` and `npm run typecheck` in your own environment; further type compatibility adjustments may be necessary. The backend was retained from the uploaded project and its runtime/database behavior was not retested.
