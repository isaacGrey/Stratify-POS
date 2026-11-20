import {randomBytes} from 'node:crypto';
import {one,rows} from './db.js';
import {fail} from './platform.js';

const uuid=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
export const isUuid=value=>typeof value==='string'&&uuid.test(value);
export function normalizeReferralCode(value,{optional=false}={}){
 if(optional&&(value===null||value===undefined||value===''))return null;
 if(typeof value!=='string')throw fail(400,'Invalid affiliate referral code');
 const code=value.trim().toUpperCase();
 if(!/^[A-Z][A-Z0-9-]{4,31}$/.test(code))throw fail(400,'Invalid affiliate referral code');
 return code;
}
export function commissionRate(value,{optional=false}={}){
 if(optional&&(value===null||value===undefined||value===''))return null;
 if(!Number.isInteger(value)||value<0||value>10000)
  throw fail(400,'Commission rate must be between 0 and 10000 basis points (0–100%)');
 return value;
}
export function commissionCents(amount,rate){
 if(!Number.isSafeInteger(amount)||amount<=0||amount>100000000||
    !Number.isInteger(rate)||rate<0||rate>10000)throw fail(400,'Invalid commission amount or rate');
 return Math.round(amount*rate/10000);
}
export const freshReferralCode=()=>'SP-'+randomBytes(6).toString('hex').toUpperCase();

/** Bind attribution only once during the original business-registration transaction. */
export async function attributeAffiliate(db,{code,tenantId,ownerId}){
 const normalized=normalizeReferralCode(code,{optional:true});
 if(!normalized)return null;
 const affiliate=await one(db,`SELECT id,user_id,status,referral_code FROM affiliate_accounts
   WHERE referral_code=$1 AND status='active' FOR SHARE`,[normalized]);
 if(!affiliate)throw fail(400,'Affiliate referral code is invalid or unavailable');
 if(affiliate.user_id===ownerId)throw fail(409,'You cannot refer your own business');
 const attribution=await one(db,`INSERT INTO affiliate_referrals
    (tenant_id,affiliate_id,owner_user_id,referral_code_snapshot)
    VALUES($1,$2,$3,$4) RETURNING tenant_id,affiliate_id`,
   [tenantId,affiliate.id,ownerId,normalized]);
 return attribution;
}

/** Always invoked inside the existing paid-subscription verification transaction.
 * Account row locking serializes accrual with withdrawals; the UNIQUE payment FK
 * makes replayed verification idempotent.
 */
export async function accrueVerifiedAffiliateCommission(db,payment){
 if(!payment||payment.status!=='paid'||!isUuid(payment.id)||!isUuid(payment.tenant_id))
  throw fail(400,'Only a verified subscription payment can earn commission');
 const affiliate=await one(db,`SELECT a.id,a.status,a.commission_rate_override_bps,
     s.affiliate_default_rate_bps,s.affiliate_hold_days
   FROM affiliate_referrals r JOIN affiliate_accounts a ON a.id=r.affiliate_id
   CROSS JOIN platform_settings s
   WHERE r.tenant_id=$1 AND s.singleton=true FOR UPDATE OF a`,[payment.tenant_id]);
 if(!affiliate||affiliate.status!=='active')return null;
 const rate=affiliate.commission_rate_override_bps??affiliate.affiliate_default_rate_bps;
 const amount=commissionCents(Number(payment.amount_cents),rate);
 if(!amount)return null;
 return one(db,`INSERT INTO affiliate_commissions
  (payment_id,tenant_id,affiliate_id,eligible_amount_cents,rate_bps,commission_cents,available_at)
  VALUES($1,$2,$3,$4,$5,$6,now()+$7::int*interval '1 day')
  ON CONFLICT(payment_id) DO NOTHING RETURNING id,affiliate_id,commission_cents,rate_bps,available_at`,
 [payment.id,payment.tenant_id,affiliate.id,Number(payment.amount_cents),rate,amount,affiliate.affiliate_hold_days]);
}

/** The balance is a lifetime signed ledger: earned matured commissions minus
 * actual paid payouts and reserved requests. Reversed paid commissions create
 * a negative carry-forward, which future earnings must satisfy first.
 */
