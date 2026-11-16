import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';

const read=path=>readFileSync(new URL(path,import.meta.url),'utf8');
const main=read('../src/main.tsx');
const services=read('../src/customer-services.tsx');
const css=read('../src/style.css');
const offline=read('../src/offline/OfflinePOSGate.tsx');
const offlineCatalog=read('../src/offline/catalog.ts');

test('owner product editor uses three commercial item types plus separate class, category and stock',()=>{
 assert(main.includes('Product class'));
 assert(main.includes('General merchandise'));
 assert(main.includes('General service'));
 assert(main.includes('Food & beverage (restaurant fulfillment)'));
 assert(main.includes('One-time service'));
 assert(main.includes('Physical product'));
 assert(main.includes('track_inventory:form.track_inventory'));
 assert(main.includes('Category'));
 assert(main.includes('Managed in Memberships'));
 assert(!main.includes('<option value="non_stock">Non-stock item</option>'));
});
test('POS hides restaurant fulfillment for retail and sends customer membership reference',()=>{
 assert(main.includes('const hasFood=pricedCart.some'));
 assert(main.includes("const effectiveOrderType=hasFood?orderType:'standard'"));
 assert(main.includes('{hasFood&&<div className="order-types">'));
 assert(main.includes("service_customer_id: includesMembership?membershipCustomerId:null"));
 assert(main.includes("service_customer_id:includesMembership?membershipCustomerId:null"));
 assert(main.includes('Customer membership checkout'));
 assert(main.includes('Register customer'));
 assert(main.includes('Membership plans are tracked separately from one-time services.'));
 assert(main.includes("line.product.product_type==='membership'?1:100"));
});
test('cashiers have a discoverable read-only membership lookup and no plan controls',()=>{
 assert(main.includes("(canManage||role==='cashier') && allowed('services')"));
 assert(main.includes("readOnly={role==='cashier'}"));
 assert(services.includes("if(readOnly)return <>"));
 assert(services.includes('Reception verification · Read-only access'));
 assert(services.includes('Find member by name, reference or plan'));
 assert(services.includes('Membership grants, renewals, cancellations and plan settings are restricted'));
 assert(services.includes('sell_through_pos'));
 assert(services.includes('price_cents:priceCents'));
});
test('offline cart never includes membership items and preserves product classifications',()=>{
 assert(offline.includes("active: p.active && p.productType!=='membership'"));
 assert(offline.includes("product.productType==='membership'"));
 assert(offline.includes("const foodCart=body.items.some"));
 assert(offlineCatalog.includes('productType: product.product_type'));
 assert(offlineCatalog.includes('productClass: product.product_class'));
});
test('mobile sidebar is vertically scrollable independently of page content',()=>{
 assert(css.includes('.sidebar{height:100vh;height:100dvh;min-height:0;overflow:hidden}'));
 assert(css.includes('min-height:0;overflow-y:auto'));
 assert(css.includes('-webkit-overflow-scrolling:touch'));
 assert(css.includes('touch-action:pan-y'));
});
