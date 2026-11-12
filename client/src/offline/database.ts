
import Dexie, { type Table } from 'dexie';
import type { OrderType } from '../types';

// ==============================================
// STRATIFYPOS OFFLINE DATABASE
// Version 1
//
// Local browser storage only.
// PostgreSQL remains the source of truth.
// ==============================================

export type SyncStatus =
    | 'pending'
    | 'syncing'
    | 'synced'
    | 'failed'
    | 'review';

export interface OfflineProduct {
    key: string;

    tenantId: string;
    branchId: string;

    productId: string;
    name: string;
    categoryId: string | null;
    category?: string;
    variations?: { id: string; name: string; price_delta_cents: number; price_cents?: number | null }[];

    priceCents: number;
    active: boolean;

    updatedAt: string;
}

export interface OfflinePromotion {
    key: string;

    tenantId: string;

    promotionId: string;
    code: string;

    kind: 'percent' | 'fixed';
    value: number;

    active: boolean;
    expiresAt: string | null;
    startsAt?: string | null;

    updatedAt: string;
}

export interface OfflineInventory {
    key: string;

    tenantId: string;
    branchId: string;
    productId: string;

    quantity: number;
    updatedAt: string;
}

export interface OfflineSaleItem {
    productId: string;
    productName: string;
    variationId?: string;
    variationName?: string;
    addons?: { id: string; name: string; price_cents: number }[];

    quantity: number;
    unitPriceCents: number;

    discountCents: number;
    totalCents: number;
}

export interface OfflineSale {
    id: string;

    tenantId: string;
    branchId: string;
    deviceId: string;
    cashierId: string;

    createdAt: string;

    paymentMethod: 'cash';
    orderType?: OrderType;
    tableId?: string | null;

    items: OfflineSaleItem[];

    subtotalCents: number;
    discountCents: number;
    taxCents: number;
    serviceCents?: number;
    promoCode?: string | null;
    grant?: string;
    receiptFooter?: string;
    serverOrderNumber?: string;
    totalCents: number;

    amountReceivedCents: number;
    changeCents: number;

    status: SyncStatus;

    syncAttempts: number;
    lastSyncError: string | null;
    serverSaleId: string | null;
    syncedAt: string | null;
}

export interface OfflineSyncJob {
    id: string;

    saleId: string;

    tenantId: string;
    branchId: string;

    status: SyncStatus;

    attempts: number;
    createdAt: string;
    lastAttemptAt: string | null;
    nextAttemptAt: string | null;
    lastError: string | null;
}

export interface OfflineSetting {
    key: string;

    tenantId: string;
    branchId: string;
    deviceId: string;

    catalogUpdatedAt: string | null;
    lastSuccessfulSync: string | null;
    addons?: { id: string; name: string; price_cents: number; active: boolean }[];
    tables?: { id: string; branch_id: string; label: string; status: string }[];
}

// ==============================================
// DATABASE CLASS
// ==============================================

export class StratifyOfflineDB extends Dexie {
    products!: Table<OfflineProduct, string>;

    promotions!: Table<OfflinePromotion, string>;

    inventory!: Table<OfflineInventory, string>;

    sales!: Table<OfflineSale, string>;

    syncQueue!: Table<OfflineSyncJob, string>;

    settings!: Table<OfflineSetting, string>;

    constructor() {
        super('StratifyPOS_Offline');

        this.version(1).stores({
            products:
                'key, tenantId, branchId, productId, [tenantId+branchId]',

            promotions:
                'key, tenantId, promotionId, code',

            inventory:
                'key, tenantId, branchId, productId, [tenantId+branchId]',

            sales:
                'id, tenantId, branchId, deviceId, cashierId, createdAt, status, [tenantId+status]',

            syncQueue:
                'id, saleId, tenantId, branchId, status, createdAt, [tenantId+status]',

            settings:
                'key, tenantId, branchId, deviceId'
        });
    }
}

export const offlineDB = new StratifyOfflineDB();

// ==============================================
// LOCAL STORAGE HEALTH CHECK
// ==============================================

export async function initializeOfflineDatabase() {
    await offlineDB.open();

    const storagePersistent =
        navigator.storage?.persisted
            ? await navigator.storage.persisted()
            : false;

    return {
        ready: offlineDB.isOpen(),
        storagePersistent
    };
}

// ==============================================
// REQUEST PERSISTENT STORAGE
// Call from a user-initiated setup action.
// Not a guarantee against manual deletion.
// ==============================================

export async function requestOfflineStoragePersistence() {
    if (!navigator.storage?.persist) {
        return false;
    }

    return navigator.storage.persist();
}

// ==============================================
// GENERATE LOCAL RECORD KEYS
// ==============================================

export function localRecordKey(
    ...parts: string[]
): string {
    if (parts.some(part => !part)) {
        throw new Error(
            'All local record key parts are required.'
        );
    }

    return parts.join(':');
}

// ==============================================
// PENDING TRANSACTION COUNT
// Scoped to the authenticated tenant.
// ==============================================

export async function getPendingSaleCount(
    tenantId: string
): Promise<number> {
    if (!tenantId) {
        throw new Error('Tenant ID required.');
    }

    return offlineDB.sales
        .where('[tenantId+status]')
        .equals([tenantId, 'pending'])
        .count();
}

// ==============================================
// READ PENDING SALES
// ==============================================

export async function getPendingSales(
    tenantId: string
): Promise<OfflineSale[]> {
    if (!tenantId) {
        throw new Error('Tenant ID required.');
    }

    return offlineDB.sales
        .where('[tenantId+status]')
        .equals([tenantId, 'pending'])
        .toArray();
}

// ==============================================
// CHECK LOCAL DATABASE STATUS
// ==============================================

export async function getOfflineDatabaseStatus() {
    await offlineDB.open();

    const storageEstimate =
        navigator.storage?.estimate
            ? await navigator.storage.estimate()
            : null;

    return {
        ready: offlineDB.isOpen(),

        products: await offlineDB.products.count(),

        promotions: await offlineDB.promotions.count(),

        inventory: await offlineDB.inventory.count(),

        sales: await offlineDB.sales.count(),

        pendingSales: await offlineDB.sales
            .where('status')
            .equals('pending')
            .count(),

        storageUsedBytes:
            storageEstimate?.usage ?? null,

        storageQuotaBytes:
            storageEstimate?.quota ?? null
    };
}
