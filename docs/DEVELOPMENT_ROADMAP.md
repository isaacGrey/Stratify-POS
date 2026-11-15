# StratifyPOS — Development roadmap and delivery gates

**Baseline:** branch `Development` created from `main` on 14 November 2026. All commits in this workstream target **Development only**. Do not merge to `main` without an explicit deployment approval and passed release gate.

## Status policy

- **Implemented + CI:** code exists and is exercised by clean PostgreSQL integration and/or client build tests.
- **Implemented but manual verification pending:** code exists; production hardware, browser, backup or high-load behavior remains unproven.
- **Partial:** only some capabilities of the proposal are implemented.
- **Pending:** feature must still be built; do not imply availability based only on a UI label.
- **Blocked:** requires regulatory review, provider contract, live test environment or deployment credentials.

A passing build/integration suite is not a certification or authorization to operate a commercial POS.

## Requirement coverage

| Proposal area | Current state | Most important outstanding work |
|---|---|---|
| 2 Dashboard | Partial | Today/yesterday/weekly/custom dashboard filters, live refresh, branch consolidation, revenue/COGS comparisons, widgets, alerts, employee ranking and refund activity |
| 3 POS | Partial / core CI | Mixed/split tender and billing, multi-terminal held-order editing, refunds/exchanges from item lines, cashier-specific terminal assignment, queue/KDS, customer links, supported hardware, official invoice rendering |
| 4 Products & Services | Partial / identifiers and stock CI | Real image upload, flexible modifier groups, stock-aware variants, UOM pricing, price tiers, CSV/Excel bulk import, serial/warranty, change history and bundled BOM quantities |
| 5 Inventory | Partial / atomic stock CI | Physical counts/cycle counts, batches/expiry, FIFO or weighted-average costing, supplier returns, transfer approvals, robust offline inventory reconciliation, shrinkage and aging |
| 6 Sales & Transactions | Partial / cash refunds CI | Partial item returns, exchanges, void authorization, payment settlement, credit/deposit balances, official invoices and customer digital receipts |
| 7 Reports & Analytics | Partial / cost estimates CI | Item-level profit allocation, COGS valuation policy, per-method cash settlement, historical migrated COGS, forecasting, scheduled reports and full tax reports |
| 8 Team & Attendance | Partial | Leave workflow, correction requests, payroll-ready approvals, PIN verification, coverage/shift conflict checks and performance summaries |
| 9 Branches & Locations | Partial | Stockrooms/warehouses per branch, terminal/printer identity, floor layout, table reservation calendar, branch opening and closing checklists |
| 10 Promotions & Discounts | Partial | Eligible-item senior/PWD and VAT rules, stacking/exclusions, membership discounts, vouchers/credits, approval queue, advanced modifier inventory |
| 11 Settings & Billing | Partial | Licensed device authorization, receipt designer, language support, integrated billing gateway, external API management and off-site backup operations |
| 12 Additional modules | Partial | Purchasing/register/refunds added; CRM, full KDS, motor-repair job orders, customer credits and inventory supplier return remain |
| 13 Multi-industry | Partial | Core catalog types and physical stock; food kitchen, grocery variable weights, retail returns and motorcycle service workflows require separate feature slices |
| 14 Architecture/security | Partial | Tenant+branch RLS, atomic transactions, signed offline cash grants exist. Still needs offline-at-rest protection, credentials/secrets audit, device registration, disaster-recovery pilot and regulatory review |
| 16 Quality assurance | Partial | Automated integration and build tests exist; load testing, printer/scanner/device/browser matrix, penetration tests and field pilot pending |
| 17 Deliverables | Partial | Core source and development CI ready; compliance, deployment, operational runbooks and production acceptance remain |

## Completed development increments

### Critical ledger and checkout increment — CI validated

- Migration `021_operational_workflows.sql`: branch-aware cash registers, cash movements and reconciliation; purchase orders, receipts and lines; append-only cash refunds; RLS and branch rules.
- API modules `register-routes.js`, `purchasing-routes.js`, `refund-routes.js`: owner/manager/cashier permissions, validated amounts, safe retries, outstanding-quantity checks, authorization and audit records.
- Online cash sales linked to a cashier's open register. The owner can opt into requiring registers; signed offline sales remain separate for later drawer reconciliation.
- Authorized cash-only refunds with exact idempotent request IDs; payment provider reversals explicitly rejected until verified.
- Partial purchasing receipts, branch-aware stock changes, movement ledger and cost updates in one database transaction.

