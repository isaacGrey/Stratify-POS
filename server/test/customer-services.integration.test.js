import assert from 'node:assert/strict';
import {test} from 'node:test';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {expiryFrom,parseDay} from '../src/service-routes.js';

test('calendar-month expiry clamps month ends and leap days',()=>{
 assert.equal(expiryFrom('2026-01-31','months',1),'2026-02-28');
 assert.equal(expiryFrom('2024-01-31','months',1),'2024-02-29');
 assert.equal(expiryFrom('2026-11-16','months',2),'2027-01-16');
 assert.equal(expiryFrom('2026-11-16','months',12),'2027-11-16');
 assert.equal(expiryFrom('2026-11-16','days',30),'2026-12-16');
 assert.equal(expiryFrom('2026-11-16','none',null),null);
 assert.throws(()=>parseDay('2026-02-30'));
});
const database=process.env.STRATIFYPOS_TEST_DATABASE_URL;
test('customer service lifecycle, manual grants, tenant access and renewal history',{
 skip:!database&&'Set disposable STRATIFYPOS_TEST_DATABASE_URL to enable integration test',
 timeout:120000
},async t=>{
 const nonce=randomUUID();
 const child=spawn(process.execPath,['src/index.js'],{
  cwd:process.cwd(),
  env:{...process.env,DATABASE_URL:database,PORT:'0',JWT_SECRET:randomUUID()},
  stdio:['ignore','pipe','inherit']
 });
 t.after(()=>child.kill());
 const api=await new Promise((resolve,reject)=>{
  child.once('error',reject);
  child.once('exit',code=>reject(new Error('Server exited '+code)));
  let output='';child.stdout.on('data',buf=>{
   output+=buf;
   const m=output.match(/http:\/\/localhost:\d+/);
   if(m)resolve(m[0]);
  });
 });
 async function req(path,status,{method='GET',body,account,tenant}={}){
  const response=await fetch(api+'/api/'+path,{
   method,signal:AbortSignal.timeout(10000),
   headers:{'Content-Type':'application/json',
    ...(account?{Authorization:'Bearer '+account.token}:{}),
    ...(tenant||account?.shop?.id?{'X-Tenant-Id':tenant||account.shop.id}:{})},
   body:body===undefined?undefined:JSON.stringify(body)
  });
  const data=await response.json();
  assert.equal(response.status,status,method+' '+path+': '+JSON.stringify(data).slice(0,300));
  return data;
 }
 const post=(p,s,b,a)=>req(p,s,{method:'POST',body:b,account:a});
 const put=(p,s,b,a)=>req(p,s,{method:'PUT',body:b,account:a});
 const owner=await post('auth/register',201,{
  email:'membership-'+nonce+'@example.invalid',password:'membership-test-'+nonce,
  name:'Membership tester',shopName:'Member '+nonce
 });
 const outsider=await post('auth/register',201,{
  email:'membership-other-'+nonce+'@example.invalid',password:'membership-test-'+nonce,
  name:'Other membership tester',shopName:'Other Member '+nonce
 });
 const [branch]=await req('shop/branches',200,{account:owner});
 const product=await post('shop/products',200,{name:'Gym access',product_type:'service',
  price_cents:199900,description:'Monthly gym membership'},owner);
 await post('shop/service-plans',400,{product_id:randomUUID(),name:'Bad plan',duration_kind:'none'},owner);
 const plan=await post('shop/service-plans',200,{product_id:product.id,name:'Gym monthly',duration_kind:'months',duration_value:1},owner);
 await post('shop/service-plans',409,{product_id:product.id,name:'Duplicate',duration_kind:'none'},owner);
 const patient=await post('shop/service-customers',200,{
  name:'Customer A',reference:'MEM-'+nonce.slice(0,8),email:'member@example.invalid'
 },owner);
 const start='2026-01-31';
 const grant=await post('shop/service-entitlements',200,{
  customer_id:patient.id,plan_id:plan.id,branch_id:branch.id,start_on:start,
  reason:'Paid manually; receipt in office'
 },owner);
 assert.equal(String(grant.expires_on).slice(0,10),'2026-02-28');
 assert.equal((await req('shop/service-entitlements',200,{account:owner})).find(x=>x.id===grant.id).effective_status,'expired');
 const events=await req('shop/service-entitlements/'+grant.id+'/events',200,{account:owner});
 assert.equal(events.length,1);
 const renewed=await post('shop/service-entitlements/'+grant.id+'/renew',200,{
  start_on:'2026-02-28',expiry_mode:'custom',expires_on:'2027-02-28',reason:'Checked external receipt'
 },owner);
 assert.equal(String(renewed.expires_on).slice(0,10),'2027-02-28');
 await post('shop/service-entitlements/'+grant.id+'/renew',400,{
  start_on:'2027-03-01',expiry_mode:'custom',expires_on:'2026-03-01',reason:'Bad date range'
 },owner);
 const eventsAfter=await req('shop/service-entitlements/'+grant.id+'/events',200,{account:owner});
 assert.equal(eventsAfter.length,2);
 await req('shop/service-entitlements/'+grant.id+'/events',404,{account:outsider});
 await post('shop/service-entitlements/'+grant.id+'/renew',404,{
  start_on:'2027-02-28',reason:'Unauthorized renewal'
 },outsider);
 const noEnd=await post('shop/service-entitlements',200,{
  customer_id:patient.id,plan_id:plan.id,branch_id:branch.id,start_on:'2026-11-16',
  expiry_mode:'none',reason:'Lifetime complimentary access'
 },owner);
 assert.equal(noEnd.expires_on,null);
 await post('shop/service-entitlements/'+noEnd.id+'/cancel',200,{reason:'Customer requested cancellation'},owner);
 await post('shop/service-entitlements/'+noEnd.id+'/renew',409,{
  start_on:'2026-11-17',reason:'Attempt to renew cancelled'
 },owner);
 assert.equal((await req('shop/service-entitlements/'+noEnd.id+'/events',200,{account:owner})).length,2);
 await req('shop/service-customers',403,{account:outsider,tenant:owner.shop.id});
 await req('shop/service-customers',200,{account:outsider});
 await req('shop/service-entitlements',200,{account:outsider});
});
