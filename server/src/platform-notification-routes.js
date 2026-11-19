import {one,rows,pool} from './db.js';

const bad=(status,message)=>Object.assign(new Error(message),{status});
const labels={
 'business.registered':'New business registered',
 'business.created':'Business created by administrator',
 'payment.verified':'Subscription payment verified',
 'payment.rejected':'Subscription payment rejected',
 'plan_request.approved':'Plan upgrade approved',
 'plan_request.rejected':'Plan request rejected',
 'plan.created':'Subscription plan created',
 'plan.updated':'Subscription plan changed',
 'subscription.payment_verified':'Subscription renewed',
 'subscription.activated':'Paid subscription activated',
 'subscription.cancelled':'Subscription cancelled',
 'subscription.expired':'Subscription expired'
};
const printable=s=>String(s||'').slice(0,160);
const timestamp=x=>new Date(x).getTime()||0;
export async function readPlatformNotifications(db,adminId){
 const [audit,pending,trials,subscriptions,reads]=await Promise.all([
  rows(db,`SELECT id,action,target,details,created_at FROM platform_audit_logs
   WHERE action=ANY($1::text[]) OR action LIKE 'subscription.%'
    OR action LIKE 'plan_request.%'
   ORDER BY created_at DESC,id DESC LIMIT 100`,
   [Object.keys(labels)]),
  rows(db,`SELECT p.id,p.tenant_id,t.name AS business,p.status,p.created_at,p.submitted_at,
    p.amount_cents,p.plan_id FROM subscription_payments p
    JOIN tenants t ON t.id=p.tenant_id
    WHERE p.status='pending' AND t.archived_at IS NULL
    ORDER BY COALESCE(p.submitted_at,p.created_at) DESC LIMIT 100`),
  rows(db,`SELECT s.tenant_id,t.name AS business,s.trial_ends_at FROM subscriptions s
   JOIN tenants t ON t.id=s.tenant_id WHERE s.plan_id='free'
    AND s.status='trial' AND s.trial_ends_at > now()
    AND s.trial_ends_at <= now()+interval '7 days'
    AND t.archived_at IS NULL ORDER BY s.trial_ends_at LIMIT 100`),
  rows(db,`SELECT s.tenant_id,t.name AS business,s.status,s.current_period_ends_at,
    s.trial_ends_at,s.created_at
   FROM subscriptions s JOIN tenants t ON t.id=s.tenant_id
   WHERE s.status IN ('cancelled','expired','past_due') AND t.archived_at IS NULL
   ORDER BY s.created_at DESC LIMIT 100`),
  rows(db,'SELECT notification_key FROM platform_notification_reads WHERE admin_id=$1',
    [adminId])
 ]);
 const read=new Set(reads.map(x=>x.notification_key));
 const items=[];
 for(const event of audit){
  const details=event.details||{};
  items.push({key:'audit:'+event.id,kind:event.action,
    title:labels[event.action]||event.action.replaceAll('_',' ').replaceAll('.',' · '),
    detail:printable(details.business||details.plan||event.target||'Platform activity'),
    created_at:event.created_at});
 }
 for(const payment of pending){
  items.push({key:'payment:'+payment.id,kind:'payment.pending',
   title:payment.submitted_at?'Subscription payment awaiting review':'New subscription payment request',
   detail:printable(payment.business)+' · '+printable(payment.plan_id)+
    ' · PHP '+(Number(payment.amount_cents)/100).toFixed(2),
   created_at:payment.submitted_at||payment.created_at});
 }
 for(const trial of trials){
  const expiry=new Date(trial.trial_ends_at).toISOString().slice(0,10);
  items.push({key:'trial:'+trial.tenant_id+':'+expiry,kind:'trial.expiring',
   title:'Free trial ending soon',detail:printable(trial.business)+' · ends '+expiry,
   created_at:trial.trial_ends_at});
 }
 for(const subscription of subscriptions){
  const when=subscription.current_period_ends_at||subscription.trial_ends_at||subscription.created_at;
  items.push({key:'subscription:'+subscription.tenant_id+':'+subscription.status+':'+
    new Date(when).toISOString().slice(0,10),
   kind:'subscription.'+subscription.status,title:'Subscription '+subscription.status.replaceAll('_',' '),
   detail:printable(subscription.business),created_at:when});
 }
 items.sort((a,b)=>timestamp(b.created_at)-timestamp(a.created_at)||a.key.localeCompare(b.key));
 return {unread:items.filter(x=>!read.has(x.key)).length,
  items:items.slice(0,100).map(x=>({...x,read:read.has(x.key)}))};
}
export function registerPlatformNotificationRoutes(app,{wrap,auth,admin}){
 app.get('/api/admin/notifications',auth,admin,wrap(async(req,res)=>{
  const result=await readPlatformNotifications(pool,req.user.id);
  res.set('Cache-Control','no-store').json(result);
 }));
 app.post('/api/admin/notifications/read',auth,admin,wrap(async(req,res)=>{
  const keys=req.body?.keys;
  if(!Array.isArray(keys)||keys.length<1||keys.length>100||keys.some(
    x=>typeof x!=='string'||x.length>120||!/^([a-z_]+:[a-zA-Z0-9:-]+)$/.test(x)))
   throw bad(400,'Invalid notification keys');
  const available=await readPlatformNotifications(pool,req.user.id);
  const valid=new Set(available.items.map(x=>x.key));
  if(keys.some(key=>!valid.has(key)))throw bad(404,'Notification unavailable');
  for(const key of [...new Set(keys)]){
   await pool.query(`INSERT INTO platform_notification_reads(admin_id,notification_key)
    VALUES($1,$2) ON CONFLICT(admin_id,notification_key) DO NOTHING`,[req.user.id,key]);
  }
  res.json({ok:true});
 }));
}
