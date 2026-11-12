import { offlineDB, type OfflineSale } from './database';
import type { ApiRequest } from '../types';

export function checkoutTotals(subtotal: number, code: string, promotions: {
    code: string; active: boolean; kind: string; value: number; expires_at?: string | null; starts_at?: string | null
}[], taxRate: number, serviceRate: number) {
    const promotion = promotions.find(p => p.code.toUpperCase() === code.trim().toUpperCase() &&
        p.active && (!p.expires_at || Date.parse(p.expires_at) > Date.now()) &&
        (!p.starts_at || Date.parse(p.starts_at) <= Date.now()));
    if (code && !promotion) return null;
    const discount = promotion ? (promotion.kind === 'percent'
        ? Math.round(subtotal * Math.min(promotion.value, 100) / 100)
        : Math.min(subtotal, promotion.value)) : 0;
    const net = subtotal - discount;
    const tax = Math.round(net * taxRate / 10000);
    const service = Math.round(net * serviceRate / 10000);
    return { subtotal_cents: subtotal, discount_cents: discount, tax_cents: tax,
        service_cents: service, total_cents: net + tax + service };
}

export function offlineReceipt(sale: OfflineSale) {
    return {
        order_number: sale.serverOrderNumber || sale.id,
        pending: sale.status !== 'synced',
        created_at: sale.createdAt, order_type: sale.orderType ?? 'takeout', payment_method: 'cash',
        items: sale.items.map(item => ({
            name: item.productName, variation: item.variationName, addons: item.addons,
            quantity: item.quantity, total_cents: item.totalCents
        })),
        subtotal_cents: sale.subtotalCents, discount_cents: sale.discountCents,
        tax_cents: sale.taxCents, service_cents: sale.serviceCents ?? 0,
        total_cents: sale.totalCents, change_cents: sale.changeCents,
        receipt_footer: sale.receiptFooter
    };
}

async function submitOfflineSale(request: ApiRequest, sale: OfflineSale, path: string, signal: AbortSignal) {
    const receipt = offlineReceipt(sale);
    const order = await request(path, 'POST', {
        branch_id: sale.branchId, payment_method: 'cash',
        ...(sale.orderType ? { order_type: sale.orderType, table_id: sale.tableId ?? null } : {}),
        amount_tendered_cents: sale.amountReceivedCents, promo_code: sale.promoCode,
        client_sale_id: sale.id,
        offline: { grant: sale.grant, created_at: sale.createdAt, device_id: sale.deviceId },
        expected: {
            subtotal_cents: receipt.subtotal_cents, discount_cents: receipt.discount_cents,
            tax_cents: receipt.tax_cents, service_cents: receipt.service_cents,
            total_cents: receipt.total_cents
        },
        items: sale.items.map(item => ({
            product_id: item.productId, quantity: item.quantity, variation_id: item.variationId,
            addon_ids: item.addons?.map(addon => addon.id), expected_unit_cents: item.unitPriceCents
        }))
    }, false, signal);
    if (!order?.id || order.client_sale_id !== sale.id) throw new Error('Invalid server acknowledgment');
    return order;
}

export async function reconcileOfflineSale(request: ApiRequest, sale: OfflineSale) {
    if (!sale.grant || sale.status === 'synced') throw new Error('A pending signed cash sale is required.');
    const order = await submitOfflineSale(request, sale, 'checkout/reconcile/' + sale.cashierId, AbortSignal.timeout(20000));
    await offlineDB.transaction('rw', offlineDB.sales, offlineDB.syncQueue, async () => {
        const now = new Date().toISOString();
        await offlineDB.sales.update(sale.id, {
            status:'synced', serverSaleId:order.id, serverOrderNumber:String(order.order_number), syncedAt:now, lastSyncError:null
        });
        await offlineDB.syncQueue.update(sale.id, { status:'synced', lastAttemptAt:now, nextAttemptAt:null, lastError:null });
    });
}

export async function syncOfflineSales(request: ApiRequest, tenantId: string, cashierId: string, signal: AbortSignal) {
    const jobs = await offlineDB.syncQueue.where('tenantId').equals(tenantId).sortBy('createdAt');
    for (const job of jobs) {
        if (signal.aborted) return;
        if (!['pending', 'syncing', 'failed'].includes(job.status) ||
            (job.nextAttemptAt && Date.parse(job.nextAttemptAt) > Date.now())) continue;
        const sale = await offlineDB.sales.get(job.saleId);
        if (!sale || sale.tenantId !== tenantId || sale.cashierId !== cashierId || sale.status === 'synced') continue;
        const attempts = job.attempts + 1;
        let status: OfflineSale['status'] = 'review';
        let message: string | null = 'This sale predates signed cash checkout.';
        let order;
        if (sale.grant) {
            try {
                order = await submitOfflineSale(request, sale, 'checkout', AbortSignal.any([signal, AbortSignal.timeout(20000)]));
                status = 'synced';
                message = null;
            } catch (error: any) {
                if (signal.aborted) return;
                status = [400, 403, 404, 409, 413, 422].includes(error.status) ? 'review' : 'failed';
                message = error.message || 'Synchronization failed.';
            }
        }
        const now = new Date().toISOString();
        await offlineDB.transaction('rw', offlineDB.sales, offlineDB.syncQueue, async () => {
            const current = await offlineDB.syncQueue.get(job.id);
            if (!current || current.status === 'synced' ||
                (status !== 'synced' && current.attempts !== job.attempts)) return;
            await offlineDB.syncQueue.update(job.id, {
                status, attempts, lastAttemptAt: now, lastError: message,
                nextAttemptAt: status === 'failed'
                    ? new Date(Date.now() + Math.min(300000, 3000 * 2 ** Math.min(attempts, 7))).toISOString()
                    : null
            });
            await offlineDB.sales.update(sale.id, {
                status, syncAttempts: attempts, lastSyncError: message,
                ...(status === 'synced' ? {
                    serverSaleId: order.id, serverOrderNumber: String(order.order_number), syncedAt: now
                } : {})
            });
        });
    }
}

export async function retryOfflineSale(sale: OfflineSale) {
    await offlineDB.transaction('rw', offlineDB.sales, offlineDB.syncQueue, async () => {
        const current = await offlineDB.sales.get(sale.id);
        if (!current || current.status === 'synced') return;
        await offlineDB.sales.update(sale.id, { status: 'pending' });
        await offlineDB.syncQueue.update(sale.id, { status: 'pending', nextAttemptAt: null });
    });
}
