import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validateAppointmentInput} from '../src/appointment-routes.js';
import {dateFilters,exportTabular} from '../src/operations-reports.js';
import {moduleAccess,canUseRoute} from '../src/workspace-access.js';
const uuid='00000000-0000-4000-8000-000000000001';
const start='2027-01-03T09:00:00+08:00',end='2027-01-03T10:00:00+08:00';
const form={branch_id:uuid,customer_name:' Pat Example ',service_name:' Consultation ',
 resource_name:' Room A ',starts_at:start,ends_at:end};
test('appointment input sanitizes names and preserves true instants',()=>{
 const validated=validateAppointmentInput(form);
 assert.equal(validated.customer_name,'Pat Example');
 assert.equal(validated.resource_name,'Room A');
 assert.equal(validated.starts_at,'2027-01-03T01:00:00.000Z');
 assert.equal(validated.status,'pending');
 assert.equal(validateAppointmentInput({notes:'updated'},validated).notes,'updated');
});
test('appointment rejects invalid times, customer IDs and overlength data',()=>{
 for(const patch of [
  {starts_at:'2027-01-03T09:00'},{ends_at:start},
  {ends_at:'2027-01-05T10:00+08:00'},
  {customer_id:'another company'},
  {branch_id:'branch'},
  {status:'deleted'},
  {notes:'a'.repeat(2001)}
 ]){
  assert.throws(()=>validateAppointmentInput({...form,...patch}),/Invalid|duration/i);
 }
});
test('export filters refuse missing/malformed and unbounded dates',()=>{
 assert.deepEqual(dateFilters({from:'2026-11-01',to:'2026-11-20'}),{from:'2026-11-01',to:'2026-11-20'});
 for(const bad of [{from:'abc',to:'2026-11-20'},{from:'2026-12-02',to:'2026-11-20'},
  {from:'2026-01-01',to:'2026-11-20'}])
  assert.throws(()=>dateFilters(bad),/valid report/i);
});
test('generated operations Excel and PDF files contain expected headers',async()=>{
 const config={title:'Attendance timecards',subtitle:'November 2026',
  columns:[['name','Employee'],['work_hours','Worked hours']],
  records:[{name:'Example Staff',work_hours:8.25}]};
 const x=await exportTabular({...config,format:'xlsx'});
 assert.equal(x.content.subarray(0,2).toString(),'PK');
 assert.equal(x.mime,'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
 const pdf=await exportTabular({...config,format:'pdf'});
 assert.equal(pdf.content.subarray(0,4).toString(),'%PDF');
 assert.ok(pdf.content.length>1000);
 await assert.rejects(()=>exportTabular({...config,format:'csv'}),/xlsx or pdf/);
});
test('appointment and inventory reports use explicit module permissions',()=>{
 const access=moduleAccess({role:'cashier',branch_ids:[uuid],
  module_permissions:{},role_permissions:{},module_access:{},module_overrides:{appointments:true}});
 assert.equal(access.appointments,true);
 assert.equal(canUseRoute('/appointments','GET',access,[uuid]),true);
 assert.equal(canUseRoute('/appointments','POST',access,[uuid]),true);
 assert.equal(canUseRoute('/inventory/export.xlsx','GET',access,[uuid]),false);
 assert.equal(canUseRoute('/attendance/export.pdf','GET',access,[uuid]),true);
 const manager=moduleAccess({role:'manager',branch_ids:null,
  module_permissions:{},role_permissions:{},module_access:{},module_overrides:{}});
 assert.equal(canUseRoute('/inventory/export.pdf','GET',manager,null),true);
 const restricted=moduleAccess({role:'manager',branch_ids:null,
  module_permissions:{appointments:false},role_permissions:{},module_access:{},module_overrides:{}});
 assert.equal(canUseRoute('/appointments','GET',restricted,null),false);
});

test('manual features fail closed and platform denies override merchant grants',()=>{
 const base={role:'owner',branch_ids:null,module_permissions:{services:true,appointments:true},module_access:{},module_overrides:{}};
 assert.equal(moduleAccess(base).services,false);assert.equal(moduleAccess(base).appointments,false);
 assert.equal(moduleAccess({...base,module_overrides:{services:true}}).services,true);
 assert.equal(moduleAccess({...base,admin_module_permissions:{appointments:true}}).appointments,true);
 assert.equal(moduleAccess({...base,module_overrides:{services:true},admin_module_permissions:{services:false}}).services,false);
 assert.equal(moduleAccess({...base,module_overrides:{appointments:false},admin_module_permissions:{appointments:true}}).appointments,false);
 assert.equal(Object.values(moduleAccess({...base,admin_workspace_enabled:false})).some(Boolean),false);
 assert.equal(canUseRoute('/attendance/clock-in','POST',moduleAccess({role:'staff',branch_ids:null}),null),true);
});
