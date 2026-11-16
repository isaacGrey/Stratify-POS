
import { offlineDB, localRecordKey } from './database';
import type {
    OfflineProduct,
    OfflinePromotion
} from './database';

// =============================================
// STRATIFYPOS OFFLINE CATALOG
// Products and Promotions
//
// Uses existing authenticated API request.
// Does NOT store JWT or passwords.
// =============================================

type ApiRequestFunction = (
    path: string,
    method?: string,
    body?: unknown,
    admin?: boolean
) => Promise<any>;

export interface CatalogSyncResult {
    products: number;
    promotions: number;
    tenantId: string;
    branchId: string;
    syncedAt: string;
}

function requireId(value: string, name: string) {
    if (!value || typeof value !== 'string') {
        throw new Error(`${name} is required.`);
    }
}

export async function syncOfflineCatalog(
    request: ApiRequestFunction,
    tenantId: string,
    branchId: string
): Promise<CatalogSyncResult> {

    requireId(tenantId, 'Tenant ID');
    requireId(branchId, 'Branch ID');

    // Fetch through the existing authenticated
    // tenant-scoped API request.
    const [products, promotions, addons, tables] = await Promise.all([
        request('products'),
        request('promotions'),
        request('addons'),
        request('tables')
    ]);

    if (
        !Array.isArray(products) ||
        !Array.isArray(promotions) || !Array.isArray(addons) || !Array.isArray(tables)
    ) {
        throw new Error(
            'Invalid catalog response. Local data was not changed.'
        );
    }

    const syncedAt = new Date().toISOString();

    const localProducts: OfflineProduct[] =
        products.map((product: any) => {

            if (
                !product.id ||
                typeof product.name !== 'string' ||
                !Number.isSafeInteger(
                    Number(product.price_cents)
                ) ||
                Number(product.price_cents) < 0
            ) {
                throw new Error(
                    'Invalid product received from server.'
                );
            }

            return {
                key: localRecordKey(
                    tenantId,
                    branchId,
                    product.id
                ),

                tenantId,
                branchId,

                productId: product.id,
                name: product.name,

                categoryId: product.category_id ?? null,
                category: product.category,
                variations: product.variations,

                priceCents: Number(product.price_cents),
                productType: product.product_type,
                productClass: product.product_class,

                active: product.active === true,

                updatedAt: syncedAt
            };
        });

    const localPromotions: OfflinePromotion[] =
        promotions.filter(promotion => promotion.offline_eligible !== false).map((promotion: any) => {

            if (
                !promotion.id ||
                typeof promotion.code !== 'string' ||
                !['percent', 'fixed'].includes(promotion.kind) ||
                !Number.isFinite(Number(promotion.value))
            ) {
                throw new Error(
                    'Invalid promotion received from server.'
                );
            }

            return {
                key: localRecordKey(
                    tenantId,
                    promotion.id
                ),

                tenantId,

                promotionId: promotion.id,
                code: promotion.code,

                kind: promotion.kind,
                value: Number(promotion.value),

                active: promotion.active === true,

                expiresAt: promotion.expires_at ?? null,
                startsAt: promotion.starts_at ?? null,

                updatedAt: syncedAt
            };
        });

    // Atomic local replacement.
    // Any error rolls back the whole transaction.
    await offlineDB.transaction(
        'rw',
        offlineDB.products,
        offlineDB.promotions,
        offlineDB.settings,
        async () => {

            const oldProducts = await offlineDB.products
                .where('[tenantId+branchId]')
                .equals([tenantId, branchId])
                .primaryKeys();

            const oldPromotions = await offlineDB.promotions
                .where('tenantId')
                .equals(tenantId)
                .primaryKeys();

            await offlineDB.products.bulkDelete(oldProducts);
            await offlineDB.promotions.bulkDelete(oldPromotions);

            if (localProducts.length > 0) {
                await offlineDB.products.bulkPut(localProducts);
            }

            if (localPromotions.length > 0) {
                await offlineDB.promotions.bulkPut(
                    localPromotions
                );
            }

            const settingKey = localRecordKey(
                tenantId,
                branchId
            );

            await offlineDB.settings.put({
                key: settingKey,

                tenantId,
                branchId,

                deviceId: 'not-registered',

                catalogUpdatedAt: syncedAt,
                lastSuccessfulSync: null,
                addons,
                tables: tables.filter(table => table.branch_id === branchId)
            });
        }
    );

    return {
        products: localProducts.length,
        promotions: localPromotions.length,
        tenantId,
        branchId,
        syncedAt
    };
}

// =============================================
// READ CACHED PRODUCTS
// =============================================

export async function getCachedProducts(
    tenantId: string,
    branchId: string
): Promise<OfflineProduct[]> {

    requireId(tenantId, 'Tenant ID');
    requireId(branchId, 'Branch ID');

    return offlineDB.products
        .where('[tenantId+branchId]')
        .equals([tenantId, branchId])
        .toArray();
}

// =============================================
// READ CACHED PROMOTIONS
// =============================================

export async function getCachedPromotions(
    tenantId: string
): Promise<OfflinePromotion[]> {

    requireId(tenantId, 'Tenant ID');

    return offlineDB.promotions
        .where('tenantId')
        .equals(tenantId)
        .toArray();
}

// =============================================
// CHECK LAST CATALOG UPDATE
// =============================================

export async function getCatalogStatus(
    tenantId: string,
    branchId: string
) {
    const key = localRecordKey(tenantId, branchId);

    const setting = await offlineDB.settings.get(key);

    const products = await getCachedProducts(
        tenantId,
        branchId
    );

    const promotions = await getCachedPromotions(
        tenantId
    );

    return {
        ready: Boolean(setting?.catalogUpdatedAt),
        tenantId,
        branchId,
        products: products.length,
        promotions: promotions.length,
        lastUpdated: setting?.catalogUpdatedAt ?? null
    };
}
