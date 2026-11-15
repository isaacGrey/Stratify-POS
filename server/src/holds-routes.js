import { createHash } from 'node:crypto';
import { one, rows } from './db.js';

export function registerHoldRoutes(app, { data, permit, need, fail, audit, ident }) {
  function validDraft(req) {
    const { id, branch_id, items, order_type='takeout', table_id=null,
      promo_code=null, loyalty_code=null, note='' } = req.body;
    need(ident(id) && ident(branch_id) &&
      Array.isArray(items) && items.length>0 && items.length<=100 &&
      ['dine_in','takeout','delivery'].includes(order_type) &&
      (!table_id || (order_type==='dine_in' && ident(table_id))) &&
      (promo_code===null || typeof promo_code==='string' && promo_code.length<=100) &&
      (loyalty_code===null || typeof loyalty_code==='string' && loyalty_code.length<=100) &&
      typeof note==='string' && note.length<=300, 'Invalid held order');
    const normalized = items.map(item=>{
      need(item && ident(item.product_id) &&
        (!item.variation_id || ident(item.variation_id)) &&
        Number.isInteger(item.quantity) && item.quantity>=1 && item.quantity<=100 &&
        (item.addon_ids===undefined || Array.isArray(item.addon_ids) &&
          item.addon_ids.length<=50 && item.addon_ids.every(ident) &&
          item.addon_ids.length===new Set(item.addon_ids).size), 'Invalid held cart item');
      return { product_id:item.product_id,quantity:item.quantity,
        variation_id:item.variation_id || null,
        addon_ids:[...(item.addon_ids||[])].sort() };
    });
    const payload={ id,branch_id,items:normalized,order_type,
      table_id:table_id||null,promo_code:promo_code||null,
      loyalty_code:loyalty_code||null,note:note.trim() };
    const fingerprint=createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    return {...payload, fingerprint};
  }

  function secureToCashier(req,draft) {
    if (['cashier','staff'].includes(req.role) && draft.cashier_id!==req.user.id) {
      throw fail(403,'This held order belongs to another cashier');
    }
  }

  app.get('/api/shop/holds', permit('owner','manager','cashier','staff'), data(async(db,req)=>{
    const branch=req.query.branch_id ?? null;
    need(!branch || ident(branch),'Invalid branch');
    return rows(db,
      "SELECT id,branch_id,cashier_id,status,order_type,table_id,items,note,created_at,updated_at " +
      "FROM parked_orders WHERE tenant_id=$1 AND status='held' AND ($2::uuid IS NULL OR branch_id=$2) " +
      'AND ($3::boolean OR cashier_id=$4) ORDER BY updated_at DESC,id DESC LIMIT 100',
      [req.tenant,branch,!['cashier','staff'].includes(req.role),req.user.id]);
  }));

  app.post('/api/shop/holds', permit('owner','manager','cashier','staff'), data(async(db,req)=>{
    const hold=validDraft(req);
    const selected=await one(db,
      'SELECT id FROM branches WHERE tenant_id=$1 AND id=$2 AND active=true',
      [req.tenant,hold.branch_id]);
    if(!selected) throw fail(404,'Branch unavailable');
    if(hold.table_id) {
      const table=await one(db,
        'SELECT id FROM tables WHERE tenant_id=$1 AND branch_id=$2 AND id=$3',
        [req.tenant,hold.branch_id,hold.table_id]);
      if(!table) throw fail(400,'Table does not belong to branch');
    }
    const created=await one(db,
      'INSERT INTO parked_orders(id,tenant_id,branch_id,cashier_id,items,order_type,table_id,' +
      'promo_code,loyalty_code,note,request_fingerprint) VALUES ' +
      "($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (id) DO NOTHING RETURNING *",
      [hold.id,req.tenant,hold.branch_id,req.user.id,JSON.stringify(hold.items),hold.order_type,
        hold.table_id,hold.promo_code,hold.loyalty_code,hold.note,hold.fingerprint]);
    if(created) {
      await audit(db,req,'order.held',{id:created.id,branch_id:created.branch_id});
      return created;
    }
    const previous=await one(db,
      'SELECT * FROM parked_orders WHERE tenant_id=$1 AND id=$2',
      [req.tenant,hold.id]);
    if(!previous || previous.cashier_id!==req.user.id ||
      previous.request_fingerprint!==hold.fingerprint) {
      throw fail(409,'Held-order request ID is already in use');
    }
    return {...previous,duplicate:true};
  }));

  app.get('/api/shop/holds/:id', permit('owner','manager','cashier','staff'),data(async(db,req)=>{
    need(ident(req.params.id),'Invalid held order');
    const draft=await one(db,'SELECT * FROM parked_orders WHERE tenant_id=$1 AND id=$2',
      [req.tenant,req.params.id]);
    if(!draft) throw fail(404,'Held order unavailable');
    secureToCashier(req,draft);
    return draft;
  }));

  app.post('/api/shop/holds/:id/cancel',permit('owner','manager','cashier','staff'),data(async(db,req)=>{
    need(ident(req.params.id),'Invalid held order');
    const draft=await one(db,
      'SELECT * FROM parked_orders WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
      [req.tenant,req.params.id]);
    if(!draft) throw fail(404,'Held order unavailable');
    secureToCashier(req,draft);
    if(draft.status==='completed') throw fail(409,'Completed order cannot be cancelled');
    if(draft.status==='cancelled') return {...draft,duplicate:true};
    const updated=await one(db,
      "UPDATE parked_orders SET status='cancelled',updated_at=now() " +
      'WHERE tenant_id=$1 AND id=$2 RETURNING *',[req.tenant,draft.id]);
    await audit(db,req,'order.hold_cancelled',{id:draft.id});
    return updated;
  }));
}
