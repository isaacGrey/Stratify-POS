import { one, rows } from './db.js';

const MAX_EXPORT_ROWS = 10000;
const TIME_ZONE = process.env.REPORT_TIME_ZONE || 'Asia/Manila';
const calendar = new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' });
const asDate = value => value.toISOString().slice(0, 10);
const invalid = (message, status = 400) => Object.assign(new Error(message), { status });

function validDate(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
        value < '1900-01-01' || value > '9998-12-31') return false;
    const date = new Date(value);
    return Number.isFinite(date.getTime()) && asDate(date) === value;
}

function page(value) {
    const number = Number(value ?? 0);
    if (!Number.isSafeInteger(number) || number < 0 || number > 100000) throw invalid('Invalid page');
    return number;
}

export function reportFilters(query) {
    const parts = Object.fromEntries(calendar.formatToParts(new Date()).map(part => [part.type, part.value]));
    const today = parts.year + '-' + parts.month.padStart(2, '0') + '-' + parts.day.padStart(2, '0');
    const period = query.period ?? (query.days ? 'rolling' : 'monthly');
    let from;
    let to = today;
    switch (period) {
        case 'daily': from = today; break;
        case 'yesterday':
            from = to = asDate(new Date(Date.parse(today) - 86400000));
            break;
        case 'weekly': {
            const weekday = new Date(today + 'T00:00:00Z').getUTCDay();
            from = asDate(new Date(Date.parse(today) - ((weekday + 6) % 7) * 86400000));
            break;
        }
        case 'monthly': from = today.slice(0, 7) + '-01'; break;
        case 'yearly': from = today.slice(0, 4) + '-01-01'; break;
        case 'rolling': {
            const days = Math.max(1, Math.min(365, Number(query.days) || 30));
            from = asDate(new Date(Date.parse(today) - (Math.floor(days) - 1) * 86400000));
            break;
        }
        case 'custom':
            from = query.from;
            to = query.to;
            break;
        default: throw invalid('Unknown reporting period');
    }
    if (!validDate(from) || !validDate(to) || from > to ||
        Date.parse(to) - Date.parse(from) > 3660 * 86400000) throw invalid('Select a valid date range of up to ten years');
    return { period, from, to, zone: TIME_ZONE, branch_id: query.branch_id || null,
        transactionPage: page(query.transaction_page), movementPage: page(query.movement_page) };
}

