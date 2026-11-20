import {test} from 'node:test';
import assert from 'node:assert/strict';
import {commissionCents,commissionRate,normalizeReferralCode,isUuid} from '../src/affiliate-service.js';

test('affiliate referral input is canonical and never confused with promo codes',()=>{
 assert.equal(normalizeReferralCode('sp-abc123'),'SP-ABC123');
 assert.equal(normalizeReferralCode('',{optional:true}),null);
 for(const v of ['','x','bad code','12345','SP-%*&','x'.repeat(40),{},null]){
  assert.throws(()=>normalizeReferralCode(v),/Invalid affiliate referral/);
 }
});
test('commission rates and integer-cent calculation preserve precise monetary amounts',()=>{
 assert.equal(commissionCents(169900,2000),33980); // ₱1,699 at 20%
 assert.equal(commissionCents(349900,2500),87475); // 25% override
 assert.equal(commissionCents(99900,0),0);
 assert.equal(commissionCents(1,5000),1); // half-cent rounds once, at posting
 assert.equal(commissionRate(0),0);
 assert.equal(commissionRate(null,{optional:true}),null);
 for(const v of [-1,10001,20.5,'2000',Number.NaN])assert.throws(()=>commissionRate(v));
 for(const [amount,rate] of [[0,2000],[-1,2000],[169900,10001],[1.2,2000]])
  assert.throws(()=>commissionCents(amount,rate));
 assert(isUuid('00000000-0000-4000-8000-000000000001'));
 assert.equal(isUuid('guess'),false);
});
