import { randomBytes,createHash } from 'node:crypto';
import rateLimit from 'express-rate-limit';
import { one, rows, pool, scoped } from './db.js';

const hash=value=>createHash('sha256').update(value).digest('hex');
const validToken=value=>typeof value==='string' && /^[a-f0-9]{64}$/.test(value);
const validCurrency=n=>Number.isSafeInteger(n)&&n>=0&&n<=100000000;
const validId=x=>/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(x||'');
const problems=(code,msg)=>Object.assign(new Error(msg),{status:code});
const publicMenuLimit=async(token)=>{
 if(!validToken(token))throw problems(404,'Menu not available');
 // Lookup token only; public visitors never receive tenant records, private source IDs or RLS privileges.
 const row=await one(pool,`SELECT l.tenant_id,l.branch_id,l.table_id,t.label AS table_label,
 b.name AS branch_name,s.customer_menu_enabled AS enabled
 FROM public_menu_links l
 JOIN branches b ON b.tenant_id=l.tenant_id AND b.id=l.branch_id
 JOIN tables t ON t.tenant_id=l.tenant_id AND t.id=l.table_id AND t.branch_id=l.branch_id
 JOIN shop_settings s ON s.tenant_id=l.tenant_id
 WHERE l.token_hash=$1 AND l.active=true AND l.revoked_at IS NULL AND b.active=true`,[hash(token)]);
 if(!row||!row.enabled)throw problems(404,'Menu not available');
 return row;
};
function cleanCart(items) {
 if(!Array.isArray(items)||!items.length||items.length>50)throw problems(400,'Select a valid cart');
 return items.map(item=>{
  if(!validId(item?.product_id)||!Number.isInteger(item.quantity)||item.quantity<1||item.quantity>100||
   item.variation_id!=null&&!validId(item.variation_id)||item.addon_ids!=null&&
   (!Array.isArray(item.addon_ids)||item.addon_ids.length>30||
    item.addon_ids.some(id=>!validId(id))||new Set(item.addon_ids).size!==item.addon_ids.length))
   throw problems(400,'Invalid cart item');
  return {product_id:item.product_id,variation_id:item.variation_id||null,
   addon_ids:[...(item.addon_ids||[])].sort(),quantity:item.quantity};
 });
}
async function liveTotal(db,tenant,cart) {
 const settings=await one(db,'SELECT tax_basis_points,service_basis_points FROM shop_settings WHERE tenant_id=$1',[tenant]);
 let subtotal=0;
 for(const item of cart){
  const product=await one(db,'SELECT id,price_cents FROM products WHERE tenant_id=$1 AND id=$2 AND active=true AND product_class=\'food_beverage\'',
   [tenant,item.product_id]);
  if(!product)throw problems(409,'Product no longer available');
  let price=Number(product.price_cents);
  if(item.variation_id){
   const variant=await one(db,'SELECT price_cents,price_delta_cents FROM variations WHERE tenant_id=$1 AND id=$2 AND product_id=$3',
    [tenant,item.variation_id,item.product_id]);
   if(!variant)throw problems(409,'Variation unavailable');
   price=Number(variant.price_cents??price+variant.price_delta_cents);
  }
  for(const id of item.addon_ids){
    const addon=await one(db,'SELECT price_cents FROM addons WHERE tenant_id=$1 AND id=$2 AND active=true',[tenant,id]);
    if(!addon)throw problems(409,'Add-on unavailable');
    price+=Number(addon.price_cents);
  }
  subtotal+=price*item.quantity;
  if(!validCurrency(subtotal))throw problems(400,'Cart amount is too large');
 }
 return subtotal+Math.round(subtotal*settings.tax_basis_points/10000)+
    Math.round(subtotal*settings.service_basis_points/10000);
}

