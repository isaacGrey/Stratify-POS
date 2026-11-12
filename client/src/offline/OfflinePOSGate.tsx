import { useMemo, type ReactNode } from 'react';
import { Wifi, WifiOff } from 'lucide-react';
import type { ApiRequest, OrderType } from '../types';
import { getCachedProducts, getCachedPromotions } from './catalog';
import { saveLocalCashSale } from './checkout';
import { localRecordKey, offlineDB } from './database';
import { getStoredOfflineGrant, verifyOfflineGrant } from './offlineSession';
import { checkoutTotals, offlineReceipt } from './sync';

interface Props {
    tenantId: string;
    cashierId: string;
    online: boolean | null;
    request: ApiRequest;
    children: (request: ApiRequest, offline: boolean) => ReactNode;
}

export default function OfflinePOSGate({ tenantId, cashierId, online, request, children }: Props) {
    const cachedRequest = useMemo<ApiRequest>(() => async (path, method = 'GET', rawBody) => {
        const signed = getStoredOfflineGrant(tenantId);
        const grant = signed && await verifyOfflineGrant(signed, tenantId);
        if (!grant || grant.userId !== cashierId) throw new Error('Offline access expired. Reconnect to renew it.');
        const { branchId } = grant;
        const settings = await offlineDB.settings.get(localRecordKey(tenantId, branchId));
        if (!settings?.catalogUpdatedAt) throw new Error('Download the offline catalog while connected.');
        const products = await getCachedProducts(tenantId, branchId);
        const addons = settings.addons ?? [];
        const promotions = (await getCachedPromotions(tenantId)).map(p => ({
            ...p, expires_at: p.expiresAt, starts_at: p.startsAt
        }));
        switch (path) {
            case 'branches': return [{ id: branchId, name: grant.branchName, active: true }];
            case 'products': return products.map(p => ({
                id: p.productId, name: p.name, price_cents: p.priceCents,
                category_id: p.categoryId, category: p.category, active: p.active, variations: p.variations ?? []
            }));
            case 'categories': return [...new Map(products.filter(p => p.categoryId)
                .map(p => [p.categoryId, p.category || 'General'])).entries()]
                .map(([id, name]) => ({ id, name }));
            case 'tables': {
                const pending = await offlineDB.sales.where('branchId').equals(branchId)
                    .filter(sale => sale.tenantId===tenantId && !!sale.tableId && sale.status!=='synced').toArray();
                const occupied = new Set(pending.map(sale => sale.tableId));
                return (settings.tables || []).map(table => occupied.has(table.id) ? { ...table,status:'occupied' } : table);
            }
            case 'addons': return addons;
            case 'promotions': return promotions;
            case 'settings': return { tax_basis_points: grant.taxBasisPoints ?? 0, service_basis_points: grant.serviceBasisPoints ?? 0 };
            case 'checkout': {
                const body = rawBody as {
                    branch_id: string; payment_method: string; order_type: OrderType; table_id?: string | null;
                    amount_tendered_cents: number; promo_code?: string;
                    items: { product_id: string; quantity: number; variation_id?: string; addon_ids: string[] }[];
                };
                if (method !== 'POST' || !grant.permissions.includes('checkout:cash')) {
                    throw new Error('Reconnect and prepare the catalog to enable offline cash checkout.');
                }
                if (body.branch_id !== branchId || body.payment_method !== 'cash' ||
                    !['takeout','dine_in','delivery'].includes(body.order_type)) {
                    throw new Error('Offline checkout requires cash at the authorized branch.');
                }
                if (body.table_id && (body.order_type !== 'dine_in' || !(settings.tables || []).some(table =>
                    table.id===body.table_id && ['available','reserved'].includes(table.status)))) {
                    throw new Error('This table is unavailable in the offline catalog.');
                }
                const items = body.items.map(line => {
                    const product = products.find(p => p.productId === line.product_id && p.active);
                    const variation = product?.variations?.find(v => v.id === line.variation_id);
                    const selected = addons.filter(a => a.active && line.addon_ids.includes(a.id));
                    if (!product || (line.variation_id && !variation) || selected.length !== line.addon_ids.length) {
                        throw new Error('An item or option is unavailable offline.');
                    }
                    const unit = (variation?.price_cents ?? product.priceCents + (variation?.price_delta_cents ?? 0)) +
                        selected.reduce((sum, addon) => sum + addon.price_cents, 0);
                    return {
                        productId: product.productId, productName: product.name,
                        variationId: variation?.id, variationName: variation?.name, addons: selected,
                        quantity: line.quantity, unitPriceCents: unit, discountCents: 0,
                        totalCents: unit * line.quantity
                    };
                });
                const subtotal = items.reduce((sum, item) => sum + item.totalCents, 0);
                const totals = checkoutTotals(subtotal, body.promo_code || '', promotions,
                    grant.taxBasisPoints!, grant.serviceBasisPoints!);
                if (!totals) throw new Error('Promo code is unavailable in the offline catalog.');
                const expected = (rawBody as { expected?: { total_cents: number } }).expected;
                if (expected?.total_cents !== totals.total_cents) {
                    throw new Error('The offline order total changed. Review the cart.');
                }
                return offlineReceipt(await saveLocalCashSale({
                    tenantId, branchId, cashierId, deviceId: grant.deviceId, grant: signed,
                    items, amountReceivedCents: body.amount_tendered_cents,
                    promoCode: body.promo_code, discountCents: totals.discount_cents,
                    orderType: body.order_type, tableId: body.table_id,
                    taxBasisPoints: grant.taxBasisPoints, serviceBasisPoints: grant.serviceBasisPoints,
                    receiptFooter: grant.receiptFooter
                }));
            }
            default: throw new Error('This action requires a connection.');
        }
    }, [tenantId, cashierId]);

    if (online === null) return <p role="status">Checking connection…</p>;
    return <>
        <p className={online ? 'flash success' : 'flash warning'} role="status">
            {online ? <Wifi size={17} /> : <WifiOff size={17} />}
            {online ? 'Connected to StratifyPOS' : 'Offline · Cash sales are saved on this device'}
        </p>
        {children(online ? request : cachedRequest, !online)}
    </>;
}
