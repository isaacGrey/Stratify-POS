import { useEffect, useState } from 'react';
import { liveQuery } from 'dexie';
import type { ApiRequest } from '../types';
import { offlineDB, type OfflineSale } from './database';
import { offlineReceipt, retryOfflineSale, syncOfflineSales } from './sync';

export function useOfflineSales(request: ApiRequest, tenantId: string, cashierId: string, online: boolean,
    reviewBranches?: string[] | null) {
    const [sales, setSales] = useState<OfflineSale[]>([]);
    const [error, setError] = useState('');
    useEffect(() => {
        if (!tenantId || !cashierId) return;
        const subscription = liveQuery(() => offlineDB.sales.where('tenantId').equals(tenantId)
            .reverse().sortBy('createdAt'))
            .subscribe({
                next: rows => { setSales(rows); setError(''); },
                error: () => setError('Local transaction history could not be read.')
            });
        return () => subscription.unsubscribe();
    }, [tenantId, cashierId]);
    useEffect(() => {
        if (!online || !tenantId || !cashierId) return;
        const controller = new AbortController();
        let running = false;
        async function sync() {
            if (running || controller.signal.aborted) return;
            running = true;
            try {
                await syncOfflineSales(request, tenantId, cashierId, controller.signal);
            } catch {
                if (!controller.signal.aborted) setError('The local synchronization queue could not be updated.');
            } finally {
                running = false;
            }
        }
        const foreground = () => { if (!document.hidden) void sync(); };
        const timer = window.setInterval(foreground, 5000);
        window.addEventListener('online', foreground);
        document.addEventListener('visibilitychange', foreground);
        void sync();
        return () => {
            controller.abort();
            window.clearInterval(timer);
            window.removeEventListener('online', foreground);
            document.removeEventListener('visibilitychange', foreground);
        };
    }, [request, tenantId, cashierId, online]);
    return {
        sales: sales.filter(sale => sale.tenantId === tenantId && (sale.cashierId === cashierId ||
            (online && sale.status !== 'synced' && (reviewBranches === null || reviewBranches?.includes(sale.branchId))))),
        error
    };
}

export function OfflineSales({ sales, error, online, showReceipt, cashierId, reconcile }: {
    sales: OfflineSale[];
    error: string;
    online: boolean;
    showReceipt: (receipt: ReturnType<typeof offlineReceipt>) => void;
    cashierId: string;
    reconcile?: (sale: OfflineSale) => Promise<void>;
}) {
    const [visible, setVisible] = useState(10);
    const [retryError, setRetryError] = useState('');
    const [reconciling, setReconciling] = useState('');
    const labels = { pending: 'Pending', syncing: 'Pending', synced: 'Synchronized', failed: 'Failed · retry scheduled', review: 'Needs review' };
    const ordered = [...sales.filter(s => s.status !== 'synced'), ...sales.filter(s => s.status === 'synced')];
    if (!sales.length && !error) return null;
    return <details className="panel offline-sales">
        <summary>Offline transactions · {sales.filter(s => s.status !== 'synced').length} awaiting reconciliation</summary>
        {(error || retryError) && <p role="alert">{error || retryError}</p>}
        <ul>
            {ordered.slice(0, visible).map(sale => <li key={sale.id}>
                <strong>{labels[sale.status]}</strong>
                <span>{new Date(sale.createdAt).toLocaleString()} · ₱{(sale.totalCents / 100).toFixed(2)}</span>
                {sale.lastSyncError && sale.status !== 'synced' && <span>{sale.lastSyncError}</span>}
                <button className="btn btn-outline" onClick={() => showReceipt(offlineReceipt(sale))}>Receipt</button>
                {online && sale.cashierId === cashierId && sale.grant && ['failed', 'review'].includes(sale.status) &&
                    <button className="btn btn-outline" onClick={async () => {
                        try { await retryOfflineSale(sale); setRetryError(''); }
                        catch { setRetryError('Could not schedule a retry.'); }
                    }}>Retry unchanged sale</button>}
                {online && reconcile && sale.grant && sale.status !== 'synced' &&
                    <button className="btn btn-outline" disabled={!!reconciling} onClick={async () => {
                        if (!window.confirm('Submit this cash sale with its original quantities and amounts?')) return;
                        setReconciling(sale.id);
                        setRetryError('');
                        try { await reconcile(sale); }
                        catch (error) { setRetryError(error instanceof Error ? error.message : 'Reconciliation failed.'); }
                        finally { setReconciling(''); }
                    }}>{reconciling === sale.id ? 'Submitting…' : 'Reconcile unchanged sale'}</button>}
            </li>)}
        </ul>
        {visible < sales.length && <button className="btn btn-outline" onClick={() => setVisible(visible + 10)}>Show more</button>}
    </details>;
}
