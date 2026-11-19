import {one,rows} from './db.js';

const bad=(status,message)=>Object.assign(new Error(message),{status});
const uuid=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const dateOnly=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&!Number.isNaN(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value;
const isoTime=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)&&/(Z|[+-]\d{2}:\d{2})$/.test(value)&&Number.isFinite(Date.parse(value));
const short=(value,max)=>typeof value==='string'&&value.trim().length>0&&value.trim().length<=max;
const bookingTransitions={
 pending:['confirmed','rescheduled','cancelled'],
 confirmed:['rescheduled','completed','cancelled'],
 rescheduled:['confirmed','rescheduled','completed','cancelled'],
 completed:[],cancelled:[]
};
export function validateAppointment(body,old=null){
 const branch_id=body.branch_id??old?.branch_id;
 const customer_id=body.customer_id===undefined?old?.customer_id??null:body.customer_id||null;
 const client_name=body.client_name??old?.client_name;
 const client_contact=body.client_contact??old?.client_contact??'';
 const service_name=body.service_name??old?.service_name;
 const requirements=body.requirements??old?.requirements??'';
 const resource_key=(body.resource_key??old?.resource_key??'default').trim().toLowerCase();
 const starts_at=body.starts_at??(old?.starts_at instanceof Date?old.starts_at.toISOString():old?.starts_at);
 const ends_at=body.ends_at??(old?.ends_at instanceof Date?old.ends_at.toISOString():old?.ends_at);
 const status=body.status??old?.status??'pending';
 const start=Date.parse(starts_at),end=Date.parse(ends_at);
 if(!uuid.test(branch_id||'')||(customer_id&&!uuid.test(customer_id))||
  !short(client_name,160)||!short(service_name,160)||
  typeof client_contact!=='string'||client_contact.length>160||
  typeof requirements!=='string'||requirements.length>1500||
  !short(resource_key,80)||!isoTime(starts_at)||!isoTime(ends_at)||
  !Number.isFinite(start)||!Number.isFinite(end)||end<=start||
  end-start>24*60*60*1000||
  !Object.hasOwn(bookingTransitions,status))
  throw bad(400,'Invalid appointment details or times');
 if(old){
  if(branch_id!==old.branch_id)throw bad(409,'Move appointments by cancelling and rebooking at another branch');
  if(status!==old.status&&!bookingTransitions[old.status].includes(status))
   throw bad(409,'Appointment status transition is not allowed');
  if(['completed','cancelled'].includes(old.status))
   throw bad(409,'Completed and cancelled appointments cannot be edited');
  if(status==='rescheduled'&&old.status!=='rescheduled'&&
    start===Date.parse(old.starts_at)&&end===Date.parse(old.ends_at))
    throw bad(400,'A reschedule must change the appointment time');
 }
 return {branch_id,customer_id,client_name:client_name.trim(),
  client_contact:client_contact.trim(),service_name:service_name.trim(),
  requirements:requirements.trim(),resource_key,
  starts_at:new Date(start).toISOString(),ends_at:new Date(end).toISOString(),status};
}

