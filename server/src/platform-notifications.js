import {one,rows,pool} from './db.js';
const fail=(status,message)=>Object.assign(new Error(message),{status});
/** Derived from authoritative subscription/payment state; avoids duplicate notifications on retry. */
export const notificationQuery=`WITH events AS (
 SELECT 'payment:'||p.id::text||':'||p.status AS key,
  CASE WHEN p.status='paid' THEN 'Payment verified'
       WHEN p.status='pending' AND p.submitted_at IS NOT NULL THEN 'Payment awaiting approval'
       ELSE 'New subscription payment request' END AS title,
  t.name||' · '||p.plan_id AS description,
  CASE WHEN p.status='pending' THEN 'action' ELSE 'info' END AS level,
  CASE WHEN p.status='pending' AND p.submitted_at IS NOT NULL THEN p.submitted_at
       WHEN p.status='paid' THEN COALESCE(p.paid_at,p.created_at)
       ELSE p.created_at END AS occurred_at
 FROM subscription_payments p JOIN tenants t ON t.id=p.tenant_id
 WHERE p.status IN ('pending','paid') AND p.created_at>now()-interval '90 days'
 UNION ALL
 SELECT 'subscription:'||s.tenant_id::text||':'||s.status AS key,
  CASE WHEN s.status='trial' THEN 'Free trial started'
       WHEN s.status='cancelled' THEN 'Subscription cancelled'
       ELSE 'Subscription expired' END AS title,
  t.name||' · '||s.plan_id AS description,
  CASE WHEN s.status='trial' THEN 'info' ELSE 'action' END AS level,
  s.created_at AS occurred_at
 FROM subscriptions s JOIN tenants t ON t.id=s.tenant_id
 WHERE s.status IN ('trial','cancelled','expired')
 UNION ALL
 SELECT 'trial-ending:'||s.tenant_id::text||':'||s.trial_ends_at::date::text AS key,
  'Trial ending soon' AS title,t.name||' · '||s.trial_ends_at::date::text AS description,
  'action' AS level,
  now() AS occurred_at
 FROM subscriptions s JOIN tenants t ON t.id=s.tenant_id
 WHERE s.status='trial' AND s.trial_ends_at>now()
  AND s.trial_ends_at<=now()+interval '3 days'
 UNION ALL
 SELECT 'plan-change:'||c.id::text||':'||c.status AS key,
  CASE WHEN c.status IN ('pending','awaiting_payment') THEN 'Plan upgrade requires attention'
       WHEN c.status='applied' THEN 'Subscription upgraded' ELSE 'Plan request reviewed' END AS title,
  t.name||' · '||c.requested_plan_id AS description,
  CASE WHEN c.status IN ('pending','awaiting_payment') THEN 'action' ELSE 'info' END AS level,
  COALESCE(c.reviewed_at,c.created_at) AS occurred_at
 FROM plan_change_requests c JOIN tenants t ON t.id=c.tenant_id
 WHERE c.created_at>now()-interval '90 days'
)
SELECT e.key,e.title,e.description,e.level,e.occurred_at,
 r.read_at IS NOT NULL AS is_read
FROM events e LEFT JOIN platform_notification_reads r ON r.notification_key=e.key
ORDER BY e.occurred_at DESC,e.key LIMIT 150`;
export function registerPlatformNotifications(router,wrap){
 router.get('/notifications',wrap(async(_req,res)=>{
  res.set('Cache-Control','private,no-store');
  const items=await rows(pool,notificationQuery);
  res.json({items,unread:items.filter(i=>!i.is_read).length});
 }));
 router.post('/notifications/read',wrap(async(req,res)=>{
  const key=req.body?.key;
  if(typeof key!=='string'||key.length>160||!/^[a-z0-9:-]+$/i.test(key))
   throw fail(400,'Invalid notification');
  const found=(await rows(pool,notificationQuery)).find(x=>x.key===key);
  if(!found)throw fail(404,'Notification no longer available');
  await pool.query(`INSERT INTO platform_notification_reads(notification_key)
   VALUES($1) ON CONFLICT(notification_key) DO NOTHING`,[key]);
  res.json({ok:true});
 }));
}
