import React,{useState} from 'react';
import {Button,Field,Heading,Panel,Table,fmt,useLoad} from './ui';

type Api=(path:string,method?:string,body?:any)=>Promise<any>;
const today=()=>{const d=new Date();return new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,10);};
const stamp=(s:any)=>s?String(s).slice(0,10):'No expiry';
const presets=[['none','No expiry'],['months:1','1 month'],['months:2','2 months'],['months:3','3 months'],['months:6','6 months'],['months:12','12 months / 1 year'],['months:24','2 years'],['days:7','7 days'],['days:30','30 days']];
function DurationPicker({value,onChange}:{value:string,onChange:(v:string)=>void}) {
 return <Field label="Default validity">
  <select value={value} onChange={e=>onChange(e.target.value)}>
   {presets.map(([v,n])=><option key={v} value={v}>{n}</option>)}
   <option value="months:custom">Custom months</option>
   <option value="days:custom">Custom days</option>
  </select>
 </Field>;
}
function initialPlan(){return {product_id:'',name:'',description:'',duration:'months:1',custom:1,price:'999',sell_through_pos:true};}
function initialCustomer(){return {name:'',email:'',phone:'',reference:'',notes:''};}
function InitialGrant(){return {customer_id:'',plan_id:'',branch_id:'',start_on:today(),expiry_mode:'plan',expires_on:'',reason:''};}
const rowStyle:React.CSSProperties={display:'flex',gap:8,alignItems:'center',flexWrap:'wrap'};
const formStyle:React.CSSProperties={display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(165px,1fr))',gap:10};
const surface:React.CSSProperties={padding:14,border:'1px solid var(--border, #d5d5d5)',borderRadius:12,marginTop:12};
function DateOptions({form,set}:{form:any,set:(v:any)=>void}){
 return <div style={formStyle}>
  <Field label="Start / renewal effective date"><input type="date" value={form.start_on} onChange={e=>set({...form,start_on:e.target.value})}/></Field>
  <Field label="Expiry calculation"><select value={form.expiry_mode} onChange={e=>set({...form,expiry_mode:e.target.value})}>
   <option value="plan">Use plan default</option><option value="custom">Custom expiry date</option><option value="none">No expiry / lifetime</option>
  </select></Field>
  {form.expiry_mode==='custom'&&<Field label="Custom expiry date"><input type="date" min={form.start_on} value={form.expires_on} onChange={e=>set({...form,expires_on:e.target.value})}/></Field>}
 </div>;
}
export function CustomerServices({request,readOnly=false}:{request:Api;readOnly?:boolean}){
 const plans=useLoad(request,'service-plans');
 const customers=useLoad(request,'service-customers');
 const entitlements=useLoad(request,'service-entitlements');
 const products=useLoad(request,'products');
 const branches=useLoad(request,'branches');
 const [tab,setTab]=useState('memberships');
 const [lookup,setLookup]=useState('');
 const [statusFilter,setStatusFilter]=useState('all');
 const [plan,setPlan]=useState<any>(initialPlan());
 const [customer,setCustomer]=useState<any>(initialCustomer());
 const [grant,setGrant]=useState<any>(InitialGrant());
 const [editPlan,setEditPlan]=useState<any>(null);
 const [editCustomer,setEditCustomer]=useState<any>(null);
 const [renew,setRenew]=useState<any>(null);
 const [history,setHistory]=useState<any>(null);
 const [reason,setReason]=useState('');
 const [busy,setBusy]=useState(false);
 const [error,setError]=useState('');
 const [notice,setNotice]=useState('');
 const refresh=()=>{plans.load();customers.load();entitlements.load();};
 async function run(work:()=>Promise<any>,message:string){
  setBusy(true);setError('');setNotice('');
  try{await work();setNotice(message);refresh();}
  catch(e:any){setError(e?.message||'Request failed');}
  finally{setBusy(false);}
 }
 async function savePlan(){
  const parsed=plan.duration.split(':');
  const kind=parsed[0],amount=parsed.length===1?null:
   parsed[1]==='custom'?Number(plan.custom):Number(parsed[1]);
  if(kind!=='none'&&(!Number.isInteger(amount)||amount<1))return setError('Choose a positive whole-number duration.');
  const priceCents=Math.round(Number(plan.price)*100);
  if(!Number.isInteger(priceCents)||priceCents<=0||priceCents>100000000)
   return setError('Enter a positive membership plan price.');
  await run(async()=>{
   await request(plan.id?'service-plans/'+plan.id:'service-plans',plan.id?'PUT':'POST',{
    product_id:plan.id?plan.product_id:null,name:plan.name,description:plan.description,
    price_cents:priceCents,sell_through_pos:plan.sell_through_pos===true,
    duration_kind:kind,duration_value:amount,active:plan.active!==false
   });
   setEditPlan(null);setPlan(initialPlan());
  },'Service plan saved.');
 }
 function openPlan(item?:any) {
  if(item){const raw=item.duration_kind==='none'?'none':item.duration_kind+':'+item.duration_value;
   setPlan({...item,duration:presets.some(([v])=>v===raw)?raw:item.duration_kind+':custom',custom:item.duration_value||1,price:String(Number(item.price_cents||0)/100)});
  }else setPlan(initialPlan());
  setEditPlan(true);
 }
 async function saveCustomer(){
  await run(async()=>{
   const payload={...customer,email:customer.email?.trim()||null,phone:customer.phone?.trim()||null,reference:customer.reference?.trim()||null};
   await request(customer.id?'service-customers/'+customer.id:'service-customers',customer.id?'PUT':'POST',payload);
   setEditCustomer(null);setCustomer(initialCustomer());
  },'Customer saved.');
 }
 async function openHistory(item:any){
  setError('');
  try{const events=await request('service-entitlements/'+item.id+'/events');setHistory({item,events});}
  catch(e:any){setError(e?.message||'History unavailable');}
 }
 const activePlans=(plans.data||[]).filter((p:any)=>p.active&&p.product_active);
 const availableServices=(products.data||[]).filter((p:any)=>p.product_type==='membership');
 const records=entitlements.data||[];
 const searched=records.filter((e:any)=>{
   const customer=(customers.data||[]).find((c:any)=>c.id===e.customer_id);
   const match=[e.customer_name,e.plan_name,customer?.reference].join(' ').toLowerCase().includes(lookup.trim().toLowerCase());
   return match&&(statusFilter==='all'||e.effective_status===statusFilter||
     (statusFilter==='scheduled'&&e.starts_on&&stamp(e.starts_on)>today()));
 });
 const status=(item:any)=>item.effective_status==='cancelled'?'Cancelled':item.effective_status==='expired'?'Expired':
  item.starts_on&&stamp(item.starts_on)>today()?'Scheduled':'Active';
 const summary=[
  {label:'Active',value:records.filter((e:any)=>e.effective_status==='active'&&stamp(e.starts_on)<=today()).length},
  {label:'Scheduled',value:records.filter((e:any)=>stamp(e.starts_on)>today()&&e.effective_status!=='cancelled').length},
  {label:'Expired',value:records.filter((e:any)=>e.effective_status==='expired').length},
  {label:'Cancelled',value:records.filter((e:any)=>e.effective_status==='cancelled').length}
 ];
 const metrics=<div className="membership-overview">
    {summary.map(x=><div key={x.label} className="membership-overview-card">
      <span>{x.label}</span><strong>{x.value}</strong>
    </div>)}
  </div>;
 const searchControls=<div className="membership-search">
  <Field label="Search member, reference or plan"><input value={lookup} maxLength={160}
    placeholder="Name, membership code or plan" onChange={e=>setLookup(e.target.value)}/></Field>
  <Field label="Membership status"><select value={statusFilter} onChange={e=>setStatusFilter(e.target.value)}>
    <option value="all">All statuses</option>
    <option value="active">Active</option><option value="scheduled">Scheduled</option>
    <option value="expired">Expired</option><option value="cancelled">Cancelled</option>
  </select></Field>
 </div>;
 if(readOnly)return <>
  <Heading title="Customer Memberships" sub="Reception lookup · Verify membership status, customer code and expiration before admitting a visitor."/>
  {metrics}
  <div style={{...surface,marginBottom:14}}>
   {searchControls}
   <p style={{fontSize:12}}>Verification only. Membership grants, renewals, cancellations and plan settings are restricted to managers and owners.</p>
  </div>
  <Panel title="Membership status">
    <Table items={searched} columns={[
      ['customer_name','Customer',(_:any,e:any)=>{const customer=(customers.data||[]).find((c:any)=>c.id===e.customer_id);
       return <span><strong>{e.customer_name}</strong>{customer?.reference&&<small style={{display:'block'}}>{customer.reference}</small>}</span>;}],
      ['plan_name','Plan'],['branch_name','Branch'],['starts_on','Starts',stamp],
      ['expires_on','Expires',stamp],['effective_status','Status',(_:any,e:any)=>status(e)],
      ['id','History',(_:any,e:any)=><Button secondary onClick={()=>openHistory(e)}>View</Button>]
    ]}/>
    {!searched.length&&<p style={{padding:12}}>No matching memberships.</p>}
  </Panel>
  {history&&<div style={surface}><div style={rowStyle}><h3>Membership history — {history.item.customer_name}</h3>
    <Button secondary onClick={()=>setHistory(null)}>Close</Button></div>
    <Table items={history.events} columns={[
      ['event_kind','Event'],['starts_on','Effective',stamp],['expires_on','New expiry',stamp],
      ['created_at','Recorded',fmt]
    ]}/>
  </div>}
 </>;
 return <>
  <Heading title="Customer Memberships" eyebrow="MEMBER MANAGEMENT"
   sub="Manage member profiles, tracked entitlements, POS-linked plans and membership history from one place."/>
  {metrics}
  {(error||notice)&&<p role={error?'alert':'status'} className={'flash '+(error?'error':'success')}>{error||notice}</p>}
  <div className="chip-row">
   {([['memberships','Member register'],['customers','Customer directory'],['plans','Membership plans']] as const).map(([key,label])=>
    <button key={key} className={'chip '+(tab===key?'chip-on':'')} onClick={()=>setTab(key)}>{label}</button>)}
  </div>
  {tab==='plans'&&<>
   <Panel title="Service plans" right={<Button onClick={()=>openPlan()}>Add service plan</Button>}>
    <p style={{padding:12}}>Create a membership plan with a price, duration and optional <strong>Sell through POS</strong> setting. A linked membership product is generated automatically. Existing memberships preserve their current expiry when you edit a plan.</p>
    <Table items={plans.data||[]} columns={[
     ['name','Service plan'],['duration_kind','Default validity',(_:any,p:any)=>p.duration_kind==='none'?'Lifetime':p.duration_value+' '+p.duration_kind],
     ['price_cents','Catalog price',(v:any)=>'₱'+(Number(v||0)/100).toFixed(2)],
     ['sell_through_pos','POS availability',(v:any)=>v?'Sellable':'Not listed'],
     ['active','Active',(v:any)=>v?'Yes':'No'],
     ['id','Actions',(_:any,p:any)=><Button secondary onClick={()=>openPlan(p)}>Edit</Button>]
    ]}/>
   </Panel>
   {editPlan&&<div style={surface}>
    <h3>{plan.id?'Edit service plan':'New service plan'}</h3>
    <div style={formStyle}>
     <Field label="Plan price (PHP)"><input type="number" min="0.01" max="1000000" step="0.01" value={plan.price}
       onChange={e=>setPlan({...plan,price:e.target.value})}/></Field>
     <Field label="Plan name"><input value={plan.name} maxLength={160} onChange={e=>setPlan({...plan,name:e.target.value})}/></Field>
     <DurationPicker value={plan.duration} onChange={duration=>setPlan({...plan,duration})}/>
     {plan.duration.endsWith(':custom')&&<Field label="Custom duration amount"><input type="number" min={1} max={plan.duration.startsWith('months')?120:3650} step={1}
       value={plan.custom} onChange={e=>setPlan({...plan,custom:e.target.value})}/></Field>}
    </div>
    <Field label="Description"><textarea value={plan.description||''} maxLength={2000} onChange={e=>setPlan({...plan,description:e.target.value})}/></Field>
    <label className="check"><input type="checkbox" checked={plan.sell_through_pos===true}
       onChange={e=>setPlan({...plan,sell_through_pos:e.target.checked})}/> Sell through POS (customer required at checkout)</label>
    <label className="check"><input type="checkbox" checked={plan.active!==false} onChange={e=>setPlan({...plan,active:e.target.checked})}/> Active membership plan</label>
    <div style={rowStyle}><Button disabled={busy||!plan.name} onClick={savePlan}>Save service plan</Button>
     <Button secondary onClick={()=>setEditPlan(null)}>Cancel</Button></div>
   </div>}
  </>}
  {tab==='customers'&&<>
   <Panel title="Service customers" right={<Button onClick={()=>{setCustomer(initialCustomer());setEditCustomer(true);}}>Add customer</Button>}>
    <Table items={customers.data||[]} columns={[
     ['name','Name'],['reference','Reference'],['email','Email'],['phone','Phone'],
     ['id','Action',(_:any,p:any)=><Button secondary onClick={()=>{setCustomer(p);setEditCustomer(true);}}>Edit</Button>]
    ]}/>
   </Panel>
   {editCustomer&&<div style={surface}><h3>{customer.id?'Edit customer':'New customer'}</h3>
    <div style={formStyle}>
     {([['name','Name'],['reference','Member ID / reference'],['email','Email (optional)'],['phone','Phone (optional)']] as const).map(([key,label])=>
      <Field label={label} key={key}><input value={customer[key]||''} onChange={e=>setCustomer({...customer,[key]:e.target.value})}/></Field>)}
    </div>
    <Field label="Notes (avoid sensitive clinical records)"><textarea value={customer.notes||''} maxLength={1000} onChange={e=>setCustomer({...customer,notes:e.target.value})}/></Field>
    <div style={rowStyle}><Button disabled={busy||!customer.name.trim()} onClick={saveCustomer}>Save customer</Button>
     <Button secondary onClick={()=>setEditCustomer(null)}>Cancel</Button></div>
   </div>}
  </>}
  {tab==='memberships'&&<>
   {searchControls}
   <Panel title="Issue a membership / service entitlement">
    <p style={{padding:12}}>Manual administrative grant. POS-paid memberships appear in this same register automatically; this form does not charge the customer.</p>
    <div style={{...formStyle,padding:12}}>
     <Field label="Customer"><select value={grant.customer_id} onChange={e=>setGrant({...grant,customer_id:e.target.value})}>
      <option value="">Select customer</option>{(customers.data||[]).map((p:any)=><option key={p.id} value={p.id}>{p.name}</option>)}
     </select></Field>
     <Field label="Service plan"><select value={grant.plan_id} onChange={e=>setGrant({...grant,plan_id:e.target.value})}>
      <option value="">Select plan</option>{activePlans.map((p:any)=><option key={p.id} value={p.id}>{p.name}</option>)}
     </select></Field>
     <Field label="Branch"><select value={grant.branch_id} onChange={e=>setGrant({...grant,branch_id:e.target.value})}>
      <option value="">Select branch</option>{(branches.data||[]).filter((p:any)=>p.active).map((p:any)=><option key={p.id} value={p.id}>{p.name}</option>)}
     </select></Field>
    </div>
    <div style={{padding:12}}><DateOptions form={grant} set={setGrant}/>
     <Field label="Reason / payment verification reference (required)"><input maxLength={500} value={grant.reason} onChange={e=>setGrant({...grant,reason:e.target.value})} placeholder="e.g., bank deposit checked manually"/></Field>
     <Button disabled={busy||!grant.customer_id||!grant.plan_id||!grant.branch_id||grant.reason.trim().length<5}
      onClick={()=>run(async()=>{await request('service-entitlements','POST',grant);setGrant(InitialGrant());},'Membership issued.')}>Issue membership</Button>
    </div>
   </Panel>
   <Panel title="Membership register">
    <Table items={searched} columns={[
     ['customer_name','Customer'],['plan_name','Service'],['branch_name','Branch'],
     ['starts_on','Starts',stamp],['expires_on','Expires',stamp],
     ['effective_status','Status',(_:any,p:any)=>status(p)],
     ['id','Actions',(_:any,p:any)=><div style={rowStyle}>
      <Button secondary onClick={()=>openHistory(p)}>History</Button>
      {p.status==='active'&&<Button secondary onClick={()=>{setRenew({id:p.id,start_on:p.expires_on&&stamp(p.expires_on)>today()?stamp(p.expires_on):today(),
       expiry_mode:'plan',expires_on:'',reason:''});setReason('');}}>Renew</Button>}
      {p.status==='active'&&<button className="text-link" onClick={()=>{
       const explanation=window.prompt('Reason for cancelling this membership (minimum five characters):');
       if(!explanation)return;
       if(!window.confirm('Cancel this membership? Its access will end immediately.'))return;
       run(()=>request('service-entitlements/'+p.id+'/cancel','POST',{reason:explanation}),'Membership cancelled.');
      }}>Cancel</button>}
     </div>]
    ]}/>
   </Panel>
   {renew&&<div style={surface}><h3>Renew membership</h3>
    <p>Renewals are manual and do not charge a customer. For existing valid memberships, the renewal begins on the previous expiry date unless you change it.</p>
    <DateOptions form={renew} set={setRenew}/>
    <Field label="Renewal reason / payment reference"><input value={renew.reason} maxLength={500} onChange={e=>setRenew({...renew,reason:e.target.value})}/></Field>
    <div style={rowStyle}><Button disabled={busy||renew.reason.trim().length<5} onClick={()=>run(async()=>{
     await request('service-entitlements/'+renew.id+'/renew','POST',renew);setRenew(null);
    },'Membership renewed.')}>Save renewal</Button><Button secondary onClick={()=>setRenew(null)}>Cancel</Button></div>
   </div>}
   {history&&<div style={surface}><div style={rowStyle}><h3>Entitlement history — {history.item.customer_name}</h3>
    <Button secondary onClick={()=>setHistory(null)}>Close</Button></div>
    <Table items={history.events} columns={[
     ['event_kind','Event'],['starts_on','Effective',stamp],['previous_expires_on','Previous expiry',stamp],
     ['expires_on','New expiry',stamp],['actor_name','Recorded by'],['reason','Reason'],['created_at','Recorded',fmt]
    ]}/>
   </div>}
  </>}
  {!plans.data||!customers.data||!entitlements.data||!products.data||!branches.data?<p>Loading service management data…</p>:null}
 </>;
}
