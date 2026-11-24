import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import ExcelJS from 'exceljs';
import png from 'pngjs';
import { latestScheduleSlot } from '../src/backup-worker.js';
import pg from 'pg';

const databaseUrl = process.env.STRATIFYPOS_TEST_DATABASE_URL;
const recoveryDatabase = process.env.STRATIFYPOS_TEST_RECOVERY_DATABASE_URL;

test('backup schedules honor daily, weekly and monthly UTC cutoffs', () => {
    const now = new Date('2026-11-11T12:00:00Z');
    assert.equal(latestScheduleSlot({ frequency:'daily',hour_utc:18 },now).toISOString(),'2026-11-10T18:00:00.000Z');
    assert.equal(latestScheduleSlot({ frequency:'weekly',hour_utc:18,weekday_utc:3 },now).toISOString(),'2026-11-04T18:00:00.000Z');
    assert.equal(latestScheduleSlot({ frequency:'monthly',hour_utc:8,month_day_utc:15 },now).toISOString(),'2026-10-15T08:00:00.000Z');
});

test('migrations, POS reconciliation, billing and tenant isolation', {
    skip: !databaseUrl && 'Set STRATIFYPOS_TEST_DATABASE_URL to an isolated migrated database',
    timeout: 120000
}, async t => {
    const dir = await mkdtemp(join(tmpdir(), 'stratify-test-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const keyFile = join(dir, 'signing.pem');
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    await writeFile(keyFile, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    const nonce = randomUUID();
    const password = randomUUID();
    const adminEmail = `admin-${nonce}@example.invalid`;
    const env = {
        ...process.env, DATABASE_URL: databaseUrl, PORT: '0', JWT_SECRET: randomUUID(),
        OFFLINE_PRIVATE_KEY_FILE: keyFile, SUPERADMIN_EMAIL: adminEmail, SUPERADMIN_PASSWORD: password,
        REPORT_TIME_ZONE: 'Asia/Manila'
    };
    const storage = join(dir,'backups');
    if (recoveryDatabase) {
        await mkdir(storage);
        await writeFile(join(storage,'.stratifypos-backup-store'),'test volume');
        Object.assign(env,{
            BACKUP_STORAGE_DIR:storage,
            BACKUP_ENCRYPTION_KEY_B64:Buffer.from(nonce.slice(0,32)).toString('base64'),
            BACKUP_RESTORE_DATABASE_URL:recoveryDatabase,
            BACKUP_NOTIFY_EMAIL:''
        });
    }
    const pool = new pg.Pool({ connectionString: databaseUrl });
    t.after(() => pool.end());
    const seed = spawn(process.execPath, ['src/seed.js'], { env, stdio: 'ignore' });
    assert.equal(await new Promise((resolve, reject) => {
        seed.once('error', reject);
        seed.once('exit', resolve);
    }), 0);
    const child = spawn(process.execPath, ['src/index.js'], { env, stdio: ['ignore', 'pipe', 'inherit'] });
    t.after(() => child.kill());
    const api = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', code => reject(new Error('API exited with status ' + code)));
        let output = '';
        child.stdout.on('data', chunk => {
            output += chunk;
            const url = output.match(/http:\/\/localhost:\d+/)?.[0];
            if (url) resolve(url);
        });
    });
    async function request(path, status, { method = 'GET', body, account, tenant } = {}) {
        const response = await fetch(api + '/api/' + path, {
            method, signal: AbortSignal.timeout(10000),
            headers: {
                'Content-Type': 'application/json',
                ...(account && { Authorization: 'Bearer ' + account.token }),
                ...(tenant || account?.shop?.id ? { 'X-Tenant-Id': tenant || account.shop.id } : {})
            },
            body: body === undefined ? undefined : JSON.stringify(body)
        });
        const data = await response.json();
        assert.equal(response.status, status, `${method} ${path} · ${data.error ?? ''}`);
        return data;
    }
    const post = (path, status, body, account) => request(path, status, { method: 'POST', body, account });
    const image = new png.PNG({ width: 32, height: 24 });
    image.data.fill(255);
    const receipt = png.PNG.sync.write(image);
    async function upload(path, expected, token, reference, contents = receipt, tenant, type = 'image/png') {
        const response = await fetch(api + '/api/' + path, { method: 'POST',
            headers: { Authorization: 'Bearer ' + token, 'X-Payment-Reference': reference,
                'Content-Type': type, ...(tenant ? { 'X-Tenant-Id': tenant } : {}) }, body: contents });
        const data = await response.json();
        assert.equal(response.status, expected, path + ' · ' + (data.error || ''));
        return data;
    }
    assert.equal((await request('ready', 200)).ok, true);
    const plans = await request('plans', 200);
    const trialDays = plans.find(plan => plan.id === 'free').trial_days;
    const register = tag => post('auth/register', 201, {
        email: `${tag}-${nonce}@example.invalid`, password, name: tag, shopName: `${tag} ${nonce}`
    });
    const owner = await register('owner');
    const outsider = await register('outsider');
    const days = (Date.parse(owner.subscription.trial_ends_at) - Date.now()) / 86400000;
    assert.ok(days > trialDays - 0.01 && days <= trialDays);
    await post('auth/register', 400, { email: adminEmail, password, name: 'Reserved', shopName: 'Reserved' });

    const [branch] = await request('shop/branches', 200, { account: owner });
    const employeeEmail = `staff-${nonce}@example.invalid`;
    const employee = await post('shop/staff', 200, { name: 'Employee', email: employeeEmail, password, role: 'staff' }, owner);
    const employeeSession = await post('auth/login', 200, { email: employeeEmail, password });
    employeeSession.shop = owner.shop;
    await post('shop/staff', 403, { name: 'Unauthorized', email: 'bad@example.invalid', password, role: 'manager' }, employeeSession);
    await request('shop/staff/' + employee.id + '/schedule', 200, {
        method: 'PUT', account: owner, body: {
            time_zone: 'Asia/Manila', shifts: Array.from({ length: 7 }, (_, index) => ({
                weekday: index + 1, branch_id: branch.id, starts_at: '00:00', ends_at: '23:59', grace_minutes: 0
            }))
        }
    });
    // Employee attendance mutations require both attendance and cashier workspace authorization.
    await post('shop/attendance/clock-in', 403, {}, employeeSession);
    await request('shop/staff/' + employee.id + '/access', 200, {
        method:'PUT',account:owner,body:{module_permissions:{pos:true,attendance:true},branch_ids:null}
    });
    await post('shop/attendance/break-start', 409, {}, employeeSession);
    const shift = await post('shop/attendance/clock-in', 200, {}, employeeSession);
    assert.equal(shift.branch_id, branch.id);
    assert.equal(shift.late_minutes, Math.ceil((Date.parse(shift.clock_in) - Date.parse(shift.scheduled_start_at)) / 60000));
    await post('shop/attendance/clock-in', 409, {}, employeeSession);
    await post('shop/attendance/break-start', 200, {}, employeeSession);
    await post('shop/attendance/break-start', 409, {}, employeeSession);
    await post('shop/attendance/clock-out', 409, {}, employeeSession);
    await post('shop/attendance/break-end', 200, {}, employeeSession);
    await post('shop/attendance/break-end', 409, {}, employeeSession);
    await post('shop/attendance/clock-out', 200, {}, employeeSession);
    const history = await request('shop/attendance?user_id=' + owner.user.id, 200, { account: employeeSession });
    assert.deepEqual(history.map(row => row.user_id), [employee.id]);
    const attendance = await request('shop/attendance/summary', 200, { account: owner });
    assert.equal(attendance.find(row => row.user_id === employee.id).shifts, 1);
    await request('shop/staff/' + employee.id + '/schedule', 200, {
        method:'PUT',account:owner,body:{ time_zone:'Asia/Manila',shifts:[
            { weekday:1,starts_at:'21:00',ends_at:'06:00',grace_minutes:5,branch_id:branch.id }
        ] }
    });

    const ingredient = await post('shop/ingredients', 200, { name: 'Beans', unit: 'g', quantity: 50 }, owner);
    const product = await post('shop/products', 200, {
        name: 'Coffee', price_cents: 10000, variations: [{
            name: 'Large', price_cents: 11000, use_custom_recipe: true,
            recipe: [{ ingredient_id: ingredient.id, quantity: 12.5 }]
        }],
        recipe: [{ ingredient_id: ingredient.id, quantity: 10 }]
    }, owner);
    const addon = await post('shop/addons', 200, { name: 'Milk', price_cents: 500 }, owner);
    const [configuredProduct] = await request('shop/products', 200, { account: owner });
    const size = configuredProduct.variations[0];
    await request('shop/products/' + product.id, 200, {
        method: 'PUT', account: owner,
        body: { name: product.name, price_cents: 10400, variations: [size] }
    });
    const [editedProduct] = await request('shop/products', 200, { account: owner });
    assert.equal(editedProduct.variations[0].id, size.id);
    assert.equal(editedProduct.variations[0].price_cents, 11000);
    await request('shop/addons/' + addon.id + '/recipe', 200, {
        method: 'PUT', account: owner, body: { recipe: [{ ingredient_id: ingredient.id, quantity: 2.5 }] }
    });
    await request('shop/settings', 200, {
        method: 'PUT', body: { tax_basis_points: 1200, service_basis_points: 500 }, account: owner
    });
    const deviceId = randomUUID();
    const { grant } = await post('shop/offline/grant', 200, { branchId: branch.id, deviceId }, owner);
    const checkout = {
        branch_id: branch.id, client_sale_id: randomUUID(), payment_method: 'cash', amount_tendered_cents: 15000,
        offline: { grant, device_id: deviceId, created_at: new Date().toISOString() },
        expected: { subtotal_cents: 11500, discount_cents: 0, tax_cents: 1380, service_cents: 575, total_cents: 13455 },
        items: [{ product_id: product.id, quantity: 1, variation_id: configuredProduct.variations[0].id,
            addon_ids: [addon.id], expected_unit_cents: 11500 }]
    };
    const [first, second] = await Promise.all([
        post('shop/checkout', 200, checkout, owner), post('shop/checkout', 200, checkout, owner)
    ]);
    assert.equal(first.id, second.id);
    assert.equal(first.change_cents, 1545);
    assert.equal(first.items[0].variation, 'Large');
    assert.equal(first.items[0].addons[0].name, 'Milk');
    await post('shop/checkout', 409, { ...checkout, amount_tendered_cents: 16000 }, owner);
    await post('shop/checkout', 403, { ...checkout, client_sale_id: randomUUID(),
        offline: { ...checkout.offline, device_id: randomUUID() } }, owner);
    await post('shop/checkout', 403, { ...checkout, client_sale_id: randomUUID(),
        offline: { ...checkout.offline, created_at: new Date(0).toISOString() } }, owner);
    await post('shop/checkout', 409, { ...checkout, client_sale_id: randomUUID(),
        items: [{ ...checkout.items[0], expected_unit_cents: 11000 }] }, owner);
    await post('shop/checkout', 400, { ...checkout, client_sale_id: randomUUID(), promo_code: 'EXPIRED' }, owner);
    await post('shop/checkout', 409, { ...checkout, client_sale_id: randomUUID(),
        items: [{ ...checkout.items[0], quantity: 3 }] }, owner);
    await request('shop/orders/' + first.id, 404, { account: outsider });
    await request('shop/orders', 403, { account: outsider, tenant: owner.shop.id });
    const [after] = await request('shop/ingredients', 200, { account: owner });
    assert.equal(Number(after.quantity), 35);
    const movements = await request('shop/stock/movements', 200, { account: owner });
    assert.equal(movements.filter(movement => movement.reference_id === first.id).length, 1);
    await request('shop/stock/branch-mode', 200, { method: 'PUT', account: owner, body: { enabled: true } });
    await post('shop/checkout', 409, { ...checkout, client_sale_id: randomUUID() }, owner);
    const transfer = await post('shop/stock/transfer', 200, {
        ingredient_id: ingredient.id, to_branch_id: branch.id, quantity: 25
    }, owner);
    const orders = await Promise.all([0, 1].map(() => fetch(api + '/api/shop/checkout', {
        method: 'POST', headers: { Authorization: 'Bearer ' + owner.token,
            'Content-Type': 'application/json', 'X-Tenant-Id': owner.shop.id },
        body: JSON.stringify({ ...checkout, client_sale_id: randomUUID() })
    })));
    assert.deepEqual(orders.map(order => order.status).sort(), [200, 409]);
    await Promise.all(orders.map(order => order.json()));
    const branchStock = await request('shop/stock/balances?branch_id=' + branch.id, 200, { account: owner });
    const poolStock = await request('shop/stock/balances', 200, { account: owner });
    assert.equal(Number(branchStock.items[0].available), 10);
    assert.equal(Number(poolStock.items[0].available), 10);
    assert.equal(Number(branchStock.items[0].quantity), 20);
    const transferEntries = (await request('shop/stock/movements', 200, { account: owner }))
        .filter(movement => movement.reference_id === transfer.reference_id);
    assert.deepEqual(transferEntries.map(entry => Number(entry.delta)).sort((a, b) => a - b), [-25, 25]);
    await post('shop/stock/adjust', 409, { ingredient_id: ingredient.id, delta: -15, reason: 'Too much' }, owner);
    await post('shop/stock/transfer', 400, {
        ingredient_id: ingredient.id, to_branch_id: randomUUID(), quantity: 1
    }, owner);
    const filters = 'period=daily&branch_id=' + branch.id;
    const report = await request('shop/reports?' + filters, 200, { account: owner });
    assert.equal(report.summary.orders, 2);
    assert.equal(Number(report.summary.revenue_cents), first.total_cents * 2);
    assert.equal(report.top[0].variation, 'Large');
    assert.equal(Number(report.balances[0].quantity), 10);
    assert.equal(report.transactions.length, 2);
    await request('shop/reports?period=custom&from=2026-02-31&to=2026-03-01', 400, { account: owner });
    await request('shop/reports?' + filters, 404, { account: outsider });
    for (const format of ['xlsx', 'pdf']) {
        const file = await fetch(api + '/api/shop/reports/export/' + format + '?' + filters, {
            headers: { Authorization: 'Bearer ' + owner.token, 'X-Tenant-Id': owner.shop.id }
        });
        assert.equal(file.status, 200, format + ' export failed');
        assert.match(file.headers.get('content-disposition'), new RegExp('\.' + format));
        const buffer = Buffer.from(await file.arrayBuffer());
        if (format === 'xlsx') {
            const book = new ExcelJS.Workbook();
            await book.xlsx.load(buffer);
            assert.equal(book.getWorksheet('Summary').getCell('B3').value, Number(report.summary.revenue_cents) / 100);
            assert.equal(book.getWorksheet('Transactions').rowCount, 3);
        } else {
            assert.equal(buffer.subarray(0, 4).toString(), '%PDF');
        }
    }
    const schedulePath = 'shop/branches/' + branch.id + '/schedule';
    await request(schedulePath, 200, { method: 'PUT', account: owner, body: {
        time_zone: 'Asia/Manila',
        weekly: Array.from({ length: 7 }, (_, index) => ({
            weekday: index + 1, opens_at: '08:00', closes_at: '16:00', closed: false
        })),
        overrides: [{ day: report.filters.from, label: 'Holiday', closed: true }]
    } });
    const calendar = await request(schedulePath, 200, { account: owner });
    assert.equal(calendar.weekly.length, 7);
    assert.equal(calendar.today.closed, true);
    assert.equal(calendar.today.label, 'Holiday');
    await request(schedulePath, 404, { account: outsider });
    const table = await post('shop/tables', 200, { branch_id: branch.id, label: 'Table 1', seats: 4 }, owner);
    const tablePath = 'shop/tables/' + table.id + '/status';
    await request(tablePath, 200, { method: 'PUT', account: owner, body: { status: 'reserved' } });
    const dineInProduct = await post('shop/products', 200, { name: 'Pastry', price_cents: 100 }, owner);
    const dineIn = { client_sale_id: randomUUID(), branch_id: branch.id, table_id: table.id, order_type: 'dine_in',
        payment_method: 'cash', amount_tendered_cents: 200,
        items: [{ product_id: dineInProduct.id, quantity: 1 }] };
    const tableOrder = await post('shop/checkout', 200, dineIn, owner);
    const [occupied] = await request('shop/tables', 200, { account: owner });
    assert.equal(occupied.status, 'occupied');
    assert.equal(occupied.active_order_id, tableOrder.id);
    assert.equal((await post('shop/checkout', 200, dineIn, owner)).id, tableOrder.id);
    await post('shop/checkout', 409, { ...dineIn, client_sale_id: randomUUID() }, owner);
    const cleared = await request(tablePath, 200, { method: 'PUT', account: owner, body: { status: 'available' } });
    assert.equal(cleared.active_order_id, null);
    assert.equal((await request('shop/orders/' + tableOrder.id, 200, { account: owner })).table_id, table.id);
    const offlineDineIn = await post('shop/checkout', 200, { ...dineIn, client_sale_id:randomUUID(),
        offline:{ grant,device_id:deviceId,created_at:new Date().toISOString() },
        expected:{ subtotal_cents:100,discount_cents:0,tax_cents:12,service_cents:5,total_cents:117 },
        items:[{ ...dineIn.items[0],expected_unit_cents:100 }]
    },owner);
    assert.equal(offlineDineIn.order_type,'dine_in');
    assert.equal(offlineDineIn.table_id,table.id);
    const promo = await post('shop/promotions', 200, { code: '2FOR1', kind: 'bogo',
        scope: 'product', product_id: dineInProduct.id, branch_ids: [branch.id],
        usage_limit: 1, requires_approval: true }, owner);
    const promoOrder = {
        branch_id: branch.id, payment_method: 'cash', amount_tendered_cents: 200, promo_code: '2for1',
        items: [{ product_id: dineInProduct.id, quantity: 2 }]
    };
    const quote = await post('shop/checkout/quote', 200, promoOrder, owner);
    assert.equal(quote.discount_cents, 100);
    assert.equal(quote.total_cents, 117);
    await request('shop/staff/' + employee.id, 200, {
        method: 'PATCH', account: owner, body: { role: 'cashier', active: true }
    });
    await post('shop/checkout/quote', 403, promoOrder, employeeSession);
    const cashierDevice = randomUUID();
    const cashierGrant = await post('shop/offline/grant', 200, { branchId:branch.id, deviceId:cashierDevice }, employeeSession);
    const offlineFromCashier = {
        ...promoOrder, promo_code:null, items:[{product_id:dineInProduct.id,quantity:1,expected_unit_cents:100}],
        client_sale_id:randomUUID(), offline:{ grant:cashierGrant.grant,device_id:cashierDevice,created_at:new Date().toISOString() },
        expected:{subtotal_cents:100,discount_cents:0,tax_cents:12,service_cents:5,total_cents:117}
    };
    const reconcilePath = 'shop/checkout/reconcile/' + employee.id;
    await post(reconcilePath,403,offlineFromCashier,employeeSession);
    await request('shop/staff/' + employee.id,200,{method:'PATCH',account:owner,body:{role:'cashier',active:false}});
    await post('shop/checkout',403,offlineFromCashier,employeeSession);
    const recovered = await post(reconcilePath,200,offlineFromCashier,owner);
    assert.equal(recovered.cashier_id,employee.id);
    assert.equal((await post(reconcilePath,200,offlineFromCashier,owner)).id,recovered.id);
    await post(reconcilePath,409,{...offlineFromCashier,client_sale_id:randomUUID(),
        expected:{...offlineFromCashier.expected,total_cents:118}},owner);
    await request('shop/staff/' + employee.id,200,{method:'PATCH',account:owner,body:{role:'cashier',active:true}});
    const redeemed = await post('shop/checkout', 200, { ...promoOrder, client_sale_id: randomUUID(), expected: quote }, owner);
    assert.equal(redeemed.promotion_id, promo.id);
    await post('shop/checkout', 409, { ...promoOrder, client_sale_id: randomUUID(), expected: quote }, owner);
    await post('shop/promotions', 200, { code: 'BUNDLE', kind: 'bundle', value: 150, group_quantity: 2 }, owner);
    assert.equal((await post('shop/checkout/quote', 200, { ...promoOrder, promo_code: 'BUNDLE' }, owner)).discount_cents, 50);
    await post('shop/promotions', 200, { code: 'FUTURE', kind: 'percent', value: 10,
        starts_at: new Date(Date.now() + 86400000).toISOString() }, owner);
    await post('shop/checkout/quote', 400, { ...promoOrder, promo_code: 'FUTURE' }, owner);
    await request('shop/settings', 200, { method: 'PUT', account: owner, body: {
        tax_basis_points: 1200, service_basis_points: 500, loyalty_cents_per_point: 100
    } });
    await post('shop/loyalty/accounts', 200, { name: 'Regular customer', code: 'MEMBER-001' }, owner);
    const earn = { ...promoOrder, promo_code: null, amount_tendered_cents: 300,
        loyalty_code: 'member-001', client_sale_id: randomUUID() };
    const earningSale = await post('shop/checkout', 200, earn, owner);
    assert.equal((await post('shop/checkout', 200, earn, owner)).id, earningSale.id);
    const [rewardAccount] = await request('shop/loyalty/accounts', 200, { account: owner });
    assert.equal(rewardAccount.points, '2');
    await post('shop/promotions', 200, { code: 'REWARD', kind: 'loyalty', value: 50, points_required: 2 }, owner);
    const redeem = { ...earn, promo_code: 'REWARD', client_sale_id: randomUUID() };
    const redeemedReward = await post('shop/checkout', 200, redeem, owner);
    assert.equal(redeemedReward.discount_cents, 50);
    assert.equal((await request('shop/loyalty/accounts', 200, { account: owner }))[0].points, '1');
    await post('shop/checkout', 409, { ...redeem, client_sale_id: randomUUID() }, owner);
    const db = await pool.connect();
    try {
        await db.query('BEGIN');
        await db.query('SET LOCAL ROLE coffee_saas_runtime');
        await db.query("SELECT set_config('app.tenant_id',$1,true)", [outsider.shop.id]);
        assert.equal((await db.query('SELECT id FROM orders WHERE id=$1', [first.id])).rowCount, 0);
        await assert.rejects(db.query('SELECT password_hash FROM users'), { code: '42501' });
    } finally {
        await db.query('ROLLBACK');
        db.release();
    }

    await request('admin/payments', 403, { account: owner });
    const admin = await post('auth/login', 200, { email: adminEmail, password });
    await request('admin/payment-methods/maya', 403, {
        method: 'PUT', account: owner, body: { name: 'Maya', instructions: 'Merchant account', customer_enabled: true }
    });
    for (const [id, name] of [['maya','Maya'], ['maribank','MariBank'], ['local_transfer','Local transfer']]) {
        await request('admin/payment-methods/' + id, 200, { method: 'PUT', account: admin,
            body: { name, instructions: 'Pay to the merchant account for ' + name, customer_enabled: true } });
    }
    assert.deepEqual((await request('billing/methods', 200)).map(method => method.id).sort(),
        ['gcash','local_transfer','maribank','maya']);
    const paidEmail = `paid-${nonce}@example.invalid`;
    const trialWithPaidPreference = await post('auth/register',201,{
        email:'trial-preference-'+nonce+'@example.invalid',password,name:'Trial owner',shopName:'Trial with paid preference',plan:'premium'
    });
    assert.ok(trialWithPaidPreference.token);
    assert.equal(trialWithPaidPreference.subscription.plan_id,'free');
    const unpaid = await post('auth/register', 201, {
        email: paidEmail, password, name: 'Paid Owner', shopName: 'Paid ' + nonce, plan: 'basic', skip_trial:true
    });
    assert.equal(unpaid.token, undefined);
    const { payment, evidence_token } = await post('billing/select-plan', 200, {
        email: paidEmail, password, plan_id: 'basic', method: 'maya'
    });
    assert.equal(payment.method, 'maya');
    assert.equal(payment.stage, 'awaiting_receipt');
    assert.match(payment.instructions_snapshot, /merchant account for Maya/);
    const verifyPath = 'admin/payments/' + payment.id + '/verify-and-activate';
    await post(verifyPath, 400, { confirmed_received: false, verified_reference: nonce }, admin);
    await post(verifyPath, 409, { confirmed_received: true, verified_reference: nonce }, admin);
    const receiptPath = 'billing/payments/' + payment.id + '/evidence';
    await upload(receiptPath, 401, owner.token, nonce);
    await upload(receiptPath, 415, evidence_token, nonce, receipt, undefined, 'image/svg+xml');
    await upload(receiptPath, 400, evidence_token, nonce, Buffer.from('not an image'));
    const huge = Buffer.from(receipt);
    huge.writeUInt32BE(50000, 16);
    await upload(receiptPath, 400, evidence_token, nonce, huge);
    await upload(receiptPath, 413, evidence_token, nonce, Buffer.alloc(5 * 1024 * 1024 + 1));
    const withTrailingData = Buffer.concat([receipt, Buffer.from('untrusted trailing content')]);
    await upload(receiptPath, 400, evidence_token, nonce, withTrailingData);
    assert.equal((await upload(receiptPath, 200, evidence_token, nonce)).stage, 'under_review');
    await upload(receiptPath, 200, evidence_token, nonce.toUpperCase());
    await upload(receiptPath, 409, evidence_token, randomUUID());
    await request('admin/payments/' + payment.id + '/evidence', 403, { account: owner });
    const imageResponse = await fetch(api + '/api/admin/payments/' + payment.id + '/evidence', {
        headers: { Authorization: 'Bearer ' + admin.token }
    });
    assert.equal(imageResponse.status, 200);
    assert.equal(imageResponse.headers.get('content-type'), 'image/png');
    assert.match(imageResponse.headers.get('cache-control'), /no-store/);
    assert.deepEqual(Buffer.from(await imageResponse.arrayBuffer()), receipt);
    const pending = await post('billing/payment-status', 200, { email: paidEmail, password, payment_id: payment.id });
    assert.equal(pending.payment.status, 'pending');
    assert.equal(pending.payment.stage, 'under_review');
    await post(verifyPath, 409, { confirmed_received: true, verified_reference: randomUUID() }, admin);
    const verification = { confirmed_received: true, verified_reference: nonce, review_note: 'Matched provider statement' };
    await post(verifyPath, 200, verification, admin);
    const paidOwner = await post('auth/login', 200, { email: paidEmail, password });
    const workspaces = await request('me', 200, { account: paidOwner });
    paidOwner.shop = workspaces.shops[0];
    const active = await request('shop/subscription', 200, { account: paidOwner });
    assert.equal(active.status, 'active');
    await post(verifyPath, 409, verification, admin);
    assert.equal((await request('shop/subscription', 200, { account: paidOwner })).current_period_ends_at, active.current_period_ends_at);

    const change = await post('shop/subscription/request-plan', 200, { plan_id: 'basic', method: 'maya' }, owner);
    await post('shop/subscription/request-plan', 409, { plan_id: 'premium' }, owner);
    const reviewPath = 'admin/plan-requests/' + change.id + '/review';
    await post(reviewPath, 403, { decision: 'approve' }, owner);
    const reviewed = await post(reviewPath, 200, { decision: 'approve', plan_id: 'premium', note: 'Approved modification' }, admin);
    assert.equal(reviewed.status, 'awaiting_payment');
    assert.equal((await request('shop/subscription', 200, { account: owner })).plan_id, 'free');
    const billing = await request('shop/subscription/history', 200, { account: owner });
    assert.equal(billing.requests[0].approved_plan_id, 'premium');
    assert.equal(billing.payments[0].id, reviewed.payment_id);
    assert.equal(billing.payments[0].method, 'maya');
    const approvedReceiptPath = 'shop/subscription/payments/' + reviewed.payment_id + '/evidence';
    await upload(approvedReceiptPath, 404, outsider.token, nonce, receipt, outsider.shop.id);
    await upload(approvedReceiptPath, 409, owner.token, nonce.toLowerCase(), receipt, owner.shop.id);
    const rejection = await request('admin/payments/' + reviewed.payment_id, 200, {
        method: 'PATCH', account: admin, body: { status: 'failed', reason: 'Reference not received' }
    });
    assert.equal(rejection.status, 'failed');
    assert.equal((await request('shop/subscription/history', 200, { account: owner })).requests[0].status, 'rejected');
    const approved = await post('shop/subscription/request-plan', 200, { plan_id: 'basic', method: 'maribank' }, owner);
    const approvedRequest = await post('admin/plan-requests/' + approved.id + '/review', 200, { decision: 'approve' }, admin);
    const approvedReference = randomUUID();
    await upload('shop/subscription/payments/' + approvedRequest.payment_id + '/evidence',
        200, owner.token, approvedReference, receipt, owner.shop.id);
    await post('admin/payments/' + approvedRequest.payment_id + '/verify-and-activate', 200, {
        confirmed_received: true, verified_reference: approvedReference
    }, admin);
    assert.equal((await request('shop/subscription/history', 200, { account: owner })).requests[0].status, 'applied');

    const secondBranch = (await pool.query('INSERT INTO branches (tenant_id,name) VALUES ($1,$2) RETURNING id',
        [owner.shop.id,'Secondary branch'])).rows[0];
    const handoverRegister = await post('shop/register/open', 200, {
        branch_id: secondBranch.id, opening_cents: 1000
    }, employeeSession);
    const hiddenOrder = await post('shop/checkout', 200, {
        branch_id: secondBranch.id, register_session_id: handoverRegister.id,
        payment_method: 'cash', amount_tendered_cents: 200,
        items: [{ product_id: dineInProduct.id, quantity: 1 }]
    }, employeeSession);
    const memberAccess = 'shop/staff/' + employee.id + '/access';
    await request('shop/staff/role-permissions',200,{ method:'PUT',account:owner,body:{ role:'cashier',permissions:{ reports:true } } });
    await request('shop/reports?period=daily',200,{ account:employeeSession });
    await request(memberAccess, 403, { method:'PUT',account:employeeSession,body:{ branch_ids:null } });
    await request(memberAccess, 200, { method:'PUT',account:owner,
        body:{ branch_ids:[branch.id],module_permissions:{ reports:true } } });
    assert.deepEqual((await request('shop/branches', 200, { account:employeeSession })).map(row => row.id), [branch.id]);
    await request('shop/orders/' + hiddenOrder.id, 404, { account:employeeSession });
    await request('shop/reports?period=daily&branch_id=' + secondBranch.id, 404, { account:employeeSession });
    const restrictedReport = await request('shop/reports?period=daily', 200, { account:employeeSession });
    assert.equal(restrictedReport.transactions.some(row => row.order_number === hiddenOrder.order_number), false);
    await post('shop/offline/grant', 403, { branchId:secondBranch.id,deviceId:randomUUID() }, employeeSession);
    await request('admin/tenants/' + owner.shop.id + '/modules', 200, {
        method:'PUT',account:admin,body:{ modules:{ reports:false } }
    });
    await request('shop/reports?period=daily', 403, { account:employeeSession });
    await request('admin/tenants/' + owner.shop.id + '/modules', 200, {
        method:'PUT',account:admin,body:{ modules:{ reports:true } }
    });
    await request('admin/plans/basic/modules', 200, { method:'PUT',account:admin,body:{ modules:{ reports:false } } });
    try {
        await request('shop/reports?period=daily', 403, { account:employeeSession });
    } finally {
        const base = plans.find(plan => plan.id === 'basic');
        await request('admin/plans/basic/modules', 200, { method:'PUT',account:admin,body:{ modules:base.module_access } });
    }
    const planKey = 'pkg-' + nonce;
    await post('admin/plans', 201, { id:planKey,title:'Custom business plan',price_cents:100000,
        max_branches:4,max_staff:12 }, admin);
    const platformOwnerEmail = 'platform-' + nonce + '@example.invalid';
    const platformOwner = await post('admin/users', 201, { name:'Platform owner',email:platformOwnerEmail,password }, admin);
    const managed = await post('admin/tenants', 201, { name:'Managed business',owner_email:platformOwnerEmail,
        plan_id:planKey,status:'expired' }, admin);
    const discount = await post('admin/subscription-promotions', 201, { name:'New customer offer',
        plan_id:planKey,code:'SAVE-' + nonce.slice(0,8),kind:'percent',value:20,active:true }, admin);
    const discounted = await post('billing/select-plan', 200, { email:platformOwnerEmail,password,
        plan_id:planKey,method:'local_transfer',discount_code:discount.code });
    assert.equal(discounted.business.id, managed.business.id);
    assert.equal(discounted.payment.amount_cents, 80000);
    await request('admin/tenants/' + managed.business.id + '/profile', 200, { method:'PUT',account:admin,
        body:{ name:'Managed business updated',state:'archived' } });
    await request('admin/users/' + platformOwner.id, 200, { method:'PATCH',account:admin,body:{ state:'suspended' } });
    await post('billing/select-plan', 401, { email:platformOwnerEmail,password,plan_id:planKey });
    assert.ok((await request('admin/activity', 200, { account:admin })).some(row => row.action==='business.created'));
    await assert.rejects(pool.query('UPDATE platform_audit_logs SET target=NULL WHERE false'), { code:'42501' });
    assert.equal((await request('public/site',200)).public_name,'StratifyPOS');
    const inquiry = { name:'Café owner',email:'inquiry-'+nonce+'@example.invalid',
        business:'Example café',message:'Please tell me more about stock transfers.' };
    await post('public/inquiries',400,{ ...inquiry,website:'spam.invalid' });
    assert.equal((await post('public/inquiries',201,inquiry)).received,true);
    await request('admin/inquiries',403,{ account:owner });
    const [stored] = await request('admin/inquiries?q='+encodeURIComponent(inquiry.email),200,{ account:admin });
    assert.equal(stored.message,inquiry.message);
    assert.ok((await request('admin/inquiries/'+stored.id,200,{ method:'PATCH',account:admin,body:{ resolved:true } })).resolved_at);
    if (recoveryDatabase) {
        async function cycle() {
            const worker = spawn(process.execPath,['--input-type=module','-e',
                "import {runBackupCycle} from './src/backup-worker.js'; import {pool} from './src/db.js'; try { await runBackupCycle(); } finally { await pool.end(); }"],
            { env,stdio:['ignore','ignore','inherit'] });
            assert.equal(await new Promise((resolve,reject) => {
                worker.once('error',reject); worker.once('exit',resolve);
            }),0);
        }
        await post('admin/backups',403,{},owner);
        const backup = await post('admin/backups',202,{},admin);
        await cycle();
        let history = await request('admin/backups',200,{account:admin});
        const archive = history.jobs.find(job => job.id===backup.id);
        assert.equal(archive.status,'succeeded',archive.error);
        const downloaded = await fetch(api+'/api/admin/backups/'+backup.id+'/download',{
            headers:{ Authorization:'Bearer '+admin.token }
        });
        assert.equal(downloaded.status,200);
        const encrypted = Buffer.from(await downloaded.arrayBuffer());
        assert.equal(encrypted.subarray(0,17).toString(),'STRATIFY-BACKUP-1');
        const filename = join(storage,backup.id+'.dump.enc');
        assert.deepEqual(await readFile(filename),encrypted);
        await post('admin/backups/'+backup.id+'/restore',400,{ confirmation:'restore' },admin);
        const confirmation = { confirmation:'RESTORE TO EMPTY TARGET' };
        const tampered = Buffer.from(encrypted);
        tampered[tampered.length-1] ^= 1;
        await writeFile(filename,tampered);
        const rejectedRestore = await post('admin/backups/'+backup.id+'/restore',202,confirmation,admin);
        await post('shop/staff',503,{ name:'Writes paused' },owner);
        await cycle();
        history = await request('admin/backups',200,{account:admin});
        assert.match(history.jobs.find(job => job.id===rejectedRestore.id).error,/authenticated/);
        assert.equal(history.maintenance,false);
        await writeFile(filename,encrypted);
        const restore = await post('admin/backups/'+backup.id+'/restore',202,confirmation,admin);
        await cycle();
        history = await request('admin/backups',200,{account:admin});
        const recovery = history.jobs.find(job => job.id===restore.id);
        assert.equal(recovery.status,'succeeded',recovery.error);
        assert.equal(recovery.result.order_rls,true);
        assert.ok(recovery.result.payment_receipts>=2);
        assert.equal(history.maintenance,false);
        const occupied = await post('admin/backups/'+backup.id+'/restore',202,confirmation,admin);
        await cycle();
        history = await request('admin/backups',200,{account:admin});
        assert.match(history.jobs.find(job => job.id===occupied.id).error,/not empty/);
        await request('admin/backups/'+backup.id,202,{ method:'DELETE',account:admin,body:{ confirmation:'DELETE BACKUP' } });
        await cycle();
        assert.ok((await request('admin/backups',200,{account:admin})).jobs.find(job => job.id===backup.id).deleted_at);
    }
});
