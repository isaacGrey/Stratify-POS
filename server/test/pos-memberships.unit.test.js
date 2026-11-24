import assert from 'node:assert/strict';
import {test} from 'node:test';
import {moduleAccess,canUseRoute} from '../src/workspace-access.js';
import {expiryFrom} from '../src/service-routes.js';

test('cashier gets limited service lookup even when branch-scoped, with no membership changes',()=>{
 const branchIds=['00000000-0000-4000-8000-000000000001'];
 const row={role:'cashier',branch_ids:branchIds,module_permissions:{},role_permissions:{},
  module_access:{},module_overrides:{services:true}};
 const access=moduleAccess(row);
 assert.equal(access.services,true);
 for(const path of ['/service-plans','/service-customers','/service-entitlements',
  '/service-entitlements/00000000-0000-4000-8000-000000000002/events']){
   assert.equal(canUseRoute(path,'GET',access,branchIds),true,'read '+path);
  }
 for(const [path,method] of [
  ['/service-plans','POST'],
  ['/service-plans/00000000-0000-4000-8000-000000000002','PUT'],
  ['/service-customers/00000000-0000-4000-8000-000000000002','PUT'],
  ['/service-entitlements','POST'],
  ['/service-entitlements/00000000-0000-4000-8000-000000000002/cancel','POST']]){
  assert.equal(canUseRoute(path,method,access,branchIds),false,method+' '+path);
 }
 assert.equal(canUseRoute('/service-customers','POST',access,branchIds),true,
  'Cashier may register customers during POS enrollment');
 const restricted=moduleAccess({...row,module_overrides:{services:false}});
 assert.equal(restricted.services,false);
 assert.equal(canUseRoute('/service-entitlements','GET',restricted,branchIds),false);
 assert.equal(moduleAccess({...row,role:'staff'}).services,false);
});

test('membership validity uses calendar dates, including leap years and lifetime plans',()=>{
 assert.equal(expiryFrom('2024-01-31','months',1),'2024-02-29');
 assert.equal(expiryFrom('2025-01-31','months',1),'2025-02-28');
 assert.equal(expiryFrom('2026-11-16','months',2),'2027-01-16');
 assert.equal(expiryFrom('2026-11-16','none',null),null);
 assert.throws(()=>expiryFrom('not-a-date','months',1));
});
