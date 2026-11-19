import { randomBytes } from 'node:crypto';
import { one, rows } from './db.js';

export const fail = (status, message) => Object.assign(new Error(message), { status });
export const planId = id => typeof id === 'string' && /^[a-z][a-z0-9_-]{0,39}$/.test(id);

export async function inTransaction(pool, handler) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const result = await handler(client);
        await client.query('COMMIT');
        return result;
    } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
    } finally { client.release(); }
}

export function platformAudit(db, actor, action, target, details = {}) {
    return db.query('INSERT INTO platform_audit_logs (actor_id,action,target,details) VALUES ($1,$2,$3,$4)',
        [actor?.id ?? null, action, target, details]);
}

export async function provisionBusiness(db, { ownerId, name, plan, status, end = null, businessType='food' }) {
    const slug = (name.trim().toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,35) || 'business')
        + '-' + randomBytes(5).toString('hex');
    const business = await one(db, `
        INSERT INTO tenants (name,slug,status,business_type) VALUES ($1,$2,$3,$4)
        RETURNING id,name,slug,status,business_type,created_at
    `, [name.trim(), slug, ['trial','active'].includes(status) ? 'active' : 'suspended', businessType]);
    await db.query("SELECT set_config('app.tenant_id',$1,true)", [business.id]);
    await db.query("INSERT INTO memberships (tenant_id,user_id,role) VALUES ($1,$2,'owner')", [business.id, ownerId]);
    const subscription = await one(db, `
        INSERT INTO subscriptions (tenant_id,plan_id,status,trial_ends_at,current_period_ends_at)
        VALUES ($1,$2,$3,
            CASE WHEN $3='trial' THEN now()+$4::int*interval '1 day' END,
            CASE WHEN $3='active' THEN $5::timestamptz END)
        RETURNING tenant_id,plan_id,status,trial_ends_at,current_period_ends_at
    `, [business.id, plan.id, status, plan.trial_days, end]);
    await db.query('INSERT INTO shop_settings (tenant_id,kitchen_enabled) VALUES ($1,$2)', [business.id,businessType==='food']);
    await db.query("INSERT INTO branches (tenant_id,name) VALUES ($1,'Main Branch')", [business.id]);
    return { business, subscription };
}

export async function priceSubscription(db, plan, code) {
    if (code !== undefined && code !== null && (typeof code !== 'string' || code.trim().length > 40)) {
        throw fail(400, 'Invalid subscription discount code');
    }
    const normalized = code?.trim().toUpperCase() || null;
    const promotion = await one(db, `
        SELECT id,name,kind,value FROM subscription_promotions
        WHERE active AND ($1::text IS NULL AND code IS NULL OR code=$1)
            AND (plan_id=$2 OR plan_id IS NULL)
            AND (starts_at IS NULL OR starts_at<=now()) AND (expires_at IS NULL OR expires_at>now())
        ORDER BY (CASE WHEN kind='fixed' THEN value ELSE round($3::numeric * value / 100) END) DESC,id
        LIMIT 1
    `, [normalized, plan.id, plan.price_cents]);
    if (normalized && !promotion) throw fail(400, 'Subscription discount code is unavailable');
    if (!promotion) return { ...plan, promotion_id: null };
    const discount = promotion.kind === 'fixed' ? promotion.value : Math.round(plan.price_cents * promotion.value / 100);
    return { ...plan, price_cents: Math.max(1, plan.price_cents - discount), promotion_id: promotion.id, promotion_name: promotion.name };
}

export function platformPlans(db) {
    return rows(db, 'SELECT * FROM plans ORDER BY price_cents,id');
}
