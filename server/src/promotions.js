import { one, rows } from './db.js';

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const fail = (status, message) => Object.assign(new Error(message), { status });
const kinds = ['percent', 'fixed', 'bogo', 'bundle', 'loyalty'];
export const validLoyaltyCode = value => typeof value === 'string' && /^[A-Z0-9-]{3,32}$/i.test(value.trim());

function optionalDate(value) {
    if (!value) return null;
    if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw fail(400, 'Invalid promotion date');
    return new Date(value).toISOString();
}

export function offlineEligible(rule) {
    return ['percent', 'fixed'].includes(rule.kind) && rule.scope === 'transaction' &&
        !rule.requires_approval && !rule.usage_limit && !rule.branch_ids.length;
}

export async function savePromotion(db, tenant, body, id = null) {
    const code = typeof body.code === 'string' && body.code.trim().toUpperCase();
    const { kind, scope = 'transaction', product_id = null, category_id = null,
        branch_ids = [], usage_limit = null, requires_approval = false, active = true } = body;
    const points = kind === 'loyalty' ? body.points_required : null;
    const value = kind === 'bogo' ? 0 : Number(body.value);
    const group = kind === 'bundle' ? body.group_quantity : kind === 'bogo' ? 2 : null;
    const starts = optionalDate(body.starts_at);
    const expires = optionalDate(body.expires_at);
    if (!code || code.length > 100 || !kinds.includes(kind) || !Number.isSafeInteger(value) ||
        value < 0 || value > 100000000 || (['percent','fixed','loyalty'].includes(kind) && value === 0) ||
        (kind === 'percent' && value > 100) || (kind === 'bundle' && (!Number.isInteger(group) || group < 2 || group > 100)) ||
        (starts && expires && starts >= expires) || !['transaction','product','category'].includes(scope) ||
        (scope === 'product' && !uuid.test(product_id)) || (scope === 'category' && !uuid.test(category_id)) ||
        !Array.isArray(branch_ids) || branch_ids.length > 100 || !branch_ids.every(id => uuid.test(id)) ||
        new Set(branch_ids).size !== branch_ids.length ||
        (usage_limit !== null && (!Number.isInteger(usage_limit) || usage_limit < 1 || usage_limit > 100000000)) ||
        (kind === 'loyalty' && (!Number.isInteger(points) || points < 1 || points > 100000000)) ||
        typeof requires_approval !== 'boolean' || typeof active !== 'boolean') throw fail(400, 'Invalid promotion rules');

    if (scope === 'product' && !await one(db, 'SELECT id FROM products WHERE tenant_id=$1 AND id=$2', [tenant, product_id])) {
        throw fail(400, 'Product unavailable');
    }
    if (scope === 'category' && !await one(db, 'SELECT id FROM categories WHERE tenant_id=$1 AND id=$2', [tenant, category_id])) {
        throw fail(400, 'Category unavailable');
    }
    if (branch_ids.length) {
        const branches = await rows(db, 'SELECT id FROM branches WHERE tenant_id=$1 AND id=ANY($2::uuid[])', [tenant, branch_ids]);
        if (branches.length !== branch_ids.length) throw fail(400, 'Invalid promotion branch');
    }
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 10519))', [tenant + ':' + code]);
    const duplicate = await one(db, 'SELECT id FROM promotions WHERE tenant_id=$1 AND upper(code)=$2 AND id IS DISTINCT FROM $3::uuid',
        [tenant, code, id]);
    if (duplicate) throw fail(409, 'Promo code already exists');
    const args = [tenant, code, kind, value, active, expires, starts, scope,
        scope === 'product' ? product_id : null, scope === 'category' ? category_id : null,
        branch_ids, usage_limit, group, requires_approval, points];
    const saved = id ? await one(db, `
        UPDATE promotions SET code=$2,kind=$3,value=$4,active=$5,expires_at=$6,starts_at=$7,scope=$8,
            product_id=$9,category_id=$10,branch_ids=$11,usage_limit=$12,group_quantity=$13,requires_approval=$14,points_required=$15
        WHERE tenant_id=$1 AND id=$16 RETURNING *
    `, [...args, id]) : await one(db, `
        INSERT INTO promotions (tenant_id,code,kind,value,active,expires_at,starts_at,scope,
            product_id,category_id,branch_ids,usage_limit,group_quantity,requires_approval,points_required)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *
    `, args);
    if (!saved) throw fail(404, 'Promotion unavailable');
    return saved;
}