### Held-order increment — CI validated

- Migration `025_parked_orders.sql` adds tenant- and branch-scoped held-order drafts. Cashiers can manage their own held orders, while managers and owners can manage branch drafts.
- POS routes support idempotent creation, viewing and cancellation. Completing a held order happens atomically inside final checkout; inventory and prices are not reserved while a draft is held.
- The compact POS allows Hold / park order, Resume, Cancel and refreshing the list. Tests exercise replay, cancel, branch/tenant security and finalization.

### Product and cost increment — CI validated

- Migrations `022`–`024`: immutable checkout cost components, COGS snapshots, product types, direct stock links, tenant-unique SKU and barcode registry across products and variations.
- Physical items and variation-specific stock decrement atomically, using the same nonnegative inventory workflow already used by recipes.
- React product editor includes type, identifiers, brands/manufacturers, stock links and HTTPS photo URLs; POS supports search and scanner keyboard-wedge Enter.
- Report totals distinguish gross receipts, cash refunds, net receipts and known COGS. Gross profit estimates are **null** when any sale lacks historical cost data.

### Regression tests — CI validated

`server/test/development.integration.test.js` exercises register open/close and variance, idempotent sales/refunds/receipts, held-order completion/cancellation, partial refunds, partial receiving, over-receipt rejection, RLS isolation, catalog identifier uniqueness, direct physical inventory and cost snapshots.

The existing `server/test/checkout.integration.test.js` continues to cover offline signatures/replay, stock, branch permissions, billing and recovery components.

### 2026-11-16 requirement increment — server and build CI covered

- **Registered business collections:** platform admin business overview and registered-business rows now separate SaaS subscription revenue from confirmed POS customer payments and associated cash refunds, including net totals. Owner's dashboard also includes cashier shift summaries.
- **Team role isolation:** employee-tailored navigation and dedicated cashier POS, kitchen module, owner/manager QR management; tenant module access and branch RLS continue to enforce backend permissions. A cashier must open a register for each active shift; a replacement employee opens their own session.
- **Public table menu:** per-table random, hashed and revocable QR bearer tokens; publicly browsable sanitized catalog; rate-limited idempotent pending order requests; read-only order status. Customer cannot mark themselves paid.
- **Payment boundary:** checkout finalization requires an authenticated operator's explicit confirmation, matching original table/branch/cart/payment method and matching quoted total. Cashiers may verify only actual cash receipt into their own open register. Owner/manager manually attest GCash/Maya/card receipt; **no actual provider integration or verified gateway webhook is implemented**.
- **KDS:** ticket created only in committed paid checkout transaction; near-real-time 4-second refresh; sequential pending → preparing → ready → completed with audit and branch RLS. No financial amounts in kitchen endpoint.
- **Tests:** QR paid/unpaid flow, double-submission, different tenant, revoked link, cashier handover, finance collection excluding floats, status progression and cashless cashier rejection.
- **Operational safeguard:** permanent deletion of businesses with immutable operational journals is blocked pending controlled retention/erasure requirements; administrator can archive rather than bypass financial immutability.

**Outstanding:** automatic provider-verified electronic payment capture/refunds, prepayment customer gateway UX, actual real-time push channels, comprehensive device/browser/PWA testing, compliance, independent security audit, automated signed payment settlement confirmation, and product go-live acceptance.

## Next implementation slices (ordered)

### Phase 1: Transaction integrity and offline release gate — CRITICAL

1. **Split/mixed tender**: immutable payment allocations; backend total must equal order total; prevent duplicate provider references; receipts show allocations; settlement integration separate from unverified payment recording.
2. **Hold/park/resume hardening**: durable branch/cashier-scoped drafts, one-time completion and checkout price recalculation are implemented. Still add draft versioning/edits, abandoned-draft cleanup and multi-terminal handoff tests.
3. **Offline hardening**: device binding/revocation, sync conflict UI, stock reconciliation, local retention policy, lost-device security, data encryption design, DST/timezone and multi-tab stress testing.
4. **Register reconciliation**: offline cash session assignment and post-sync variance policy; fail-closed terminal/device controls.

