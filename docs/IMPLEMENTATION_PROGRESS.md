# StratifyPOS implementation progress

| Area | Status |
| --- | --- |
| 1. POS and offline sync | PARTIAL |
| 2. Products and services | PARTIAL — identifiers, types and direct stock working; upload/tier/UOM gaps |
| 3. Inventory | PARTIAL — branch ledger/stock/purchasing working; batch/count/costing gaps |
| 4. Reports and analytics | PARTIAL — refund/COGS net metrics; forecasting/tax gaps |
| 5. Team and attendance | PARTIAL — scheduling/clock actions; corrections/payroll gaps |
| 6. Branches and tables | PARTIAL — branch access, tables; terminal/reservation gaps |
| 7. Promotions and discounts | PARTIAL — BOGO/loyalty; compliance/stacking gaps |
| 8. Settings and billing | PARTIAL — manual subscription evidence; live billing absent |
| 9. Super Admin | PARTIAL — existing management; licensing/operational hardening remain |
| 10. Manual payment verification | IMPLEMENTED — manual confirmation, not gateway capture |
| 11. Member access control | IMPLEMENTED — multi-tenant/branch rules; device security pending |
| 12. Backup and recovery | BLOCKED |
| 13. UI and UX | PARTIAL |
| 14. Public marketing website | IMPLEMENTED — responsive/client build; deployment checks pending |


## Customer services and membership tracking — 16 November 2026

- Tenant-scoped customer register and service plan definitions linked to existing service products.
- Default duration presets (1, 2, 3, 6, 12, 24 months, day-based options), custom dates and non-expiring entitlements.
- Manual administrative issue, renew and cancel with an append-only history, role permissions and branch-scope enforcement.
- Calendar-month arithmetic clamps month ends rather than treating a month as 30 days.
- IMPORTANT: Issuing/renewing service access is an audited manual entitlement action, NOT a POS sale, payment capture, customer invoice or automatic recurring bill. Staff must independently verify eligibility/payment before issuing. POS-line linkage, automatic renewal billing, visit tracking, patient scheduling, notification jobs and regulated clinical-record handling are outside this increment.

## New required POS updates — 16 November 2026

**All changes remain on `Development`; not yet deployed or promoted to `main`.**

- **Registered business dashboard:** separate verified subscription receipts from gross/net completed POS customer collections and cash refunds, per tenant and platform-wide; register float is excluded from customer collection totals.
- **Dedicated employee work area:** compact cashier/staff POS, branch-aware module and server access controls. Staff only gain POS permission if configured. Cashier must open a personal register for shift checkout; another cashier can use their own session with independent float and transaction history.
- **Customer table QR menus:** table-specific revoke/rotate tokens, sanitized public menu, pending order requests, cashier-entered cash verification and manager/manual electronic verification. Public requests cannot independently produce paid sales or kitchen tickets.
- **Kitchen screen:** paid-only tickets and validated sequential status progression. Current near-live implementation refreshes every four seconds.
- **CI and security:** PostgreSQL 18 migration, new QR and kitchen integration tests, existing checkout suites, TypeScript and production build. QR generation uses a locally hosted MIT component rather than leaking customer table bearer tokens to third-party QR-image servers.
- **No actual online payment gateway:** GCash/Maya/card payment confirmation still requires physical/manual verification by owner/manager. No automated provider capture, settlement checks or webhooks. QR menu remains disabled by default pending business acceptance.
- **Retention:** permanent deletion of a tenant with immutable operational data is blocked pending a formally approved retention/erasure pathway; administrators can archive.

## Development branch increment (14 November 2026)

**This update covers verified code, not full acceptance of the 18-section commercial proposal.** See [DEVELOPMENT_ROADMAP.md](DEVELOPMENT_ROADMAP.md) for the full outstanding list and acceptance gates.

- **025:** persistent online held/parked POS drafts, scope-protected resume/cancel, idempotent requests, final server-side pricing and atomic checkout completion. Held drafts do not reserve stock or tables; abandoned-draft cleanup and concurrent-device UI testing remain.
- **021:** cash register ledger/open-close/variance, authorized cash refunds, purchase orders and partial goods receipts with backend branch checks, RLS, append-only records and idempotency.
- **022:** immutable checkout component cost snapshots and COGS estimates. Reports mark estimated gross profit unavailable for mixed historic sales without original costs.
- **023–024:** product types, brands, SKU/barcodes for products and variations, direct physical-stock links and cross-catalog tenant-unique identifier registry. POS barcode/SKU search is scanner keyboard-wedge compatible.
- **UI:** compact cash-register tools, supplier purchasing, supervised refunds, product metadata, barcode search and refund-aware reporting.
- **Integration tests:** clean PostgreSQL 18 CI migration, original integration suite, new register/refund/purchase/physical-stock tests, client typecheck and Vite build.

**Remaining critical gaps:** provider-verified electronic payments/refunds, hold/split payments and bills, compliant Philippine fiscal receipts and legally applicable discounts, physical returns/exchanges, offline device security and cash-drawer reconciliation, batch/expiration/cycle counts, full hardware testing and operational backup/restore procedures. This is a development branch; `main` has not been intentionally changed.


