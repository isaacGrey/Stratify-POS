import React,{useState} from 'react';
import type {ApiRequest} from './types';
import {Button,Field,Heading,Load,Modal,Panel,Table,fmt,useLoad} from './ui';
import {CalendarDays,Plus} from 'lucide-react';

type Appointment={
 id:string;branch_id:string;customer_id:string|null;customer_name:string;service_name:string;
 contact:string;resource_name:string;requirements:string;notes:string;starts_at:string;ends_at:string;
 status:'pending'|'confirmed'|'rescheduled'|'completed'|'cancelled';branch_name?:string
};
const states=['pending','confirmed','rescheduled','completed','cancelled'] as const;
const dateTime=(v:string)=>{const d=new Date(v);return Number.isNaN(d.getTime())?'':new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,16)};
const blank=():Partial<Appointment>=>({customer_id:null,branch_id:'',customer_name:'',service_name:'',
 contact:'',resource_name:'General',requirements:'',notes:'',
 starts_at:dateTime(new Date(Date.now()+3600000).toISOString()),
 ends_at:dateTime(new Date(Date.now()+5400000).toISOString()),status:'pending'});
const stamp=v=>new Date(v).toLocaleTimeString('en-PH',{hour:'numeric',minute:'2-digit'});
export function AppointmentsPage({request}:{request:ApiRequest}){
 const [from,setFrom]=useState(new Date().toISOString().slice(0,10));
 const [to,setTo]=useState(new Date(Date.now()+7*86400000).toISOString().slice(0,10));
 const [query,setQuery]=useState(''),[status,setStatus]=useState(''),[branch,setBranch]=useState('');
 const [view,setView]=useState<'list'|'calendar'>('list');
 const [draft,setDraft]=useState<Partial<Appointment>|null>(null);
 const [working,setWorking]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const branches=useLoad(request,'branches'),customers=useLoad(request,'service-customers');
 const params=new URLSearchParams({from,to,q:query,status,branch_id:branch});
 const {data,err,load}=useLoad(request,'appointments?'+params.toString());
 const appointments=(data||[]) as Appointment[];
 const grouped=appointments.reduce<Record<string,Appointment[]>>((r,a)=>{
  const day=new Date(a.starts_at).toLocaleDateString('en-CA');(r[day]??=[]).push(a);return r;
 },{});
 function open(row?:Appointment){setError('');setDraft(row?{...row,starts_at:dateTime(row.starts_at),ends_at:dateTime(row.ends_at)}:
   {...blank(),branch_id:branch||(branches.data||[])[0]?.id||''});}
 function update(key:string,value:any){setDraft(d=>({...d,[key]:value}));}
 async function save(){
  if(!draft||working)return;setWorking(true);setError('');
  try{
   const payload={...draft,customer_id:draft.customer_id||null,
    starts_at:new Date(draft.starts_at||'').toISOString(),
    ends_at:new Date(draft.ends_at||'').toISOString()};
   await request(draft.id?'appointments/'+draft.id:'appointments',draft.id?'PUT':'POST',payload);
   setNotice(draft.id?'Appointment updated':'Appointment booked');setDraft(null);load();
  }catch(e){setError(e instanceof Error?e.message:'Could not save appointment');}
  finally{setWorking(false);}
 }
 async function quick(row:Appointment,next:Appointment['status']){
  setWorking(true);setError('');
  try{await request('appointments/'+row.id,'PUT',{...row,status:next});
   setNotice('Appointment '+next);load();}
  catch(e){setError(e instanceof Error?e.message:'Status update failed');}
  finally{setWorking(false);}
 }
 return <>
  <Heading title="Appointment scheduling" sub="Book, reschedule and manage client appointments across your branches. Conflicting times for the same room or resource are blocked."
   action={<Button onClick={()=>open()}><Plus size={16}/> Book appointment</Button>}/>
  {(error||err)&&<p className="flash error" role="alert">{error||err}</p>}
  {notice&&<p className="flash success" role="status">{notice}</p>}
  <Panel title="Find appointments" right={<div className="inline-form">
   <Button secondary onClick={()=>setView('list')} disabled={view==='list'}>List</Button>
   <Button secondary onClick={()=>setView('calendar')} disabled={view==='calendar'}><CalendarDays size={16}/> Calendar</Button>
  </div>}>
   <div className="form-grid padded">
    <Field label="From"><input type="date" value={from} onChange={e=>setFrom(e.target.value)}/></Field>
    <Field label="Through"><input type="date" min={from} value={to} onChange={e=>setTo(e.target.value)}/></Field>
    <Field label="Search client, service or room"><input placeholder="Search appointments" value={query} onChange={e=>setQuery(e.target.value)}/></Field>
    <Field label="Status"><select value={status} onChange={e=>setStatus(e.target.value)}>
      <option value="">All statuses</option>{states.map(s=><option value={s} key={s}>{s}</option>)}
    </select></Field>
    <Field label="Branch"><select value={branch} onChange={e=>setBranch(e.target.value)}>
      <option value="">All permitted branches</option>{(branches.data||[]).map((b:any)=><option value={b.id} key={b.id}>{b.name}</option>)}
    </select></Field>
   </div>
  </Panel>
  {!data&&!err?<Load/>:view==='list'?<Panel title={'Appointments · '+appointments.length}>
    <Table items={appointments} columns={[
     ['starts_at','Start',fmt],['customer_name','Client'],['service_name','Service'],
     ['branch_name','Branch'],['resource_name','Room / Resource'],['status','Status',v=><span className="badge">{v}</span>],
     ['id','Actions',(_,a:Appointment)=><div className="inline-form"><button className="text-link" onClick={()=>open(a)}>Details / Edit</button>
       {a.status==='pending'&&<button className="text-link" disabled={working} onClick={()=>quick(a,'confirmed')}>Confirm</button>}
       {a.status!=='cancelled'&&a.status!=='completed'&&<button className="text-link" disabled={working} onClick={()=>quick(a,'completed')}>Complete</button>}</div>]
    ]}/>
  </Panel>:<div className="appointment-calendar">
    {Object.keys(grouped).sort().map(day=><Panel title={day} key={day}>
      <div className="appointment-day">{grouped[day].map(a=><button className="appointment-entry" key={a.id} onClick={()=>open(a)}>
       <strong>{stamp(a.starts_at)} – {stamp(a.ends_at)}</strong>
       <span>{a.customer_name} · {a.service_name}</span>
       <small>{a.resource_name} · {a.status}</small>
      </button>)}</div>
    </Panel>)}
    {!appointments.length&&<p className="padded">No appointments for the selected dates.</p>}
  </div>}
  {draft&&<Modal title={draft.id?'Manage appointment':'Book an appointment'} onClose={()=>setDraft(null)}>
   <div className="modal-body">
    <div className="form-grid">
     <Field label="Client"><input required value={draft.customer_name||''} maxLength={160} onChange={e=>update('customer_name',e.target.value)}/></Field>
     <Field label="Existing customer (optional)"><select value={draft.customer_id||''} onChange={e=>{
       const customer=(customers.data||[]).find((c:any)=>c.id===e.target.value);
       setDraft(d=>({...d,customer_id:e.target.value||null,
         customer_name:customer?.name||d?.customer_name||''}));}}>
       <option value="">Unlinked client</option>{(customers.data||[]).map((c:any)=><option value={c.id} key={c.id}>{c.name}</option>)}
     </select></Field>
     <Field label="Service requested"><input required maxLength={160} value={draft.service_name||''} onChange={e=>update('service_name',e.target.value)}/></Field>
     <Field label="Contact (optional)"><input maxLength={180} value={draft.contact||''} onChange={e=>update('contact',e.target.value)}/></Field>
     <Field label="Branch"><select value={draft.branch_id||''} onChange={e=>update('branch_id',e.target.value)}>
       <option value="">Select branch</option>{(branches.data||[]).map((b:any)=><option value={b.id} key={b.id}>{b.name}</option>)}
     </select></Field>
     <Field label="Room / staff / resource"><input required maxLength={120} value={draft.resource_name||''} onChange={e=>update('resource_name',e.target.value)}/></Field>
     <Field label="Starts"><input type="datetime-local" value={draft.starts_at||''} onChange={e=>update('starts_at',e.target.value)}/></Field>
     <Field label="Ends"><input type="datetime-local" value={draft.ends_at||''} min={draft.starts_at} onChange={e=>update('ends_at',e.target.value)}/></Field>
     <Field label="Status"><select value={draft.status||'pending'} onChange={e=>update('status',e.target.value)}>
       {states.map(s=><option key={s} value={s}>{s}</option>)}</select></Field>
    </div>
    <Field label="Client requirements"><textarea maxLength={2000} value={draft.requirements||''} onChange={e=>update('requirements',e.target.value)}/></Field>
    <Field label="Internal notes"><textarea maxLength={2000} value={draft.notes||''} onChange={e=>update('notes',e.target.value)}/></Field>
    {error&&<p className="flash error">{error}</p>}
    <div className="inline-form"><Button disabled={working||!draft.branch_id||!draft.customer_name?.trim()||!draft.service_name?.trim()}
      onClick={save}>{working?'Saving…':draft.id?'Save changes':'Create appointment'}</Button>
      <Button secondary onClick={()=>setDraft(null)}>Cancel</Button>
    </div>
   </div>
  </Modal>}
 </>;
}