**Gate:** concurrent checkouts and offline replay remain consistent under retry/failure; no duplicate order, payment, movement or refund; no unauthorized cross-tenant/branch data.

### Phase 2: Procurement, returns and lawful receipts — CRITICAL

1. Supplier purchasing approval, purchase return, shortages, receiving variances and three-way matching where appropriate.
2. Item-level return/exchange and approved restocking or waste handling; tax/discount reversal per line.
3. Void authority workflow and receipt reprints with reason/identity.
4. Philippine invoicing requirements (BIR, VAT/discount treatment and electronic record retention) determined with a qualified adviser and implemented/tested before merchant use.

**Gate:** cash, stock, invoices, taxes and refund balances reconcile; legally reviewed receipt path is verified.

### Phase 3: Management operations — HIGH

1. Dashboard/analytics periods, cashier/branch comparisons, payment reconciliation, inventory valuation and report scheduling.
2. Staff attendance correction, approved timesheets and detailed shifts.
3. Warehouses/stockrooms, branch terminal mapping and table floor plans.
4. Costing policy migration: historical average/FIFO decisions and explicit cost snapshot coverage.

### Phase 4: Industry workflows and CRM — HIGH

1. **Cafés:** required/optional modifier groups, sizes, queue, barista/KDS and ingredient waste.
2. **Restaurants:** table lifecycle, course prep, split bills, kitchen printers, delivery.
3. **Grocery/retail:** expiration/batch, variable-weight barcodes, sales units, wholesale and membership tiers, inventory count.
4. **Motorcycle service:** vehicles, jobs, labor, mechanics, parts compatibility, approvals and warranty history.
5. Customer profiles, loyalty, vouchers/credits and legally applicable promotional rules.

**Gate:** configurable feature flags, permissions and modules deliver the requested workflow without copying whole POS services for each industry.

### Phase 5: Commercial SaaS and infrastructure — HIGH/MEDIUM

1. Subscription provider integration, signed webhooks, reconciliation and licensing/device limits.
2. Production monitoring, rate limits, backups and repeated restore drills, secure secrets and audit retention.
3. Mobile/tablet stress testing and supported printer/scanner/cash drawer hardware matrix.
4. Secure APIs/integrations, platform admin controls, export/delete/privacy workflows.
5. Staging acceptance and production release checklist with explicit owner sign-off.

## Nonnegotiable engineering standards

- Use integer centavos for recorded financial amounts and server-authoritative totals; never trust checkout totals calculated in a browser.
- Post sale, payment, stock movements and cost snapshots in one database transaction; use client-generated idempotency IDs on retryable mutations.
- Permission-check **backend** operations and enforce PostgreSQL tenant + branch restrictions. Do not rely on hiding navigation elements.
- Preserve old tenant data with additive migrations and migration rollback checks. No destructive prod changes without backed-up migration and restore test.
- Do not call unverified GCash/Maya/card **recording** a captured/settled payment. Provider verification and reconciliation are separate features.
- Keep every code/UI change compact, responsive and keyboard/touch usable.
- Do not claim regulatory certification, live payment processing, automatic offline data encryption, complete inventory costing or production readiness until evidenced.
- Every completed slice requires integration tests, client build, clear doc changes and a branch `Development` commit. **Never push implementation work to `main`.**

## Release acceptance checklist

- [ ] Feature-level acceptance tests pass on clean and migrated PostgreSQL environments.
- [ ] Concurrent/cross-tenant/cross-branch transactions validated.
- [ ] Offline sync and duplicate suppression tested on real devices and lost-network scenarios.
- [ ] Cash register and purchasing reconciliation verified with actual cashier scenarios.
- [ ] Browser/tablet/PWA and printer/scanner hardware matrix validated.
- [ ] BIR/invoicing and data privacy requirements reviewed and implemented.
- [ ] Backups stored off server and restoration practiced.
- [ ] Payment gateways and webhooks tested with signed provider callbacks.
- [ ] Owner approves production promotion and deployment.
