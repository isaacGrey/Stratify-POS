import { one, rows } from './db.js';

export async function enqueueKitchenTicket(db, tenant, order) {
    if (!order || !['paid','partially_refunded','refunded'].includes(order.status)) return;
    const food=await one(db,`SELECT 1 FROM order_items i JOIN products p
      ON p.tenant_id=i.tenant_id AND p.id=i.product_id
      WHERE i.tenant_id=$1 AND i.order_id=$2
        AND COALESCE(i.product_class,p.product_class)='food_beverage' LIMIT 1`,[tenant,order.id]);
    if(!food)return;
    // The kitchen policy is tenant-scoped; runtime must never query platform tenants.
    const policy=await one(db,'SELECT kitchen_enabled FROM shop_settings WHERE tenant_id=$1',[tenant]);
    if(!policy?.kitchen_enabled)return;
    await db.query(
        "INSERT INTO kitchen_tickets(tenant_id,branch_id,order_id) VALUES($1,$2,$3) " +
        "ON CONFLICT (tenant_id,order_id) DO NOTHING",
        [tenant,order.branch_id,order.id]
    );
}

export function registerKitchenRoutes(app, {data,permit,need,fail,audit,ident}) {
    app.get('/api/shop/kitchen',permit('owner','manager','cashier','staff'),data(async(db,req)=>{
        const branch=req.query.branch_id||null;
        need(!branch||ident(branch),'Invalid branch');
        const tickets=await rows(db, `
          SELECT k.id,k.order_id,k.branch_id,k.status,k.created_at,k.updated_at,k.completed_at,
             o.order_number,o.order_type,o.table_id,t.label AS table_label,
             COALESCE((SELECT jsonb_agg(jsonb_build_object(
                 'name',i.product_name,'variation',i.variation_name,'quantity',i.quantity,
                 'addons',i.addons) ORDER BY i.line_position)
                 FROM order_items i
                 JOIN products p ON p.tenant_id=i.tenant_id AND p.id=i.product_id
                 WHERE i.tenant_id=k.tenant_id AND i.order_id=k.order_id
                   AND COALESCE(i.product_class,p.product_class)='food_beverage'),'[]'::jsonb) AS items
          FROM kitchen_tickets k
          JOIN orders o ON o.tenant_id=k.tenant_id AND o.id=k.order_id
          LEFT JOIN tables t ON t.tenant_id=o.tenant_id AND t.id=o.table_id
          WHERE k.tenant_id=$1 AND ($2::uuid IS NULL OR k.branch_id=$2)
            AND o.status IN ('paid','partially_refunded','refunded')
            AND EXISTS (SELECT 1 FROM order_items i
               JOIN products p ON p.tenant_id=i.tenant_id AND p.id=i.product_id
               WHERE i.tenant_id=k.tenant_id AND i.order_id=k.order_id
                 AND COALESCE(i.product_class,p.product_class)='food_beverage')
          ORDER BY (k.status='completed') ASC,k.created_at DESC LIMIT 200`,
          [req.tenant,branch]);
        return tickets;
    }));
    app.patch('/api/shop/kitchen/:id/status',permit('owner','manager','cashier','staff'),data(async(db,req)=>{
        need(ident(req.params.id),'Invalid kitchen ticket');
        const next=req.body?.status;
        const states=['pending','preparing','ready','completed'];
        need(states.includes(next),'Invalid kitchen status');
        const ticket=await one(db,`
           SELECT k.*,o.status AS payment_status FROM kitchen_tickets k
           JOIN orders o ON o.tenant_id=k.tenant_id AND o.id=k.order_id
           WHERE k.tenant_id=$1 AND k.id=$2 FOR UPDATE OF k`,[req.tenant,req.params.id]);
        if(!ticket)throw fail(404,'Kitchen ticket unavailable');
        if(!['paid','partially_refunded','refunded'].includes(ticket.payment_status)){
           throw fail(409,'Only confirmed paid sales may enter the kitchen');
        }
        if(ticket.status===next)return ticket;
        if(states.indexOf(next)!==states.indexOf(ticket.status)+1) {
            throw fail(409,'Move kitchen orders forward one status at a time');
        }
        const updated=await one(db,
            "UPDATE kitchen_tickets SET status=$3,updated_at=now(),updated_by=$4,"+
            "completed_at=CASE WHEN $3='completed' THEN now() ELSE completed_at END "+
            "WHERE tenant_id=$1 AND id=$2 RETURNING *",
            [req.tenant,ticket.id,next,req.user.id]);
        await audit(db,req,'kitchen.status_updated',{ticket_id:ticket.id,order_id:ticket.order_id,from:ticket.status,to:next});
        return updated;
    }));
}
