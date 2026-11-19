import assert from 'node:assert/strict';
import {test} from 'node:test';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import bcrypt from 'bcryptjs';
import {validateAppointment} from '../src/appointment-routes.js';
import {validateReportPeriod,createOperationalExport} from '../src/operational-report-routes.js';

test('appointment input validation rejects invalid date, duration and statuses',()=>{
 const id=randomUUID(),start=new Date(Date.now()+86400000).toISOString();
 const good={branch_id:id,client_name:'Visitor',service_name:'Consultation',
  starts_at:start,ends_at:new Date(Date.parse(start)+3600000).toISOString()};
 assert.equal(validateAppointment(good).status,'pending');
 assert.throws(()=>validateAppointment({...good,ends_at:start}),/Invalid appointment/);
 assert.throws(()=>validateAppointment({...good,status:'paid'}),/Invalid appointment/);
 assert.throws(()=>validateAppointment({...good,starts_at:'2026-11-20T10:00'}),/Invalid appointment/);
 assert.throws(()=>validateAppointment({...good,resource_key:''}),/Invalid appointment/);
});
test('report periods are bounded and reject invalid dates',()=>{
 assert.deepEqual(validateReportPeriod({from:'2026-11-01',to:'2026-11-19'}),
  {from:'2026-11-01',to:'2026-11-19',branch_id:null});
 assert.throws(()=>validateReportPeriod({from:'2026-02-30',to:'2026-03-01'}));
 assert.throws(()=>validateReportPeriod({from:'2026-01-01',to:'2026-11-01'}));
});
test('standalone Excel and PDF exports have correct genuine file signatures',async()=>{
 const data={title:'Test Report',period:{from:'2026-11-01',to:'2026-11-19'},
  sheets:[{name:'Time cards',columns:[{key:'employee',title:'Employee',width:25},
   {key:'hours',title:'Hours',width:10}],rows:[{employee:'Sample User',hours:7.5}]}]};
 const excel=await createOperationalExport(data,'xlsx');
 const pdf=await createOperationalExport(data,'pdf');
 assert.equal(excel.subarray(0,2).toString(),'PK');
 assert.equal(pdf.subarray(0,4).toString(),'%PDF');
 assert.ok(excel.length>1000);assert.ok(pdf.length>300);
});
const dbUrl=process.env.STRATIFYPOS_TEST_DATABASE_URL;
test('business type, admin notifications, appointments, exports and tenant/role isolation',{
 skip:!dbUrl&&'Requires migrated disposable PostgreSQL',timeout:180000
},async t=>{
 const nonce=randomUUID(),email='admin-'+nonce+'@example.invalid',password='Test-admin-'+nonce;
 const sql=new pg.Pool({connectionString:dbUrl});
 t.after(()=>sql.end());
 const hash=await bcrypt.hash(password,6);
 await sql.query('INSERT INTO users(name,email,password_hash,platform_admin) VALUES($1,$2,$3,true)',
  ['QA Super Admin',email,hash]);
 const child=spawn(process.execPath,['src/index.js'],{
  cwd:process.cwd(),env:{...process.env,DATABASE_URL:dbUrl,PORT:'0',
   JWT_SECRET:randomUUID(),SUPERADMIN_EMAIL:email},
  stdio:['ignore','pipe','inherit']
 });
 t.after(()=>child.kill());
 const base=await new Promise((resolve,reject)=>{
  child.once('error',reject);child.once('exit',code=>reject(new Error('API exited '+code)));
  let output='';child.stdout.on('data',buf=>{
   output+=buf;const found=output.match(/http:\/\/localhost:\d+/);if(found)resolve(found[0]);
  });
 });
 async function request(path,expect,{body,method='GET',account,binary=false}={}){
  const resp=await fetch(base+'/api/'+path,{method,signal:AbortSignal.timeout(12000),
   headers:{'Content-Type':'application/json',
    ...(account?.token?{Authorization:'Bearer '+account.token}:{}),
    ...(account?.shop?.id?{'X-Tenant-Id':account.shop.id}:{})},
   body:body===undefined?undefined:JSON.stringify(body)});
  const result=binary?Buffer.from(await resp.arrayBuffer()):await resp.json();
  assert.equal(resp.status,expect,method+' '+path+' -> '+JSON.stringify(result).slice(0,450));
  return result;
 }
 const post=(p,e,b,a)=>request(p,e,{method:'POST',body:b,account:a});
 const put=(p,e,b,a)=>request(p,e,{method:'PUT',body:b,account:a});
 const account=await post('auth/register',201,{email:'shop-'+nonce+'@example.invalid',
  name:'Clinic Owner',shopName:'Clinic '+nonce,password:'Password-'+nonce,business_type:'non_food'});
 const other=await post('auth/register',201,{email:'other-'+nonce+'@example.invalid',
  name:'Other Owner',shopName:'Restaurant '+nonce,password:'Password-'+nonce,business_type:'food'});
 const admin=await post('auth/login',200,{email,password});
 const me=await request('me',200,{account});
 assert.equal(me.shops[0].business_type,'non_food');
 assert.equal(me.shops[0].modules.kitchen,false);
 const settings=await request('shop/settings',200,{account});
 assert.equal(settings.kitchen_enabled,false);
 await request('shop/kitchen',403,{account});
 await put('shop/settings',400,{kitchen_enabled:true},account);
 const [branch]=await request('shop/branches',200,{account});
 const [otherBranch]=await request('shop/branches',200,{account:other});
 const start=new Date(Date.now()+48*3600000);start.setUTCMinutes(0,0,0);
 const plus=n=>new Date(start.getTime()+n*60000).toISOString();
 const appointment={branch_id:branch.id,client_name:'Client Jane',
  client_contact:'0917000000',service_name:'Consultation',
  requirements:'Bring referral slip',resource_key:'room 1',
  starts_at:plus(0),ends_at:plus(60),status:'pending'};
 const first=await post('shop/appointments',200,appointment,account);
 assert.equal(first.resource_key,'room 1');
 await post('shop/appointments',409,{...appointment,starts_at:plus(15),ends_at:plus(75)},account);
 const adjacent=await post('shop/appointments',200,{...appointment,starts_at:plus(60),
  ends_at:plus(90),client_name:'Client Two'},account);
 const secondResource=await post('shop/appointments',200,{...appointment,resource_key:'room 2',
  client_name:'Client Three'},account);
 assert.ok(adjacent.id&&secondResource.id);
 await put('shop/appointments/'+first.id,200,{status:'confirmed'},account);
 await put('shop/appointments/'+first.id,409,{status:'completed',
  starts_at:plus(60),ends_at:plus(90)},account);
 await put('shop/appointments/'+first.id,200,{status:'rescheduled',
  starts_at:plus(120),ends_at:plus(180)},account);
 await put('shop/appointments/'+first.id,200,{status:'completed'},account);
 await put('shop/appointments/'+first.id,409,{status:'confirmed'},account);
 const history=await request('shop/appointments/'+first.id+'/events',200,{account});
 assert.deepEqual(history.map(x=>x.event_kind),['created','status_changed','rescheduled','status_changed']);
 await request('shop/appointments/'+first.id+'/events',404,{account:other});
 const date=start.toISOString().slice(0,10);
 const appointments=await request('shop/appointments?from='+date+'&to='+date,200,{account});
 assert.ok(appointments.some(x=>x.id===first.id));
 await post('shop/appointments',404,{...appointment,branch_id:otherBranch.id},account);
 const c=await Promise.all([0,1].map(async i=>{
  const response=await fetch(base+'/api/shop/appointments',{
   method:'POST',signal:AbortSignal.timeout(12000),
   headers:{'Content-Type':'application/json',Authorization:'Bearer '+account.token,
    'X-Tenant-Id':account.shop.id},
   body:JSON.stringify({...appointment,starts_at:plus(200),ends_at:plus(230),
    client_name:'Concurrent '+i})});
  return {status:response.status,body:await response.json()};
 }));
 assert.deepEqual(c.map(x=>x.status).sort((a,b)=>a-b),[200,409],
  'Exactly one concurrent reservation may succeed');

 const inventory=await request('shop/inventory-reports?from='+date+'&to='+date,200,{account});
 assert.ok(inventory.sheets.some(x=>x.name==='Stock levels'));
 const inExcel=await request('shop/inventory-reports/export/xlsx?from='+date+'&to='+date,
  200,{account,binary:true});
 const inPdf=await request('shop/inventory-reports/export/pdf?from='+date+'&to='+date,
  200,{account,binary:true});
 assert.equal(inExcel.subarray(0,2).toString(),'PK');
 assert.equal(inPdf.subarray(0,4).toString(),'%PDF');
 const attendance=await request('shop/attendance-reports?from='+date+'&to='+date,200,{account});
 assert.ok(attendance.sheets.some(x=>x.name==='Time cards'));
 const attPdf=await request('shop/attendance-reports/export/pdf?from='+date+'&to='+date,
  200,{account,binary:true});
 assert.equal(attPdf.subarray(0,4).toString(),'%PDF');
 await put('shop/business-type',200,{business_type:'food'},account);
 assert.equal((await request('shop/settings',200,{account})).kitchen_enabled,true);
 await put('shop/settings',200,{kitchen_enabled:false},account);
 assert.equal((await request('shop/settings',200,{account})).kitchen_enabled,false);
 const adminUsers=await request('admin/users?business_id='+account.shop.id,200,{account:admin});
 assert.ok(adminUsers.some(x=>x.email==='shop-'+nonce+'@example.invalid'));
 assert.ok(!adminUsers.some(x=>x.email==='other-'+nonce+'@example.invalid'));
 assert.ok(adminUsers.some(x=>x.businesses.includes('Clinic '+nonce)));
 const opts=await request('admin/users/business-options',200,{account:admin});
 assert.ok(opts.some(x=>x.id===account.shop.id));
 const feed=await request('admin/notifications',200,{account:admin});
 assert.ok(feed.items.some(x=>x.kind==='business.registered'),'Registration should appear in admin feed');
 const item=feed.items.find(x=>x.kind==='business.registered'&&x.detail.includes('Clinic '+nonce));
 assert.ok(item);
 await post('admin/notifications/read',200,{keys:[item.key]},admin);
 const reread=await request('admin/notifications',200,{account:admin});
 assert.equal(reread.items.find(x=>x.key===item.key)?.read,true);
 await request('admin/notifications',403,{account});
 await post('admin/notifications/read',403,{keys:[item.key]},account);
});
