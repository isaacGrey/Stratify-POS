import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {test} from 'node:test';
import {pool} from '../src/db.js';

const database=process.env.STRATIFYPOS_TEST_DATABASE_URL;
test('QR checkout remains pending until manager-confirmed payment; KDS and cashier registers isolate tenants', {
 skip:!database && 'Requires isolated migrated test database',
 timeout:120000
},async t=>{
 const nonce=randomUUID();
 const child=spawn(process.execPath,['src/index.js'],{
  env:{...process.env,DATABASE_URL:database,PORT:'0',JWT_SECRET:randomUUID(),REPORT_TIME_ZONE:'Asia/Manila'},
  stdio:['ignore','pipe','inherit']
 });
 t.after(()=>child.kill());
 const api=await new Promise((resolve,reject)=>{
  child.once('error',reject);child.once('exit',n=>reject(new Error('API exited '+n)));
  let output='';
  child.stdout.on('data',part=>{output+=part;const match=output.match(/http:\/\/localhost:\d+/);
   if(match)resolve(match[0]);});
 });
 async function send(path,status,{method='GET',body,account,publicRequest=false}={}){
  const r=await fetch(api+'/api/'+(publicRequest?'public/':'shop/')+path,{
   method,signal:AbortSignal.timeout(10000),
   headers:{'Content-Type':'application/json',
    ...(account?{'Authorization':'Bearer '+account.token,'X-Tenant-Id':account.shop.id}:{})},
   body:body===undefined?undefined:JSON.stringify(body)
  });
  const data=await r.json();
  assert.equal(r.status,status,method+' '+path+' '+JSON.stringify(data).slice(0,450));
  return data;
 }
 async function auth(tag) {
  const res=await fetch(api+'/api/auth/register',{
   method:'POST',headers:{'Content-Type':'application/json'},
   body:JSON.stringify({email:tag+'-'+nonce+'@example.invalid',password:'test-'+nonce,name:tag,shopName:tag+' '+nonce})});
  const data=await res.json();assert.equal(res.status,201,JSON.stringify(data));return data;
 }
 const owner=await auth('qr-owner'),outsider=await auth('qr-outsider');
 const [branch]=await send('branches',200,{account:owner});
 const [otherBranch]=await send('branches',200,{account:outsider});
 const p=await send('products',200,{method:'POST',account:owner,body:{name:'QR Espresso',price_cents:2500}});
 const table=await send('tables',200,{method:'POST',account:owner,body:{
   branch_id:branch.id,label:'A1',seats:2
 }});
 const policy=await send('menu/policy',200,{method:'PUT',account:owner,body:{enabled:true}});
 assert.equal(policy.customer_menu_enabled,true);
 const qr=await send('menu/links/'+table.id+'/rotate',200,{method:'POST',account:owner,body:{}});
 assert.equal(qr.token.length,64);
 const menu=await send('menu/'+qr.token,200,{publicRequest:true});
 assert.equal(menu.table,'A1');
 assert.equal(menu.products.find(x=>x.id===p.id).name,'QR Espresso');
 assert.equal('cost_cents' in menu.products[0],false);
 const sameRequest={
   request_id:randomUUID(),items:[{product_id:p.id,quantity:1}],payment_method:'cash'
 };
 const pending=await send('menu/'+qr.token+'/requests',202,{method:'POST',publicRequest:true,body:sameRequest});
 assert.equal(pending.status,'awaiting_payment');
 assert.equal(Number(pending.total_cents),2500);
 assert.equal((await send('menu/'+qr.token+'/requests',202,{method:'POST',publicRequest:true,body:sameRequest})).request_id,pending.request_id);
 await send('menu/'+qr.token+'/requests',409,{method:'POST',publicRequest:true,body:{
   ...sameRequest,items:[{product_id:p.id,quantity:2}]
 }});
 assert.equal((await send('kitchen',200,{account:owner})).length,0);
 assert.equal((await send('menu/requests',200,{account:owner})).length,1);
 await send('checkout',409,{method:'POST',account:owner,body:{
   branch_id:branch.id,table_id:table.id,order_type:'dine_in',
   customer_request_id:pending.request_id,client_sale_id:randomUUID(),
   payment_method:'cash',amount_tendered_cents:2500,items:[{product_id:p.id,quantity:1}],
   payment_verified:true
 }});
 assert.equal((await send('kitchen',200,{account:owner})).length,0);
 await send('menu/requests/'+pending.request_id+'/payment-review',200,{method:'POST',account:owner,
  body:{reference:'CASH-QR-'+nonce.slice(0,8)}});
 await send('checkout',409,{method:'POST',account:owner,body:{
   branch_id:branch.id,table_id:table.id,order_type:'dine_in',customer_request_id:pending.request_id,
   client_sale_id:randomUUID(),payment_method:'cash',amount_tendered_cents:2500,
   items:[{product_id:p.id,quantity:1}]
 }});
 const order=await send('checkout',200,{method:'POST',account:owner,body:{
   branch_id:branch.id,table_id:table.id,order_type:'dine_in',
   customer_request_id:pending.request_id,client_sale_id:randomUUID(),
   payment_method:'cash',amount_tendered_cents:2500,items:[{product_id:p.id,quantity:1}],
   payment_verified:true
 }});
 const tickets=await send('kitchen',200,{account:owner});
 assert.equal(tickets.length,1);
 assert.equal(tickets[0].order_id,order.id);
 assert.equal(tickets[0].status,'pending');
 await send('kitchen/'+tickets[0].id+'/status',409,{method:'PATCH',account:owner,body:{status:'ready'}});
 for(const status of ['preparing','ready','completed']){
  await send('kitchen/'+tickets[0].id+'/status',200,{method:'PATCH',account:owner,body:{status}});
 }
 assert.equal((await send('kitchen',200,{account:outsider})).length,0);
 await send('kitchen/'+tickets[0].id+'/status',404,{method:'PATCH',account:outsider,body:{status:'completed'}});
 await send('menu/'+qr.token+'/requests/'+pending.request_id,200,{publicRequest:true});
 await send('menu/links/'+table.id+'/revoke',200,{method:'POST',account:owner,body:{}});
 await send('menu/'+qr.token,404,{publicRequest:true});

 // This isolated test uses a paid-plan fixture to allow two team seats in the same tenant.
 await pool.query("UPDATE subscriptions SET plan_id='basic',status='active',current_period_ends_at=now()+interval '30 days' WHERE tenant_id=$1",[owner.shop.id]);
 // Cashier register handover: two separate people, independent drawers, no double-opening.
 const cashier1=await send('staff',200,{method:'POST',account:owner,body:{
   name:'Cashier One',email:'cash1-'+nonce+'@example.invalid',password:'cash-'+nonce,role:'cashier'
 }});
 const cashier2=await send('staff',200,{method:'POST',account:owner,body:{
   name:'Cashier Two',email:'cash2-'+nonce+'@example.invalid',password:'cash-'+nonce,role:'cashier'
 }});
 async function login(email){
  const response=await fetch(api+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},
   body:JSON.stringify({email,password:'cash-'+nonce})});
  assert.equal(response.status,200);const result=await response.json();result.shop=owner.shop;return result;
 }
 const first=await login('cash1-'+nonce+'@example.invalid'),second=await login('cash2-'+nonce+'@example.invalid');
 const shiftA=await send('register/open',200,{method:'POST',account:first,body:{branch_id:branch.id,opening_cents:5000}});
 await send('register/open',409,{method:'POST',account:first,body:{branch_id:branch.id,opening_cents:7000}});
 const shiftB=await send('register/open',200,{method:'POST',account:second,body:{branch_id:branch.id,opening_cents:8000}});
 assert.notEqual(shiftA.id,shiftB.id);
 const shiftSale=await send('checkout',200,{method:'POST',account:first,body:{
  branch_id:branch.id,client_sale_id:randomUUID(),payment_method:'cash',
  register_session_id:shiftA.id,amount_tendered_cents:3000,
  items:[{product_id:p.id,quantity:1}]
 }});
 assert.equal(shiftSale.register_session_id,shiftA.id);
 await send('checkout',409,{method:'POST',account:second,body:{
  branch_id:branch.id,client_sale_id:randomUUID(),payment_method:'cash',
  register_session_id:shiftA.id,amount_tendered_cents:3000,items:[{product_id:p.id,quantity:1}]
 }});
 const summary1=await send('register/summary',200,{account:first});
 const summary2=await send('register/summary',200,{account:second});
 assert.equal(summary1.sessions.some(s=>s.id===shiftA.id),true);
 assert.equal(summary1.sessions.some(s=>s.id===shiftB.id),false);
 assert.equal(summary2.sessions.some(s=>s.id===shiftA.id),false);
 assert.equal(summary2.sessions.some(s=>s.id===shiftB.id),true);
 assert.equal(Number(summary1.sessions.find(s=>s.id===shiftA.id).cash_sales_cents),2500);
 assert.equal(Number(summary2.sessions.find(s=>s.id===shiftB.id).cash_sales_cents),0);
 await send('register/'+shiftA.id+'/close',200,{method:'POST',account:first,body:{counted_cents:7500}});
 assert.equal((await send('register/summary',200,{account:first})).sessions.find(s=>s.id===shiftA.id).status,'closed');
 assert.equal(Number((await send('register/summary',200,{account:owner})).gross_collected_cents),7500);
 assert.equal((await send('kitchen',200,{account:owner})).length,2);
 assert.equal(otherBranch.id!==branch.id,true);
});
