import {one,rows} from './db.js';
import {randomUUID} from 'node:crypto';

// Calendar-month arithmetic is anchored to the original day, then clamped to the last
// available day of the destination month (Jan 31 + 1 month = Feb 28/29).
const iso = /^\d{4}-\d{2}-\d{2}$/;
export function parseDay(value) {
 if(typeof value!=='string'||!iso.test(value)) throw Object.assign(new Error('Enter a valid YYYY-MM-DD date'),{status:400});
 const d=new Date(value+'T00:00:00.000Z');
 if(!Number.isFinite(d.getTime())||d.toISOString().slice(0,10)!==value)
  throw Object.assign(new Error('Invalid calendar date'),{status:400});
 return d;
}
export function expiryFrom(start,kind,value) {
 if(kind==='none') return null;
 const day=parseDay(start);
 if(kind==='days') day.setUTCDate(day.getUTCDate()+value);
 else if(kind==='months') {
  const dom=day.getUTCDate();
  day.setUTCDate(1);
  day.setUTCMonth(day.getUTCMonth()+value);
  const last=new Date(Date.UTC(day.getUTCFullYear(),day.getUTCMonth()+1,0)).getUTCDate();
  day.setUTCDate(Math.min(dom,last));
 } else throw Object.assign(new Error('Invalid service duration'),{status:400});
 return day.toISOString().slice(0,10);
}
function bad(message,status=400){return Object.assign(new Error(message),{status});}
function isText(v,min,max){return typeof v==='string'&&v.trim().length>=min&&v.trim().length<=max;}
function day(v){parseDay(v);return v;}
const expiryMode=['plan','custom','none'];
function expiryFor(plan,start,body) {
 const mode=body.expiry_mode??'plan';
 if(!expiryMode.includes(mode)) throw bad('Invalid expiry option');
 if(mode==='none') return null;
 if(mode==='custom'){
  const expires=day(body.expires_on);
  if(expires<start) throw bad('Expiry cannot precede the start date');
  return expires;
 }
 const kind=plan.duration_kind;
 return expiryFrom(start,kind,Number(plan.duration_value));
}
export function registerServiceRoutes(app,{data,permit,audit,ident}) {
 const restricted=permit('owner','manager');
 const lookup=permit('owner','manager','cashier');
 app.get('/api/shop/service-plans',lookup,data(async(db,req)=>
   rows(db,`SELECT p.*,c.price_cents,c.active AS product_active
     FROM service_plans p JOIN products c ON c.tenant_id=p.tenant_id AND c.id=p.product_id
     WHERE p.tenant_id=$1 ORDER BY p.name,p.id`,[req.tenant])));
 app.post('/api/shop/service-plans',restricted,data(async(db,req)=>{
  const {product_id=null,name,description='',duration_kind='none',duration_value=null,
   price_cents=null,sell_through_pos=false}=req.body;
  if((product_id!==null&&!ident(product_id))||!isText(name,1,160)||
     !isText(description,0,2000)||typeof sell_through_pos!=='boolean'||
     !['none','days','months'].includes(duration_kind)||
     (duration_kind==='none'?duration_value!==null:
      !Number.isInteger(duration_value)||duration_value<1||
       duration_value>(duration_kind==='months'?120:3650))||
     (price_cents!==null&&(!Number.isInteger(price_cents)||price_cents<=0||price_cents>100000000))||
     (!product_id&&price_cents===null))
    throw bad('Invalid membership plan or price');
  let product;
  if(product_id){
    product=await one(db,'SELECT * FROM products WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
      [req.tenant,product_id]);
    if(!product||!['service','membership'].includes(product.product_type))
     throw bad('Choose an existing service product');
    if(product.stock_item_id)throw bad('A membership cannot consume physical stock');
    const configured=await one(db,`SELECT
      EXISTS (SELECT 1 FROM recipes WHERE tenant_id=$1 AND product_id=$2)
      OR EXISTS (SELECT 1 FROM variations WHERE tenant_id=$1 AND product_id=$2)
      AS has_options`,[req.tenant,product_id]);
    if(configured?.has_options)throw bad('Remove service recipes and variations before converting it to a membership',409);
    const existingPlan=await one(db,'SELECT id FROM service_plans WHERE tenant_id=$1 AND product_id=$2',
      [req.tenant,product_id]);
    if(existingPlan)throw bad('This product already has a service plan',409);
    // An existing one-time service can be converted only when creating its explicit plan.
    product=await one(db,`UPDATE products SET product_type='membership',
      product_class='membership_plan',track_inventory=false,price_cents=$3
      WHERE tenant_id=$1 AND id=$2 RETURNING *`,
      [req.tenant,product_id,price_cents??product.price_cents]);
  }else{
    const sku='MEM-'+randomUUID().replace(/-/g,'').slice(0,12).toUpperCase();
    product=await one(db,`INSERT INTO products
     (tenant_id,name,description,price_cents,cost_cents,product_type,product_class,track_inventory,sku)
     VALUES($1,$2,$3,$4,0,'membership','membership_plan',false,$5) RETURNING *`,
     [req.tenant,name.trim(),description.trim(),price_cents,sku]);
  }
  const plan=await one(db,`INSERT INTO service_plans
    (tenant_id,product_id,name,description,duration_kind,duration_value,sell_through_pos)
    VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [req.tenant,product.id,name.trim(),description.trim(),duration_kind,duration_value,sell_through_pos]);
  await audit(db,req,'service_plan.created',{id:plan.id,product_id:product.id,sell_through_pos});
  return plan;
 }));
 app.put('/api/shop/service-plans/:id',restricted,data(async(db,req)=>{
  if(!ident(req.params.id))throw bad('Invalid service plan');
  const prior=await one(db,'SELECT * FROM service_plans WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
      [req.tenant,req.params.id]);
  if(!prior)throw bad('Service plan not found',404);
  const {name=prior.name,description=prior.description,duration_kind=prior.duration_kind,
   duration_value=prior.duration_value,active=prior.active,
   sell_through_pos=prior.sell_through_pos,price_cents=null}=req.body;
  if(!isText(name,1,160)||!isText(description,0,2000)||
     typeof active!=='boolean'||typeof sell_through_pos!=='boolean'||
     (price_cents!==null&&(!Number.isInteger(price_cents)||price_cents<=0||price_cents>100000000))||
     !['none','days','months'].includes(duration_kind)||
     (duration_kind==='none'?duration_value!==null:
      !Number.isInteger(duration_value)||duration_value<1||
       duration_value>(duration_kind==='months'?120:3650)))throw bad('Invalid service plan');
  const updated=await one(db,`UPDATE service_plans SET name=$3,description=$4,
   duration_kind=$5,duration_value=$6,active=$7,sell_through_pos=$8,updated_at=now()
   WHERE tenant_id=$1 AND id=$2 RETURNING *`,
   [req.tenant,prior.id,name.trim(),description.trim(),duration_kind,duration_value,active,sell_through_pos]);
  await db.query(`UPDATE products SET name=$3,description=$4,
   price_cents=COALESCE($5::integer,price_cents)
   WHERE tenant_id=$1 AND id=$2`,
   [req.tenant,prior.product_id,name.trim(),description.trim(),price_cents]);
  await audit(db,req,'service_plan.updated',{id:prior.id,sell_through_pos});
  return updated;
 }));
 app.get('/api/shop/service-customers',lookup,data(async(db,req)=>
  req.role==='cashier'
   ? rows(db,'SELECT id,name,reference FROM service_customers WHERE tenant_id=$1 ORDER BY name,id LIMIT 1000',[req.tenant])
   : rows(db,'SELECT * FROM service_customers WHERE tenant_id=$1 ORDER BY name,id LIMIT 1000',[req.tenant])));
 app.post('/api/shop/service-customers',permit('owner','manager','cashier'),data(async(db,req)=>{
  const {name,email=null,phone=null,reference=null,notes=''}=req.body;
  if(!isText(name,1,160)||!isText(notes,0,1000)||
   (email!==null&&(!isText(email,1,254)||!/^\S+@\S+\.\S+$/.test(email.trim())))||
   (phone!==null&&!isText(phone,1,40))||
   (reference!==null&&!isText(reference,1,80))) throw bad('Invalid customer information');
  try{
   const customer=await one(db,`INSERT INTO service_customers
    (tenant_id,name,email,phone,reference,notes) VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,
    [req.tenant,name.trim(),email?.trim()||null,phone?.trim()||null,reference?.trim()||null,notes.trim()]);
   await audit(db,req,'service_customer.created',{id:customer.id});
   return customer;
  }catch(e){if(e.code==='23505')throw bad('Customer reference already exists',409);throw e;}
 }));
 app.put('/api/shop/service-customers/:id',restricted,data(async(db,req)=>{
  if(!ident(req.params.id))throw bad('Invalid customer');
  const old=await one(db,'SELECT * FROM service_customers WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
    [req.tenant,req.params.id]);
  if(!old)throw bad('Customer not found',404);
  const {name=old.name,email=old.email,phone=old.phone,reference=old.reference,notes=old.notes}=req.body;
  if(!isText(name,1,160)||!isText(notes,0,1000)||
   (email!==null&&(!isText(email,1,254)||!/^\S+@\S+\.\S+$/.test(email.trim())))||
   (phone!==null&&!isText(phone,1,40))||
   (reference!==null&&!isText(reference,1,80)))throw bad('Invalid customer information');
  try{
   const updated=await one(db,`UPDATE service_customers
    SET name=$3,email=$4,phone=$5,reference=$6,notes=$7,updated_at=now()
    WHERE tenant_id=$1 AND id=$2 RETURNING *`,
    [req.tenant,old.id,name.trim(),email?.trim()||null,phone?.trim()||null,reference?.trim()||null,notes.trim()]);
   await audit(db,req,'service_customer.updated',{id:old.id});
   return updated;
  }catch(e){if(e.code==='23505')throw bad('Customer reference already exists',409);throw e;}
 }));
 app.get('/api/shop/service-entitlements',lookup,data(async(db,req)=>{
  const result=await rows(db,`SELECT e.*,c.name AS customer_name,p.name AS plan_name,
    b.name AS branch_name,CASE WHEN e.status='cancelled' THEN 'cancelled'
     WHEN e.expires_on IS NOT NULL AND e.expires_on<CURRENT_DATE THEN 'expired'
     ELSE 'active' END AS effective_status
    FROM service_entitlements e
    JOIN service_customers c ON c.id=e.customer_id AND c.tenant_id=e.tenant_id
    JOIN service_plans p ON p.id=e.plan_id AND p.tenant_id=e.tenant_id
    JOIN branches b ON b.id=e.branch_id AND b.tenant_id=e.tenant_id
    WHERE e.tenant_id=$1 ORDER BY e.created_at DESC,e.id DESC LIMIT 1000`,[req.tenant]);
  return req.role==='cashier'?result.map(e=>({
   id:e.id,customer_id:e.customer_id,plan_id:e.plan_id,branch_id:e.branch_id,
   customer_name:e.customer_name,plan_name:e.plan_name,branch_name:e.branch_name,
   starts_on:e.starts_on,expires_on:e.expires_on,status:e.status,
   effective_status:e.effective_status
  })):result;
 }));
 app.get('/api/shop/service-entitlements/:id/events',lookup,data(async(db,req)=>{
  if(!ident(req.params.id))throw bad('Invalid membership');
  const membership=await one(db,'SELECT id FROM service_entitlements WHERE tenant_id=$1 AND id=$2',
   [req.tenant,req.params.id]);
  if(!membership)throw bad('Membership not found',404);
  if(req.role==='cashier')return rows(db,`SELECT event_kind,starts_on,expires_on,created_at,source_order_id
   FROM service_entitlement_events WHERE tenant_id=$1 AND entitlement_id=$2
   ORDER BY created_at,id`,[req.tenant,req.params.id]);
  return rows(db,`SELECT v.*,u.name AS actor_name FROM service_entitlement_events v
   JOIN users u ON u.id=v.actor_id WHERE v.tenant_id=$1 AND v.entitlement_id=$2
   ORDER BY v.created_at,v.id`,[req.tenant,req.params.id]);
 }));
 app.post('/api/shop/service-entitlements',restricted,data(async(db,req)=>{
  const {customer_id,plan_id,branch_id,start_on,expiry_mode='plan',reason}=req.body;
  if(!ident(customer_id)||!ident(plan_id)||!ident(branch_id)||!isText(reason,5,500))
   throw bad('Choose customer, service, branch and explain the manual grant');
  const start=day(start_on);
  const plan=await one(db,'SELECT * FROM service_plans WHERE tenant_id=$1 AND id=$2 AND active=true',
   [req.tenant,plan_id]);
  if(!plan)throw bad('Service plan unavailable',404);
  const customer=await one(db,'SELECT id FROM service_customers WHERE tenant_id=$1 AND id=$2',[req.tenant,customer_id]);
  if(!customer)throw bad('Customer unavailable',404);
  const branch=await one(db,'SELECT id FROM branches WHERE tenant_id=$1 AND id=$2 AND active=true',[req.tenant,branch_id]);
  if(!branch)throw bad('Branch unavailable',404);
  const expiry=expiryFor(plan,start,{...req.body,expiry_mode});
  const membership=await one(db,`INSERT INTO service_entitlements
   (tenant_id,branch_id,customer_id,plan_id,starts_on,expires_on,granted_by)
   VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
   [req.tenant,branch_id,customer_id,plan_id,start,expiry,req.user.id]);
  await db.query(`INSERT INTO service_entitlement_events
   (tenant_id,branch_id,entitlement_id,actor_id,event_kind,starts_on,expires_on,reason)
   VALUES($1,$2,$3,$4,'grant',$5,$6,$7)`,
   [req.tenant,branch_id,membership.id,req.user.id,start,expiry,reason.trim()]);
  await audit(db,req,'service_entitlement.manual_grant',{id:membership.id,customer_id,plan_id,expiry});
  return membership;
 }));
 app.post('/api/shop/service-entitlements/:id/renew',restricted,data(async(db,req)=>{
  if(!ident(req.params.id)||!isText(req.body.reason,5,500))throw bad('Invalid renewal reason');
  const membership=await one(db,'SELECT * FROM service_entitlements WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
   [req.tenant,req.params.id]);
  if(!membership)throw bad('Membership unavailable',404);
  if(membership.status!=='active')throw bad('Cancelled memberships cannot be renewed',409);
  const plan=await one(db,'SELECT * FROM service_plans WHERE tenant_id=$1 AND id=$2',[req.tenant,membership.plan_id]);
  const previous=membership.expires_on ? new Date(membership.expires_on).toISOString().slice(0,10) : null;
  const start=day(req.body.start_on);
  // The caller chooses the renewal effective date. Never silently extend a cancelled grant.
  if(start<new Date(membership.starts_on).toISOString().slice(0,10))throw bad('Renewal cannot start before membership');
  const expiry=expiryFor(plan,start,req.body);
  const updated=await one(db,`UPDATE service_entitlements
   SET expires_on=$3,updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING *`,
   [req.tenant,membership.id,expiry]);
  await db.query(`INSERT INTO service_entitlement_events
   (tenant_id,branch_id,entitlement_id,actor_id,event_kind,previous_expires_on,starts_on,expires_on,reason)
   VALUES($1,$2,$3,$4,'renew',$5,$6,$7,$8)`,
   [req.tenant,membership.branch_id,membership.id,req.user.id,previous,start,expiry,req.body.reason.trim()]);
  await audit(db,req,'service_entitlement.renewed',{id:membership.id,previous,expiry});
  return updated;
 }));
 app.post('/api/shop/service-entitlements/:id/cancel',restricted,data(async(db,req)=>{
  if(!ident(req.params.id)||!isText(req.body.reason,5,500))throw bad('Invalid cancellation reason');
  const membership=await one(db,'SELECT * FROM service_entitlements WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
   [req.tenant,req.params.id]);
  if(!membership)throw bad('Membership unavailable',404);
  if(membership.status!=='active')throw bad('Membership is already cancelled',409);
  const updated=await one(db,"UPDATE service_entitlements SET status='cancelled',updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING *",
   [req.tenant,membership.id]);
  await db.query(`INSERT INTO service_entitlement_events
   (tenant_id,branch_id,entitlement_id,actor_id,event_kind,previous_expires_on,starts_on,expires_on,reason)
   VALUES($1,$2,$3,$4,'cancel',$5,$6,$7,$8)`,
   [req.tenant,membership.branch_id,membership.id,req.user.id,membership.expires_on,membership.starts_on,membership.expires_on,req.body.reason.trim()]);
  await audit(db,req,'service_entitlement.cancelled',{id:membership.id});
  return updated;
 }));
}