export async function loadReport(db, tenant, filters, exporting, branchLimited = false) {
    const { from, to, zone, branch_id: branch, transactionPage, movementPage } = filters;
    const args = [tenant, from, to, zone, branch];
    const window = alias => `
        ${alias}.tenant_id=$1 AND ($5::uuid IS NULL OR ${alias}.branch_id=$5)
        AND ${alias}.created_at >= ($2::date::timestamp AT TIME ZONE $4)
        AND ${alias}.created_at < (($3::date+1)::timestamp AT TIME ZONE $4)
    `;
    const paid = window('o') + " AND o.status IN ('paid','partially_refunded','refunded')";
    const counts = await one(db, `
        SELECT
            (SELECT count(*)::int FROM orders o WHERE ${window('o')}) AS transactions,
            (SELECT count(*)::int FROM stock_movements m WHERE ${window('m')}) AS movements
    `, args);
    if (exporting && (counts.transactions > MAX_EXPORT_ROWS || counts.movements > MAX_EXPORT_ROWS)) {
        throw invalid('The report is too large to export. Narrow the date range or choose one branch.', 422);
    }
    const limit = exporting ? MAX_EXPORT_ROWS : 50;
    const [summary, daily, top, cashiers, discounts, balances, transactions, movements] = [
        await one(db, `SELECT COUNT(*)::int AS orders, COALESCE(sum(total_cents),0) AS revenue_cents,
            COALESCE(sum(discount_cents),0) AS discount_cents, COALESCE(sum(tax_cents),0) AS tax_cents,
            COALESCE(sum(service_cents),0) AS service_cents,
            (SELECT COALESCE(sum(amount_cents),0) FROM expenses e WHERE e.tenant_id=$1
             AND e.spent_on BETWEEN $2::date AND $3::date AND ($5::uuid IS NULL OR e.branch_id=$5)) AS expenses_cents
            FROM orders o WHERE ${paid}`, args),
        await rows(db, `SELECT day, sum(orders)::int AS orders, sum(revenue)::bigint AS revenue
            FROM (
                SELECT to_char(o.created_at AT TIME ZONE $4,$6) AS day,
                    count(*)::int AS orders, sum(o.total_cents)::bigint AS revenue
                FROM orders o WHERE ${paid} GROUP BY 1
                UNION ALL
                SELECT to_char(f.created_at AT TIME ZONE $4,$6) AS day,
                    0::int AS orders, -sum(f.amount_cents)::bigint AS revenue
                FROM sales_refunds f WHERE ${window('f')} GROUP BY 1
            ) daily_activity GROUP BY day ORDER BY day`,
        [...args, filters.period === 'yearly' ? 'YYYY-MM' : 'YYYY-MM-DD']),
        await rows(db, `SELECT oi.product_name AS name, oi.variation_name AS variation,
            sum(oi.quantity)::bigint AS units, sum(oi.total_cents)::bigint AS sales
            FROM order_items oi JOIN orders o ON o.tenant_id=oi.tenant_id AND o.id=oi.order_id
            WHERE ${paid} GROUP BY oi.product_id, oi.product_name, oi.variation_id, oi.variation_name
            ORDER BY sales DESC, name, variation`, args),
        await rows(db, `SELECT u.name, count(*)::int AS orders, sum(o.total_cents) AS sales
            FROM orders o JOIN users u ON u.id=o.cashier_id
            WHERE ${paid} GROUP BY u.id, u.name ORDER BY sales DESC, u.name`, args),
        await rows(db, `SELECT o.promo_code AS code, count(*)::int AS orders, sum(o.discount_cents) AS discount_cents
            FROM orders o WHERE ${paid} AND o.promo_code IS NOT NULL
            GROUP BY o.promo_code ORDER BY discount_cents DESC, code`, args),
        await rows(db, `SELECT i.name, i.inventory_category AS category, i.unit, i.low_stock_at,
            CASE WHEN NOT $3 AND ($2::uuid IS NULL OR NOT s.branch_stock_enabled) THEN i.quantity
                 ELSE COALESCE(b.quantity,0) END AS quantity
            FROM ingredients i JOIN shop_settings s ON s.tenant_id=i.tenant_id
            LEFT JOIN LATERAL (SELECT sum(quantity) AS quantity FROM branch_stock_balances
                WHERE tenant_id=i.tenant_id AND ingredient_id=i.id AND ($2::uuid IS NULL OR branch_id=$2)) b ON true
            WHERE i.tenant_id=$1 AND (NOT $3 OR s.branch_stock_enabled)
            ORDER BY i.name, i.id`, [tenant, branch, branchLimited]),
        await rows(db, `SELECT o.order_number, to_char(o.created_at AT TIME ZONE $4, 'YYYY-MM-DD HH24:MI:SS') AS local_time,
            b.name AS branch, u.name AS cashier, o.status, o.payment_method, o.subtotal_cents, o.discount_cents,
            o.tax_cents, o.service_cents, o.total_cents, o.promo_code
            FROM orders o JOIN branches b ON b.tenant_id=o.tenant_id AND b.id=o.branch_id
            JOIN users u ON u.id=o.cashier_id WHERE ${window('o')}
            ORDER BY o.created_at DESC, o.id DESC LIMIT $6 OFFSET $7`,
        [...args, limit, exporting ? 0 : transactionPage * limit]),
        await rows(db, `SELECT to_char(m.created_at AT TIME ZONE $4, 'YYYY-MM-DD HH24:MI:SS') AS local_time,
            i.name, i.unit, b.name AS branch, m.delta, m.reason, m.movement_type, m.reference_id
            FROM stock_movements m JOIN ingredients i ON i.tenant_id=m.tenant_id AND i.id=m.ingredient_id
            LEFT JOIN branches b ON b.tenant_id=m.tenant_id AND b.id=m.branch_id WHERE ${window('m')}
            ORDER BY m.created_at DESC, m.id DESC LIMIT $6 OFFSET $7`,
        [...args, limit, exporting ? 0 : movementPage * limit])
    ];
    // Refunds are reported on the day cash was returned, even when the original
    // purchase belongs to a previous reporting period. Product/cashier rankings
    // remain original sales figures until item-level returns are available.
    const refundTotals = await one(db,
        `SELECT COALESCE(sum(f.amount_cents),0)::bigint AS refund_cents
         FROM sales_refunds f WHERE ${window('f')}`, args);
    summary.gross_revenue_cents = summary.revenue_cents;
    summary.refund_cents = refundTotals.refund_cents;
    summary.revenue_cents = String(BigInt(summary.gross_revenue_cents) - BigInt(summary.refund_cents));
    return { filters, counts, summary, daily, top, cashiers, discounts, balances, transactions, movements,
        expenses_cents: summary.expenses_cents };
}
