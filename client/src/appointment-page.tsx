import React,{useMemo,useState} from 'react';
import {CalendarDays,CalendarPlus,ClipboardList,RefreshCcw} from 'lucide-react';
import {Button,Field,Heading,Modal,Panel,Table,fmt,useLoad} from './ui';
import type {ApiRequest} from './types';

const localDate=()=>{
 const d=new Date();return new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,10);
};
const addDays=(date:string,n:number)=>new Date(Date.parse(date)+n*86400000).toISOString().slice(0,10);
const datetimeLocal=(v:string)=>{
 if(!v)return '';
 const d=new Date(v);return new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,16);
};
const toIso=(v:string)=>v?new Date(v).toISOString():'';
const statuses=['pending','confirmed','rescheduled','completed','cancelled'];
const newAppointment=()=>({id:'',branch_id:'',customer_id:'',client_name:'',client_contact:'',
 service_name:'',requirements:'',resource_key:'default',
 starts_at:localDate()+'T09:00',ends_at:localDate()+'T10:00',status:'pending',note:''});
type Booking=ReturnType<typeof newAppointment>;
const badge=(status:string)=><span className={'badge '+(
 status==='confirmed'||status==='completed'?'green':
 status==='cancelled'?'red':'amber')}>{status}</span>;

export function AppointmentPage({request,role}:{request:ApiRequest;role:string}){
 const [from,setFrom]=useState(localDate());
 const [to,setTo]=useState(addDays(localDate(),30));
 const [branch,setBranch]=useState('');
 const [status,setStatus]=useState('');
 const [query,setQuery]=useState('');
 const [view,setView]=useState<'list'|'calendar'>('calendar');
 const [form,setForm]=useState<Booking|null>(null);
 const [history,setHistory]=useState<any>(null);
 const [busy,setBusy]=useState(false);
 const [error,setError]=useState('');
 const [notice,setNotice]=useState('');
 const {data:branches}=useLoad(request,'branches');
 const {data:customers}=useLoad(request,'service-customers');
 const {data:products}=useLoad(request,'products');
 const search=new URLSearchParams({from,to,...(branch?{branch_id:branch}:{}),
  ...(status?{status}:{}),...(query?{q:query}:{})}).toString();
 const bookings=useLoad(request,'appointments?'+search);
 const items=bookings.data||[];
 const days=useMemo(()=>{
  const map=new Map<string,any[]>();
  for(const entry of items){
   const date=datetimeLocal(entry.starts_at).slice(0,10);
   if(!map.has(date))map.set(date,[]);
   map.get(date)!.push(entry);
  }
  return [...map.entries()].sort(([a],[b])=>a.localeCompare(b));
 },[items]);
 function open(item?:any){
  setError('');
  setForm(item?{...item,starts_at:datetimeLocal(item.starts_at),
   ends_at:datetimeLocal(item.ends_at),customer_id:item.customer_id||'',note:''}:
   {...newAppointment(),branch_id:branch||branches?.[0]?.id||''});
 }
 async function save(){
  if(!form||busy)return;
  setBusy(true);setError('');setNotice('');
  try{
   const {id,note,...fields}=form;
   const body={...fields,customer_id:fields.customer_id||null,
    starts_at:toIso(fields.starts_at),ends_at:toIso(fields.ends_at),note};
   await request(id?'appointments/'+id:'appointments',id?'PUT':'POST',body);
   setForm(null);bookings.load();setNotice(id?'Appointment updated':'Appointment booked');
  }catch(e:any){setError(e?.message||'Appointment could not be saved');}
  finally{setBusy(false);}
 }
 async function inspect(item:any){
  setError('');
  try{setHistory({item,events:await request('appointments/'+item.id+'/events')});}
  catch(e:any){setError(e?.message||'History could not be loaded');}
 }
 const editing=role==='owner'||role==='manager'||role==='cashier';
 return <>
  <Heading eyebrow="CUSTOMER OPERATIONS" title="Appointment Scheduling"
   sub="Book clients, manage resources, prevent overlapping appointments and track status changes."
   action={editing&&<Button onClick={()=>open()}><CalendarPlus size={17}/> New appointment</Button>}/>
  <div className="booking-metrics">
   {statuses.slice(0,4).map(x=><div className="booking-metric" key={x}>
    <strong>{items.filter((a:any)=>a.status===x).length}</strong><span>{x}</span>
   </div>)}
  </div>
  <Panel title="Schedule & availability" right={<div className="inline-form">
   <Button secondary onClick={()=>setView('calendar')} disabled={view==='calendar'}><CalendarDays size={15}/> Calendar</Button>
   <Button secondary onClick={()=>setView('list')} disabled={view==='list'}><ClipboardList size={15}/> List</Button>
   <Button secondary onClick={bookings.load}><RefreshCcw size={14}/> Refresh</Button>
  </div>}>
   <div className="booking-filters">
    <Field label="From"><input type="date" value={from} onChange={e=>setFrom(e.target.value)}/></Field>
    <Field label="Through"><input type="date" value={to} onChange={e=>setTo(e.target.value)}/></Field>
    <Field label="Branch"><select value={branch} onChange={e=>setBranch(e.target.value)}>
     <option value="">All permitted branches</option>
     {(branches||[]).map((b:any)=><option key={b.id} value={b.id}>{b.name}</option>)}
    </select></Field>
    <Field label="Status"><select value={status} onChange={e=>setStatus(e.target.value)}>
     <option value="">All statuses</option>{statuses.map(x=><option key={x} value={x}>{x}</option>)}
    </select></Field>
    <Field label="Search client, service or requirements"><input value={query} maxLength={100}
     onChange={e=>setQuery(e.target.value)} placeholder="Find appointment"/></Field>
   </div>
   {(error||bookings.err)&&<p role="alert" className="flash error">{error||bookings.err}</p>}
   {notice&&<p role="status" className="flash success">{notice}</p>}
   {view==='list'?<Table items={items} columns={[
    ['client_name','Client'],['service_name','Service'],['branch_name','Branch'],
    ['starts_at','Starts',fmt],['ends_at','Ends',fmt],
    ['status','Status',(x:any)=>badge(x)],
    ['id','Actions',(_:any,a:any)=><div className="inline-form">
      {editing&&<button className="text-link" onClick={()=>open(a)}>Edit</button>}
      <button className="text-link" onClick={()=>inspect(a)}>History</button>
    </div>]
   ]}/>:
    <div className="booking-calendar">
     {!days.length&&<p className="padded">No bookings for these filters.</p>}
     {days.map(([date,list])=><div key={date} className="booking-day">
      <strong>{new Date(date+'T12:00:00').toLocaleDateString('en-PH',{weekday:'long',month:'short',day:'numeric'})}</strong>
      <div className="booking-day-cards">{list.map((a:any)=><button className="booking-card" key={a.id} onClick={()=>editing?open(a):inspect(a)}>
       <span className="booking-time">{new Date(a.starts_at).toLocaleTimeString('en-PH',{hour:'numeric',minute:'2-digit'})}</span>
       <b>{a.client_name}</b>
       <span>{a.service_name} · {a.branch_name}</span>
       <small>{a.resource_key} · {a.status}</small>
      </button>)}</div>
     </div>)}
    </div>}
  </Panel>
  {form&&<Modal title={form.id?'Edit appointment':'Book appointment'} onClose={()=>setForm(null)}>
   <div className="modal-body">
    <div className="booking-form">
     <Field label="Branch"><select disabled={!!form.id} value={form.branch_id} onChange={e=>setForm({...form,branch_id:e.target.value})}>
      <option value="">Choose branch</option>{(branches||[]).map((b:any)=><option key={b.id} value={b.id}>{b.name}</option>)}
     </select></Field>
     <Field label="Existing customer (optional)"><select value={form.customer_id} onChange={e=>{
      const c=(customers||[]).find((x:any)=>x.id===e.target.value);
      setForm({...form,customer_id:e.target.value,client_name:c?.name||form.client_name,
       client_contact:c?.phone||form.client_contact});
     }}><option value="">Walk-in / new client</option>
     {(customers||[]).map((c:any)=><option key={c.id} value={c.id}>{c.name}</option>)}
     </select></Field>
     <Field label="Client name"><input value={form.client_name} maxLength={160} onChange={e=>setForm({...form,client_name:e.target.value})}/></Field>
     <Field label="Contact (optional)"><input value={form.client_contact} maxLength={160} onChange={e=>setForm({...form,client_contact:e.target.value})}/></Field>
     <Field label="Service requested"><input list="appointment-services" value={form.service_name} maxLength={160} onChange={e=>setForm({...form,service_name:e.target.value})}/></Field>
     <datalist id="appointment-services">{(products||[]).filter((p:any)=>p.product_type==='service')
      .map((p:any)=><option key={p.id} value={p.name}/>)}</datalist>
     <Field label="Room / resource"><input value={form.resource_key} maxLength={80} onChange={e=>setForm({...form,resource_key:e.target.value})}/></Field>
     <Field label="Starts"><input type="datetime-local" value={form.starts_at}
      onChange={e=>setForm({...form,starts_at:e.target.value,
       status:form.id&&form.status!=='cancelled'&&form.status!=='completed'?'rescheduled':form.status})}/></Field>
     <Field label="Ends"><input type="datetime-local" value={form.ends_at}
      onChange={e=>setForm({...form,ends_at:e.target.value,
       status:form.id&&form.status!=='cancelled'&&form.status!=='completed'?'rescheduled':form.status})}/></Field>
     <Field label="Status"><select value={form.status} onChange={e=>setForm({...form,status:e.target.value})}>
      {statuses.map(x=><option key={x} value={x}>{x}</option>)}
     </select></Field>
     <Field label="Appointment requirements / notes"><textarea value={form.requirements} maxLength={1500}
      onChange={e=>setForm({...form,requirements:e.target.value})}/></Field>
     {!!form.id&&<Field label="Update reason"><input value={form.note} maxLength={300}
       onChange={e=>setForm({...form,note:e.target.value})}/></Field>}
    </div>
    {error&&<p className="flash error" role="alert">{error}</p>}
    <p className="operational-hint">Overlapping bookings for the same room/resource at the same branch are prevented by the server.</p>
    <Button onClick={save} disabled={busy||!form.branch_id||!form.client_name.trim()||!form.service_name.trim()||!form.starts_at||!form.ends_at}>
     {busy?'Saving…':form.id?'Update appointment':'Book appointment'}</Button>
   </div>
  </Modal>}
  {history&&<Modal title={'Appointment history · '+history.item.client_name} onClose={()=>setHistory(null)}>
   <div className="modal-body"><Table items={history.events} columns={[
    ['occurred_at','Recorded',fmt],['event_kind','Event'],['previous_status','Previous'],['new_status','New'],
    ['actor_name','Recorded by'],['note','Notes']
   ]}/></div>
  </Modal>}
 </>;
}
