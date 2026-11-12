import { randomUUID } from 'node:crypto';
import { one, rows } from './db.js';

const fail = (status, message) => Object.assign(new Error(message), { status });

export function inventoryQuantity(value) {
    const quantity = Number(value);
    if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim()) ||
        !Number.isFinite(quantity) || Math.abs(quantity) > 99999999999.999 ||
        Math.abs(quantity * 1000 - Math.round(quantity * 1000)) > 0.02) {
        throw fail(400, 'Enter a valid quantity with up to three decimal places');
    }
    return quantity;
}

async function lockItem(db, tenant, item) {
    const current = await one(db, 'SELECT id FROM ingredients WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [tenant, item]);
    if (!current) throw fail(404, 'Stock item unavailable');
}

async function adjustBranch(db, tenant, item, branch, delta) {
    if (delta > 0) {
        await db.query(`
            INSERT INTO branch_stock_balances (tenant_id,ingredient_id,branch_id,quantity)
            VALUES ($1,$2,$3,$4)
            ON CONFLICT (tenant_id,ingredient_id,branch_id)
            DO UPDATE SET quantity=branch_stock_balances.quantity+EXCLUDED.quantity
        `, [tenant, item, branch, delta]);
        return;
    }
    const result = await db.query(`
        UPDATE branch_stock_balances SET quantity=quantity+$4
        WHERE tenant_id=$1 AND ingredient_id=$2 AND branch_id=$3 AND quantity+$4>=0
    `, [tenant, item, branch, delta]);
    if (!result.rowCount) throw fail(409, 'Insufficient branch stock');
}

async function checkUnallocated(db, tenant, item, required) {
    const available = await one(db, `
        SELECT i.quantity-COALESCE(sum(b.quantity),0) >= $3::numeric AS enough
        FROM ingredients i
        LEFT JOIN branch_stock_balances b ON b.tenant_id=i.tenant_id AND b.ingredient_id=i.id
        WHERE i.tenant_id=$1 AND i.id=$2 GROUP BY i.id
    `, [tenant, item, required]);
    if (!available?.enough) throw fail(409, 'Insufficient unallocated stock');
}

export async function changeStock(db, tenant, item, branch, delta, branchMode) {
    await lockItem(db, tenant, item);
    if (branchMode && branch) await adjustBranch(db, tenant, item, branch, delta);
    if (branchMode && !branch && delta < 0) await checkUnallocated(db, tenant, item, -delta);
    const updated = await one(db, `
        UPDATE ingredients SET quantity=quantity+$3
        WHERE tenant_id=$1 AND id=$2 AND quantity+$3>=0 RETURNING *
    `, [tenant, item, delta]);
    if (!updated) throw fail(409, 'Insufficient item stock');
    return updated;
}

export function recordMovement(db, tenant, item, branch, delta, type, reason, actor, reference = null) {
    return db.query(`
        INSERT INTO stock_movements (tenant_id,ingredient_id,branch_id,delta,movement_type,reason,actor_id,reference_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    `, [tenant, item, branch, delta, type, reason, actor, reference]);
}

export async function transferStock(db, tenant, item, from, to, quantity, reason, actor) {
    await lockItem(db, tenant, item);
    if (from) await adjustBranch(db, tenant, item, from, -quantity);
    else await checkUnallocated(db, tenant, item, quantity);
    if (to) await adjustBranch(db, tenant, item, to, quantity);
    const reference = randomUUID();
    await recordMovement(db, tenant, item, from, -quantity, 'transfer', reason, actor, reference);
    await recordMovement(db, tenant, item, to, quantity, 'transfer', reason, actor, reference);
    return { reference_id: reference };
}

export function listBalances(db, tenant, branch) {
    return rows(db, `
        SELECT i.*, CASE WHEN $2::uuid IS NULL
            THEN i.quantity-COALESCE((SELECT sum(quantity) FROM branch_stock_balances
                WHERE tenant_id=i.tenant_id AND ingredient_id=i.id),0)
            ELSE COALESCE(b.quantity,0) END AS available
        FROM ingredients i
        LEFT JOIN branch_stock_balances b ON b.tenant_id=i.tenant_id AND b.ingredient_id=i.id AND b.branch_id=$2
        WHERE i.tenant_id=$1
        ORDER BY i.name, i.id
    `, [tenant, branch]);
}
