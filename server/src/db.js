import pg from 'pg';
import 'dotenv/config';

export const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    max: 20
});

/** Tenant queries MUST always execute under a non-BYPASSRLS role. */
export async function scoped(tenantId, fn, { consistentRead = false, branchIds = null, userId = '' } = {}) {
    if (!tenantId || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(String(tenantId))) {
        throw new Error('Valid tenant ID required');
    }
    const db = await pool.connect();
    try {
        await db.query(consistentRead ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN');
        // Critical: the postgres SUPERUSER bypasses RLS even with FORCE RLS.
        // Use a restricted runtime role for EVERY tenant-scoped query.
        await db.query('SET LOCAL ROLE coffee_saas_runtime');
        await db.query(`SELECT set_config('app.tenant_id',$1,true), set_config('app.branch_ids',$2,true),
            set_config('app.user_id',$3,true)`,
        [tenantId, branchIds === null ? '' : '{' + branchIds.join(',') + '}', userId]);
        const out = await fn(db);
        await db.query('COMMIT');
        return out;
    } catch (error) {
        await db.query('ROLLBACK');
        throw error;
    } finally {
        db.release();
    }
}

export const rows = async (db, sql, args = []) => (await db.query(sql, args)).rows;
export const one = async (db, sql, args = []) => (await db.query(sql, args)).rows[0];
