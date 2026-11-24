import {Router} from 'express';
import bcrypt from 'bcryptjs';
import {pool,one,rows} from './db.js';
import {fail,inTransaction,platformAudit} from './platform.js';
import {attributeAffiliate,affiliateBalance,commissionRate,freshReferralCode,
 normalizeReferralCode,isUuid,requestedPayout,payoutForAdmin,reverseAffiliateCommission} from './affiliate-service.js';

const email=v=>typeof v==='string'?v.trim().toLowerCase():'';
const validEmail=v=>/^\S+@\S+\.\S+$/.test(v)&&v.length<=254;
const queryPage=value=>{
 const n=value===undefined?0:Number(value);
 if(!Number.isInteger(n)||n<0||n>200000)throw fail(400,'Invalid pagination offset');
 return n;
};
const text=(v,max)=>typeof v==='string'&&v.trim().length>0&&v.trim().length<=max;

export function registerAffiliateRoutes(app,{auth,wrap}){
 const router=Router();
 router.use(auth);
 router.use(wrap(async(req,res,next)=>{
  const affiliate=await one(pool,`SELECT a.id,a.referral_code,a.status,a.commission_rate_override_bps,
      u.name,u.email FROM affiliate_accounts a JOIN users u ON u.id=a.user_id
    WHERE a.user_id=$1 AND a.status='active' AND u.active AND u.archived_at IS NULL
      AND u.suspended_at IS NULL`,[req.user.id]);
  if(!affiliate)throw fail(403,'Active affiliate account required');
  req.affiliate=affiliate;
  res.set('Cache-Control','private, no-store');
  next();
 }));
 router.get('/me',wrap(async(req,res)=>{
  const settings=await one(pool,`SELECT affiliate_default_rate_bps,affiliate_hold_days,affiliate_min_payout_cents
   FROM platform_settings WHERE singleton`);
  const balance=await affiliateBalance(pool,req.affiliate.id);
  const performance=await one(pool,`SELECT (SELECT count(*)::int FROM affiliate_referrals r WHERE r.affiliate_id=a.id) AS referred_businesses,
   (SELECT count(*)::int FROM affiliate_referrals r JOIN tenants t ON t.id=r.tenant_id JOIN subscriptions s ON s.tenant_id=t.id
      WHERE r.affiliate_id=a.id AND t.status='active' AND t.archived_at IS NULL
        AND NOT t.administratively_suspended AND s.status='active' AND s.plan_id<>'free'
        AND s.current_period_ends_at>now()) AS active_subscriptions,
   (SELECT COALESCE(sum(p.amount_cents),0)::bigint FROM affiliate_referrals r
      JOIN subscription_payments p ON p.tenant_id=r.tenant_id WHERE r.affiliate_id=a.id AND p.status='paid') AS sales_cents,
   (SELECT COALESCE(sum(c.commission_cents),0)::bigint FROM affiliate_commissions c
      WHERE c.affiliate_id=a.id AND c.reversed_at IS NULL AND c.available_at>now()) AS pending_cents,
   (SELECT COALESCE(sum(p.amount_cents),0)::bigint FROM affiliate_payouts p
      WHERE p.affiliate_id=a.id AND p.status='paid') AS paid_cents
    FROM affiliate_accounts a WHERE a.id=$1`,[req.affiliate.id]);
  res.json({affiliate:{...req.affiliate,effective_rate_bps:
    req.affiliate.commission_rate_override_bps??settings.affiliate_default_rate_bps},
   payout_minimum_cents:settings.affiliate_min_payout_cents,
   hold_days:settings.affiliate_hold_days,balance,performance});
 }));
 router.get('/referrals',wrap(async(req,res)=>{
  const offset=queryPage(req.query.offset);
  res.json(await rows(pool,`SELECT r.tenant_id,t.name AS business_name,r.referral_code_snapshot,
   r.attributed_at,s.plan_id,s.status AS subscription_status
   FROM affiliate_referrals r JOIN tenants t ON t.id=r.tenant_id
   JOIN subscriptions s ON s.tenant_id=t.id
   WHERE r.affiliate_id=$1 ORDER BY r.attributed_at DESC,r.tenant_id
   LIMIT 50 OFFSET $2`,[req.affiliate.id,offset]));
 }));
 router.get('/commissions',wrap(async(req,res)=>{
  const offset=queryPage(req.query.offset);
  res.json(await rows(pool,`SELECT c.id,c.payment_id,c.tenant_id,t.name AS business_name,
    c.eligible_amount_cents,c.rate_bps,c.commission_cents,
    c.created_at,c.available_at,c.reversed_at,c.reversal_reason
   FROM affiliate_commissions c JOIN tenants t ON t.id=c.tenant_id
   WHERE c.affiliate_id=$1 ORDER BY c.created_at DESC,c.id LIMIT 50 OFFSET $2`,
  [req.affiliate.id,offset]));
 }));
 router.get('/payouts',wrap(async(req,res)=>{
  res.json(await rows(pool,`SELECT id,amount_cents,status,requested_at,reviewed_at,
   payment_reference,review_note FROM affiliate_payouts WHERE affiliate_id=$1
   ORDER BY requested_at DESC,id LIMIT 100`,[req.affiliate.id]));
 }));
 router.post('/payouts',wrap(async(req,res)=>{
  if(req.body&&Object.keys(req.body).length)
    throw fail(400,'Payout amounts are calculated by the server');
  const payout=await inTransaction(pool,async db=>requestedPayout(db,req.affiliate.id));
  res.status(201).json(payout);
 }));
 app.use('/api/affiliate',router);
}

