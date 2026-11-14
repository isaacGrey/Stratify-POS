import { one, rows } from './db.js';

export function registerRefundRoutes(app, {data,permit,need,fail,audit,ident,money}) {
    app.get('/api/shop/orders/:id/refunds', permit('owner','manager','cashier'), data(async(db,req) => {
        need(ident(req.params.id),'Invalid transaction');
        const order=await one(db,'SELECT id FROM orders WHERE tenant_id=$1 AND id=$2',
            [req.tenant,req.params.id]);
        if (!order) throw fail(404,'Transaction unavailable');
        return rows(db,
            'SELECT r.*,u.name AS authorized_by FROM sales_refunds r ' +
            'JOIN users u ON u.id=r.actor_id WHERE r.tenant_id=$1 AND r.order_id=$2 ' +
            'ORDER BY r.created_at DESC,r.id DESC',
            [req.tenant,order.id]);
    }));

    app.post('/api/shop/orders/:id/refunds', permit('owner','manager'), data(async(db,req) => {
        const { request_id,amount_cents,reason,register_session_id=null } = req.body;
        need(ident(req.params.id) && ident(request_id) && money(amount_cents) && amount_cents>0 &&
            typeof reason==='string' && reason.trim().length>=5 && reason.trim().length<=500 &&
            (!register_session_id || ident(register_session_id)), 'Invalid refund request');
        const order=await one(db,
            'SELECT * FROM orders WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
            [req.tenant,req.params.id]);
        if (!order) throw fail(404,'Transaction unavailable');
        const previous=await one(db,
            'SELECT * FROM sales_refunds WHERE tenant_id=$1 AND request_id=$2',
            [req.tenant,request_id]);
        if (previous) {
            if (previous.order_id!==order.id || previous.amount_cents!==amount_cents ||
                previous.reason!==reason.trim() || previous.register_session_id!==register_session_id) {
                throw fail(409,'Refund request ID belongs to different refund details');
            }
            return { ...previous,duplicate:true };
        }
        if (!['paid','partially_refunded'].includes(order.status)) {
            throw fail(409,'Transaction is not refundable');
        }
        // Cash only until external provider reversals can be verified. Never claim an
        // electronic refund has been made without a provider confirmation.
        if (order.payment_method!=='cash') {
            throw fail(422,'Cash refunds only. Electronic payment reversals require provider verification.');
        }
        const total=await one(db,
            'SELECT COALESCE(sum(amount_cents),0)::bigint AS refunded FROM sales_refunds ' +
            'WHERE tenant_id=$1 AND order_id=$2',[req.tenant,order.id]);
        const remaining=Number(order.total_cents)-Number(total.refunded);
        if (amount_cents>remaining) throw fail(409,'Refund exceeds the remaining paid amount');

        const settings=await one(db,
            'SELECT require_cash_register FROM shop_settings WHERE tenant_id=$1',[req.tenant]);
        if (settings?.require_cash_register && !register_session_id) {
            throw fail(409,'An open register is required for cash refunds');
        }
        let register=null;
        if (register_session_id) {
            register=await one(db,
                'SELECT * FROM register_sessions WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
                [req.tenant,register_session_id]);
            if (!register || register.status!=='open' ||
                register.branch_id!==order.branch_id || register.cashier_id!==req.user.id) {
                throw fail(409,'Use your own open register in the sale branch');
            }
            const cash=await one(db,
                'SELECT COALESCE(sum(amount_cents),0)::bigint AS delta FROM register_movements ' +
                'WHERE tenant_id=$1 AND session_id=$2',
                [req.tenant,register.id]);
            if (Number(register.opening_cents)+Number(cash.delta)<amount_cents) {
                throw fail(409,'Refund exceeds the recorded register cash');
            }
        }
        const refund=await one(db,
            'INSERT INTO sales_refunds(tenant_id,order_id,branch_id,actor_id,request_id,amount_cents,method,reason,register_session_id) ' +
            "VALUES($1,$2,$3,$4,$5,$6,'cash',$7,$8) RETURNING *",
            [req.tenant,order.id,order.branch_id,req.user.id,request_id,amount_cents,reason.trim(),register_session_id]);
        const status=amount_cents===remaining ? 'refunded':'partially_refunded';
        await db.query('UPDATE orders SET status=$3 WHERE tenant_id=$1 AND id=$2',
            [req.tenant,order.id,status]);
        if (register) {
            await db.query(
                'INSERT INTO register_movements(tenant_id,branch_id,session_id,actor_id,kind,amount_cents,reason,reference_id) ' +
                "VALUES($1,$2,$3,$4,'refund',$5,$6,$7)",
                [req.tenant,order.branch_id,register.id,req.user.id,-amount_cents,reason.trim(),refund.id]);
        }
        await audit(db,req,'order.cash_refund',{
            order_id:order.id,refund_id:refund.id,amount_cents,status,
            register_session_id:register_session_id
        });
        return { ...refund,status };
    }));
}
