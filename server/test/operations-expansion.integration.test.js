import assert from 'node:assert/strict';
import {test} from 'node:test';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
const database=process.env.STRATIFYPOS_TEST_DATABASE_URL;
test('business classification, kitchen restrictions, appointment booking and report exports',{
 skip:!database&&'Requires migrated disposable PostgreSQL database',timeout:150000
},async t=>{
 const nonce=randomUUID();
 const child=spawn(process.execPath,['src/index.js'],{
  cwd:process.cwd(),env:{...process.env,DATABASE_URL:database,PORT:'0',JWT_SECRET:randomUUID()},
  stdio:['ignore','pipe','inherit']
 });
 t.after(()=>child.kill());
 const api=await new Promise((resolve,reject)=>{
  child.once('error',reject);child.once('exit',code=>reject(new Error('API exited '+code)));
  let out='';child.stdout.on('data',chunk=>{
   out+=chunk;const m=out.match(/http:\/\/localhost:\d+/);if(m)resolve(m[0]);
  });
 });
 async function send(path,status,{method='GET',account,body,raw=false}={}){
  const response=await fetch(api+'/api/'+path,{method,signal:AbortSignal.timeout(15000),
   headers:{'Content-Type':'application/json',...(account?{Authorization:'Bearer '+account.token,
    'X-Tenant-Id':account.shop.id}:{})},
   body:body===undefined?undefined:JSON.stringify(body)});
  if(raw){assert.equal(response.status,status,method+' '+path);return Buffer.from(await response.arrayBuffer());}
  const json=await response.json().catch(()=>({}));
  assert.equal(response.status,status,method+' '+path+' '+JSON.stringify(json).slice(0,380));
  return json;
 }
 const post=(p,s,b,a)=>send(p,s,{method:'POST',body:b,account:a});
 const put=(p,s,b,a)=>send(p,s,{method:'PUT',body:b,account:a});
 const register=async(tag,type)=>post('auth/register',201,{
  name:tag+' owner',shopName:tag+' '+nonce,
  email:tag+'-'+nonce+'@example.invalid',password:'pw-'+nonce,
  business_type:type
 });
 const cafe=await register('cafe','food');
 const clinic=await register('clinic','non_food');
 const cafeMe=await send('me',200,{account:cafe});
 const clinicMe=await send('me',200,{account:clinic});
 assert.equal(cafeMe.shops[0].business_type,'food');
 assert.equal(clinicMe.shops[0].business_type,'non_food');
 assert.equal(cafeMe.shops[0].modules.kitchen,true);
 assert.equal(clinicMe.shops[0].modules.kitchen,false);
 await send('shop/kitchen',403,{account:clinic});
 await put('shop/settings',403,{kitchen_enabled:true},clinic);
 const noFood=await send('shop/settings',200,{account:clinic});
 assert.equal(noFood.kitchen_enabled,false);
 const [branch]=await send('shop/branches',200,{account:clinic});
 const [cafeBranch]=await send('shop/branches',200,{account:cafe});
 // Conflicts only for the same business, branch and named resource.
 const fixture={branch_id:branch.id,customer_name:'Patient A',service_name:'Consultation',
  contact:'0917',resource_name:'Doctor 1',requirements:'Arrive 10 min early',
  notes:'',starts_at:'2027-07-01T09:00:00+08:00',ends_at:'2027-07-01T10:00:00+08:00',
  status:'pending'};
 const appointment=await post('shop/appointments',200,fixture,clinic);
 assert.equal(appointment.customer_name,'Patient A');
 assert.equal(appointment.status,'pending');
 await post('shop/appointments',409,{...fixture,customer_name:'Patient B',
  starts_at:'2027-07-01T09:30:00+08:00',ends_at:'2027-07-01T10:30:00+08:00'},clinic);
 const simultaneous=await post('shop/appointments',200,{...fixture,
  customer_name:'Patient B',resource_name:'Doctor 2'},clinic);
 assert.notEqual(appointment.id,simultaneous.id);
 await put('shop/appointments/'+appointment.id,200,{...fixture,status:'confirmed'},clinic);
 await put('shop/appointments/'+appointment.id,200,{...fixture,
  starts_at:'2027-07-01T11:00:00+08:00',ends_at:'2027-07-01T12:00:00+08:00',
  status:'rescheduled'},clinic);
 await put('shop/appointments/'+appointment.id,200,{...fixture,
  status:'cancelled'},clinic);
 await put('shop/appointments/'+appointment.id,409,{...fixture,
  status:'confirmed'},clinic);
 const reused=await post('shop/appointments',200,{...fixture,customer_name:'Patient C'},clinic);
 assert.ok(reused.id);
 const list=await send('shop/appointments?from=2027-07-01&to=2027-07-02&q=Patient%20C',200,{account:clinic});
 assert.equal(list.length,1);
 await send('shop/appointments?status=unknown',400,{account:clinic});
 await put('shop/appointments/'+appointment.id,404,fixture,cafe);
 assert.equal((await send('shop/appointments?from=2027-07-01&to=2027-07-02',200,{account:cafe})).length,0);
 // Employees at reception can manage appointments but not change protected settings.
 const email='reception-'+nonce+'@example.invalid';
 await post('shop/staff',200,{name:'Reception',email,password:'pw-'+nonce,role:'cashier'},clinic);
 const receptionist=await post('auth/login',200,{email,password:'pw-'+nonce});
 receptionist.shop=clinic.shop;
 await post('shop/appointments',200,{...fixture,resource_name:'Doctor 3',
  customer_name:'Patient D'},receptionist);
 await put('shop/settings',403,{kitchen_enabled:true},receptionist);
 // Exports provide authenticated, properly typed downloadable files.
 await post('shop/ingredients',200,{name:'Disposable gloves',unit:'pcs',
  quantity:90,low_stock_at:20,unit_cost_cents:100},clinic);
 const xlsx=await send('shop/inventory/export.xlsx?from=2026-11-01&to=2026-11-20',200,
  {account:clinic,raw:true});
 assert.equal(xlsx.subarray(0,2).toString(),'PK');
 const pdf=await send('shop/inventory/export.pdf?from=2026-11-01&to=2026-11-20',200,
  {account:clinic,raw:true});
 assert.equal(pdf.subarray(0,4).toString(),'%PDF');
 const attendance=await send('shop/attendance/export.xlsx?from=2026-11-01&to=2026-11-20',200,
  {account:clinic,raw:true});
 assert.equal(attendance.subarray(0,2).toString(),'PK');
 await send('shop/attendance/export.pdf?from=2026-11-01&to=2026-11-20',200,
  {account:clinic,raw:true});
 await send('shop/inventory/export.xlsx?from=2026-01-01&to=2026-11-20',400,{account:clinic});
 await send('shop/inventory/export.xlsx',403,{account:receptionist});
 assert.equal(cafeBranch.id===branch.id,false);
});
