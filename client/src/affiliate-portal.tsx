import React,{useCallback,useEffect,useMemo,useState} from 'react';
import {Copy,LogOut,RefreshCcw,Users,Wallet,ReceiptText,ShieldCheck,ArrowUpRight} from 'lucide-react';
import {applicationOrigin} from './site-routing';
import {apiOrigin} from './site-routing';
import {Button,Heading,Panel,Table,fmt,money} from './ui';

type Balance={lifetime_earned_cents:number;pending_cents:number;reversed_cents:number;
 paid_out_cents:number;reserved_cents:number;available_cents:number;withdrawable_cents:number};
type Profile={affiliate:{id:string;name:string;email:string;referral_code:string;
 effective_rate_bps:number;commission_rate_override_bps:number|null};
 balance:Balance;payout_minimum_cents:number;hold_days:number;
 performance:{referred_businesses:number;active_subscriptions:number;sales_cents:string}};
type Referral={tenant_id:string;business_name:string;plan_id:string;
 subscription_status:string;attributed_at:string};
type Commission={id:string;payment_id:string;business_name:string;
 eligible_amount_cents:number;rate_bps:number;commission_cents:number;
 created_at:string;available_at:string;reversed_at:string|null;reversal_reason:string|null};
type Payout={id:string;amount_cents:number;status:string;
 requested_at:string;reviewed_at:string|null;payment_reference:string|null;review_note:string};