export function registerCustomerMenuRoutes(app,{wrap,data,permit,need,fail,audit,ident}) {
 const publicMenuReadLimit=rateLimit({windowMs:60*1000,limit:90,standardHeaders:'draft-7',legacyHeaders:false});
 const publicMenuOrderLimit=rateLimit({windowMs:60*1000,limit:12,standardHeaders:'draft-7',legacyHeaders:false});
 app.get('/api/public/menu/:token',publicMenuReadLimit,wrap(async(req,res)=>{
  const link=await publicMenuLimit(req.params.token);
  const menu=await scoped(link.tenant_id,async(db)=>{
   const products=await rows(db,`SELECT p.id,p.name,p.description,p.image_url,p.price_cents,
     p.product_type,c.name AS category,
     COALESCE((SELECT jsonb_agg(jsonb_build_object('id',v.id,'name',v.name,
       'price_cents',COALESCE(v.price_cents,p.price_cents+v.price_delta_cents)) ORDER BY v.name)
       FROM variations v WHERE v.tenant_id=p.tenant_id AND v.product_id=p.id),'[]'::jsonb) AS variations
     FROM products p LEFT JOIN categories c ON c.tenant_id=p.tenant_id AND c.id=p.category_id
     WHERE p.tenant_id=$1 AND p.active=true AND p.product_class='food_beverage' ORDER BY p.name LIMIT 500`,[link.tenant_id]);
   const addons=await rows(db,'SELECT id,name,price_cents FROM addons WHERE tenant_id=$1 AND active=true ORDER BY name LIMIT 100',
    [link.tenant_id]);
   return {products,addons};
  },{branchIds:[link.branch_id]});
  res.set('Cache-Control','no-store');
  res.json({branch:link.branch_name,table:link.table_label,products:menu.products,addons:menu.addons,
   checkout_enabled:true,payment_notice:'Orders are submitted only after cashier-confirmed payment.'});
 }));
 app.post('/api/public/menu/:token/requests',publicMenuOrderLimit,wrap(async(req,res)=>{
  const link=await publicMenuLimit(req.params.token);
  const cart=cleanCart(req.body?.items);
  const requestId=req.body?.request_id;
  if(!validId(requestId))throw problems(400,'Invalid request ID');
  const method=req.body?.payment_method;
  if(!['cash','gcash','maya','card'].includes(method))throw problems(400,'Choose a payment method');
  const fingerprint=hash(JSON.stringify({cart,method,table:link.table_id}));
  const result=await scoped(link.tenant_id,async(db)=>{
   const existing=await one(db,
     'SELECT * FROM customer_order_requests WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
     [link.tenant_id,requestId]);
   if(existing){
     if(existing.request_fingerprint!==fingerprint||existing.table_id!==link.table_id)
      throw problems(409,'Request ID already used for a different cart');
     return existing;
   }
   const quote=await liveTotal(db,link.tenant_id,cart);
   return one(db,`INSERT INTO customer_order_requests
     (id,tenant_id,branch_id,table_id,cart,request_fingerprint,payment_method,quoted_total_cents)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
     [requestId,link.tenant_id,link.branch_id,link.table_id,JSON.stringify(cart),fingerprint,method,quote]);
  },{branchIds:[link.branch_id]});
  res.status(202).set('Cache-Control','no-store').json({
   request_id:result.id,status:result.status,total_cents:result.quoted_total_cents,
   message:'Awaiting verified payment and cashier confirmation. This is not a submitted kitchen order.'
  });
 }));
 app.get('/api/public/menu/:token/requests/:id',wrap(async(req,res)=>{
  const link=await publicMenuLimit(req.params.token);
  if(!validId(req.params.id))throw problems(404,'Request not found');
  const result=await scoped(link.tenant_id,db=>one(db,
    'SELECT id,status,quoted_total_cents FROM customer_order_requests WHERE tenant_id=$1 AND branch_id=$2 AND table_id=$3 AND id=$4',
    [link.tenant_id,link.branch_id,link.table_id,req.params.id]),{branchIds:[link.branch_id]});
  if(!result)throw problems(404,'Request not found');
  res.set('Cache-Control','no-store').json(result);
 }));
 app.get('/api/shop/menu/links',permit('owner','manager'),data(async(db,req)=>{
  return rows(db,`SELECT l.table_id,l.branch_id,l.active,l.created_at,t.label AS table_label,
   b.name AS branch_name FROM public_menu_links l
   JOIN tables t ON t.tenant_id=l.tenant_id AND t.id=l.table_id
   JOIN branches b ON b.tenant_id=l.tenant_id AND b.id=l.branch_id
   WHERE l.tenant_id=$1 ORDER BY b.name,t.label`,[req.tenant]);
 }));
 app.post('/api/shop/menu/links/:tableId/rotate',permit('owner','manager'),data(async(db,req)=>{
  if(!ident(req.params.tableId))throw fail(400,'Invalid table');
  const table=await one(db,`SELECT t.id,t.branch_id FROM tables t
   JOIN branches b ON b.tenant_id=t.tenant_id AND b.id=t.branch_id
   WHERE t.tenant_id=$1 AND t.id=$2 AND b.active=true`,[req.tenant,req.params.tableId]);
  if(!table)throw fail(404,'Table unavailable');
  const token=randomBytes(32).toString('hex');
  await db.query(`INSERT INTO public_menu_links(tenant_id,branch_id,table_id,token_hash)
   VALUES($1,$2,$3,$4) ON CONFLICT(tenant_id,table_id) DO UPDATE SET
   token_hash=excluded.token_hash,branch_id=excluded.branch_id,active=true,revoked_at=NULL`,
   [req.tenant,table.branch_id,table.id,hash(token)]);
  await audit(db,req,'menu.qr_rotated',{table_id:table.id});
  return {table_id:table.id,token};
 }));
 app.post('/api/shop/menu/links/:tableId/revoke',permit('owner','manager'),data(async(db,req)=>{
  if(!ident(req.params.tableId))throw fail(400,'Invalid table');
  const row=await one(db,`UPDATE public_menu_links
   SET active=false,revoked_at=now()
   WHERE tenant_id=$1 AND table_id=$2 RETURNING table_id`,[req.tenant,req.params.tableId]);
  if(!row)throw fail(404,'Menu link unavailable');
  await audit(db,req,'menu.qr_revoked',{table_id:row.table_id});
  return {ok:true};
 }));
 app.put('/api/shop/menu/policy',permit('owner'),data(async(db,req)=>{
  need(typeof req.body?.enabled==='boolean','Invalid menu policy');
  const row=await one(db,'UPDATE shop_settings SET customer_menu_enabled=$2 WHERE tenant_id=$1 RETURNING customer_menu_enabled',
   [req.tenant,req.body.enabled]);
  await audit(db,req,'menu.policy_updated',{enabled:req.body.enabled});
  return row;
 }));
 app.get('/api/shop/menu/requests',permit('owner','manager','cashier','staff'),data(async(db,req)=>{
  const branch=req.query.branch_id||null;
  if(branch&&!ident(branch))throw fail(400,'Invalid branch');
  return rows(db,`SELECT q.id,q.branch_id,q.table_id,q.cart,q.status,q.payment_method,
   q.payment_reference,q.quoted_total_cents,q.created_at,t.label AS table_label
   FROM customer_order_requests q JOIN tables t ON t.tenant_id=q.tenant_id AND t.id=q.table_id
   WHERE q.tenant_id=$1 AND ($2::uuid IS NULL OR q.branch_id=$2) AND q.status<>'cancelled'
   ORDER BY q.created_at DESC LIMIT 100`,[req.tenant,branch]);
 }));
 app.post('/api/shop/menu/requests/:id/payment-review',permit('owner','manager','cashier','staff'),data(async(db,req)=>{
  if(!ident(req.params.id))throw fail(400,'Invalid request');
  const paymentReference=String(req.body?.reference||'').trim();
  if(!paymentReference||paymentReference.length>120)throw fail(400,'Enter a payment reference');
  const order=await one(db,`SELECT * FROM customer_order_requests
     WHERE tenant_id=$1 AND id=$2 FOR UPDATE`,[req.tenant,req.params.id]);
  if(!order)throw fail(404,'Request unavailable');
  if(order.status!=='awaiting_payment')throw fail(409,'Request has already been reviewed');
  const result=await one(db,`UPDATE customer_order_requests
    SET status='payment_review',payment_reference=$3,updated_at=now()
    WHERE tenant_id=$1 AND id=$2 RETURNING id,status`,[req.tenant,order.id,paymentReference]);
  await audit(db,req,'customer_order.payment_review',{request_id:order.id});
  return result;
 }));
 app.post('/api/shop/menu/requests/:id/cancel',permit('owner','manager','cashier','staff'),data(async(db,req)=>{
  if(!ident(req.params.id))throw fail(400,'Invalid request');
  const q=await one(db,'SELECT * FROM customer_order_requests WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
   [req.tenant,req.params.id]);
  if(!q)throw fail(404,'Request unavailable');
  if(q.status==='confirmed')throw fail(409,'Confirmed orders cannot be cancelled');
  if(q.status==='cancelled')return q;
  const row=await one(db,`UPDATE customer_order_requests SET status='cancelled',updated_at=now()
   WHERE tenant_id=$1 AND id=$2 RETURNING id,status`,[req.tenant,q.id]);
  await audit(db,req,'customer_order.cancelled',{request_id:q.id});
  return row;
 }));
}
