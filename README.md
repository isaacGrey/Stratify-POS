# StratifyPOS

**Development branch: enhanced multi-industry POS and business management platform.**

> **Status: ACTIVE DEVELOPMENT — NOT CERTIFIED OR CLEARED FOR LIVE COMMERCIAL POS USE.**
> This repository contains working, database-backed workflows, not a complete
> payment gateway, fiscal invoicing product, or formally audited production system.

## Stack

- **Web client:** React 19, TypeScript, Vite, responsive PWA, Dexie/IndexedDB for supported offline cash checkout.
- **Backend:** Node.js 20+/22 recommended, Express, PostgreSQL 15+ (CI validates PostgreSQL 18).
- **Security:** JWT sessions, live membership and permission checks, PostgreSQL tenant RLS with a restricted runtime role, branch restrictions, audited operational actions.
- **Deployments:** Vite client can be hosted separately; the Node API and PostgreSQL need their own secure hosting. A static frontend-only Vercel deployment is not a complete functional backend.

## Functional scope

| Module | Current capability | Important limits |
|---|---|---|
| POS | Server-calculated carts, durable hold/park/resume drafts, recipes, product variations and add-ons, cash/cashless **recording**, signed offline cash sales, idempotent checkout, dine-in/takeout/delivery, printed browser receipt, barcode and SKU search | No cashless provider capture, split tender, item-level split bills or certified fiscal receipts; held orders do not reserve stock, tables or pricing |
| Catalog | Products, services, menu items, bundles and non-stock types, tenant-unique SKU/barcodes including variants, image HTTPS URLs, recipes and direct physical-stock links | Image **uploads**, price tiers, expiration/serial controls and flexible advanced modifiers remain |
| Inventory | Stock ledger, nonnegative checks, optional branch balances, transfers, ingredients, recipe and linked-stock deduction | No FIFO, batch/expiry, physical count approval workflow or procurement return |
| Purchasing | Supplier records, purchase orders, partial receiving, duplicate receiving protection and atomic goods receipt | No supplier invoice matching, payable ledger or supplier-return workflow |
| Register | Opening cash, cash in/out, online checkout assignment, closure, variance, optional owner-enforced policy | Offline cash is not auto-assigned to a drawer; manual reconciliation is required |
| Refunds | Supervised partial/full **cash** refunds, immutable ledger and idempotency, linked register payouts | Card, Maya, GCash and bank reversals **not** implemented; no automatic returned-item restocking |
| Reporting | Date and branch filters, sales/payments/transactions/stock, exports, refund-aware net receipts, cost snapshots and estimated gross profit | Historical orders without cost snapshots are excluded from profit estimates; no audited financial statements |
| Workforce | Users, roles, branch access, attendance, breaks, shifts and permissions | Full payroll and leave workflows not complete |
| Locations | Branch records, hours, tables, basic branch stock and permissions | Advanced terminals, reservations and floor-layout designer not complete |
| Promotions | Promotions, scoped rules, bundles, BOGO and loyalty capabilities | Legally compliant PWD/senior VAT handling needs review |
| SaaS | Plans, limits, super-admin, plan approvals and manually verified payment evidence | No automatic billing/subscription gateway |
| Backups | Encrypted backups, retention, restore verification components | Requires off-server storage and recovery operations to be configured and drilled |

For a requirement-by-requirement delivery picture, see
[Development implementation roadmap](docs/DEVELOPMENT_ROADMAP.md).

## Quick start

1. Install Node.js 22 (or 20+) and PostgreSQL. Create a new **non-production** database.
2. Copy `server/.env.example` to `server/.env`. Configure `DATABASE_URL`, a strong `JWT_SECRET` (32+ characters), `CLIENT_URL`, and super-admin seed credentials if needed.
3. From `server`, run:

```bash
npm ci
npm run migrate
npm run seed
npm run dev
```

4. Copy `client/.env.example` to `client/.env`, configure the API/public origins, and from `client` run:

```bash
npm ci
npm run typecheck
npm run dev
```

5. Open the Vite development URL (usually `http://localhost:5173`). The workspace lives at `/app`, with public pages at `/`.

**Database role:** `scoped()` uses `SET LOCAL ROLE coffee_saas_runtime`. In production, the API connection must not be a superuser or have `BYPASSRLS`. Use separate migration and runtime credentials, minimal grants and auditable secrets management.

## New team, table QR and kitchen workflows (November 2026)

**Source:** `POS New requirements .txt`. These are development-branch features, and they are not a real cashless payment gateway, BIR-certified checkout, or a replacement for actual cash-count reconciliation.