export async function orderPromotion(db, { tenant, role, branch, code, lines, offline, quote, loyalty }) {
    if (!code) return { id: null, code: null, discount: 0 };
    const rule = await one(db, `
        SELECT * FROM promotions WHERE tenant_id=$1 AND upper(code)=upper(trim($2))
            AND active AND (starts_at IS NULL OR starts_at <= now())
            AND (expires_at IS NULL OR expires_at > now())
        ORDER BY (code=upper(trim($2))) DESC, id LIMIT 1 ${quote ? '' : 'FOR UPDATE'}
    `, [tenant, code]);
    if (!rule) throw fail(400, 'Promo code is unavailable');
    if (rule.branch_ids.length && !rule.branch_ids.includes(branch)) throw fail(409, 'Promotion is unavailable at this branch');
    if (offline && !offlineEligible(rule)) throw fail(409, 'Promotion terms changed or require an online sale');
    if (rule.requires_approval && !['owner', 'manager'].includes(role)) throw fail(403, 'A manager or owner must approve this promotion at checkout');
    if (rule.kind === 'loyalty' && (!loyalty || BigInt(loyalty.points) < BigInt(rule.points_required))) {
        throw fail(409, 'Reward account is missing or has insufficient points');
    }
    if (rule.usage_limit) {
        const usage = await one(db, `
            SELECT count(*)::int AS count FROM orders WHERE tenant_id=$1
                AND (promotion_id=$2 OR (promotion_id IS NULL AND upper(promo_code)=upper($3)))
        `, [tenant, rule.id, rule.code]);
        if (usage.count >= rule.usage_limit) throw fail(409, 'Promotion usage limit reached');
    }
    const eligible = lines.filter(line => rule.scope === 'transaction' ||
        (rule.scope === 'product' && line.product.id === rule.product_id) ||
        (rule.scope === 'category' && line.product.category_id === rule.category_id));
    if (!eligible.length) throw fail(409, 'No items in this order qualify for the promotion');
    const base = eligible.reduce((sum, line) => sum + line.total, 0);
    let discount;
    if (rule.kind === 'percent') discount = Math.round(base * Math.min(rule.value, 100) / 100);
    else if (['fixed', 'loyalty'].includes(rule.kind)) discount = Math.min(base, rule.value);
    else {
        const prices = eligible.flatMap(line => Array.from({ length: line.qty }, () => line.unit)).sort((a, b) => a - b);
        const group = rule.group_quantity || 2;
        const groups = Math.floor(prices.length / group);
        if (!groups) throw fail(409, 'Add more eligible items to apply the promotion');
        if (rule.kind === 'bogo') discount = prices.slice(0, groups).reduce((sum, price) => sum + price, 0);
        else {
            const eligiblePrices = prices.slice(-groups * group);
            discount = 0;
            for (let index = 0; index < eligiblePrices.length; index += group) {
                const total = eligiblePrices.slice(index, index + group).reduce((sum, price) => sum + price, 0);
                discount += Math.max(0, total - rule.value);
            }
        }
    }
    return { id: rule.id, code: rule.code, discount, points: rule.points_required || 0 };
}

export async function recordLoyalty(db, tenant, account, order, earned, redeemed) {
    if (!account || (!earned && !redeemed)) return;
    await db.query('UPDATE loyalty_accounts SET points=points+$3::integer WHERE tenant_id=$1 AND id=$2',
        [tenant, account, earned - redeemed]);
    if (earned) await db.query(`INSERT INTO loyalty_movements (tenant_id,account_id,order_id,kind,points)
        VALUES ($1,$2,$3,'earned',$4)`, [tenant, account, order, earned]);
    if (redeemed) await db.query(`INSERT INTO loyalty_movements (tenant_id,account_id,order_id,kind,points)
        VALUES ($1,$2,$3,'redeemed',$4)`, [tenant, account, order, -redeemed]);
}
