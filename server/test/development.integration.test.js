import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

const database = process.env.STRATIFYPOS_TEST_DATABASE_URL;

test('Development: cash register, idempotent refunds, purchasing and tenant boundaries', {
    skip: !database && 'Set STRATIFYPOS_TEST_DATABASE_URL to a disposable, migrated database',
    timeout: 120000
}, async t => {
    const nonce=randomUUID();
    const child=spawn(process.execPath,['src/index.js'],{
        env:{...process.env,DATABASE_URL:database,PORT:'0',JWT_SECRET:randomUUID(),
            REPORT_TIME_ZONE:'Asia/Manila'},
        stdio:['ignore','pipe','inherit']
    });
    t.after(()=>child.kill());
    const api=await new Promise((resolve,reject)=>{
        child.once('error',reject);
        child.once('exit',code=>reject(new Error('API exited: '+code)));
        let output='';
        child.stdout.on('data',chunk=>{
            output+=chunk;
            const match=output.match(/http:\/\/localhost:\d+/);
            if(match) resolve(match[0]);
        });
    });
    async function request(path,status,{method='GET',body,account,tenant}={}) {
        const response=await fetch(api+'/api/'+path,{
            method,signal:AbortSignal.timeout(10000),
            headers:{'Content-Type':'application/json',
                ...(account?{Authorization:'Bearer '+account.token}:{}),
                ...(tenant||account?.shop?.id?{'X-Tenant-Id':tenant||account.shop.id}:{})
            },
            body:body===undefined?undefined:JSON.stringify(body)
        });
        const data=await response.json();
        assert.equal(response.status,status,
            method+' '+path+': '+JSON.stringify(data).slice(0,250));
        return data;
    }
    const post=(path,status,body,account)=>request(path,status,{method:'POST',body,account});
    const put=(path,status,body,account)=>request(path,status,{method:'PUT',body,account});
    const owner=await post('auth/register',201,{
        email:'development-'+nonce+'@example.invalid',password:'development-test-'+nonce,
        name:'Development owner',shopName:'Dev Test '+nonce
    });
    const outsider=await post('auth/register',201,{
        email:'external-'+nonce+'@example.invalid',password:'development-test-'+nonce,
        name:'External owner',shopName:'Other Dev Test '+nonce
    });
    const [branch]=await request('shop/branches',200,{account:owner});
    const stock=await post('shop/ingredients',200,{
        name:'Test beans',unit:'g',quantity:50,unit_cost_cents:100
    },owner);
    const product=await post('shop/products',200,{
        name:'Test coffee',price_cents:1000,
        recipe:[{ingredient_id:stock.id,quantity:1}]
    },owner);
    const supplier=await post('shop/suppliers',200,{name:'Dev test supplier',contact:''},owner);
    assert.equal((await put('shop/register/policy',200,{require_cash_register:true},owner))
        .require_cash_register,true);
    const checkout={
        branch_id:branch.id,client_sale_id:randomUUID(),payment_method:'cash',
        amount_tendered_cents:3000,items:[{product_id:product.id,quantity:2}]
    };
    await post('shop/checkout',409,checkout,owner);
    const session=await post('shop/register/open',200,{
        branch_id:branch.id,opening_cents:10000
    },owner);
    await post('shop/register/open',409,{branch_id:branch.id,opening_cents:0},owner);
    const payload={...checkout,register_session_id:session.id};
    const order=await post('shop/checkout',200,payload,owner);
    assert.equal(Number(order.total_cents),2000);
    assert.equal('estimated_cogs_cents' in order,false,'Cost snapshots stay private to management reports');
    assert.equal((await post('shop/checkout',200,payload,owner)).id,order.id);
    await post('shop/checkout',409,{...payload,amount_tendered_cents:4000},owner);
    const openRegister=await request('shop/register/'+session.id,200,{account:owner});
    assert.equal(openRegister.movements.filter(row=>row.kind==='sale').length,1);
    assert.equal(Number(openRegister.expected_cents),12000);

    await post('shop/register/'+session.id+'/movements',200,{
        kind:'cash_out',amount_cents:1000,reason:'Petty cash withdrawal'
    },owner);
    const firstId=randomUUID();
    const refundPayload={request_id:firstId,amount_cents:500,reason:'Customer requested a partial refund',
        register_session_id:session.id};
    const refund=await post('shop/orders/'+order.id+'/refunds',200,refundPayload,owner);
    assert.equal(refund.status,'partially_refunded');
    assert.equal((await post('shop/orders/'+order.id+'/refunds',200,refundPayload,owner)).id,refund.id);
    await post('shop/orders/'+order.id+'/refunds',409,{
        ...refundPayload,amount_cents:1000
    },owner);
    await post('shop/orders/'+order.id+'/refunds',409,{
        request_id:randomUUID(),amount_cents:2000,
        reason:'Excessive refund attempt',register_session_id:session.id
    },owner);
    const remainder=await post('shop/orders/'+order.id+'/refunds',200,{
        request_id:randomUUID(),amount_cents:1500,
        reason:'Customer returns the full order',register_session_id:session.id
    },owner);
    assert.equal(remainder.status,'refunded');
    assert.equal((await request('shop/orders/'+order.id+'/refunds',200,{account:owner})).length,2);
    assert.equal((await request('shop/orders/'+order.id,200,{account:owner})).status,'refunded');
    assert.equal((await request('shop/register/'+session.id,200,{account:owner})).movements.length,4);
    await request('shop/orders/'+order.id,404,{account:outsider});
    await request('shop/register/'+session.id,404,{account:outsider});
    await request('shop/register',403,{account:outsider,tenant:owner.shop.id});

    const po=await post('shop/purchases',200,{
        branch_id:branch.id,supplier_id:supplier.id,reference:'DEV-001',
        notes:'Integration test purchase',
        lines:[{ingredient_id:stock.id,quantity:10,unit_cost_cents:125}]
    },owner);
    const receivePath='shop/purchases/'+po.id+'/receive';
    const partial={request_id:randomUUID(),
        lines:[{line_id:po.lines[0].id,quantity:3}]};
    const receipt1=await post(receivePath,200,partial,owner);
    assert.equal(receipt1.status,'partially_received');
    assert.equal((await post(receivePath,200,partial,owner)).id,receipt1.id);
    await post(receivePath,409,{...partial,lines:[{line_id:po.lines[0].id,quantity:5}]},owner);
    await post(receivePath,409,{request_id:randomUUID(),
        lines:[{line_id:po.lines[0].id,quantity:8}]},owner);
    const receipt2=await post(receivePath,200,{
        request_id:randomUUID(),lines:[{line_id:po.lines[0].id,quantity:7}]
    },owner);
    assert.equal(receipt2.status,'received');
    const completed=await request('shop/purchases/'+po.id,200,{account:owner});
    assert.equal(Number(completed.lines[0].received_quantity),10);
    const items=await request('shop/ingredients',200,{account:owner});
    assert.equal(Number(items.find(item=>item.id===stock.id).quantity),58);
    const movements=await request('shop/stock/movements',200,{account:owner});
    assert.equal(movements.filter(item=>item.reference_id===receipt1.id).length,1);
    assert.equal(movements.find(item=>item.reference_id===receipt1.id).branch_id,null);
    assert.equal(movements.filter(item=>item.reference_id===receipt2.id).length,1);
    await request('shop/purchases/'+po.id,404,{account:outsider});
    await request('shop/purchases',403,{account:outsider,tenant:owner.shop.id});

    // A physical product can consume a directly linked stock item rather than a recipe.
    const spareA=await post('shop/ingredients',200,{
        name:'Brake pad',unit:'pcs',quantity:2,unit_cost_cents:700,item_type:'product'
    },owner);
    const spareB=await post('shop/ingredients',200,{
        name:'Blue brake pad',unit:'pcs',quantity:3,unit_cost_cents:800,item_type:'product'
    },owner);
    const sku='BRAKE-'+nonce.slice(0,8).toUpperCase();
    const barcode='BP-'+nonce.slice(0,10).toUpperCase();
    const variantBarcode='BLUE-'+nonce.slice(0,10).toUpperCase();
    const spareProduct=await post('shop/products',200,{
        name:'Motorcycle brake pads',price_cents:5000,cost_cents:1000,
        product_type:'physical',stock_item_id:spareA.id,sku,barcode,
        brand:'Sample Parts',manufacturer:'Sample Factory',
        variations:[{name:'Blue model',price_cents:5500,sku:sku+'-BLUE',
            barcode:variantBarcode,stock_item_id:spareB.id}]
    },owner);
    await post('shop/products',409,{
        name:'Duplicate barcode',price_cents:100,barcode:variantBarcode
    },owner);
    await post('shop/products',200,{
        name:'Same barcode in another tenant',price_cents:100,barcode:variantBarcode
    },outsider);
    const inventoryProduct=(await request('shop/products',200,{account:owner}))
        .find(item=>item.id===spareProduct.id);
    assert.equal(inventoryProduct.sku,sku);
    assert.equal(inventoryProduct.variations[0].barcode,variantBarcode);
    const baseSale=await post('shop/checkout',200,{
        branch_id:branch.id,client_sale_id:randomUUID(),payment_method:'cash',
        amount_tendered_cents:6000,register_session_id:session.id,
        items:[{product_id:spareProduct.id,quantity:1}]
    },owner);
    assert.equal(Number(baseSale.total_cents),5000);
    const variantSale=await post('shop/checkout',200,{
        branch_id:branch.id,client_sale_id:randomUUID(),payment_method:'cash',
        amount_tendered_cents:6000,register_session_id:session.id,
        items:[{product_id:spareProduct.id,variation_id:inventoryProduct.variations[0].id,quantity:1}]
    },owner);
    assert.equal(Number(variantSale.total_cents),5500);
    const finalInventory=await request('shop/ingredients',200,{account:owner});
    assert.equal(Number(finalInventory.find(item=>item.id===spareA.id).quantity),1);
    assert.equal(Number(finalInventory.find(item=>item.id===spareB.id).quantity),2);

    const cancelledDraft={
        id:randomUUID(),branch_id:branch.id,order_type:'takeout',
        items:[{product_id:product.id,quantity:1}]
    };
    const draft=await post('shop/holds',200,cancelledDraft,owner);
    assert.equal(draft.status,'held');
    assert.equal((await post('shop/holds',200,cancelledDraft,owner)).id,draft.id);
    await post('shop/holds',409,{...cancelledDraft,
        items:[{product_id:product.id,quantity:2}]},owner);
    await request('shop/holds/'+draft.id,404,{account:outsider});
    assert.equal((await post('shop/holds/'+draft.id+'/cancel',200,{},owner)).status,'cancelled');
    assert.equal((await post('shop/holds/'+draft.id+'/cancel',200,{},owner)).status,'cancelled');
    await post('shop/checkout',409,{
        branch_id:branch.id,client_sale_id:randomUUID(),held_order_id:draft.id,
        payment_method:'cash',register_session_id:session.id,
        amount_tendered_cents:1000,
        items:[{product_id:product.id,quantity:1}]
    },owner);
    const savedDraft={...cancelledDraft,id:randomUUID()};
    await post('shop/holds',200,savedDraft,owner);
    assert.equal((await request('shop/holds?branch_id='+branch.id,200,{account:owner}))
        .some(row=>row.id===savedDraft.id),true);
    const resumedCheckout={
        branch_id:branch.id,client_sale_id:randomUUID(),
        held_order_id:savedDraft.id,payment_method:'cash',
        register_session_id:session.id,amount_tendered_cents:1000,
        items:[{product_id:product.id,quantity:1}]
    };
    const paidHold=await post('shop/checkout',200,resumedCheckout,owner);
    assert.equal(Number(paidHold.total_cents),1000);
    assert.equal((await post('shop/checkout',200,resumedCheckout,owner)).id,paidHold.id);
    assert.equal((await request('shop/holds/'+savedDraft.id,200,{account:owner})).status,'completed');
    await post('shop/checkout',409,{
        ...resumedCheckout,client_sale_id:randomUUID()
    },owner);
    assert.equal((await request('shop/holds?branch_id='+branch.id,200,{account:owner})).length,0);

    const report=await request('shop/reports?period=daily',200,{account:owner});
    assert.equal(Number(report.summary.gross_revenue_cents),13500);
    assert.equal(Number(report.summary.refund_cents),2000);
    assert.equal(Number(report.summary.cogs_cents),1800);
    assert.equal(Number(report.summary.cogs_covered_orders),4);
    assert.equal(Number(report.summary.estimated_gross_profit_cents),9700);
    assert.equal(Number(report.summary.revenue_cents),11500);
    const closed=await post('shop/register/'+session.id+'/close',200,{
        counted_cents:20300
    },owner);
    assert.equal(closed.status,'closed');
    assert.equal(closed.expected_cents,20500);
    assert.equal(closed.variance_cents,-200);
    await post('shop/register/'+session.id+'/movements',409,{
        kind:'cash_in',amount_cents:200,reason:'Late cash deposit'
    },owner);
});