- **Registered businesses:** The platform dashboard separates SaaS subscription receipts from each merchant's customer payments. Per-business columns show completed POS customer payments, recorded refunds and net collections. Opening drawer floats are not customer revenue.
- **Dedicated team POS:** Cashiers use the employee-oriented workspace. Management pages are hidden according to effective module permissions, and server middleware enforces those permissions. The owner/manager dashboard remains separate. Staff without POS permission see only assigned operational pages.
- **Shift cash registers:** Each cashier can open one register session at a time, with their own starting cash float. Another cashier can start a separate register during a shift handover. Paid cash sales, refunds, manual cash movements and closing variances remain associated with the correct session; reporting shows sessions separately. Server checkout requires a cashier's own open drawer for online shift sales. Offline checkouts require reconciliation and are not automatically assigned to a drawer.
- **Table QR menu:** Owners enable customer menus under **Customer QR Menus** (disabled by default). Owners/managers generate or rotate table QR codes; the link is shown only at generation time, and revoked/rotated codes become invalid. Customers scan to browse the active menu and send a **pending payment request**, never a paid order. QR images are generated on-device using a locally vendored MIT QR encoder; table tokens are not sent to remote QR image services. The Vercel app has a direct `/menu/:token` rewrite.
- **Payment verification:** Payment requests remain separate from POS transactions and kitchen tickets until reviewed. Staff/cashiers with POS access can record a reference and verify **cash received in their own drawer**. Electronic payments (GCash, Maya and card) may only be manually attested by an owner/manager. **There is no automatic provider authorization, capture, signature confirmation or settlement reconciliation**; the operator must verify a real external payment first. Changed order totals block confirmation until the customer restarts the request.
- **Kitchen Display System:** Only successful paid POS sales create tickets. Preparation staff see customer product names/quantities, not private financial amounts. KDS auto-refreshes every four seconds; it is near-live polling, not a push/SSE connection. Tickets advance Pending → Preparing → Ready → Completed with audited status changes and branch/tenant access controls.

### Testing and remaining limitations

The development GitHub Actions workflow runs clean PostgreSQL 18 schema migrations, the historical checkout suite, original Development tests, new QR-menu and kitchen tests, TypeScript validation and the client build. QR tests check that unpaid requests never enter KDS, idempotent retries, payment-review requirements, QR link revocation, status transitions, cross-tenant isolation and independent drawer handover.

**Still requires pre-release checks:** Actual cashless gateway integration and signed webhooks; end-to-end payment reconciliation; BIR/fiscal-compliant receipts; test of real QR scanners, tablets and network dropouts; device-specific cashier station handover, printer/cash drawer integration, high-load tests; and production UX/security review. Do not enable this feature on paying production merchants until acceptance tests and regulatory requirements are completed. Permanent tenant deletion with immutable journals is intentionally blocked pending a documented retention/erasure process; use archive instead of circumventing ledger protection.

## Development branch additions

Migrations `021`–`025` add operational ledgers, register reconciliation, purchase receipts, supervised cash refunds, cost snapshots, SKU/barcode registry, direct physical-stock links and held-order drafts. They are applied transactionally by `npm run migrate`. **Back up your database first**, test against a restored copy, and verify rollback/recovery before applying to a deployment with real data.

### Operational usage

- **Hold or resume:** In the online POS, select **Hold / park order** to save an order draft; use **Held orders** to resume or cancel it. Drafts never reserve inventory, tables or prices, and checkout revalidates their current totals. Completion of the held draft is atomic with the paid sale.
- **Open register:** POS → Cash register. The owner may require an open register for online cash checkout. Recorded sales, withdrawals and refunds affect the expected closing balance. Count cash physically before closing.
- **Purchase stock:** Purchasing & Suppliers → New purchase order → Receive selected stock. Partial receipts, stock changes and movement ledger records commit together. Repeating the same receipt ID cannot add stock twice.
- **Refund cash sale:** Sales & Transactions → Refund (owner/manager only). This records cash returned and optionally debits the current manager's open register. Manually inspect returned goods and separately authorize any inventory adjustment.
- **Retail product:** Products & Services → Physical / stock item → Direct stock item (and optional variant-specific stock item). A completed checkout deducts that stock from branch inventory when enabled, otherwise from shared stock.
- **Scan barcode:** In the POS search field, scan a unique barcode or type an SKU and press Enter. A matched product or variation is added directly to the cart.

Products and variations may reference ingredients through recipes. **Do not link a stock item to a product and its recipe simultaneously**; checkout rejects duplicate use of the same stock ID. Stock costs are captured at checkout using the current stock unit cost or (for non-recipe items) the product cost. These are estimates, not FIFO or a tax-compliant accounting valuation.

## Validation

GitHub Actions workflow `StratifyPOS Development validation` runs on pushes to **Development**:
- A clean PostgreSQL 18 migration.
- Node syntax checks.
- Server integration tests including tenant and branch access, checkout/offline, registers, refunds, purchase receiving, SKU/barcode uniqueness and stock-cost snapshots.
- Client TypeScript checking and production build.

Run the database tests locally only against a disposable migrated database:

```bash
cd server
STRATIFYPOS_TEST_DATABASE_URL="postgresql://..." node --test test/checkout.integration.test.js test/development.integration.test.js
```

These tests are not a substitute for real printer/scanner compatibility, browser and mobile manual testing, performance/load testing, offline device-loss tests, staging database recovery or a third-party security audit.

## Before commercial rollout

Do not connect live business cashiers or represent receipts as official Philippine tax documents until the following are complete:

1. BIR and VAT/discount requirements reviewed and the appropriate invoicing/compliance workflow implemented.
2. Actual payment providers, verified payment callbacks, electronic refunds and reconciliation added.
3. Offline recovery and device security threat model completed, including lost/stolen device handling, local sales data and signed grant security.
4. Backup key management, off-server copies, restoration drills, monitoring, security tests, audit retention, privacy/deletion workflows and incident response deployed.
5. Hardware testing of printers, drawers and barcode scanners; real-world multi-branch and multi-cashier pilot.
6. Remaining modules and edge-case tests documented in the roadmap completed.

The POS is built incrementally; business-critical changes should remain on `Development` until verified. **The default `main` branch is not changed by this implementation.**
