import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import bcrypt from 'bcryptjs';
import {test} from 'node:test';
import {pool,one,scoped} from '../src/db.js';

const ready=Boolean(process.env.STRATIFYPOS_TEST_DATABASE_URL&&process.env.SUPERADMIN_EMAIL&&process.env.SUPERADMIN_PASSWORD);
test('affiliate signup attribution, roles, verified commissions, payouts and refunds', {
 skip:!ready&&'Disposable PostgreSQL and Super Admin test credentials required',timeout:180000
},async t=>{
 const nonce=randomUUID(),password='Aff-test-'+nonce;
 const testEmail=process.env.SUPERADMIN_EMAIL.toLowerCase();
 await pool.query(`INSERT INTO users(name,email,password_hash,platform_admin,active)
   VALUES('Development super admin',$1,$2,true,true)
   ON CONFLICT(email) DO UPDATE SET password_hash=excluded.password_hash,platform_admin=true,active=true`,
 [testEmail,await bcrypt.hash(process.env.SUPERADMIN_PASSWORD,12)]);
 const child=spawn(process.execPath,['src/index.js'],{
  cwd:process.cwd(),
  env:{...process.env,DATABASE_URL:process.env.STRATIFYPOS_TEST_DATABASE_URL,PORT:'0'},
  stdio:['ignore','pipe','inherit']
 });
 t.after(()=>child.kill());
 t.after(async()=>{await pool.end();});
 const url=await new Promise((resolve,reject)=>{
  child.once('error',reject);child.once('exit',code=>reject(Error('API exited '+code)));
  let stdout='';child.stdout.on('data',chunk=>{stdout+=chunk;
   const match=stdout.match(/http:\/\/localhost:\d+/);if(match)resolve(match[0]);});
 });
 async function req(path,status,{method='GET',token,body,tenant}={}){
  const response=await fetch(url+'/api/'+path,{method,signal:AbortSignal.timeout(20000),
   headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{}),
    ...(tenant?{'X-Tenant-Id':tenant}:{})},
   body:body===undefined?undefined:JSON.stringify(body)});
  const result=await response.json().catch(()=>({}));
  assert.equal(response.status,status,method+' '+path+': '+JSON.stringify(result).slice(0,420));
  return result;
 }
 const post=(path,status,body,token)=>req(path,status,{method:'POST',body,token});
 const patch=(path,status,body,token)=>req(path,status,{method:'PATCH',body,token});
 const put=(path,status,body,token)=>req(path,status,{method:'PUT',body,token});
 const admin=(await post('auth/login',200,{email:testEmail,password:process.env.SUPERADMIN_PASSWORD})).token;
 assert((await req('me',200,{token:admin})).superAdmin);
 const settings=await put('admin/affiliates/settings',200,{
  affiliate_default_rate_bps:2000,affiliate_hold_days:0,affiliate_min_payout_cents:100
 },admin);
 assert.equal(settings.affiliate_default_rate_bps,2000);
 const affEmail='affiliate-'+nonce+'@example.invalid',code='SP-'+nonce.replaceAll('-','').slice(0,12).toUpperCase();
 const affiliate=await post('admin/affiliates',201,{
  name:'Affiliate QA',email:affEmail,password,referral_code:code
 },admin);
 assert.equal(affiliate.referral_code,code);
 assert.equal(affiliate.commission_rate_override_bps,null);
 await post('admin/affiliates',409,{
  name:'Duplicate',email:'duplicate-'+nonce+'@example.invalid',password,referral_code:code
 },admin);
 const affiliateToken=(await post('auth/login',200,{email:affEmail,password})).token;
 const affMe=await req('me',200,{token:affiliateToken});
 assert.equal(affMe.affiliate,true);
 assert.equal(affMe.superAdmin,false);
 assert.equal(affMe.shops.length,0);
 await req('admin/affiliates',403,{token:affiliateToken});
 await req('affiliate/me',403,{token:admin});
 await req('affiliate/referrals',403,{token:admin});
 await req('shop/overview',400,{token:affiliateToken});
 const missing=await post('auth/register',400,{
  email:'invalid-ref-'+nonce+'@example.invalid',password,
  name:'Invalid referral',shopName:'Invalid '+nonce,plan:'basic',skip_trial:true,
  referral_code:'SP-NOT-VALID'
 });
 assert(missing.error.includes('referral'));
 const ownerEmail='owner-'+nonce+'@example.invalid';
 const registered=await post('auth/register',201,{
  email:ownerEmail,password,name:'Referred owner',shopName:'Referred '+nonce,
  plan:'basic',skip_trial:true,referral_code:code.toLowerCase(),
  business_type:'non_food'
 });
 assert.equal(registered.status,'payment_pending');
 await post('auth/login',403,{email:ownerEmail,password});
 const tenant=await one(pool,'SELECT id FROM tenants WHERE name=$1',['Referred '+nonce]);
 assert(tenant?.id);
 const referral=(await req('affiliate/referrals',200,{token:affiliateToken}));
 assert.equal(referral.length,1);
 assert.equal(referral[0].tenant_id,tenant.id);
 assert.equal(referral[0].referral_code_snapshot,code);
 const plan=await one(pool,"SELECT price_cents FROM plans WHERE id='basic'");
 const createPayment=async(tag)=>{
  const payment=await post('admin/payments',201,{
   tenant_id:tenant.id,plan_id:'basic',amount_cents:plan.price_cents,
   method:'gcash',reference_no:'REQ-'+tag+'-'+nonce.slice(0,8).toUpperCase(),status:'pending'
  },admin);
  const verified=await post('admin/payments/'+payment.id+'/verify-and-activate',200,{
   confirmed_received:true,verified_reference:'PAY-'+tag+'-'+nonce.slice(0,12).toUpperCase()
  },admin);
  assert(verified.ok);
  return payment;
 };
 const first=await createPayment('A');
 await post('admin/payments/'+first.id+'/verify-and-activate',409,{
  confirmed_received:true,verified_reference:'PAY-A-'+nonce.slice(0,12).toUpperCase()
 },admin);
 const owner=(await post('auth/login',200,{email:ownerEmail,password})).token;
 await req('affiliate/me',403,{token:owner});
 const firstExpected=Math.round(plan.price_cents*0.2);
 let commissions=await req('affiliate/commissions',200,{token:affiliateToken});
 assert.equal(commissions.length,1);
 assert.equal(commissions[0].commission_cents,firstExpected);
 assert.equal(commissions[0].rate_bps,2000);
 let dashboard=await req('affiliate/me',200,{token:affiliateToken});
 assert.equal(dashboard.balance.withdrawable_cents,firstExpected);
 assert.equal(dashboard.affiliate.effective_rate_bps,2000);
 const payout=await post('affiliate/payouts',201,{},affiliateToken);
 assert.equal(payout.amount_cents,firstExpected);
 await post('affiliate/payouts',409,{},affiliateToken);
 await post('admin/affiliates/payouts/'+payout.id+'/review',400,{
  decision:'paid',reference:''
 },admin);
 const paid=await post('admin/affiliates/payouts/'+payout.id+'/review',200,{
  decision:'paid',reference:'TRANSFER-'+nonce.slice(0,12).toUpperCase()
 },admin);
 assert.equal(paid.status,'paid');
 await post('admin/affiliates/payouts/'+payout.id+'/review',409,{
  decision:'paid',reference:'TRANSFER-'+nonce.slice(0,12).toUpperCase()
 },admin);
 dashboard=await req('affiliate/me',200,{token:affiliateToken});
 assert.equal(dashboard.balance.withdrawable_cents,0);
 await patch('admin/affiliates/'+affiliate.id,200,{
  commission_rate_override_bps:2500
 },admin);
 const second=await createPayment('B');
 commissions=await req('affiliate/commissions',200,{token:affiliateToken});
 assert.equal(commissions.length,2);
 const firstRecorded=commissions.find(x=>x.payment_id===first.id);
 const secondRecorded=commissions.find(x=>x.payment_id===second.id);
 assert.equal(firstRecorded.rate_bps,2000);
 assert.equal(secondRecorded.rate_bps,2500);
 const secondExpected=Math.round(plan.price_cents*0.25);
 assert.equal(secondRecorded.commission_cents,secondExpected);
 dashboard=await req('affiliate/me',200,{token:affiliateToken});
 assert.equal(dashboard.balance.withdrawable_cents,secondExpected);
 await post('admin/affiliates/payments/'+first.id+'/refund',400,{
  confirmed_refunded:false,reason:''
 },admin);
 const refund=await post('admin/affiliates/payments/'+first.id+'/refund',200,{
  confirmed_refunded:true,reason:'Customer received the confirmed refund'
 },admin);
 assert.equal(refund.commission_reversed,true);
 const replay=await post('admin/affiliates/payments/'+first.id+'/refund',200,{
  confirmed_refunded:true,reason:'Confirmed refund'
 },admin);
 assert.equal(replay.already_refunded,true);
 dashboard=await req('affiliate/me',200,{token:affiliateToken});
 assert.equal(dashboard.balance.withdrawable_cents,secondExpected-firstExpected,
  'A reversal after payout must carry forward as debt, not pay twice');
 assert.equal(dashboard.balance.reversed_cents,firstExpected);
 const secondPayout=await post('affiliate/payouts',201,{},affiliateToken);
 assert.equal(secondPayout.amount_cents,secondExpected-firstExpected);
 await post('admin/affiliates/payouts/'+secondPayout.id+'/review',200,{
  decision:'rejected',note:'Payout details need verification'
 },admin);
 assert.equal((await req('affiliate/me',200,{token:affiliateToken})).balance.withdrawable_cents,
  secondExpected-firstExpected);
 await patch('admin/affiliates/'+affiliate.id,200,{status:'suspended'},admin);
 await req('affiliate/me',403,{token:affiliateToken});
 await post('auth/register',400,{
  email:'suspended-ref-'+nonce+'@example.invalid',password,
  name:'Blocked signup',shopName:'Blocked '+nonce,plan:'basic',skip_trial:true,
  referral_code:code
 });
 // Merchant-scoped SQL role must never read platform affiliate records.
 await assert.rejects(()=>scoped(tenant.id,db=>db.query('SELECT * FROM affiliate_accounts LIMIT 1')),
  err=>err.code==='42501');
 const count=await one(pool,'SELECT count(*)::int AS count FROM affiliate_commissions WHERE tenant_id=$1',[tenant.id]);
 assert.equal(count.count,2);
});