- Baseline. `server/src/migrate.js` and `server/sql/003–020` provide ordered transactional upgrades, restricted tenant grants, and automatic configurable trials. The default is five days, and customers can skip an available trial when selecting a paid plan. Existing trial end dates are preserved. Run `npm run migrate` and reseed the trusted administrator with `npm run seed`.
- POS and catalog. `server/src/index.js`, `server/src/offline-grants.js`, `server/src/catalog-options.js`, `client/src/main.tsx` and `client/src/offline/` implement idempotent checkout, durable offline cash sales for dine-in/takeout/delivery, automatic retry, review states, shared receipts, independent option prices, and recipe overrides. Review preserves the original sale and supports retrying after fixing the underlying conflict. Online managers and owners can reconcile signed sales from another cashier on the same device and within an authorized branch, including after the original cashier is disabled. The original cashier remains on the order and the reviewer is recorded separately. Permanent pricing conflicts still require a manager adjustment workflow.
- Inventory. `server/src/inventory.js` and Inventory UI implement stock item types, units, thresholds, branch balances, stock movements and transfers. Existing businesses keep shared stock until the owner enables branch inventory. Existing stock then remains available to transfer from the unallocated pool.
- Reporting. `server/src/reports.js`, `server/src/report-exports.js` and Reports UI use the same branch/date filters for data and downloads. Inventory balances show the current snapshot. Dates default to `Asia/Manila` and can use the server's `REPORT_TIME_ZONE`.
- Business operations. `server/src/attendance.js`, `branch-operations.js` and `promotions.js` back team accounts, same-day and overnight shifts, breaks, late starts, branch calendars, table occupancy, promotion scopes and limits, buy-one-get-one, bundles, and loyalty. Online checkout quotes advanced promotions. Offline checkout supports simple transaction discounts.
- Billing. `server/src/index.js` and Settings/Super Admin screens persist plan requests, review decisions, adjusted plans and rejection reasons. Approved requests create pending GCash payments. Verification applies the plan once and records subscription history.
- Verified on isolated PostgreSQL 18. Fresh, repeat and legacy schema upgrades, transactional checkout and stock, RLS, filtered Excel/PDF, attendance, promotions, payment evidence and review, public inquiries and verified recovery. Run `node --test test/checkout.integration.test.js` from `server` with `STRATIFYPOS_TEST_DATABASE_URL` pointing to an isolated migrated database. Set `STRATIFYPOS_TEST_RECOVERY_DATABASE_URL` to a separate empty test database to exercise encrypted recovery.
- Client typecheck and workspace `npm run build` pass with the Rollup WASM override. Chromium passed offline dine-in reconciliation, payment upload and review, and the inquiry inbox. Chromium, Firefox and WebKit passed mobile marketing, live plans and registration navigation. Edge and standalone Safari remain unverified.
- Local configuration. The installed PostgreSQL 18 service on port 5432 now hosts `coffeesaas`. Restored four businesses and two orders from the supplied archive, skipping the legacy adminpack extension. Applied migrations through 020 and seeded the local Super Admin. The preview on port 47474 and API on port 4000 passed sign-in and authenticated admin overview checks. Port 47473 serves older cached previews. The offline P-256 private key is stored outside the workspace and the client is built with its matching public key.
- Payment verification. Migration 014, `server/src/billing-payments.js`, `client/src/billing.tsx` and billing screens add configurable GCash/Maya/MariBank/custom methods, validated private screenshots, duplicate-reference checks, and audited manual review. Customer payment instructions must be configured before enabling each method.
- Platform and access. `server/src/admin-platform.js`, `workspace-access.js` and `client/src/platform-pages.tsx` add Super Admin pages, custom paid plans and discounts, plan and business access overrides, configurable roles, member permissions, branch RLS and append-only activity.
- Recovery. `server/src/backup-worker.js` and `backup-storage.js` provide encrypted manual and scheduled backups, retention, download, notifications and verification into an empty recovery database. Local tests verified tamper rejection, recovery including receipt images, and refusal to overwrite an existing database. Off-server storage and SMTP verification are blocked on deployment configuration. Configure `BACKUP_STORAGE_DIR` as a mounted off-server volume with a `.stratifypos-backup-store` marker, provide a stable 32-byte Base64 `BACKUP_ENCRYPTION_KEY_B64`, configure PostgreSQL utilities and the optional SMTP recipient, and run `npm run backup:worker`. The empty recovery database needs the runtime PostgreSQL role available at cluster level.
- Website. `client/src/marketing.tsx`, `site-routing.ts` and `client/public/previews/` provide the public site, live pricing and feature comparison, actual demo screenshots, and an inquiry inbox. Local routes use `/` for the site and `/app` for the workspace. Separate-origin pricing, registration and login passed on loopback hosts. Configure `VITE_APP_ORIGIN`, `VITE_MARKETING_ORIGIN`, `VITE_API_URL`, server `CLIENT_URL` and `APP_PUBLIC_URL` for deployment.
- Next. Configure payment instructions and off-server backup storage. Verify deployment and implement an audited adjustment workflow for permanent offline pricing conflicts.
