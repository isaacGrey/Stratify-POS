# StratifyPOS — public portfolio demo

This repository includes a deliberately separate, browser-only demonstration.

## Deploy to Vercel

1. Import this repository in Vercel, then select branch **portfolio-demo**.
2. Set **Root Directory** to **client**.
3. Framework preset: **Vite**.
4. Build command: **npm run build:demo** (also configured in client/vercel.json).
5. Output directory: **dist**.
6. Deploy. Add the resulting public URL to the portfolio.

The build uses \`VITE_PORTFOLIO_DEMO=true\` and imports \`src/demo.tsx\`, rather than mounting the production application. No server, PostgreSQL database, API URL, payment secrets, or Supabase project is required. Do not configure production API environment variables for this deployment.

## Public sample access

| Role | Email | Password |
| --- | --- | --- |
| Owner | owner@demo.stratifypos.app | demo1234 |
| Manager | manager@demo.stratifypos.app | demo1234 |
| Cashier | cashier@demo.stratifypos.app | demo1234 |

Credentials are **UI-only demo selectors**; they are intentionally included in frontend code and are **not** real security boundaries. This deployment must not connect to any real user/customer data.

## Demo behaviors

- Public login with clearly labeled sample accounts.
- Role-specific navigation: cashier sees dashboard, checkout, sales, and attendance. Owner/manager can explore management pages.
- Functional cart, sample POS checkout, simulated payment methods, and display-only receipts.
- Completing a sample checkout updates browser-local transaction history, revenue summaries, and stock.
- Sample product creation/editing, stock adjustments, low-stock indicators, analytics and CSV export.
- Branch selection, shift clock in/out, checkout tax and service configuration.
- Reset sample data restores original fixtures.
- Changes stored in localStorage, account selection stored in sessionStorage; no remote mutations.
- Persistent notice indicating that this is a portfolio demo.

## Important limitations

This version showcases app workflows and design, **not** the live database-backed product:
- No server-side authentication; the displayed passwords are public and only drive simulated login.
- All changes remain in the visitor's browser and are not shared across visitors/devices.
- No payment gateway integration or financial transactions.
- No accounting/fiscal/BIR receipts, email delivery, subscription billing, or real inventory reconciliation.
- Browser storage can be cleared and the workspace can be reset by the visitor.
- In the portfolio, describe this deployment as **interactive demo with simulated data**, not as a production deployment.

## Local test

\`\`\`bash
cd client
npm ci
npm run build:demo
npm run preview:demo
\`\`\`

The existing production build and backend remain available on the untouched \`main\` branch.
