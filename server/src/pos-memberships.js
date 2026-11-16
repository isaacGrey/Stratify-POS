import {one,rows} from './db.js';
import {expiryFrom} from './service-routes.js';

const uuid=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const fail=(status,message)=>Object.assign(new Error(message),{status});
const dayOf=value=>value instanceof Date?value.toISOString().slice(0,10):String(value).slice(0,10);

/** Validate membership eligibility before funds, order ledger or stock are committed. */
export async function validateMembershipCart(db,tenant,lines,{customerId=null,offline=false,held=false,qr=false,promo=null,loyalty=null}={}){
 const selected=lines.filter(l=>l.product.product_type==='membership');
 if(!selected.length){
  if(customerId!==null && (!uuid.test(customerId)))throw fail(400,'Invalid service customer');
  return [];
 }
 if(offline||qr)throw fail(409,'Memberships require an online cashier checkout');
 // Parked sales are permitted only when their customer stays identical at checkout.
 if(promo||loyalty)throw fail(409,'Membership plans cannot be combined with promotion or reward codes');
 if(!uuid.test(customerId||''))throw fail(400,'Select a membership customer before payment');
 const customer=await one(db,'SELECT id FROM service_customers WHERE tenant_id=$1 AND id=$2',[tenant,customerId]);
 if(!customer)throw fail(404,'Membership customer unavailable');
 const seen=new Set();
 const selections=[];
 for(const line of selected){
  if(line.qty!==1||line.variant||line.addons.length || seen.has(line.product.id))
   throw fail(409,'Sell only one of each membership plan per checkout, without variations or add-ons');
  seen.add(line.product.id);
  const plan=await one(db,`SELECT * FROM service_plans WHERE tenant_id=$1 AND product_id=$2
   AND active=true AND sell_through_pos=true FOR SHARE`,[tenant,line.product.id]);
  if(!plan)throw fail(409,'Membership plan unavailable for POS sales');
  if(!Number.isInteger(line.unit)||line.unit<=0)throw fail(409,'Membership plan requires a positive price');
  selections.push({plan,productId:line.product.id});
 }
 return selections;
}

/** Called inside the same scoped transaction as the paid POS sale. */
export async function fulfillMembershipCheckout(db,tenant,order,customerId,selections,actorId){
 if(!selections.length)return [];
 const today=(await one(db,'SELECT CURRENT_DATE::text AS day')).day;
 const result=[];
 for(const {plan} of selections){
  // Serialize concurrent enrollments for the same customer+plan even when no entitlement exists.
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 783122))',
   [tenant+':'+customerId+':'+plan.id]);
  const prior=await one(db,`SELECT * FROM service_entitlements WHERE tenant_id=$1
   AND customer_id=$2 AND plan_id=$3 AND status='active'
   ORDER BY created_at DESC,id DESC LIMIT 1 FOR UPDATE`,[tenant,customerId,plan.id]);
  let entitlement,kind,previous=null,start=today;
  if(prior){
   if(prior.expires_on===null)throw fail(409,'Customer already holds a lifetime membership for this plan');
   previous=dayOf(prior.expires_on);
   start=previous>today?previous:today;
   const expiry=expiryFrom(start,plan.duration_kind,plan.duration_value);
   entitlement=await one(db,`UPDATE service_entitlements SET expires_on=$3,updated_at=now()
    WHERE tenant_id=$1 AND id=$2 RETURNING *`,[tenant,prior.id,expiry]);
   kind='renew';
  }else{
   const expiry=expiryFrom(start,plan.duration_kind,plan.duration_value);
   entitlement=await one(db,`INSERT INTO service_entitlements
    (tenant_id,branch_id,customer_id,plan_id,starts_on,expires_on,granted_by)
    VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [tenant,order.branch_id,customerId,plan.id,start,expiry,actorId]);
   kind='grant';
  }
  await db.query(`INSERT INTO service_entitlement_events
   (tenant_id,branch_id,entitlement_id,actor_id,event_kind,
    previous_expires_on,starts_on,expires_on,reason,source_order_id)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
   [tenant,entitlement.branch_id,entitlement.id,actorId,kind,previous,start,
    entitlement.expires_on,'POS purchase '+order.order_number,order.id]);
  result.push({entitlement_id:entitlement.id,plan_id:plan.id,event_kind:kind,
   expires_on:entitlement.expires_on,customer_id:customerId});
 }
 return result;
}

/** Cash-refund reversal is all-or-nothing; never leave access granted for a refunded sale. */
export async function reverseMembershipCheckout(db,tenant,order,refund,actorId){
 const linked=await rows(db,`SELECT ev.id AS event_id,ev.entitlement_id,ev.event_kind,
   ev.previous_expires_on,e.starts_on,e.expires_on,e.branch_id,e.status
   FROM service_entitlement_events ev
   JOIN service_entitlements e ON e.tenant_id=ev.tenant_id AND e.id=ev.entitlement_id
   WHERE ev.tenant_id=$1 AND ev.source_order_id=$2 AND ev.event_kind IN ('grant','renew')
   ORDER BY e.id FOR UPDATE OF e`,[tenant,order.id]);
 if(!linked.length)return [];
 if(refund.amount_cents!==order.total_cents)
  throw fail(409,'Membership sales require a full cash refund');
 const reversed=[];
 for(const item of linked){
  const last=await one(db,`SELECT id,event_kind FROM service_entitlement_events
   WHERE tenant_id=$1 AND entitlement_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1`,
   [tenant,item.entitlement_id]);
  if(last?.id!==item.event_id||item.status!=='active')
   throw fail(409,'Membership changed after purchase; review the refund manually');
  const expiry=item.event_kind==='renew'?dayOf(item.previous_expires_on):item.expires_on;
  await db.query(`UPDATE service_entitlements SET expires_on=$3,
   status=$4,updated_at=now() WHERE tenant_id=$1 AND id=$2`,
   [tenant,item.entitlement_id,expiry,item.event_kind==='grant'?'cancelled':'active']);
  await db.query(`INSERT INTO service_entitlement_events
   (tenant_id,branch_id,entitlement_id,actor_id,event_kind,previous_expires_on,
    starts_on,expires_on,reason,source_order_id,source_refund_id)
   VALUES($1,$2,$3,$4,'reverse',$5,$6,$7,$8,$9,$10)`,
   [tenant,item.branch_id,item.entitlement_id,actorId,item.expires_on,item.starts_on,
    expiry,'Full cash refund of POS membership',order.id,refund.id]);
  reversed.push(item.entitlement_id);
 }
 return reversed;
}