async function affiliateRequest<T>(token:string,path:string,method='GET',body?:object):Promise<T>{
 const response=await fetch(apiOrigin+'/api/affiliate/'+path,{method,
  headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},
  cache:'no-store',body:body===undefined?undefined:JSON.stringify(body)});
 const data=await response.json().catch(()=>({}));
 if(!response.ok)throw Error(data.error||'Affiliate request failed');
 return data as T;
}
export function AffiliatePortal({token,logout}:{token:string;logout:()=>void}){
 const [profile,setProfile]=useState<Profile|null>(null);
 const [referrals,setReferrals]=useState<Referral[]>([]);
 const [commissions,setCommissions]=useState<Commission[]>([]);
 const [payouts,setPayouts]=useState<Payout[]>([]);
 const [tab,setTab]=useState<'referrals'|'commissions'|'payouts'>('referrals');
 const [busy,setBusy]=useState(false),[loading,setLoading]=useState(true);
 const [error,setError]=useState(''),[notice,setNotice]=useState('');
 const refresh=useCallback(async()=>{
  try{
   const [p,r,c,x]=await Promise.all([
    affiliateRequest<Profile>(token,'me'),
    affiliateRequest<Referral[]>(token,'referrals'),
    affiliateRequest<Commission[]>(token,'commissions'),
    affiliateRequest<Payout[]>(token,'payouts')
   ]);
   setProfile(p);setReferrals(r);setCommissions(c);setPayouts(x);setError('');
  }catch(e){setError(e instanceof Error?e.message:'Unable to load affiliate data');}
  finally{setLoading(false);}
 },[token]);
 useEffect(()=>{void refresh();},[refresh]);
 const refUrl=useMemo(()=>profile?
  new URL('/register?ref='+encodeURIComponent(profile.affiliate.referral_code),
   applicationOrigin||window.location.origin).href:'',[profile]);
 async function copy(value:string,label:string){
  try{await navigator.clipboard.writeText(value);setNotice(label+' copied');}
  catch{setError('Clipboard unavailable. Please copy the text manually.');}
 }
 async function requestPayout(){
  if(busy)return;setBusy(true);setError('');setNotice('');
  try{await affiliateRequest(token,'payouts','POST',{});await refresh();
   setTab('payouts');setNotice('Payout request submitted for Super Admin review.');}
  catch(e){setError(e instanceof Error?e.message:'Could not request payout');}
  finally{setBusy(false);}
 }
 const available=profile?.balance.withdrawable_cents??0;
 const minimum=profile?.payout_minimum_cents??0;
 return <div className="affiliate-shell">
  <header className="affiliate-topbar">
   <div className="affiliate-brand"><img src="/stratify-logo.png" alt="" width="32" height="32"/>
    <span><strong>StratifyPOS</strong><small>Affiliate Partner Portal</small></span></div>
   <div className="inline-form">
    <Button secondary onClick={()=>{setLoading(true);void refresh()}} disabled={busy}><RefreshCcw size={15}/> Refresh</Button>
    <Button secondary onClick={logout}><LogOut size={15}/> Sign out</Button>
   </div>
  </header>
  <main className="affiliate-main">
   <Heading eyebrow="STRATIFYPOS PARTNERS" title={'Welcome'+(profile?', '+profile.affiliate.name.split(' ')[0]:'')}
    sub="Track registered businesses, verified subscription commissions, and payout requests. Only your own referrals are shown."/>
   {error&&<div className="flash error" role="alert">{error}</div>}
   {notice&&<div className="flash success" role="status">{notice}</div>}
   {loading&&!profile?<p className="padded">Loading your affiliate workspace…</p>:!profile?
    <Panel title="Account unavailable"><p className="padded">Your affiliate account could not be loaded. Check your status or contact StratifyPOS support.</p></Panel>:
    <>
     <div className="affiliate-metrics">
      <div><span>Lifetime commissions</span><strong>{money(profile.balance.lifetime_earned_cents)}</strong><small>Net of reversed earnings</small></div>
      <div><span>Available balance</span><strong>{money(available)}</strong><small>Eligible for payout</small></div>
      <div><span>Pending release</span><strong>{money(profile.balance.pending_cents)}</strong><small>{profile.hold_days}-day commission hold at current settings</small></div>
      <div><span>Paid out</span><strong>{money(profile.balance.paid_out_cents)}</strong><small>Confirmed transfers</small></div>
     </div>
     <div className="affiliate-metrics">
      <div><span>Total referred businesses</span><strong>{profile.performance?.referred_businesses??0}</strong><small>Attributed signup records</small></div>
      <div><span>Successful registrations</span><strong>{profile.performance?.referred_businesses??0}</strong><small>Completed business signup</small></div>
      <div><span>Active paid subscriptions</span><strong>{profile.performance?.active_subscriptions??0}</strong><small>Currently active and verified</small></div>
      <div><span>Verified subscription sales</span><strong>{money(Number(profile.performance?.sales_cents??0))}</strong><small>Excludes refunded payments</small></div>
     </div>
     <div className="affiliate-two-col">
      <Panel title="Your referral link">
       <div className="affiliate-referral">
        <div><span>Referral code</span><strong>{profile.affiliate.referral_code}</strong>
         <button className="text-link" onClick={()=>void copy(profile.affiliate.referral_code,'Referral code')}><Copy size={14}/> Copy code</button></div>
        <label className="field"><span>Share this registration link</span>
         <input readOnly value={refUrl} onFocus={e=>e.currentTarget.select()} aria-label="Registration referral link"/></label>
        <Button secondary onClick={()=>void copy(refUrl,'Referral link')}><Copy size={15}/> Copy referral link</Button>
        <p className="muted">A referred business is attributed at signup. Commissions start only after StratifyPOS verifies its subscription payment.</p>
       </div>
      </Panel>
      <Panel title="Commission and payout rules">
       <div className="affiliate-rules">
        <div><span>Current rate</span><strong>{(profile.affiliate.effective_rate_bps/100).toFixed(2)}%</strong></div>
        <div><span>Minimum payout</span><strong>{money(minimum)}</strong></div>
        <div><span>Awaiting payout review</span><strong>{money(profile.balance.reserved_cents)}</strong></div>
        {profile.balance.available_cents<0&&<p className="flash error">Refund reversals created a negative carry-forward of {money(-profile.balance.available_cents)}. Future commissions must offset it first.</p>}
        <Button disabled={busy||available<minimum||profile.balance.reserved_cents>0} onClick={()=>void requestPayout()}>
         <Wallet size={15}/> Request payout
        </Button>
        <p className="muted">Payouts are reviewed and transferred manually. A request does not automatically send money.</p>
       </div>
      </Panel>
     </div>
     <div className="affiliate-tabs" role="tablist" aria-label="Affiliate records">
      {([['referrals','Referred businesses'],['commissions','Commissions'],['payouts','Payout history']] as const).map(([key,label])=>
       <button key={key} type="button" className={tab===key?'active':''} role="tab"
        aria-selected={tab===key} onClick={()=>setTab(key)}>{label}</button>)}
     </div>
     {tab==='referrals'&&<Panel title={'Referred businesses ('+referrals.length+')'}>
      <Table items={referrals} columns={[
       ['business_name','Business'],['attributed_at','Registered',fmt],
       ['plan_id','Plan'],['subscription_status','Subscription']
      ]}/>
     </Panel>}
     {tab==='commissions'&&<Panel title="Verified subscription commissions">
      <Table items={commissions} columns={[
       ['business_name','Business'],['created_at','Verified',fmt],
       ['eligible_amount_cents','Payment',money],
       ['rate_bps','Rate',v=>(v/100).toFixed(2)+'%'],
       ['commission_cents','Commission',money],
       ['available_at','Status',(_v,c:Commission)=>c.reversed_at?'Reversed':new Date(c.available_at)>new Date()?'On hold':'Available / settled']
      ]}/>
     </Panel>}
     {tab==='payouts'&&<Panel title="Payout requests and transfers">
      <Table items={payouts} columns={[
       ['requested_at','Requested',fmt],['amount_cents','Amount',money],
       ['status','Status',v=>v.replace('_',' ')],
       ['reviewed_at','Reviewed',fmt],['payment_reference','Transfer reference']
      ]}/>
     </Panel>}
     <p className="affiliate-footnote"><ShieldCheck size={15}/> Affiliate records are separate from merchant POS accounts and customer transaction data.</p>
    </>}
  </main>
 </div>;
}
