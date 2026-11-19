import {one,rows} from './db.js';
const uuid=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const invalid=message=>Object.assign(new Error(message),{status:400});
const conflict=()=>Object.assign(new Error('This resource already has an appointment during the selected times'),{status:409});
const text=(value,max,required=false)=>typeof value==='string'&&value.length<=max&&(!required||value.trim().length>0);
const stamp=v=>typeof v==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d/.test(v)&&Number.isFinite(Date.parse(v))&&/(Z|[+-]\d\d:\d\d)$/.test(v);
const statuses=['pending','confirmed','rescheduled','completed','cancelled'];
export function validateAppointmentInput(body,existing=null){
 const data={...existing,...body};
 if(!uuid.test(data.branch_id)||data.customer_id!=null&&!uuid.test(data.customer_id)||
  !text(data.customer_name,160,true)||!text(data.service_name,160,true)||
  !text(data.contact??'',180)||!text(data.resource_name??'General',120,true)||
  !text(data.requirements??'',2000)||!text(data.notes??'',2000)||
  !statuses.includes(data.status??'pending')||
  !stamp(data.starts_at)||!stamp(data.ends_at))
   throw invalid('Invalid appointment details, branch, dates, or status');
 const start=new Date(data.starts_at),end=new Date(data.ends_at);
 if(end<=start||end-start>86400000)throw invalid('Appointment duration must be 1 minute to 24 hours');
 return {branch_id:data.branch_id,customer_id:data.customer_id??null,
  customer_name:data.customer_name.trim(),service_name:data.service_name.trim(),
  contact:(data.contact??'').trim(),resource_name:(data.resource_name??'General').trim(),
  requirements:data.requirements??'',notes:data.notes??'',status:data.status??'pending',
  starts_at:start.toISOString(),ends_at:end.toISOString()};
}
export function registerAppointmentRoutes(app,{data,permit,audit,fail}){
 const access=permit('owner','manager','cashier');
 app.get('/api/shop/appointments',access,data(async(db,req)=>{
  const {from='',to='',q='',status='',branch_id=''}=req.query;
  if(typeof q!=='string'||q.length>160||status&&!statuses.includes(status)||
    branch_id&&!uuid.test(branch_id)||from&&!/^\d{4}-\d\d-\d\d$/.test(from)||
    to&&!/^\d{4}-\d\d-\d\d$/.test(to))throw invalid('Invalid appointment filters');
  return rows(db,`SELECT a.*,b.name AS branch_name,c.reference AS customer_reference
   FROM customer_appointments a
   JOIN branches b ON b.tenant_id=a.tenant_id AND b.id=a.branch_id
   LEFT JOIN service_customers c ON c.tenant_id=a.tenant_id AND c.id=a.customer_id
   WHERE a.tenant_id=$1 AND ($2::uuid IS NULL OR a.branch_id=$2)
    AND ($3::text='' OR a.status=$3)
    AND ($4::date IS NULL OR a.ends_at >= $4::date)
    AND ($5::date IS NULL OR a.starts_at < ($5::date + interval '1 day'))
    AND (a.customer_name ILIKE '%'||$6||'%' OR a.service_name ILIKE '%'||$6||'%'
      OR a.resource_name ILIKE '%'||$6||'%')
   ORDER BY a.starts_at,a.id LIMIT 500`,
   [req.tenant,branch_id||null,status,from||null,to||null,q.trim()]);
 }));
 app.post('/api/shop/appointments',access,data(async(db,req)=>{
  const a=validateAppointmentInput(req.body||{});
  const branch=await one(db,'SELECT id FROM branches WHERE tenant_id=$1 AND id=$2 AND active=true',
   [req.tenant,a.branch_id]);
  if(!branch)throw fail(404,'Branch unavailable');
  if(a.customer_id&&!await one(db,'SELECT id FROM service_customers WHERE tenant_id=$1 AND id=$2',
   [req.tenant,a.customer_id]))throw fail(404,'Customer unavailable');
  try{
   const result=await one(db,`INSERT INTO customer_appointments
    (tenant_id,branch_id,customer_id,customer_name,service_name,contact,resource_name,
     requirements,notes,starts_at,ends_at,status,created_by)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
    [req.tenant,a.branch_id,a.customer_id,a.customer_name,a.service_name,a.contact,
     a.resource_name,a.requirements,a.notes,a.starts_at,a.ends_at,a.status,req.user.id]);
   await audit(db,req,'appointment.created',{id:result.id,branch_id:a.branch_id,status:a.status});
   return result;
  }catch(error){if(error.code==='23P01')throw conflict();throw error;}
 }));
 app.put('/api/shop/appointments/:id',access,data(async(db,req)=>{
  if(!uuid.test(req.params.id))throw invalid('Invalid appointment identifier');
  const previous=await one(db,'SELECT * FROM customer_appointments WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
   [req.tenant,req.params.id]);
  if(!previous)throw fail(404,'Appointment unavailable');
  const a=validateAppointmentInput(req.body||{},previous);
  if(previous.status==='cancelled'&&a.status!=='cancelled')
   throw fail(409,'Cancelled appointments cannot be reopened');
  if(a.customer_id&&!await one(db,'SELECT id FROM service_customers WHERE tenant_id=$1 AND id=$2',
   [req.tenant,a.customer_id]))throw fail(404,'Customer unavailable');
  const branch=await one(db,'SELECT id FROM branches WHERE tenant_id=$1 AND id=$2 AND active=true',
   [req.tenant,a.branch_id]);
  if(!branch)throw fail(404,'Branch unavailable');
  try{
   const result=await one(db,`UPDATE customer_appointments SET branch_id=$3,customer_id=$4,
     customer_name=$5,service_name=$6,contact=$7,resource_name=$8,requirements=$9,
     notes=$10,starts_at=$11,ends_at=$12,status=$13,updated_by=$14,updated_at=now()
     WHERE tenant_id=$1 AND id=$2 RETURNING *`,
    [req.tenant,previous.id,a.branch_id,a.customer_id,a.customer_name,a.service_name,a.contact,
     a.resource_name,a.requirements,a.notes,a.starts_at,a.ends_at,a.status,req.user.id]);
   await audit(db,req,'appointment.updated',{id:result.id,from:previous.status,to:a.status});
   return result;
  }catch(error){if(error.code==='23P01')throw conflict();throw error;}
 }));
}
