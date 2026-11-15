import { one, rows } from './db.js';

export function registerRegisterRoutes(app, { data, permit, need, fail, audit, ident, money }) {
    async function session(db, req, id) {
        if (!ident(id)) throw fail(400, 'Invalid register session');
        const record = await one(db,
            'SELECT * FROM register_sessions WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
            [req.tenant, id]);
        if (!record) throw fail(404, 'Register session unavailable');
        if (req.role === 'cashier' && record.cashier_id !== req.user.id) {
            throw fail(403, 'This register belongs to another cashier');
        }
        return record;
    }

    async function balance(db, req, record) {
        const result = await one(db,
            'SELECT COALESCE(sum(amount_cents),0)::bigint AS movement_cents FROM register_movements ' +
            'WHERE tenant_id=$1 AND session_id=$2',
            [req.tenant, record.id]);
        return Number(record.opening_cents) + Number(result.movement_cents);
    }

    app.get('/api/shop/register', permit('owner','manager','cashier'), data(async (db, req) => {
        const branch = req.query.branch_id || null;
        need(!branch || ident(branch), 'Invalid branch');
        return rows(db,
            'SELECT s.*, b.name AS branch, u.name AS cashier, ' +
            '(s.opening_cents + COALESCE((SELECT sum(m.amount_cents) FROM register_movements m ' +
            'WHERE m.tenant_id=s.tenant_id AND m.session_id=s.id),0))::bigint AS ledger_cents ' +
            'FROM register_sessions s JOIN branches b ON b.tenant_id=s.tenant_id AND b.id=s.branch_id ' +
            'JOIN users u ON u.id=s.cashier_id ' +
            'WHERE s.tenant_id=$1 AND ($2::uuid IS NULL OR s.branch_id=$2) ' +
            'AND ($3::boolean OR s.cashier_id=$4) ORDER BY s.opened_at DESC LIMIT 100',
            [req.tenant, branch, req.role !== 'cashier', req.user.id]);
    }));

    app.get('/api/shop/register/summary', permit('owner','manager','cashier'), data(async (db, req) => {
        const branch=req.query.branch_id||null;
        if(branch&&!ident(branch))throw fail(400,'Invalid branch');
        // Completed orders are reported separately from physical drawer cash;
        // opening float, cash-in and cash-out are never counted as customer payments.
        const scope=req.role==='cashier' ? req.user.id : null;
        const [sessions,sales,refunds]=await Promise.all([
            rows(db,`SELECT s.id,s.branch_id,s.cashier_id,u.name AS cashier_name,
                b.name AS branch,s.status,s.opening_cents,s.counted_cents,s.expected_cents,
                s.variance_cents,s.opened_at,s.closed_at,
                COALESCE((SELECT sum(m.amount_cents) FROM register_movements m
                  WHERE m.tenant_id=s.tenant_id AND m.session_id=s.id AND m.kind='sale'),0)::bigint AS cash_sales_cents,
                COALESCE((SELECT -sum(m.amount_cents) FROM register_movements m
                  WHERE m.tenant_id=s.tenant_id AND m.session_id=s.id AND m.kind='refund'),0)::bigint AS cash_refunds_cents,
                COALESCE((SELECT sum(m.amount_cents) FROM register_movements m
                  WHERE m.tenant_id=s.tenant_id AND m.session_id=s.id),0)::bigint AS movement_cents
                FROM register_sessions s JOIN users u ON u.id=s.cashier_id
                JOIN branches b ON b.tenant_id=s.tenant_id AND b.id=s.branch_id
                WHERE s.tenant_id=$1 AND ($2::uuid IS NULL OR s.branch_id=$2)
                  AND ($3::uuid IS NULL OR s.cashier_id=$3)
                ORDER BY s.opened_at DESC LIMIT 100`,[req.tenant,branch,scope]),
            one(db,`SELECT count(*)::int AS completed_payments,
                  COALESCE(sum(total_cents),0)::bigint AS gross_collected_cents
                FROM orders WHERE tenant_id=$1 AND ($2::uuid IS NULL OR branch_id=$2)
                  AND ($3::uuid IS NULL OR cashier_id=$3)
                  AND status IN ('paid','partially_refunded','refunded')`,
                [req.tenant,branch,scope]),
            one(db,`SELECT COALESCE(sum(r.amount_cents),0)::bigint AS refunded_cents FROM sales_refunds r
                JOIN orders o ON o.tenant_id=r.tenant_id AND o.id=r.order_id
                WHERE r.tenant_id=$1 AND ($2::uuid IS NULL OR r.branch_id=$2)
                AND ($3::uuid IS NULL OR o.cashier_id=$3)`,[req.tenant,branch,scope])
        ]);
        const gross=BigInt(sales.gross_collected_cents);
        const returned=BigInt(refunds.refunded_cents);
        return { completed_payments:sales.completed_payments,gross_collected_cents:gross.toString(),
          refunds_cents:returned.toString(),net_collected_cents:(gross-returned).toString(),
          sessions:sessions.map(row=>({
            ...row,expected_live_cents:(BigInt(row.opening_cents)+BigInt(row.movement_cents)).toString()
          })) };
    }));

    app.put('/api/shop/register/policy', permit('owner'), data(async (db, req) => {
        need(typeof req.body.require_cash_register === 'boolean', 'Invalid cash register requirement');
        const settings = await one(db,
            'UPDATE shop_settings SET require_cash_register=$2 WHERE tenant_id=$1 RETURNING *',
            [req.tenant,req.body.require_cash_register]);
        await audit(db,req,'register.policy_updated',{required:req.body.require_cash_register});
        return settings;
    }));

    app.post('/api/shop/register/open', permit('owner','manager','cashier'), data(async (db, req) => {
        const { branch_id, opening_cents } = req.body;
        need(ident(branch_id) && money(opening_cents), 'Invalid branch or opening cash');
        const branch = await one(db,
            'SELECT id FROM branches WHERE tenant_id=$1 AND id=$2 AND active=true',
            [req.tenant, branch_id]);
        if (!branch) throw fail(404, 'Branch unavailable');
        const existing = await one(db,
            "SELECT id FROM register_sessions WHERE tenant_id=$1 AND cashier_id=$2 AND status='open' FOR UPDATE",
            [req.tenant, req.user.id]);
        if (existing) throw fail(409, 'Close your existing register before opening another');
        let record;
        try {
            record = await one(db,
                'INSERT INTO register_sessions(tenant_id,branch_id,cashier_id,opening_cents) ' +
                'VALUES ($1,$2,$3,$4) RETURNING *',
                [req.tenant, branch_id, req.user.id, opening_cents]);
        } catch (error) {
            if (error.code === '23505') throw fail(409, 'Cashier already has an open register');
            throw error;
        }
        await audit(db, req, 'register.opened', { id:record.id, branch_id, opening_cents });
        return record;
    }));

    app.get('/api/shop/register/:id', permit('owner','manager','cashier'), data(async (db, req) => {
        const record = await session(db, req, req.params.id);
        const movements = await rows(db,
            'SELECT m.*, u.name AS actor FROM register_movements m ' +
            'JOIN users u ON u.id=m.actor_id WHERE m.tenant_id=$1 AND m.session_id=$2 ' +
            'ORDER BY m.created_at,m.id LIMIT 500',
            [req.tenant, record.id]);
        return { ...record, expected_cents:await balance(db,req,record), movements };
    }));

    app.post('/api/shop/register/:id/movements', permit('owner','manager','cashier'), data(async (db, req) => {
        const record = await session(db, req, req.params.id);
        if (record.status !== 'open') throw fail(409, 'Register is already closed');
        const { kind, amount_cents, reason } = req.body;
        need(['cash_in','cash_out'].includes(kind) &&
            money(amount_cents) && amount_cents > 0 &&
            typeof reason === 'string' && reason.trim().length >= 3 &&
            reason.trim().length <= 300, 'Invalid cash movement');
        const signed = kind === 'cash_out' ? -amount_cents : amount_cents;
        if (await balance(db, req, record) + signed < 0) {
            throw fail(409, 'Cash out exceeds the recorded register balance');
        }
        const movement = await one(db,
            'INSERT INTO register_movements(tenant_id,branch_id,session_id,actor_id,kind,amount_cents,reason) ' +
            'VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',
            [req.tenant,record.branch_id,record.id,req.user.id,kind,signed,reason.trim()]);
        await audit(db,req,'register.cash_movement',{ id:movement.id,kind,amount_cents:signed });
        return movement;
    }));

    app.post('/api/shop/register/:id/close', permit('owner','manager','cashier'), data(async (db, req) => {
        const record = await session(db, req, req.params.id);
        if (record.status !== 'open') throw fail(409, 'Register already closed');
        need(money(req.body.counted_cents), 'Invalid counted cash');
        const expected = await balance(db,req,record);
        const counted = req.body.counted_cents;
        const closed = await one(db,
            "UPDATE register_sessions SET status='closed',counted_cents=$3,expected_cents=$4," +
            "variance_cents=($3::integer - $4::integer),closed_at=now(),closed_by=$5 WHERE tenant_id=$1 AND id=$2 RETURNING *",
            [req.tenant,record.id,counted,expected,req.user.id]);
        await audit(db,req,'register.closed',{id:record.id,expected_cents:expected,
            counted_cents:counted,variance_cents:counted-expected});
        return closed;
    }));
}