/** Only mount this router under the existing /api/admin auth+platform-admin guards. */
export function registerAffiliateAdminRoutes(router,wrap){
 router.get('/affiliates/settings',wrap(async(_req,res)=>{
  res.set('Cache-Control','private, no-store');
  res.json(await one(pool,`SELECT affiliate_default_rate_bps,affiliate_hold_days,
    affiliate_min_payout_cents FROM platform_settings WHERE singleton`));
 }));
 router.put('/affiliates/settings',wrap(async(req,res)=>{
  const {affiliate_default_rate_bps,affiliate_hold_days,affiliate_min_payout_cents}=req.body||{};
  commissionRate(affiliate_default_rate_bps);
  if(!Number.isInteger(affiliate_hold_days)||affiliate_hold_days<0||affiliate_hold_days>90||
     !Number.isInteger(affiliate_min_payout_cents)||affiliate_min_payout_cents<100||
     affiliate_min_payout_cents>100000000)throw fail(400,'Invalid affiliate payout settings');
  const saved=await inTransaction(pool,async db=>{
   const row=await one(db,`UPDATE platform_settings SET affiliate_default_rate_bps=$1,
     affiliate_hold_days=$2,affiliate_min_payout_cents=$3 WHERE singleton
     RETURNING affiliate_default_rate_bps,affiliate_hold_days,affiliate_min_payout_cents`,
    [affiliate_default_rate_bps,affiliate_hold_days,affiliate_min_payout_cents]);
   await platformAudit(db,req.user,'affiliates.settings_updated','platform',{...row});
   return row;
  });
  res.json(saved);
 }));
 router.get('/affiliates',wrap(async(req,res)=>{
  const offset=queryPage(req.query.offset),q=String(req.query.q??'');
  if(q.length>120)throw fail(400,'Invalid affiliate search');
  const list=await rows(pool,`SELECT a.id,a.user_id,a.referral_code,a.status,a.commission_rate_override_bps,
   a.created_at,u.name,u.email,
   (SELECT count(*)::int FROM affiliate_referrals r WHERE r.affiliate_id=a.id) AS referred_businesses,
   (SELECT count(*)::int FROM affiliate_referrals r JOIN tenants t ON t.id=r.tenant_id JOIN subscriptions s ON s.tenant_id=t.id
      WHERE r.affiliate_id=a.id AND t.status='active' AND t.archived_at IS NULL
        AND NOT t.administratively_suspended AND s.status='active' AND s.plan_id<>'free'
        AND s.current_period_ends_at>now()) AS active_subscriptions,
   (SELECT COALESCE(sum(p.amount_cents),0)::bigint FROM affiliate_referrals r
      JOIN subscription_payments p ON p.tenant_id=r.tenant_id WHERE r.affiliate_id=a.id AND p.status='paid') AS sales_cents,
   (SELECT COALESCE(sum(c.commission_cents),0)::bigint FROM affiliate_commissions c
      WHERE c.affiliate_id=a.id AND c.reversed_at IS NULL AND c.available_at>now()) AS pending_cents,
   (SELECT COALESCE(sum(p.amount_cents),0)::bigint FROM affiliate_payouts p
      WHERE p.affiliate_id=a.id AND p.status='paid') AS paid_cents,
   (SELECT COALESCE(sum(c.commission_cents),0)::bigint
      FROM affiliate_commissions c WHERE c.affiliate_id=a.id AND c.reversed_at IS NULL) AS earned_cents
   FROM affiliate_accounts a JOIN users u ON u.id=a.user_id
   WHERE (u.name ILIKE '%'||$1||'%' OR u.email ILIKE '%'||$1||'%'
       OR a.referral_code ILIKE '%'||$1||'%')
   ORDER BY a.created_at DESC,a.id LIMIT 50 OFFSET $2`,[q.trim(),offset]);
  res.set('Cache-Control','private, no-store').json(list);
 }));
 router.post('/affiliates',wrap(async(req,res)=>{
  const {name,password,commission_rate_override_bps=null}=req.body||{};
  const address=email(req.body?.email);
  const providedCode=req.body?.referral_code;
  if(!text(name,120)||!validEmail(address)||!text(password,200)||password.length<12||Buffer.byteLength(password)>72||
     address===email(process.env.SUPERADMIN_EMAIL))
    throw fail(400,'Provide a name, valid email and password of at least 12 characters');
  const rate=commissionRate(commission_rate_override_bps,{optional:true});
  const code=providedCode?normalizeReferralCode(providedCode):freshReferralCode();
  const result=await inTransaction(pool,async db=>{
   const user=await one(db,`INSERT INTO users(name,email,password_hash)
     VALUES($1,$2,$3) RETURNING id,name,email`,[name.trim(),address,await bcrypt.hash(password,12)]);
   const account=await one(db,`INSERT INTO affiliate_accounts(user_id,referral_code,commission_rate_override_bps)
     VALUES($1,$2,$3) RETURNING *`,[user.id,code,rate]);
   await platformAudit(db,req.user,'affiliate.created',account.id,{user:user.id,code});
   return {...account,name:user.name,email:user.email};
  }).catch(err=>{if(err.code==='23505')throw fail(409,'Email or affiliate code already exists');throw err;});
  res.status(201).json(result);
 }));
 router.patch('/affiliates/:id',wrap(async(req,res)=>{
  if(!isUuid(req.params.id))throw fail(400,'Invalid affiliate identifier');
  const keys=Object.keys(req.body||{});
  if(!keys.length||keys.some(k=>!['status','commission_rate_override_bps'].includes(k)))
   throw fail(400,'Only status or commission override can be changed');
  const status=req.body.status,hasRate=Object.prototype.hasOwnProperty.call(req.body,'commission_rate_override_bps');
  if(status!==undefined&&!['active','suspended'].includes(status))
   throw fail(400,'Invalid affiliate status');
  const rate=hasRate?commissionRate(req.body.commission_rate_override_bps,{optional:true}):null;
  const updated=await inTransaction(pool,async db=>{
   const row=await one(db,`UPDATE affiliate_accounts
     SET status=COALESCE($2,status),commission_rate_override_bps=
       CASE WHEN $3::boolean THEN $4::integer ELSE commission_rate_override_bps END,updated_at=now()
     WHERE id=$1 RETURNING id,user_id,referral_code,status,commission_rate_override_bps`,
    [req.params.id,status??null,hasRate,rate]);
   if(!row)throw fail(404,'Affiliate not found');
   await platformAudit(db,req.user,'affiliate.updated',row.id,{
    status:row.status,rate_bps:row.commission_rate_override_bps});
   return row;
  });
  res.json(updated);
 }));
 router.get('/affiliates/:id/commissions',wrap(async(req,res)=>{
  if(!isUuid(req.params.id))throw fail(400,'Invalid affiliate identifier');
  const offset=queryPage(req.query.offset);
  const account=await one(pool,'SELECT id FROM affiliate_accounts WHERE id=$1',[req.params.id]);
  if(!account)throw fail(404,'Affiliate unavailable');
  res.json(await rows(pool,`SELECT c.id,c.payment_id,t.name AS business_name,
     c.eligible_amount_cents,c.rate_bps,c.commission_cents,c.created_at,c.available_at,
     c.reversed_at,c.reversal_reason FROM affiliate_commissions c
     JOIN tenants t ON t.id=c.tenant_id WHERE c.affiliate_id=$1
     ORDER BY c.created_at DESC,c.id LIMIT 50 OFFSET $2`,[req.params.id,offset]));
 }));
 router.get('/affiliates/payouts',wrap(async(req,res)=>{
  const status=req.query.status??'';
  if(status!==''&&!['requested','paid','rejected'].includes(status))throw fail(400,'Invalid payout status');
  res.json(await rows(pool,`SELECT p.*,a.referral_code,u.name AS affiliate_name,u.email
   FROM affiliate_payouts p JOIN affiliate_accounts a ON a.id=p.affiliate_id
   JOIN users u ON u.id=a.user_id
   WHERE ($1::text='' OR p.status=$1)
   ORDER BY (p.status='requested') DESC,p.requested_at DESC,p.id LIMIT 200`,[status]));
 }));
 router.post('/affiliates/payouts/:id/review',wrap(async(req,res)=>{
  const {decision,reference='',note=''}=req.body||{};
  const result=await inTransaction(pool,async db=>{
   const payout=await payoutForAdmin(db,{payoutId:req.params.id,decision,
    actorId:req.user.id,reference,note});
   await platformAudit(db,req.user,'affiliate.payout_'+decision,payout.id,{
    affiliate:payout.affiliate_id,amount_cents:payout.amount_cents,
    reference:decision==='paid'?payout.payment_reference:null});
   return payout;
  });
  res.json(result);
 }));
 // Refunds of SaaS payments reverse the affiliate earning in the same transaction.
 // Subscription cancellation is a separate administrative decision.
 router.post('/affiliates/payments/:id/refund',wrap(async(req,res)=>{
  const {confirmed_refunded,reason}=req.body||{};
  if(!isUuid(req.params.id)||confirmed_refunded!==true||!text(reason,500))
   throw fail(400,'Confirm the actual refund and provide a reason');
  const result=await inTransaction(pool,async db=>{
   const tenant=await one(db,`SELECT t.id FROM tenants t JOIN subscription_payments p ON p.tenant_id=t.id
    WHERE p.id=$1 FOR UPDATE OF t`,[req.params.id]);
   if(!tenant)throw fail(404,'Payment unavailable');
   const payment=await one(db,'SELECT * FROM subscription_payments WHERE id=$1 FOR UPDATE',[req.params.id]);
   if(payment.status==='refunded')return {ok:true,already_refunded:true};
   if(payment.status!=='paid')throw fail(409,'Only verified payments can be refunded');
   await db.query(`UPDATE subscription_payments SET status='refunded',
     review_note=concat_ws(' | ',NULLIF(review_note,''),$2::text),reviewed_at=now()
     WHERE id=$1 AND status='paid'`,[payment.id,reason.trim()]);
   const reversal=await reverseAffiliateCommission(db,payment.id,reason.trim());
   await platformAudit(db,req.user,'payment.refunded',payment.id,{
     business:tenant.id,reversed_commission_id:reversal?.id??null,
     subscription_requires_review:true});
   return {ok:true,already_refunded:false,commission_reversed:Boolean(reversal),
    subscription_requires_review:true};
  });
  res.json(result);
 }));
}
