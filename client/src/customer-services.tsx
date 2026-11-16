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
function initialPlan(){return {product_id:'',name:'',description:'',duration:'months:1',custom:1};}
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
export function CustomerServices({request}:{request:Api}){
 const plans=useLoad(request,'service-plans');
 const customers=useLoad(request,'service-customers');
 const entitlements=useLoad(request,'service-entitlements');
 const products=useLoad(request,'products');
 const branches=useLoad(request,'branches');
 const [tab,setTab]=useState('memberships');
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
  await run(async()=>{
   await request(plan.id?'service-plans/'+plan.id:'service-plans',plan.id?'PUT':'POST',{
    product_id:plan.product_id,name:plan.name,description:plan.description,
    duration_kind:kind,duration_value:amount,active:plan.active!==false
   });
   setEditPlan(null);setPlan(initialPlan());
  },'Service plan saved.');
 }
 function openPlan(item?:any) {
  if(item){const raw=item.duration_kind==='none'?'none':item.duration_kind+':'+item.duration_value;
   setPlan({...item,duration:presets.some(([v])=>v===raw)?raw:item.duration_kind+':custom',custom:item.duration_value||1});
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
 const availableServices=(products.data||[]).filter((p:any)=>p.product_type==='service');
 const unconfigured=availableServices.filter((p:any)=>!(plans.data||[]).some((plan:any)=>plan.product_id===p.id));
 const records=entitlements.data||[];
 const status=(item:any)=>item.effective_status==='cancelled'?'Cancelled':item.effective_status==='expired'?'Expired':
  item.starts_on&&stamp(item.starts_on)>today()?'Scheduled':'Active';
 return <>
  <Heading title="Customer services & memberships" sub="Track gym passes, clinic service packages and other time-limited or lifetime customer entitlements. Grants are manual, audited records—not payment processing."/>
  {(error||notice)&&<p role={error?'alert':'status'} className={'flash '+(error?'error':'success')}>{error||notice}</p>}
  <div className="chip-row">
   {([['memberships','Memberships'],['customers','Customers'],['plans','Service plans']] as const).map(([key,label])=>
    <button key={key} className={'chip '+(tab===key?'chip-on':'')} onClick={()=>setTab(key)}>{label}</button>)}
  </div>
  {tab==='plans'&&<>
   <Panel title="Service plans" right={<Button onClick={()=>openPlan()}>Add service plan</Button>}>
    <p style={{padding:12}}>First create a product with type <strong>Service</strong> under Products & Services. Then configure its validity here. Editing a plan affects future grants and renewals, not existing expiry dates.</p>
    <Table items={plans.data||[]} columns={[
     ['name','Service plan'],['duration_kind','Default validity',(_:any,p:any)=>p.duration_kind==='none'?'Lifetime':p.duration_value+' '+p.duration_kind],
     ['price_cents','Catalog price',(v:any)=>'₱'+(Number(v||0)/100).toFixed(2)],
     ['active','Active',(v:any)=>v?'Yes':'No'],
     ['id','Actions',(_:any,p:any)=><Button secondary onClick={()=>openPlan(p)}>Edit</Button>]
    ]}/>
    {unconfigured.length===0&&availableServices.length===0&&<p style={{padding:12}}>No service products yet. Create one in the product catalog first.</p>}
   </Panel>
   {editPlan&&<div style={surface}>
    <h3>{plan.id?'Edit service plan':'New service plan'}</h3>
    <div style={formStyle}>
     {!plan.id&&<Field label="Service product"><select value={plan.product_id} onChange={e=>{
      const p=unconfigured.find((p:any)=>p.id===e.target.value);
      setPlan({...plan,product_id:e.target.value,name:p?.name||plan.name});
     }}><option value="">Select service product</option>{unconfigured.map((p:any)=><option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>}
     <Field label="Plan name"><input value={plan.name} maxLength={160} onChange={e=>setPlan({...plan,name:e.target.value})}/></Field>
     <DurationPicker value={plan.duration} onChange={duration=>setPlan({...plan,duration})}/>
     {plan.duration.endsWith(':custom')&&<Field label="Custom duration amount"><input type="number" min={1} max={plan.duration.startsWith('months')?120:3650} step={1}
       value={plan.custom} onChange={e=>setPlan({...plan,custom:e.target.value})}/></Field>}
    </div>
    <Field label="Description"><textarea value={plan.description||''} maxLength={2000} onChange={e=>setPlan({...plan,description:e.target.value})}/></Field>
    <label className="check"><input type="checkbox" checked={plan.active!==false} onChange={e=>setPlan({...plan,active:e.target.checked})}/> Available for new grants</label>
    <div style={rowStyle}><Button disabled={busy||!plan.name||(!plan.id&&!plan.product_id)} onClick={savePlan}>Save service plan</Button>
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
   <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(150px,1fr))',gap:10,marginBottom:12}}>
    {['Active','Scheduled','Expired','Cancelled'].map(key=><div style={surface} key={key}><small>{key}</small>
     <h2>{records.filter((p:any)=>status(p)===key).length}</h2></div>)}
   </div>
   <Panel title="Issue a membership / service entitlement">
    <p style={{padding:12}}>Administrative grant only. Granting or renewing does not create a POS sale or charge a customer. Confirm entitlement eligibility and payment separately.</p>
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
    <Table items={records} columns={[
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