export async function affiliateBalance(db,id){
 const r=await one(db,`SELECT
   (SELECT COALESCE(sum(commission_cents),0)::bigint FROM affiliate_commissions
    WHERE affiliate_id=$1 AND reversed_at IS NULL) AS lifetime_earned_cents,
   (SELECT COALESCE(sum(commission_cents),0)::bigint FROM affiliate_commissions
    WHERE affiliate_id=$1 AND reversed_at IS NULL AND available_at>now()) AS pending_cents,
   (SELECT COALESCE(sum(commission_cents),0)::bigint FROM affiliate_commissions
    WHERE affiliate_id=$1 AND reversed_at IS NULL AND available_at<=now()) AS matured_cents,
   (SELECT COALESCE(sum(commission_cents),0)::bigint FROM affiliate_commissions
    WHERE affiliate_id=$1 AND reversed_at IS NOT NULL) AS reversed_cents,
   (SELECT COALESCE(sum(amount_cents),0)::bigint FROM affiliate_payouts
    WHERE affiliate_id=$1 AND status='paid') AS paid_out_cents,
   (SELECT COALESCE(sum(amount_cents),0)::bigint FROM affiliate_payouts
    WHERE affiliate_id=$1 AND status='requested') AS reserved_cents`,[id]);
 const toInt=x=>{const n=Number(x);if(!Number.isSafeInteger(n))throw fail(409,'Affiliate balance exceeds supported range');return n;};
 const earned=toInt(r.lifetime_earned_cents),pending=toInt(r.pending_cents),
 matured=toInt(r.matured_cents),reversed=toInt(r.reversed_cents),
 paid=toInt(r.paid_out_cents),reserved=toInt(r.reserved_cents);
 const balance=matured-paid-reserved;
 return {lifetime_earned_cents:earned,pending_cents:pending,
  reversed_cents:reversed,paid_out_cents:paid,reserved_cents:reserved,
  available_cents:balance,withdrawable_cents:Math.max(0,balance)};
}

/** Invoked in the same transaction as confirmed SaaS payment refund. */
export async function reverseAffiliateCommission(db,paymentId,reason){
 if(!isUuid(paymentId)||typeof reason!=='string'||!reason.trim()||reason.length>500)
  throw fail(400,'Valid payment and refund reason required');
 const account=await one(db,`SELECT a.id FROM affiliate_commissions c
    JOIN affiliate_accounts a ON a.id=c.affiliate_id WHERE c.payment_id=$1
    FOR UPDATE OF a`,[paymentId]);
 if(!account)return null;
 const reverted=await one(db,`UPDATE affiliate_commissions
     SET reversed_at=now(),reversal_reason=$2
     WHERE payment_id=$1 AND reversed_at IS NULL RETURNING id,affiliate_id,commission_cents`,
  [paymentId,reason.trim()]);
 if(reverted){
  await db.query(`UPDATE affiliate_payouts
    SET status='rejected',reviewed_at=now(),
     review_note='A subscription refund changed the available commission balance. Please request again.'
    WHERE affiliate_id=$1 AND status='requested'`,[account.id]);
 }
 return reverted??null;
}

export async function requestedPayout(db,affiliateId){
 const account=await one(db,'SELECT id FROM affiliate_accounts WHERE id=$1 AND status=\'active\' FOR UPDATE',[affiliateId]);
 if(!account)throw fail(403,'Affiliate account unavailable');
 const settings=await one(db,'SELECT affiliate_min_payout_cents FROM platform_settings WHERE singleton');
 const balance=await affiliateBalance(db,affiliateId);
 if(balance.reserved_cents>0)throw fail(409,'A payout request is already awaiting review');
 if(balance.withdrawable_cents<settings.affiliate_min_payout_cents)
  throw fail(409,'Available commissions are below the minimum payout amount');
 if(balance.withdrawable_cents>2147483647)throw fail(409,'Please contact support for a large payout');
 return one(db,`INSERT INTO affiliate_payouts(affiliate_id,amount_cents)
  VALUES($1,$2) RETURNING *`,[affiliateId,balance.withdrawable_cents]);
}

export async function payoutForAdmin(db,{payoutId,decision,actorId,reference='',note=''}) {
 if(!isUuid(payoutId)||!['paid','rejected'].includes(decision)||typeof reference!=='string'||
  reference.length>120||typeof note!=='string'||note.length>500)
  throw fail(400,'Invalid payout review');
 if(decision==='paid'&&(!reference.trim()||reference.trim().length<4))
  throw fail(400,'A confirmed transfer reference is required');
 const target=await one(db,'SELECT affiliate_id FROM affiliate_payouts WHERE id=$1',[payoutId]);
 if(!target)throw fail(404,'Payout unavailable');
 const account=await one(db,'SELECT id FROM affiliate_accounts WHERE id=$1 FOR UPDATE',[target.affiliate_id]);
 if(!account)throw fail(404,'Affiliate unavailable');
 const payout=await one(db,'SELECT * FROM affiliate_payouts WHERE id=$1 FOR UPDATE',[payoutId]);
 if(payout.status!=='requested')throw fail(409,'Payout already reviewed');
 if(decision==='paid'){
  const balances=await affiliateBalance(db,target.affiliate_id);
  if(balances.available_cents<0)throw fail(409,'Affiliate earnings changed. Reject and request a recalculation');
 }
 return one(db,`UPDATE affiliate_payouts SET status=$2,reviewed_at=now(),reviewed_by=$3,
   payment_reference=$4,review_note=$5 WHERE id=$1 AND status='requested' RETURNING *`,
  [payoutId,decision,actorId,decision==='paid'?reference.trim():null,note.trim()]);
}
