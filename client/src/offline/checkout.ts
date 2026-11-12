
import { offlineDB } from './database';
import type { OrderType } from '../types';

import type {
    OfflineSale,
    OfflineSaleItem,
    OfflineSyncJob
} from './database';

export interface LocalCashSaleInput {
    tenantId: string;
    branchId: string;
    deviceId: string;
    cashierId: string;

    items: OfflineSaleItem[];

    amountReceivedCents: number;
    grant?: string;
    promoCode?: string | null;
    discountCents?: number;
    taxBasisPoints?: number;
    serviceBasisPoints?: number;
    receiptFooter?: string;
    orderType?: OrderType;
    tableId?: string | null;
}

// Verify amounts are valid integer centavos.
function validCents(value: number): boolean {
    return Number.isSafeInteger(value) && value >= 0;
}

// ==============================================
// SAVE A LOCAL CASH SALE
// ==============================================

export async function saveLocalCashSale(
    input: LocalCashSaleInput
): Promise<OfflineSale> {

    if (
        !input.tenantId ||
        !input.branchId ||
        !input.deviceId ||
        !input.cashierId
    ) {
        throw new Error(
            'Tenant, branch, device and cashier are required.'
        );
    }

    if (!input.items.length || input.items.length > 100) {
        throw new Error('Sale must contain products.');
    }

    for (const item of input.items) {
        if (
            !item.productId ||
            !item.productName ||
            !Number.isSafeInteger(item.quantity) ||
            item.quantity <= 0 || item.quantity > 100 ||
            !validCents(item.unitPriceCents) ||
            item.discountCents !== 0 ||
            !validCents(item.totalCents) ||
            item.totalCents !==
                item.quantity * item.unitPriceCents
        ) {
            throw new Error(
                'Invalid or unsupported offline sale item.'
            );
        }
    }

    const subtotalCents = input.items.reduce(
        (sum, item) => sum + item.totalCents,
        0
    );

    const discountCents = input.discountCents ?? 0;
    if (!validCents(discountCents) || discountCents > subtotalCents) {
        throw new Error('Invalid discount.');
    }
    const net = subtotalCents - discountCents;
    const taxCents = Math.round(net * (input.taxBasisPoints ?? 0) / 10000);
    const serviceCents = Math.round(net * (input.serviceBasisPoints ?? 0) / 10000);
    const totalCents = net + taxCents + serviceCents;
    if (
        !validCents(totalCents) || subtotalCents > 100000000 ||
        !validCents(input.amountReceivedCents) ||
        input.amountReceivedCents > 100000000 ||
        input.amountReceivedCents < totalCents
    ) {
        throw new Error(
            'Invalid subtotal or insufficient cash received.'
        );
    }

    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();

    const sale: OfflineSale = {
        id,

        tenantId: input.tenantId,
        branchId: input.branchId,
        deviceId: input.deviceId,
        cashierId: input.cashierId,

        createdAt,
        paymentMethod: 'cash',
        orderType: input.orderType,
        tableId: input.tableId,

        items: structuredClone(input.items),

        subtotalCents,
        discountCents,
        taxCents,
        serviceCents,
        totalCents,
        grant: input.grant,
        promoCode: input.promoCode,
        receiptFooter: input.receiptFooter,

        amountReceivedCents:
            input.amountReceivedCents,

        changeCents:
            input.amountReceivedCents - totalCents,

        status: 'pending',

        syncAttempts: 0,
        lastSyncError: null,
        serverSaleId: null,
        syncedAt: null
    };

    const syncJob: OfflineSyncJob = {
        id,
        saleId: id,

        tenantId: input.tenantId,
        branchId: input.branchId,

        status: 'pending',

        attempts: 0,
        createdAt,

        lastAttemptAt: null,
        nextAttemptAt: null,
        lastError: null
    };

    // Both records must be written successfully.
    // If one fails, the transaction rolls back.
    await offlineDB.transaction(
        'rw',
        offlineDB.sales,
        offlineDB.syncQueue,
        async () => {
            if (sale.tableId && await offlineDB.sales.where('branchId').equals(sale.branchId)
                .filter(other => other.tenantId===sale.tenantId && other.tableId===sale.tableId && other.status!=='synced').first()) {
                throw new Error('This table has an offline order awaiting synchronization.');
            }
            await offlineDB.sales.add(sale);
            await offlineDB.syncQueue.add(syncJob);
        }
    );

    return sale;
}

// ==============================================
// LIST PENDING SALES FOR A SPECIFIC TENANT
// ==============================================

export async function listLocalPendingSales(
    tenantId: string
): Promise<OfflineSale[]> {

    if (!tenantId) {
        throw new Error('Tenant ID is required.');
    }

    return offlineDB.sales
        .where('[tenantId+status]')
        .equals([tenantId, 'pending'])
        .toArray();
}

// ==============================================
// STORAGE TEST ONLY
//
// Creates synthetic data using a separate
// test tenant. Not a real POS transaction.
// ==============================================

export async function testLocalSaleStorage() {
    const sale = await saveLocalCashSale({
        tenantId: 'offline-storage-test',
        branchId: 'test-branch',
        deviceId: 'test-device',
        cashierId: 'test-cashier',

        items: [
            {
                productId: 'test-product',
                productName: 'Storage Test Item',
                quantity: 1,
                unitPriceCents: 5000,
                discountCents: 0,
                totalCents: 5000
            }
        ],

        amountReceivedCents: 10000
    });

    const savedSale = await offlineDB.sales.get(
        sale.id
    );

    const queuedJob = await offlineDB.syncQueue.get(
        sale.id
    );

    if (!savedSale || !queuedJob) {
        throw new Error(
            'Offline transaction storage test failed.'
        );
    }

    console.log('LOCAL SALE STORAGE TEST PASSED', {
        transactionId: sale.id,
        status: savedSale.status,
        totalCents: savedSale.totalCents,
        changeCents: savedSale.changeCents,
        queued: true
    });

    // Remove only the synthetic test records.
    // Never delete real pending sales.
    await offlineDB.transaction(
        'rw',
        offlineDB.sales,
        offlineDB.syncQueue,
        async () => {
            await offlineDB.syncQueue.delete(sale.id);
            await offlineDB.sales.delete(sale.id);
        }
    );

    return {
        passed: true,
        transactionId: sale.id,
        testRecordsRemoved: true
    };
}