export function registerAppointmentRoutes(app,{data,permit,audit}){
 const manage=permit('owner','manager','cashier');
 const ensureBranch=async(db,req,branch)=>{
  const visible=await one(db,`SELECT id FROM branches
    WHERE tenant_id=$1 AND id=$2 AND active=true`,[req.tenant,branch]);
  if(!visible)throw bad(404,'Branch unavailable');
 };
 const ensureCustomer=async(db,req,id)=>{
  if(!id)return;
  const found=await one(db,'SELECT id FROM service_customers WHERE tenant_id=$1 AND id=$2',[req.tenant,id]);
  if(!found)throw bad(404,'Customer unavailable');
 };
 const history=async(db,req,id)=>rows(db,`SELECT e.id,e.event_kind,e.previous_status,
   e.new_status,e.note,e.occurred_at,u.name AS actor_name
   FROM customer_appointment_events e JOIN users u ON u.id=e.actor_id
   JOIN customer_appointments a ON a.tenant_id=e.tenant_id AND a.id=e.appointment_id
   WHERE e.tenant_id=$1 AND e.appointment_id=$2 ORDER BY e.occurred_at,e.id`,[req.tenant,id]);

 app.get('/api/shop/appointments',data(async(db,req)=>{
  const q=req.query||{};
  const today=new Date().toISOString().slice(0,10);
  const from=q.from||today,to=q.to||new Date(Date.parse(today)+30*86400000).toISOString().slice(0,10);
  if(!dateOnly(from)||!dateOnly(to)||from>to||
    Date.parse(to)-Date.parse(from)>366*86400000||
    (q.branch_id&&!uuid.test(q.branch_id))||
    (q.status&&!Object.hasOwn(bookingTransitions,q.status))||
    (q.q&&String(q.q).length>100))
   throw bad(400,'Invalid appointment filters');
  if(q.branch_id)await ensureBranch(db,req,q.branch_id);
  return rows(db,`SELECT a.*,b.name AS branch_name,c.reference AS customer_reference
   FROM customer_appointments a
   JOIN branches b ON b.tenant_id=a.tenant_id AND b.id=a.branch_id
   LEFT JOIN service_customers c ON c.tenant_id=a.tenant_id AND c.id=a.customer_id
   WHERE a.tenant_id=$1 AND a.starts_at >= $2::date
     AND a.starts_at < ($3::date + interval '1 day')
     AND ($4::uuid IS NULL OR a.branch_id=$4)
     AND ($5::text IS NULL OR a.status=$5)
     AND (lower(a.client_name||' '||a.service_name||' '||a.requirements)
        LIKE '%'||lower($6::text)||'%')
   ORDER BY a.starts_at,a.id LIMIT 1000`,
   [req.tenant,from,to,q.branch_id||null,q.status||null,String(q.q||'').trim()]);
 }));

 app.get('/api/shop/appointments/:id/events',data(async(db,req)=>{
  if(!uuid.test(req.params.id))throw bad(400,'Invalid appointment ID');
  const found=await one(db,'SELECT id FROM customer_appointments WHERE tenant_id=$1 AND id=$2',
    [req.tenant,req.params.id]);
  if(!found)throw bad(404,'Appointment unavailable');
  return history(db,req,req.params.id);
 }));

 app.post('/api/shop/appointments',manage,data(async(db,req)=>{
  const p=validateAppointment(req.body);
  if(p.status!=='pending'&&p.status!=='confirmed')throw bad(400,'New appointments must be pending or confirmed');
  await ensureBranch(db,req,p.branch_id);
  await ensureCustomer(db,req,p.customer_id);
  try{
   const created=await one(db,`INSERT INTO customer_appointments
    (tenant_id,branch_id,customer_id,client_name,client_contact,service_name,requirements,
     resource_key,starts_at,ends_at,status,created_by,updated_by)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12) RETURNING *`,
    [req.tenant,p.branch_id,p.customer_id,p.client_name,p.client_contact,p.service_name,
     p.requirements,p.resource_key,p.starts_at,p.ends_at,p.status,req.user.id]);
   await db.query(`INSERT INTO customer_appointment_events
    (tenant_id,branch_id,appointment_id,actor_id,event_kind,new_status,note)
    VALUES($1,$2,$3,$4,'created',$5,'Appointment scheduled')`,
    [req.tenant,p.branch_id,created.id,req.user.id,p.status]);
   await audit(db,req,'appointment.created',{id:created.id,branch:p.branch_id});
   return created;
  }catch(e){if(e.code==='23P01')throw bad(409,'The selected time overlaps another booking for this resource');throw e;}
 }));

 app.put('/api/shop/appointments/:id',manage,data(async(db,req)=>{
  if(!uuid.test(req.params.id))throw bad(400,'Invalid appointment ID');
  const old=await one(db,`SELECT * FROM customer_appointments
   WHERE tenant_id=$1 AND id=$2 FOR UPDATE`,[req.tenant,req.params.id]);
  if(!old)throw bad(404,'Appointment unavailable');
  const p=validateAppointment(req.body,old);
  await ensureCustomer(db,req,p.customer_id);
  const changedTimes=Date.parse(old.starts_at)!==Date.parse(p.starts_at)||
    Date.parse(old.ends_at)!==Date.parse(p.ends_at);
  const kind=changedTimes?'rescheduled':p.status!==old.status?'status_changed':'updated';
  try{
   const updated=await one(db,`UPDATE customer_appointments
    SET customer_id=$3,client_name=$4,client_contact=$5,service_name=$6,
      requirements=$7,resource_key=$8,starts_at=$9,ends_at=$10,status=$11,
      updated_by=$12,updated_at=now()
    WHERE tenant_id=$1 AND id=$2 RETURNING *`,
    [req.tenant,old.id,p.customer_id,p.client_name,p.client_contact,p.service_name,
     p.requirements,p.resource_key,p.starts_at,p.ends_at,p.status,req.user.id]);
   await db.query(`INSERT INTO customer_appointment_events
    (tenant_id,branch_id,appointment_id,actor_id,event_kind,previous_status,new_status,note)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
    [req.tenant,old.branch_id,old.id,req.user.id,kind,old.status,p.status,
     String(req.body.note||'').slice(0,300)]);
   await audit(db,req,'appointment.updated',{id:old.id,status:p.status,kind});
   return updated;
  }catch(e){if(e.code==='23P01')throw bad(409,'The selected time overlaps another booking for this resource');throw e;}
 }));
}
