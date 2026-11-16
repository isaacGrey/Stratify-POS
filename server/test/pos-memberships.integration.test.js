import assert from 'node:assert/strict';
import {test} from 'node:test';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {expiryFrom} from '../src/service-routes.js';

const database=process.env.STRATIFYPOS_TEST_DATABASE_URL;
test('multi-industry sales, cashier reception lookup and atomic POS membership lifecycle',{
 skip:!database&&'Requires disposable migrated PostgreSQL database',
 timeout:180000
},async t=>{
 const nonce=randomUUID();
 const child=spawn(process.execPath,['src/index.js'],{
  cwd:process.cwd(),
  env:{...process.env,DATABASE_URL:database,PORT:'0',JWT_SECRET:randomUUID(),
   REPORT_TIME_ZONE:'Asia/Manila'},
  stdio:['ignore','pipe','inherit']
 });
 t.after(()=>child.kill());
 const base=await new Promise((resolve,reject)=>{
  child.once('error',reject);child.once('exit',code=>reject(new Error('API exited '+code)));
  let output='';child.stdout.on('data',buf=>{
   output+=buf;const m=output.match(/http:\/\/localhost:\d+/);
   if(m)resolve(m[0]);
  });
 });
 async function request(path,status,{method='GET',body,account,tenant}={}){
  const response=await fetch(base+'/api/'+path,{
   method,signal:AbortSignal.timeout(12000),
   headers:{'Content-Type':'application/json',
    ...(account?{Authorization:'Bearer '+account.token}:{}),
    ...(account?.shop?.id||tenant?{'X-Tenant-Id':tenant||account.shop.id}:{})},
   body:body===undefined?undefined:JSON.stringify(body)
  });
  const json=await response.json();
  assert.equal(response.status,status,method+' '+path+' -> '+JSON.stringify(json).slice(0,450));
  return json;
 }
 const post=(p,s,b,a)=>request(p,s,{method:'POST',body:b,account:a});
 const put=(p,s,b,a)=>request(p,s,{method:'PUT',body:b,account:a});
 const register=tag=>post('auth/register',201,{
  email:tag+'-'+nonce+'@example.invalid',password:'pw-'+nonce,
  name:tag+' owner',shopName:tag+' '+nonce
 });
 const owner=await register('member-owner');
 const stranger=await register('member-stranger');
 const [branch]=await request('shop/branches',200,{account:owner});
 const [otherBranch]=await request('shop/branches',200,{account:stranger});
 const cashierMail='pos-cashier-'+nonce+'@example.invalid';
 await post('shop/staff',200,{name:'Reception cashier',email:cashierMail,password:'pw-'+nonce,role:'cashier'},owner);
 const cashier=await post('auth/login',200,{email:cashierMail,password:'pw-'+nonce});
 cashier.shop=owner.shop;
 const registerSession=await post('shop/register/open',200,{branch_id:branch.id,opening_cents:300000},cashier);

 // Type and class are independent: services and memberships never consume physical stock.
 const food=await post('shop/products',200,{
  name:'Club sandwich',product_type:'physical',product_class:'food_beverage',
  track_inventory:true,price_cents:11000
 },owner);
 const retail=await post('shop/products',200,{
  name:'Brake pads',product_type:'physical',product_class:'general_merchandise',
  track_inventory:false,price_cents:8000
 },owner);
 const service=await post('shop/products',200,{
  name:'Haircut',product_type:'service',product_class:'general_service',
  track_inventory:false,price_cents:9000
 },owner);
 await post('shop/products',400,{
  name:'Bad class',product_type:'service',product_class:'general_merchandise',
  track_inventory:false,price_cents:1000
 },owner);
 await post('shop/products',400,{
  name:'Not a valid direct membership',product_type:'membership',product_class:'membership_plan',
  track_inventory:false,price_cents:1000
 },owner);
 await post('shop/products',400,{
  name:'Stock service',product_type:'service',product_class:'general_service',
  track_inventory:true,price_cents:1000
 },owner);
 const configuredService=await post('shop/products',200,{
  name:'Configured treatment',product_type:'service',product_class:'general_service',
  track_inventory:false,price_cents:12000,variations:[{name:'Extended',price_cents:16000}]
 },owner);
 await post('shop/service-plans',409,{
  product_id:configuredService.id,name:'Unsafe conversion',duration_kind:'months',
  duration_value:1,sell_through_pos:true
 },owner);
 const configuredAfter=(await request('shop/products',200,{account:owner}))
  .find(p=>p.id===configuredService.id);
 assert.equal(configuredAfter.product_type,'service','Rejected plan conversion must not alter the product');
 const stockComponent=await post('shop/ingredients',200,{
  name:'Membership test consumable',unit:'g',quantity:10,unit_cost_cents:20
 },owner);
 const recipeItem=await post('shop/products',200,{
  name:'Prepared testing item',product_type:'physical',product_class:'food_beverage',
  track_inventory:true,price_cents:1500,
  recipe:[{ingredient_id:stockComponent.id,quantity:1}]
 },owner);
 const recipeItemBase={name:'Prepared testing item',product_type:'physical',
  product_class:'food_beverage',price_cents:1500,track_inventory:false};
 await put('shop/products/'+recipeItem.id,409,recipeItemBase,owner);
 await put('shop/products/'+recipeItem.id,200,{...recipeItemBase,recipe:[]},owner);
 const all=await request('shop/products',200,{account:owner});
 assert.equal(all.find(p=>p.id===food.id).product_class,'food_beverage');
 assert.equal(all.find(p=>p.id===retail.id).product_class,'general_merchandise');
 assert.equal(all.find(p=>p.id===service.id).product_type,'service');

 const customer=await post('shop/service-customers',200,{
  name:'Jane Member',email:'jane@example.invalid',reference:'JAN-'+nonce.slice(0,8),
  notes:'Restricted administrative note'
 },owner);
 const newCustomer=await post('shop/service-customers',200,{
  name:'New reception member',email:null,reference:null,notes:''
 },cashier);
 assert.ok(newCustomer.id);
 const customerRows=await request('shop/service-customers',200,{account:cashier});
 const safe=customerRows.find(c=>c.id===customer.id);
 assert.equal(safe.name,'Jane Member');
 assert.equal(safe.email,undefined,'Cashiers must not receive customer email');
 assert.equal(safe.notes,undefined,'Cashiers must not receive administrative notes');
 const foreignCustomer=await post('shop/service-customers',200,{name:'External member'},stranger);
 await request('shop/service-customers',403,{account:cashier,tenant:stranger.shop.id});

 // Creating a plan generates its product automatically, and the manager controls POS visibility.
 const gym=await post('shop/service-plans',200,{
  name:'Gym Monthly',description:'Monthly access',price_cents:150000,
  duration_kind:'months',duration_value:1,sell_through_pos:true
 },owner);
 assert.equal(gym.sell_through_pos,true);
 const gymItem=(await request('shop/products',200,{account:owner})).find(p=>p.id===gym.product_id);
 assert.equal(gymItem.product_type,'membership');
 assert.equal(gymItem.product_class,'membership_plan');
 assert.equal(gymItem.track_inventory,false);
 assert.equal(gymItem.sell_through_pos,true);
 assert.equal(Number(gymItem.price_cents),150000);
 const visible=(await request('shop/products',200,{account:cashier})).find(p=>p.id===gymItem.id);
 assert.equal(visible.sell_through_pos,true);
 await request('shop/service-plans',200,{account:cashier});
 await post('shop/service-plans',403,{
  name:'Cashier must not create',price_cents:500,duration_kind:'none'
 },cashier);
 await put('shop/service-plans/'+gym.id,403,{sell_through_pos:false},cashier);
 await post('shop/service-entitlements',403,{
  customer_id:customer.id,plan_id:gym.id,branch_id:branch.id,
  start_on:'2026-11-16',reason:'Unapproved free grant'
 },cashier);
 await put('shop/service-customers/'+customer.id,403,{name:'Changed'},cashier);

 const baseCart={branch_id:branch.id,payment_method:'cash',register_session_id:registerSession.id,
  amount_tendered_cents:250000};
 const checkout=(id,lines,more={})=>({...baseCart,client_sale_id:id,
  items:lines.map(([product_id,quantity])=>({product_id,quantity})),...more});
 const retailSale=await post('shop/checkout',200,checkout(randomUUID(),[[retail.id,1]],{
  order_type:'standard',amount_tendered_cents:20000
 }),cashier);
 assert.equal(retailSale.order_type,'standard');
 assert.equal((await request('shop/kitchen',200,{account:cashier})).length,0);
 await post('shop/checkout',400,checkout(randomUUID(),[[retail.id,1]],{order_type:'takeout'}),cashier);
 await post('shop/checkout',400,checkout(randomUUID(),[[food.id,1]],{order_type:'standard'}),cashier);
 const foodSale=await post('shop/checkout',200,checkout(randomUUID(),[[food.id,1]],{order_type:'takeout'}),cashier);
 assert.equal(foodSale.order_type,'takeout');
 let tickets=await request('shop/kitchen',200,{account:cashier});
 assert.equal(tickets.length,1);
 assert.deepEqual(tickets[0].items.map(i=>i.name),['Club sandwich']);

 const membershipItems=[[gymItem.id,1]];
 await post('shop/checkout',400,checkout(randomUUID(),membershipItems,{order_type:'standard'}),cashier);
 await post('shop/checkout',404,checkout(randomUUID(),membershipItems,{
  order_type:'standard',service_customer_id:foreignCustomer.id
 }),cashier);
 await post('shop/checkout',409,checkout(randomUUID(),[[gymItem.id,2]],{
  order_type:'standard',service_customer_id:customer.id
 }),cashier);
 // An owner can disable sales without removing existing customers or plan history.
 await put('shop/service-plans/'+gym.id,200,{
  sell_through_pos:false,price_cents:150000
 },owner);
 await post('shop/checkout',409,checkout(randomUUID(),membershipItems,{
  order_type:'standard',service_customer_id:customer.id
 }),cashier);
 await put('shop/service-plans/'+gym.id,200,{
  sell_through_pos:true,price_cents:150000
 },owner);

 const firstPayload=checkout(randomUUID(),membershipItems,{
  order_type:'standard',service_customer_id:customer.id,amount_tendered_cents:150000
 });
 const first=await post('shop/checkout',200,firstPayload,cashier);
 assert.equal(first.order_type,'standard');
 assert.equal(first.memberships.length,1);
 assert.equal(first.memberships[0].event_kind,'grant');
 assert.equal(first.memberships[0].customer_id,customer.id);
 const repeated=await post('shop/checkout',200,firstPayload,cashier);
 assert.equal(repeated.id,first.id);
 assert.equal(repeated.memberships.length,1);
 const initial=(await request('shop/service-entitlements',200,{account:cashier}))
   .find(e=>e.customer_id===customer.id&&e.plan_id===gym.id);
 assert.ok(initial);
 assert.equal(initial.effective_status,'active');
 const firstDate=new Date(first.created_at).toISOString().slice(0,10);
 const firstExpiry=expiryFrom(firstDate,'months',1);
 assert.equal(String(initial.expires_on).slice(0,10),firstExpiry);
 const historyPath='shop/service-entitlements/'+initial.id+'/events';
 let history=await request(historyPath,200,{account:cashier});
 assert.equal(history.length,1);
 assert.equal(history[0].source_order_id,first.id);
 assert.equal(history[0].reason,undefined,'Cashiers must not receive audit reasons');
 assert.equal((await request(historyPath,200,{account:owner}))[0].source_order_id,first.id);
 await post('shop/service-entitlements/'+initial.id+'/cancel',403,{reason:'Unauthorized cancellation'},cashier);

 // Paid renewal uses the prior expiration date. Retries never double-renew.
 const renewalPayload=checkout(randomUUID(),membershipItems,{
  order_type:'standard',service_customer_id:customer.id,amount_tendered_cents:150000
 });
 const renewal=await post('shop/checkout',200,renewalPayload,cashier);
 assert.equal(renewal.memberships[0].event_kind,'renew');
 const retried=await post('shop/checkout',200,renewalPayload,cashier);
 assert.equal(retried.id,renewal.id);
 history=await request(historyPath,200,{account:owner});
 assert.deepEqual(history.map(e=>e.event_kind),['grant','renew']);
 const renewedRow=(await request('shop/service-entitlements',200,{account:owner}))
   .find(e=>e.id===initial.id);
 assert.equal(String(renewedRow.expires_on).slice(0,10),expiryFrom(firstExpiry,'months',1));
 const initialRetryAfterRenewal=await post('shop/checkout',200,firstPayload,cashier);
 assert.equal(String(initialRetryAfterRenewal.memberships[0].expires_on).slice(0,10),firstExpiry,
  'Idempotent receipt must use its own historical expiry, not a later renewal');

 // Refunding older grant after a renewal, or partially refunding a member sale, fails atomically.
 const refund=(orderId,requestId,amount)=>({
  request_id:requestId,amount_cents:amount,reason:'Member requested cancellation',
  register_session_id:registerSession.id
 });
 await post('shop/orders/'+renewal.id+'/refunds',409,refund(renewal.id,randomUUID(),10000),owner);
 await post('shop/orders/'+first.id+'/refunds',409,refund(first.id,randomUUID(),150000),owner);
 assert.equal((await request('shop/orders/'+first.id+'/refunds',200,{account:owner})).length,0);
 // Refund with cashier register must be authorized by its owner; use cashier's own account only for sales.
 const ownRegister=await post('shop/register/open',200,{branch_id:branch.id,opening_cents:300000},owner);
 const reversalRequest={request_id:randomUUID(),amount_cents:150000,
  reason:'Membership renewal reversed in full',register_session_id:ownRegister.id};
 const reversal=await post('shop/orders/'+renewal.id+'/refunds',200,reversalRequest,owner);
 assert.equal(reversal.status,'refunded');
 assert.equal((await post('shop/orders/'+renewal.id+'/refunds',200,reversalRequest,owner)).id,reversal.id);
 const restored=(await request('shop/service-entitlements',200,{account:owner})).find(e=>e.id===initial.id);
 assert.equal(String(restored.expires_on).slice(0,10),firstExpiry);
 assert.equal(restored.status,'active');
 assert.equal((await request(historyPath,200,{account:owner})).at(-1).event_kind,'reverse');

 const secondPersonSale=await post('shop/checkout',200,checkout(randomUUID(),membershipItems,{
  order_type:'standard',service_customer_id:newCustomer.id,amount_tendered_cents:150000
 }),cashier);
 const granted=(await request('shop/service-entitlements',200,{account:owner}))
  .find(e=>e.customer_id===newCustomer.id&&e.plan_id===gym.id);
 assert.ok(granted);
 await post('shop/orders/'+secondPersonSale.id+'/refunds',200,{
  request_id:randomUUID(),amount_cents:150000,reason:'Unused membership cancelled',
  register_session_id:ownRegister.id
 },owner);
 assert.equal((await request('shop/service-entitlements',200,{account:owner}))
  .find(e=>e.id===granted.id).status,'cancelled');

 // A mixed order sends only food to the kitchen; its other items are not kitchen tasks.
 const mixed=await post('shop/checkout',200,checkout(randomUUID(),[
  [food.id,1],[retail.id,1],[service.id,1],[gymItem.id,1]
 ],{order_type:'takeout',service_customer_id:newCustomer.id}),cashier);
 assert.equal(mixed.memberships.length,1);
 tickets=await request('shop/kitchen',200,{account:cashier});
 const forMixed=tickets.find(ticket=>ticket.order_id===mixed.id);
 assert.deepEqual(forMixed.items.map(i=>i.name),['Club sandwich']);
 assert.ok(!tickets.some(ticket=>ticket.items.some(i=>i.name==='Gym Monthly')));
 // Concurrent paid checkouts are serialized per customer + plan.
 const parallelCustomer=await post('shop/service-customers',200,{name:'Concurrent renewal customer'},owner);
 const concurrentIds=[randomUUID(),randomUUID()];
 const parallel=await Promise.all(concurrentIds.map(id=>
   post('shop/checkout',200,checkout(id,membershipItems,{
     order_type:'standard',service_customer_id:parallelCustomer.id,
     amount_tendered_cents:150000
   }),cashier)));
 assert.equal(new Set(parallel.map(p=>p.id)).size,2,'Distinct paid checkouts each create a sale');
 assert.equal(parallel.every(p=>p.memberships.length===1),true);
 const parallelEntitlements=(await request('shop/service-entitlements',200,{account:owner}))
  .filter(e=>e.customer_id===parallelCustomer.id&&e.plan_id===gym.id);
 assert.equal(parallelEntitlements.length,1,'Concurrent checkouts cannot create two active memberships');
 const parallelEvents=await request('shop/service-entitlements/'+parallelEntitlements[0].id+'/events',
   200,{account:owner});
 assert.deepEqual(parallelEvents.map(e=>e.event_kind),['grant','renew']);
 // Duplicate idempotency keys may also race; neither the sale nor its entitlement should repeat.
 const retryCustomer=await post('shop/service-customers',200,{name:'Retry customer'},owner);
 const retryPayload=checkout(randomUUID(),membershipItems,{
   order_type:'standard',service_customer_id:retryCustomer.id,amount_tendered_cents:150000
 });
 const retriedConcurrent=await Promise.all([0,1].map(()=>
   post('shop/checkout',200,retryPayload,cashier)));
 assert.equal(retriedConcurrent[0].id,retriedConcurrent[1].id);
 const retryMemberships=(await request('shop/service-entitlements',200,{account:owner}))
  .filter(e=>e.customer_id===retryCustomer.id&&e.plan_id===gym.id);
 assert.equal(retryMemberships.length,1);
 assert.equal((await request('shop/service-entitlements/'+retryMemberships[0].id+'/events',
   200,{account:owner})).length,1);
 // Another business cannot access the membership or checkout records.
 await request('shop/service-entitlements',200,{account:stranger});
 await request('shop/service-entitlements/'+initial.id+'/events',404,{account:stranger});
 await post('shop/checkout',400,checkout(randomUUID(),membershipItems,{
  order_type:'standard',branch_id:otherBranch.id,service_customer_id:customer.id
 }),stranger);
});
