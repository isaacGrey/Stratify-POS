import React,{useEffect,useState} from 'react';
import {Plus,Percent,Wallet,ShieldCheck} from 'lucide-react';
import type {ApiRequest} from './types';
import {Button,Field,Heading,Modal,Panel,Table,fmt,money,useLoad} from './ui';

type Affiliate={id:string;name:string;email:string;referral_code:string;status:string;
 commission_rate_override_bps:number|null;referred_businesses:number;earned_cents:string};
type Payout={id:string;affiliate_id:string;affiliate_name:string;email:string;
 amount_cents:number;status:string;requested_at:string;payment_reference:string|null};
const percent=(basis:number|null|undefined)=>basis==null?'Default':(basis/100).toFixed(2)+'%';
function toBps(value:string):number|null{
 if(value.trim()==='')return null;
 const n=Number(value);if(!Number.isFinite(n)||n<0||n>100||Math.round(n*100)!==n*100)
  throw Error('Use a commission percentage from 0 to 100 with up to two decimals');
 return Math.round(n*100);
}
export function AffiliateAdmin({adminReq,request}:{adminReq:(path:string)=>Promise<any>;request:ApiRequest}){
 const {data:accounts,load:loadAccounts,err:accountsError}=useLoad(adminReq,'affiliates');
 const {data:settings,load:loadSettings,err:settingsError}=useLoad(adminReq,'affiliates/settings');
 const {data:payouts,load:loadPayouts,err:payoutError}=useLoad(adminReq,'affiliates/payouts');
 const [config,setConfig]=useState<{rate:string;hold:string;minimum:string}|null>(null);
 const [form,setForm]=useState<{name:string;email:string;password:string;referral_code:string;rate:string}|null>(null);
 const [editing,setEditing]=useState<{account:Affiliate;rate:string;status:string}|null>(null);
 const [review,setReview]=useState<{payout:Payout;decision:'paid'|'rejected';reference:string;note:string;confirmed:boolean}|null>(null);
 const [details,setDetails]=useState<Affiliate|null>(null);
 const [q,setQ]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState('');
 const [commissions,setCommissions]=useState<any[]>([]);
 useEffect(()=>{if(settings&&!config)setConfig({rate:String(settings.affiliate_default_rate_bps/100),
  hold:String(settings.affiliate_hold_days),minimum:String(settings.affiliate_min_payout_cents/100)});},[settings]);
 const refresh=()=>{loadAccounts();loadSettings();loadPayouts();};
 const save=async(path:string,method:string,body:object,done?:()=>void)=>{
  if(busy)return;setBusy(true);setError('');setMessage('');
  try{await request(path,method,body,true);done?.();refresh();setMessage('Affiliate settings saved.');}
  catch(e){setError(e instanceof Error?e.message:'Unable to save');}
  finally{setBusy(false);}
 };
 async function view(account:Affiliate){
  setDetails(account);setCommissions([]);
  try{const data=await adminReq('affiliates/'+account.id+'/commissions');setCommissions(data);}
  catch(e){setError(e instanceof Error?e.message:'Unable to load commissions');}
 }
 const filtered=((accounts||[]) as Affiliate[]).filter(a=>(a.name+' '+a.email+' '+a.referral_code).toLowerCase().includes(q.toLowerCase()));
 return <>
  <Heading eyebrow="STRATIFYPOS PLATFORM" title="Affiliate program"
   sub="Manage referral accounts, recurring subscription commissions, payment holds and manual payouts. Commissions are posted only after verified SaaS payments."
   action={<Button onClick={()=>setForm({name:'',email:'',password:'',referral_code:'',rate:''})}><Plus size={15}/> Add affiliate</Button>}/>
  {(error||accountsError||settingsError||payoutError)&&<p className="flash error" role="alert">{error||accountsError||settingsError||payoutError}</p>}
  {message&&<p className="flash success" role="status">{message}</p>}
  <Panel title="Default commission and payout settings">
   {config&&<div className="affiliate-admin-settings">
    <Field label="Default recurring commission (%)"><input inputMode="decimal" type="number" step=".01" min="0" max="100" value={config.rate}
     onChange={e=>setConfig(v=>({...v!,rate:e.target.value}))}/></Field>
    <Field label="Commission hold (days)"><input type="number" min="0" max="90" value={config.hold}
     onChange={e=>setConfig(v=>({...v!,hold:e.target.value}))}/></Field>
    <Field label="Minimum payout (₱)"><input type="number" min="1" max="1000000" step=".01" value={config.minimum}
     onChange={e=>setConfig(v=>({...v!,minimum:e.target.value}))}/></Field>
    <Button disabled={busy} onClick={async()=>{
     try{const rate=toBps(config.rate),hold=Number(config.hold),min=Math.round(Number(config.minimum)*100);
      if(rate===null||!Number.isInteger(hold)||!Number.isInteger(min)||min<100)
       throw Error('Fill in valid commission and payout settings');
      await save('affiliates/settings','PUT',{affiliate_default_rate_bps:rate,
       affiliate_hold_days:hold,affiliate_min_payout_cents:min});}
     catch(e){setError(e instanceof Error?e.message:'Invalid settings');}
    }}><Percent size={15}/> Save default settings</Button>
   </div>}
   <p className="padded muted">Rates and release dates are snapshotted when payments are verified. Editing rates does not recalculate historical commissions. No automatic payouts or bank transfers occur.</p>
  </Panel>
  <Panel title={'Affiliate accounts ('+filtered.length+')'}
   right={<input aria-label="Search affiliates" placeholder="Search name, email or referral code" value={q}
    onChange={e=>setQ(e.target.value)}/>}>
   <Table items={filtered} columns={[
    ['name','Affiliate'],['referral_code','Referral code'],
    ['referred_businesses','Referred businesses'],
    ['earned_cents','Net earnings',money],
    ['commission_rate_override_bps','Commission rate',percent],
    ['status','Status'],
    ['id','Actions',(_id,a:Affiliate)=><div className="inline-form">
     <button className="text-link" onClick={()=>setEditing({account:a,
      rate:a.commission_rate_override_bps==null?'':String(a.commission_rate_override_bps/100),
      status:a.status})}>Edit</button>
     <button className="text-link" onClick={()=>void view(a)}>Commissions</button>
    </div>]
   ]}/>
  </Panel>
  <Panel title="Affiliate payout requests">
   <Table items={(payouts||[]) as Payout[]} columns={[
    ['affiliate_name','Affiliate'],['amount_cents','Amount',money],
    ['requested_at','Requested',fmt],['status','Status'],
    ['payment_reference','Transfer reference'],
    ['id','Review',(_id,row:Payout)=>row.status==='requested'?
      <div className="inline-form">
       <button className="text-link" onClick={()=>setReview({payout:row,decision:'paid',reference:'',note:'',confirmed:false})}>Mark paid</button>
       <button className="text-link" onClick={()=>setReview({payout:row,decision:'rejected',reference:'',note:'',confirmed:false})}>Reject</button>
      </div>:'—']
   ]}/>
  </Panel>
  {form&&<Modal title="Create affiliate login" onClose={()=>setForm(null)}>
   <div className="modal-body">
    <p>Creates a separate affiliate login with no merchant POS or Super Admin access.</p>
    <Field label="Affiliate name"><input required maxLength={120} value={form.name} onChange={e=>setForm({...form,name:e.target.value})}/></Field>
    <Field label="Email"><input required type="email" value={form.email} onChange={e=>setForm({...form,email:e.target.value})}/></Field>
    <Field label="Initial password (12+ characters)"><input required type="password" minLength={12} autoComplete="new-password" value={form.password}
     onChange={e=>setForm({...form,password:e.target.value})}/></Field>
    <Field label="Referral code (optional; auto-generated)"><input maxLength={32} placeholder="SP-PARTNER01"
      value={form.referral_code} onChange={e=>setForm({...form,referral_code:e.target.value.toUpperCase()})}/></Field>
    <Field label="Commission override (%) — blank uses default"><input type="number" min="0" max="100" step=".01" value={form.rate}
      onChange={e=>setForm({...form,rate:e.target.value})}/></Field>
    <Button disabled={busy||!form.name.trim()||!form.email.trim()||form.password.length<12}
     onClick={async()=>{try{const rate=toBps(form.rate);await save('affiliates','POST',{
      name:form.name,email:form.email,password:form.password,
      referral_code:form.referral_code||undefined,commission_rate_override_bps:rate
     },()=>setForm(null));}catch(e){setError(e instanceof Error?e.message:'Invalid rate');}}}>Create affiliate</Button>
   </div>
  </Modal>}
  {editing&&<Modal title={'Manage '+editing.account.name} onClose={()=>setEditing(null)}>
   <div className="modal-body">
    <Field label="Affiliate status"><select value={editing.status} onChange={e=>setEditing({...editing,status:e.target.value})}>
     <option value="active">Active</option><option value="suspended">Suspended</option></select></Field>
    <Field label="Commission override (%) — leave blank for default"><input type="number" min="0" max="100" step=".01"
     value={editing.rate} onChange={e=>setEditing({...editing,rate:e.target.value})}/></Field>
    <p className="muted">Suspending prevents new referrals, login access, and future commission accrual. Historical earnings and payouts remain recorded.</p>
    <Button disabled={busy} onClick={async()=>{try{const rate=toBps(editing.rate);
     await save('affiliates/'+editing.account.id,'PATCH',{
      status:editing.status,commission_rate_override_bps:rate
     },()=>setEditing(null));}catch(e){setError(e instanceof Error?e.message:'Invalid override');}}}>Save affiliate</Button>
   </div>
  </Modal>}
  {review&&<Modal title={review.decision==='paid'?'Confirm payout transfer':'Reject payout request'} onClose={()=>setReview(null)}>
   <div className="modal-body">
    <p><strong>{review.payout.affiliate_name}</strong> · {money(review.payout.amount_cents)}.</p>
    {review.decision==='paid'&&<><p>Only mark paid after the funds have actually been sent. This system does not transfer money.</p>
     <Field label="Confirmed bank / wallet transfer reference"><input maxLength={120} required value={review.reference}
      onChange={e=>setReview({...review,reference:e.target.value})}/></Field>
     <label className="check"><input type="checkbox" checked={review.confirmed}
      onChange={e=>setReview({...review,confirmed:e.target.checked})}/> I verified that the payout was transferred.</label>
    </>}
    <Field label={review.decision==='paid'?'Review note (optional)':'Reason for rejection'}>
     <textarea maxLength={500} value={review.note} onChange={e=>setReview({...review,note:e.target.value})}/></Field>
    <Button disabled={busy||(review.decision==='paid'&&(!review.confirmed||review.reference.trim().length<4))||
      (review.decision==='rejected'&&!review.note.trim())} onClick={()=>void save('affiliates/payouts/'+review.payout.id+'/review','POST',
      {decision:review.decision,reference:review.reference,note:review.note},()=>setReview(null))}>
     <Wallet size={15}/> {review.decision==='paid'?'Record confirmed transfer':'Reject request'}
    </Button>
   </div>
  </Modal>}
  {details&&<Modal title={'Commission history · '+details.name} onClose={()=>setDetails(null)}>
   <div className="modal-body">
    <p>Commission rates are fixed per payment verification; refunded payments are reversed.</p>
    <Table items={commissions} columns={[
     ['business_name','Business'],['created_at','Verified',fmt],
     ['eligible_amount_cents','Paid subscription',money],
     ['rate_bps','Rate',v=>(v/100).toFixed(2)+'%'],
     ['commission_cents','Commission',money],['reversed_at','Reversed',fmt]
    ]}/>
   </div>
  </Modal>}
 </>;
}
