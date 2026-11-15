import { registerSW } from 'virtual:pwa-register';
import { apiOrigin, publicUrl } from './site-routing';
import { BusinessEditor, moduleLabels, PermissionFields, PlatformPage } from './platform-pages';
import { Button, Empty, Field, Heading, Load, Modal, Panel, Table, fmt, money, pesos, useLoad } from './ui';
import { fetchPaymentMethods, paymentStageLabel, ReceiptSubmission, type PaymentMethod } from './billing';
import { CashRegisterPanel, PurchasingPage, RefundDialog } from './operations';
import { CustomerOrdersQueue, KitchenDisplay, MenuManagement, RegisterSummary } from './kitchen-menu';
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { LayoutDashboard, Coffee, Package, ChartNoAxesCombined, Users, Settings, Store, LogOut, Plus, Search, ShoppingCart, Minus, Trash2, Receipt, ArrowRight, ChevronDown, Menu, X, Bell, Clock, CalendarDays, Tags, CreditCard, ShieldCheck, Sun, Layers, UserRound, ClipboardList, CheckCircle2, Printer, ArrowUpRight, Wallet, AlertTriangle } from 'lucide-react';
import { ResponsiveContainer, AreaChart, Area, XAxis, Tooltip, CartesianGrid } from 'recharts';
import './style.css';
import type { ApiRequest, AuthPayload, Workspace, ShopUser } from './types';
import type { LucideIcon } from 'lucide-react';
import { ScanLine, ShoppingBag, Boxes } from 'lucide-react';
import { testOfflineSystem } from './offline/test';
import { OfflineSales, useOfflineSales } from './offline/OfflineSales';
import { checkoutTotals, reconcileOfflineSale } from './offline/sync';
import { requestOfflineStoragePersistence } from './offline/database';
import OfflinePOSGate from './offline/OfflinePOSGate';
import OfflineSessionGuard from './offline/OfflineSessionGuard';
import {
    testOfflineGrantSecurity
} from './offline/offlineSession';
import {
    getOfflineDeviceId,
    saveOfflineGrant,
    clearOfflineGrant,
    restoreOfflineGrant
} from './offline/offlineSession';
import { checkServerConnection } from './offline/connection';
import {
    syncOfflineCatalog,
    getCatalogStatus
} from './offline/catalog';





if (import.meta.env.DEV) {
    const devWindow = window as Window & {
        testOfflineSystem?: () => Promise<void>;

        testOfflineGrantSecurity?: (
            tenantId: string
        ) => Promise<unknown>;
    };

    devWindow.testOfflineSystem =
        testOfflineSystem;

    devWindow.testOfflineGrantSecurity =
        testOfflineGrantSecurity;
}



const API = apiOrigin;
const routes: [
    string,
    string,
    LucideIcon
][] = [
    ['overview', 'Dashboard', LayoutDashboard],
    ['pos', 'Point of Sale', ScanLine],
    ['kitchen','Kitchen Display',Coffee],
    ['menu','Customer QR Menus',ClipboardList],
    ['products', 'Products & Services', ShoppingBag],
    ['inventory', 'Inventory Management', Boxes],
    ['purchasing', 'Purchasing & Suppliers', ClipboardList],
    ['orders', 'Sales & Transactions', Receipt],
    ['reports', 'Reports & Analytics', ChartNoAxesCombined],
    ['staff', 'Team & Attendance', Users],
    ['branches', 'Branches & Locations', Store],
    ['promotions', 'Promotions & Discounts', Tags],
    ['settings', 'Settings & Billing', Settings]
];
const platformNavigation: [string,string,LucideIcon][] = [
    ['dashboard','Platform dashboard',LayoutDashboard], ['users','Users',Users], ['businesses','Businesses',Store],
    ['subscriptions','Subscriptions',CreditCard], ['trials','Trials',Clock], ['saas-promotions','SaaS promotions',Tags],
    ['payments','Payments',Wallet], ['branches','Branch oversight',Store], ['access','Access control',ShieldCheck],
    ['activity','Activity logs',ClipboardList], ['system','System settings',Settings], ['backups','Backups',Boxes]
];

function App() {
    const [adminSection,setAdminSection] = useState('dashboard');
    const [token, setToken] = useState(localStorage.getItem('crema-token') || '');
    const [me, setMe] = useState<{
        user: ShopUser;
        shops: Workspace[];
        superAdmin?: boolean;
    } | null>(null), [shop, setShop] = useState(localStorage.getItem('crema-shop') || ''), [page, setPage] = useState('overview'), [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false), [mobile, setMobile] = useState(false);
    const request: ApiRequest = useCallback(async (path, method = 'GET', body, admin = false, signal) => {
        const response = await fetch(API + '/api/' + (admin ? 'admin/' : 'shop/') + path, {
            method, signal, headers: {
                'Content-Type': 'application/json', Authorization: 'Bearer ' + token,
                ...(admin ? {} : { 'X-Tenant-Id': shop })
            },
            body: body === undefined ? undefined : JSON.stringify(body)
        });
        const type = response.headers.get('Content-Type') || '';
        if (response.ok && (type === 'image/png' || type === 'image/jpeg' || type.startsWith('application/octet-stream') || type.startsWith('application/pdf') ||
            type.startsWith('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'))) return response.blob();
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw Object.assign(new Error(data.error || 'Request failed'), { status: response.status });
        return data;
    }, [token, shop]);


const [serverAvailable, setServerAvailable] =
    useState<boolean | null>(null);
    const saleWorkspace = me?.shops.find(workspace => workspace.id === shop);
    const canReconcileSales = ['owner', 'manager'].includes(saleWorkspace?.role || '') && saleWorkspace?.modules?.pos !== false;
    const localSales = useOfflineSales(request, shop, me?.user.id || '', serverAvailable === true,
        canReconcileSales ? saleWorkspace?.branch_ids ?? null : undefined);
    const [localReceipt, setLocalReceipt] = useState(null);

useEffect(() => {
    let disposed = false;
    let checking = false;

    async function checkConnection() {
        if (checking) return;

        checking = true;

        try {
            const result = await checkServerConnection();

            if (!disposed) {
                setServerAvailable(result.online);
            }
        } catch {
            if (!disposed) {
                setServerAvailable(false);
            }
        } finally {
            checking = false;
        }
    }

    function onOffline() {
        setServerAvailable(false);
    }

    function onOnline() {
        void checkConnection();
    }

    window.addEventListener('offline', onOffline);
    window.addEventListener('online', onOnline);

    const interval = window.setInterval(
        checkConnection,
        10000
    );

    void checkConnection();

    return () => {
        disposed = true;

        window.clearInterval(interval);

        window.removeEventListener(
            'offline',
            onOffline
        );

        window.removeEventListener(
            'online',
            onOnline
        );
    };
}, []);


    const publicReq = async (path: string, body: AuthPayload): Promise<any> => {
        const response = await fetch(API + '/api/' + path, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(body)
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
            throw new Error(data.error || 'Request failed');
        }
        // Verify that the login API returned
        // the exact account being signed in.
        if (path === 'auth/login') {
            const enteredEmail = String(body.email || '').trim().toLowerCase();
            const returnedEmail = String(data.user?.email || '').trim().toLowerCase();
            if (!data.token ||
                !data.user?.id ||
                returnedEmail !== enteredEmail) {
                throw new Error('Login account mismatch. Session was not saved.');
            }
            // Verify the identity attached to the JWT.
            const meResponse = await fetch(API + '/api/me', {
                headers: {
                    Authorization: 'Bearer ' + data.token
                },
                cache: 'no-store'
            });
            if (!meResponse.ok) {
                throw new Error('Unable to verify the login session.');
            }
            const meData = await meResponse.json();
            if (meData.user?.id !== data.user.id ||
                String(meData.user?.email || '')
                    .toLowerCase() !== enteredEmail) {
                throw new Error('Session identity mismatch. Login cancelled.');
            }
            // Keep the verified user identity.
            data.user = meData.user;
        }
        return data;
    };
    
const refresh = useCallback(async () => {
    if (!token) return;

    try {
        const response = await fetch(
            API + '/api/me',
            {
                method: 'GET',
                headers: {
                    Authorization: 'Bearer ' + token
                },
                cache: 'no-store'
            }
        );

        if (response.status === 401) {
            clearOfflineGrant(shop);
            localStorage.removeItem('crema-token');
            localStorage.removeItem('crema-shop');

            setToken('');
            setMe(null);
            setShop('');

            return;
        }

        if (!response.ok) {
            throw new Error(
                `Session verification failed: ${response.status}`
            );
        }

        const data = await response.json();

        if (
            !data.superAdmin &&
            (
                !Array.isArray(data.shops) ||
                data.shops.length === 0
            )
        ) {
            localStorage.removeItem('crema-token');
            localStorage.removeItem('crema-shop');

            setToken('');
            setMe(null);
            setShop('');

            return;
        }

        setMe(data);

        if (data.superAdmin) {
            setPage('admin');
            return;
        }

        const allowedShops = data.shops;
        const validShop = allowedShops.some(
            (s: Workspace) => s.id === shop
        );

        const nextShop = validShop
            ? shop
            : allowedShops[0]?.id || '';

        if (nextShop !== shop) {
            setShop(nextShop);

            if (nextShop) {
                localStorage.setItem(
                    'crema-shop',
                    nextShop
                );
            } else {
                localStorage.removeItem('crema-shop');
            }
        }

    
} catch (error) {
    console.warn(
        'Online session verification failed:',
        error
    );

    // Only use offline restoration when the
    // server is actually unavailable.
    const connection = await checkServerConnection();

    if (connection.online) {
        setMe(null);
        return;
    }

    const grant = await restoreOfflineGrant(shop);

    if (!grant) {
        console.warn(
            'No valid signed offline session.'
        );

        setMe(null);
        return;
    }

    const cachedCatalog = await getCatalogStatus(
        grant.tenantId,
        grant.branchId
    );

    if (!cachedCatalog.ready) {
        setMe(null);
        return;
    }

    setMe({
        user: {
            id: grant.userId,
            name: grant.userName,
            email: grant.userEmail
        } as ShopUser,

        shops: [
            {
                id: grant.tenantId,
                name: grant.tenantName,
                role: grant.role,
                status: 'active'
            } as Workspace
        ],

        superAdmin: false
    });

    setShop(grant.tenantId);
    setPage('pos');

    console.log(
        'Verified offline POS session.'
    );
}

}, [token, shop]);

    useEffect(() => {
    if (serverAvailable !== null) {
        void refresh();
    }
}, [refresh, serverAvailable]);
useEffect(() => {
    if (!token || serverAvailable !== true) return;
    const update = () => { if (!document.hidden) void refresh(); };
    const timer = window.setInterval(update,30000);
    window.addEventListener('focus',update);
    return () => { window.clearInterval(timer); window.removeEventListener('focus',update); };
},[token,refresh,serverAvailable]);

   
const act = async (fn: () => Promise<unknown>) => {
    setError('');
    setNotice('');
    setBusy(true);

    try {
        await fn();
    } catch (e) {
        console.error('StratifyPOS action failed:', e);

        setError(
            e instanceof Error
                ? e.message
                : 'An unexpected error occurred.'
        );
    } finally {
        setBusy(false);
    }
};

    const logout = () => {
        // Clear current user session.
        localStorage.removeItem('crema-token');
        localStorage.removeItem('crema-shop');
        // Clear React state.
        for (const key of Object.keys(localStorage)) {
    if (key.startsWith('stratifypos-offline-grant:')) {
        localStorage.removeItem(key);
    }
}
        setToken('');
        setMe(null);
        setShop('');
        setPage('overview');
        setError('');
        setNotice('');
        // Return to clean login page.
        window.location.replace('/login');
    };
    
const currentShop = me?.shops?.find(
    x => String(x.id) === String(shop)
);

    const role = currentShop?.role || '';
    const canManage = ['owner', 'manager'].includes(role), canSell = ['owner', 'manager', 'cashier','staff'].includes(role);
    
const allowed = key => currentShop?.modules?.[key] !== false;
const visibleRoutes = routes.filter(([id]) => {
    if (id==='settings') return canManage && (allowed('settings') || allowed('billing'));
    if (id==='staff') return allowed('staff') || allowed('attendance');
    if (id==='pos') return canSell && allowed('pos');
    if (id==='kitchen') return allowed('kitchen');
    if (id==='menu') return canManage && allowed('menu');
    if (['branches','promotions','products','inventory','purchasing'].includes(id)) return canManage && allowed(id);
    if (id==='reports') return currentShop?.modules ? allowed(id) : canManage;
    return allowed(id);
});
const activePage = me?.superAdmin && (!currentShop || page==='admin') ? 'admin'
    : serverAvailable === false && currentShop && canSell && allowed('pos') ? 'pos'
    : visibleRoutes.some(([id]) => id===page) ? page : (role==='cashier'||role==='staff' ? visibleRoutes.find(([id])=>id==='pos')?.[0]||visibleRoutes[0]?.[0] : visibleRoutes[0]?.[0]);

    // Show invitation and password reset pages even when
    // a shop owner or another user is already logged in.
    // Show invitation and reset pages when needed.
    const isInvitationPage = window.location.pathname === '/invite';
    const isResetPage = window.location.pathname === '/reset';
    if (isInvitationPage || isResetPage || !token || !me) {
        return (<Auth onSuccess={(d) => {
                if (!d?.token) {
                    console.error('Login response has no token');
                    return;
                }
                // Remove previous account information.
                localStorage.removeItem('crema-token');
                localStorage.removeItem('crema-shop');
                // Store ONLY the newly authenticated account.
                localStorage.setItem('crema-token', d.token);
                // Registration may return an initial shop.
                if (d.shop?.id) {
                    localStorage.setItem('crema-shop', d.shop.id);
                }
                // Reload application with the new user's session.
                // This prevents old React account state from
                // appearing after switching users.
                window.location.replace('/app');
            }} publicReq={publicReq}/>);
    }
    return <div className={'shell '+(['cashier','staff'].includes(role)?'employee-shell':'management-shell')}><aside className={'sidebar ' + (mobile ? 'opened' : '')}><div className="brand">
        <div className="brand-icon">
            <img src="/stratify-logo.png" alt="StratifyPOS logo" />
        </div>
        <span>
            Stratify<span className="brand-dot">POS</span>
            <small>{['cashier','staff'].includes(role)?'TEAM WORKSPACE':'SMART BUSINESS MANAGEMENT'}</small>
        </span>
        <button className="icon-btn mobile-close" onClick={() => setMobile(false)}><X size={19}/></button></div><div className="workspace"><div className="workspace-icon"><Store size={19}/></div><div><small>WORKSPACE</small>
        
        
<select
    value={shop}
    disabled={
        !me.shops.length ||
        serverAvailable !== true
    }
    onChange={e => {
        if (serverAvailable !== true) return;

        setShop(e.target.value);

        localStorage.setItem(
            'crema-shop',
            e.target.value
        );

        setPage('overview');
    }}
>

            
            {!me.shops.length && <option value="">Platform administration</option>}{me.shops.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></div><ChevronDown size={15}/></div>{currentShop && <div className="side-label">WORKSPACE</div>}<nav>{currentShop && visibleRoutes.map(([id, label, Icon]) => {
    const offlineBlocked =
        serverAvailable !== true &&
        id !== 'pos';

    const selected =
        activePage === id;

    return (
        <button
            key={id}
            type="button"
            className={
                'nav-item ' +
                (selected ? 'selected ' : '') +
                (offlineBlocked ? 'offline-disabled' : '')
            }
            disabled={offlineBlocked}
            title={
                offlineBlocked
                    ? 'Requires server connection'
                    : label
            }
            onClick={() => {
                if (offlineBlocked) return;

                setPage(id);
                setMobile(false);
            }}
        >
            <Icon size={19} strokeWidth={1.8} />

            {label}

            {offlineBlocked && (
                <span className="offline-nav-label">
                    Offline
                </span>
            )}

            {selected && (
                <span className="active-dot" />
            )}
        </button>
    );
})
}


{me.superAdmin && <>
    <div className="side-label">PLATFORM</div>
    {platformNavigation.map(([id,label,Icon]) => <button key={id} type="button"
        className={'nav-item ' + (activePage==='admin' && adminSection===id ? 'selected' : '')}
        disabled={serverAvailable !== true} onClick={() => { setAdminSection(id); setPage('admin'); setMobile(false); }}>
        <Icon size={19} />{label}
    </button>)}
</>}
</nav><div className="sidebar-bottom">
            
            <div className="support">
                <span className="support-emoji"><LayoutDashboard size={26}/></span>
                <strong>{['cashier','staff'].includes(role)?'Team operations':'Business made simple.'}</strong>
                <p>{['cashier','staff'].includes(role)?'Only your permitted work tools appear here.':'Sales, inventory, staff, and reporting — all in one place.'}</p>
            </div>
            <button className="nav-item" onClick={logout}><LogOut size={18}/>Sign out</button></div></aside>
        <div className="main"><header className="topbar"><div className="top-left"><button className="icon-btn menu-trigger" onClick={() => setMobile(true)}><Menu /></button><div className="breadcrumb">Workspace <span>/</span> <b>{activePage === 'admin' ? platformNavigation.find(row => row[0]===adminSection)?.[1] : routes.find(x => x[0] === activePage)?.[1]}</b></div></div><div className="top-actions"><span className="today"><CalendarDays size={16}/>{new Date().toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' })}</span><span className="user-avatar">{me.user.name.slice(0, 1).toUpperCase()}</span><div className="user-info"><strong>{me.user.name}</strong><small>{role || 'Platform Admin'}</small></div></div></header>
            
<main
    className="content"
    key={activePage + '-' + shop}
>
    {error && (
        <div className="flash error">
            <AlertTriangle size={17} />
            {error}
            <button onClick={() => setError('')}>
                ×
            </button>
        </div>
    )}

    {notice && (
        <div className="flash success">
            <CheckCircle2 size={17} />
            {notice}
            <button onClick={() => setNotice('')}>
                ×
            </button>
        </div>
    )}

    {/* DASHBOARD */}
{activePage === 'overview' &&
    currentShop &&
    serverAvailable === true && (
        <Overview
            request={request}
            go={setPage}
        />
)}
{activePage==='overview' && currentShop && serverAvailable===true && canManage && <RegisterSummary request={request} role={role}/>}


{/* ==========================================
    POINT OF SALE — ONLINE / OFFLINE
   ========================================== */}


{activePage === 'pos' && currentShop && <div className={['cashier','staff'].includes(role)?'dedicated-employee-pos':''}>
    {['cashier','staff'].includes(role) && <div className="employee-pos-banner">
      <h2>Cashier point of sale</h2><p>Sell products and manage your own shift register. Management tools are kept separate.</p>
    </div>}
    <OfflineSessionGuard
        tenantId={shop}
        online={serverAvailable}
    >
        <OfflinePOSGate tenantId={shop} cashierId={me.user.id} online={serverAvailable} request={request}>
            {(posRequest, offline) => <>
                {!offline && canManage && <details className="offline-preparation">
                    <summary>Prepare a branch for offline checkout</summary>
                    <OfflineCatalogSetup request={request} tenantId={shop} />
                </details>}
                {(canManage || offline) && <OfflineSales {...localSales} online={!offline} cashierId={me.user.id}
                    reconcile={canReconcileSales ? sale => reconcileOfflineSale(request, sale) : undefined} showReceipt={receipt =>
                    setLocalReceipt({ shop, user: me.user.id, receipt })} />}
                {localReceipt?.shop === shop && localReceipt.user === me.user.id &&
                    <ReceiptModal receipt={localReceipt.receipt} close={() => setLocalReceipt(null)} />}
                <POS key={shop + ':' + me.user.id} scope={shop + ':' + me.user.id}
                    request={posRequest} offline={offline} act={act} busy={busy} cashierId={me.user.id} role={role} />
            </>}
        </OfflinePOSGate>
    </OfflineSessionGuard>
    {serverAvailable===true && allowed('pos') && <details className="operations-compact">
      <summary><ClipboardList size={16}/> Table QR checkout requests</summary>
      <CustomerOrdersQueue request={request} role={role} cashierId={me.user.id}/>
    </details>}
 </div>}



   
{/* PRODUCTS & SERVICES */}
{activePage === 'products' &&
    currentShop &&
    serverAvailable === true && (
        <Products
            request={request}
            act={act}
            busy={busy}
        />
)}

{/* INVENTORY MANAGEMENT */}
{activePage === 'inventory' &&
    currentShop &&
    serverAvailable === true && (
        <Inventory
            key={shop}
            limited={currentShop.branch_ids != null}
            role={role}
            request={request}
            act={act}
        />
)}

{/* KITCHEN DISPLAY — paid orders only */}
{activePage==='kitchen' && currentShop && serverAvailable===true && <KitchenDisplay request={request}/>}
{/* CUSTOMER QR MENUS — owner and manager only */}
{activePage==='menu' && currentShop && serverAvailable===true && <MenuManagement request={request} appOrigin={window.location.origin}/>}

{/* PURCHASING */}
{activePage === 'purchasing' && currentShop && serverAvailable === true && (
    <PurchasingPage request={request}/>
)}

{/* SALES & TRANSACTIONS */}
{activePage === 'orders' &&
    currentShop &&
    serverAvailable === true && (
        <Orders
            request={request}
            role={role}
            cashierId={me.user.id}
        />
)}

{/* REPORTS & ANALYTICS */}
{activePage === 'reports' &&
    currentShop &&
    serverAvailable === true && (
        <Reports
            request={request}
        />
)}

{/* TEAM & ATTENDANCE */}
{activePage === 'staff' &&
    currentShop &&
    serverAvailable === true && (
        <Staff
            key={shop}
            access={currentShop.modules}
            request={request}
            act={act}
            role={role}
            setNotice={setNotice}
        />
)}

{/* BRANCHES & LOCATIONS */}
{activePage === 'branches' &&
    currentShop &&
    serverAvailable === true && (
        <Branches
            request={request}
            act={act}
        />
)}

{/* PROMOTIONS & DISCOUNTS */}
{activePage === 'promotions' &&
    currentShop &&
    serverAvailable === true && (
        <Promotions
            request={request}
            act={act}
        />
)}

{/* SETTINGS & BILLING */}
{activePage === 'settings' &&
    currentShop &&
    serverAvailable === true && (
        <SettingsPage
            key={shop}
            access={currentShop.modules}
            token={token}
            tenant={shop}
            role={role}
            request={request}
            act={act}
        />
)}

{/* SUPER ADMIN — ONLINE ONLY */}
{activePage === 'admin' &&
    me.superAdmin &&
    serverAvailable === true && (
        <Admin
            key={adminSection}
            section={adminSection}
            request={request}
            act={act}
        />
)}

{/* NO OFFLINE POS PERMISSION */}
{serverAvailable === false &&
    !canSell && (
        <div className="flash error">
            <AlertTriangle size={17} />
            Server connection unavailable.
            This account has no authorized offline POS access.
        </div>
)}


</main>
</div>{mobile && <div className="scrim" onClick={() => setMobile(false)}/>}</div>;
}
type SubscriptionChoice = string;
type PaidPlan = string;

type AuthMode =
    | 'login'
    | 'register'
    | 'forgot'
    | 'reset'
    | 'invite'
    | 'billing';

interface PublicPlan {
    id: SubscriptionChoice;
    title: string;
    price_cents: number;
    trial_days: number;
    promotional_price_cents?: number | null;
    promotion_name?: string | null;
    max_branches: number;
    max_staff: number;
}

interface BillingPayment {
    id: string;
    plan_id: PaidPlan;
    plan_title: string;
    amount_cents: number;
    reference_no: string;
    status: string;
    method: string;
    method_name: string;
    stage: string;
    submitted_at: string | null;
    submitted_reference?: string | null;
    instructions_snapshot?: string | null;
    review_note?: string;
}



function Auth({ onSuccess, publicReq }) {
    const initialMode: AuthMode =
        window.location.pathname === '/reset'
            ? 'reset'
            : window.location.pathname === '/invite'
                ? 'invite'
                : window.location.pathname === '/register' ? 'register' : 'login';

    const [mode, setMode] = useState<AuthMode>(initialMode);

    const [form, setForm] = useState({
        name: '',
        shopName: '',
        email: '',
        password: '',
        plan: (new URLSearchParams(window.location.search).get('plan') || 'free') as SubscriptionChoice
    });

    const [plans, setPlans] = useState<PublicPlan[]>([]);
    const [plansLoading, setPlansLoading] = useState(true);
    const [skipTrial,setSkipTrial] = useState(false);

    const [billingPlan, setBillingPlan] =
        useState<PaidPlan>('basic');

    const [billingMethod, setBillingMethod] = useState('');
    const [billingDiscount,setBillingDiscount] = useState('');
    const [evidenceToken, setEvidenceToken] = useState('');
    const { data: methods, err: methodsError } = useLoad(loadPaymentMethods, mode === 'billing' ? 'methods' : null);
    const [billingPayment, setBillingPayment] =
        useState<BillingPayment | null>(null);

    const [error, setError] = useState('');
    const [message, setMessage] = useState('');
    const [busy, setBusy] = useState(false);

    // ==================================================
    // FORM HELPERS
    // ==================================================

    const updateForm = (
        field: keyof typeof form,
        value: string
    ) => {
        setForm(previous => ({
            ...previous,
            [field]: value
        }));
    };

    const switchMode = (next: AuthMode) => {
        setError('');
        setMessage('');
        setBillingPayment(null);
        setMode(next);
    };

    const goToLogin = () => {
        window.location.assign('/login');
    };

    // ==================================================
    // LOAD SUBSCRIPTION PLANS
    // ==================================================

    useEffect(() => {
        let cancelled = false;

        async function loadPlans() {
            try {
                const response = await fetch(
                    API + '/api/plans',
                    {
                        cache: 'no-store'
                    }
                );

                if (!response.ok) {
                    throw new Error(
                        'Unable to load subscription plans'
                    );
                }

                const result = await response.json();

                if (
                    !cancelled &&
                    Array.isArray(result)
                ) {
                    const available: PublicPlan[] = result;
                    setPlans(available);
                    setForm(prev => available.length && !available.some(plan => plan.id === prev.plan)
                        ? { ...prev, plan: available[0].id } : prev);
                }

            } catch (err) {
                if (!cancelled) {
                    setError(
                        err instanceof Error
                            ? err.message
                            : 'Unable to load plans'
                    );
                }

            } finally {
                if (!cancelled) {
                    setPlansLoading(false);
                }
            }
        }

        loadPlans();

        return () => {
            cancelled = true;
        };

    }, []);

    // ==================================================
    // REQUEST MONTHLY PAYMENT
    // ==================================================

    async function requestMonthlyPayment(
        selectedPlan: PaidPlan
    ) {
        setBusy(true);
        setError('');
        setMessage('');

        try {
            const response = await publicReq(
                'billing/select-plan',
                {
                    email: form.email,
                    password: form.password,
                    plan_id: selectedPlan,
                    method: billingMethod || methods?.[0]?.id,
                    discount_code: billingDiscount || undefined
                }
            );

            if (!response.payment?.id) {
                throw new Error(
                    'No payment request was returned'
                );
            }

            setBillingPlan(response.payment.plan_id);
            setBillingPayment(response.payment);
            setEvidenceToken(response.evidence_token);
            setMode('billing');

            setMessage(
                response.recent_rejection ? 'Previous payment rejected: ' + response.recent_rejection
                    : paymentStageLabel[response.payment.stage]
            );

        } catch (err) {
            setMode('billing');

            setError(
                err instanceof Error
                    ? err.message
                    : 'Payment request failed'
            );

        } finally {
            setBusy(false);
        }
    }

    // ==================================================
    // CHECK PAYMENT STATUS
    // ==================================================

    async function checkPaymentStatus() {
        if (!billingPayment) {
            return;
        }

        setBusy(true);
        setError('');
        setMessage('');

        try {
            const result = await publicReq(
                'billing/payment-status',
                {
                    email: form.email,
                    password: form.password,
                    payment_id: billingPayment.id
                }
            );

            if (result.activated === true) {
                setMessage(
                    'Payment verified. Your subscription is now active.'
                );

                setBillingPayment(null);

                // After successful activation,
                // allow the owner to sign in.
                setMode('login');

            } else {
                setBillingPayment(previous => previous ? { ...previous, ...result.payment } : null);
                setEvidenceToken(result.evidence_token);
                setMessage(paymentStageLabel[result.payment.stage] || 'Payment status refreshed.');
            }

        } catch (err) {
            setError(
                err instanceof Error
                    ? err.message
                    : 'Unable to check payment'
            );

        } finally {
            setBusy(false);
        }
    }

    // ==================================================
    // LOGIN / REGISTER / INVITE / PASSWORD
    // ==================================================

    async function submit(
        event: React.FormEvent<HTMLFormElement>
    ) {
        event.preventDefault();

        setBusy(true);
        setError('');
        setMessage('');

        const submittedMode = mode;

        try {
            const path =
                submittedMode === 'login'
                    ? 'auth/login'
                    : submittedMode === 'register'
                        ? 'auth/register'
                        : submittedMode === 'forgot'
                            ? 'auth/forgot'
                            : submittedMode === 'reset'
                                ? 'auth/reset'
                                : 'auth/accept-invite';

            const result = await publicReq(
                path,
                {
                    ...form,
                    ...(submittedMode==='register' && { skip_trial: form.plan!=='free' && skipTrial }),
                    token: new URLSearchParams(
                        window.location.search
                    ).get('token')
                }
            );

            // ------------------------------------------
            // Successful Free Trial / Normal Login
            // ------------------------------------------

            if (result.token) {
                onSuccess(result);
                return;
            }

            // ------------------------------------------
            // Direct Basic / Premium registration
            // ------------------------------------------

            if (
                submittedMode === 'register' &&
                result.status === 'payment_pending'
            ) {
                const selectedPlan = form.plan;

                setMode('billing');
                setBillingPlan(selectedPlan);

                return;
            }

            setMessage(
                result.message || 'Request completed'
            );

            // Invitation/reset links must be cleared.
            if (
                submittedMode === 'invite' ||
                submittedMode === 'reset'
            ) {
                window.history.replaceState(
                    null,
                    '',
                    '/'
                );

                setMode('login');
            }

        } catch (err) {
            const description =
                err instanceof Error
                    ? err.message
                    : 'Request failed';

            // ------------------------------------------
            // Expired trial / Pending subscription
            // ------------------------------------------

            const needsBilling =
                submittedMode === 'login' &&
                /no active subscription|trial may have expired|payment is pending|subscription expired/i
                    .test(description);

            if (needsBilling) {
                setBillingPlan('basic');
                setBillingPayment(null);
                setMode('billing');

                setMessage(
                    'Your business needs an active monthly subscription. Select Basic or Premium below.'
                );

            } else {
                setError(description);
            }

        } finally {
            setBusy(false);
        }
    }

    // ==================================================
    // UI VALUES
    // ==================================================

    const selectedPlan = plans.find(
        plan => plan.id === form.plan
    );
    const trialPlan = plans.find(plan => plan.id==='free' && plan.trial_days>0);
    const startsTrial = !!trialPlan && (form.plan==='free' || !skipTrial);

    const title: Record<AuthMode, string> = {
        login: 'Welcome back.',
        register: 'Register your business.',
        forgot: 'Forgot your password?',
        reset: 'Choose a new password.',
        invite: 'Accept your invitation.',
        billing: 'Continue your subscription.'
    };

    // ==================================================
    // UI
    // ==================================================

    return (
        <div className="auth-screen">

            {/* LEFT SIDE */}

            <div className="auth-left">
                <div className="auth-logo">
                    <img src="/stratify-logo.png" alt="StratifyPOS logo" />
                    <span className="auth-wordmark">Stratify<span>POS</span></span>
                </div>

                <div className="auth-message">
                    <div className="auth-tag">
                        SMART BUSINESS MANAGEMENT
                    </div>

                    <h1>
                        Run your business.
                        <br />
                        <em>Smarter.</em>
                    </h1>

                    <p>
                        Manage your sales, inventory,
                        employees, and business operations
                        in one powerful platform.
                    </p>

                    <div className="auth-feature">
                        <span>✦</span> Sell faster
                        <span>✦</span> Manage better
                        <span>✦</span> Grow smarter
                    </div>
                </div>

                <div className="auth-bottom">
                    BUILT FOR BUSINESSES OF EVERY SIZE
                </div>
            </div>

            {/* RIGHT SIDE */}

            <div className="auth-right">
                <div
                    className={
                        'auth-card ' +
                        (
                            mode === 'register'
                                ? 'auth-card-register'
                                : ''
                        )
                    }
                >
                    <div className="auth-mobile-logo">
                        <img src="/stratify-logo.png" alt="StratifyPOS logo" />
                        <span>Stratify<strong>POS</strong></span>
                    </div>

                    <div className="auth-eyebrow">
                        WELCOME TO STRATIFYPOS
                    </div>

                    <h2>{title[mode]}</h2>

                    <p className="auth-sub">
                        {mode === 'register'
                            ? 'Create your business account and choose a subscription.'
                            : mode === 'billing'
                                ? 'Choose your monthly subscription and complete payment verification.'
                                : mode === 'login'
                                    ? 'Sign in to your business workspace.'
                                    : 'Complete the form below to continue.'}
                    </p>

                    {error && (
                        <div className="flash error">
                            <AlertTriangle size={17} />
                            {error}
                        </div>
                    )}

                    {message && (
                        <div className="flash success">
                            <CheckCircle2 size={17} />
                            {message}
                        </div>
                    )}

                    {/* ==========================
                        BILLING / RENEWAL PAGE
                       ========================== */}

                    {mode === 'billing' ? (
                        <div className="billing-recovery">

                            <div className="billing-plan-header">
                                <h3>
                                    Select your monthly subscription
                                </h3>

                                <p>
                                    Your business becomes active
                                    after payment verification.
                                </p>
                            </div>

                            <div className="billing-options">
                                {plans.filter(plan => plan.price_cents > 0).map(plan => {
                                    const planId = plan.id;

                                    return (
                                        <button
                                            key={planId}
                                            type="button"
                                            className={
                                                'billing-option ' +
                                                (
                                                    billingPlan === planId
                                                        ? 'selected'
                                                        : ''
                                                )
                                            }
                                            disabled={busy}
                                            onClick={() => {
                                                setBillingPlan(planId);
                                                setBillingPayment(null);
                                                setMessage('');
                                            }}
                                        >
                                            <strong>
                                                {plan?.title ||
                                                    planId.toUpperCase()}
                                            </strong>

                                            <span>
                                                {plan
                                                    ? money(plan.promotional_price_cents ?? plan.price_cents)
                                                    : '—'}
                                                {' / month'}
                                            </span>

                                            <small>
                                                {plan ? plan.max_branches + ' branches · ' + plan.max_staff + ' accounts' : 'Unavailable'}
                                            </small>
                                        </button>
                                    );
                                })}
                            </div>

                            {methodsError && <p role="alert">{methodsError}</p>}
                            {billingPayment ? <div className="billing-payment-details">
                                <h3>{billingPayment.method_name} subscription payment</h3>
                                <div className="billing-payment-row"><span>Plan</span><strong>{billingPayment.plan_title}</strong></div>
                                <div className="billing-payment-row"><span>Amount due</span><strong>{money(billingPayment.amount_cents)}</strong></div>
                                <div className="billing-payment-row"><span>Request reference</span><strong>{billingPayment.reference_no}</strong></div>
                                <p role="status">{paymentStageLabel[billingPayment.stage]}</p>
                                {billingPayment.instructions_snapshot && <p style={{ whiteSpace: 'pre-wrap' }}>{billingPayment.instructions_snapshot}</p>}
                                {billingPayment.review_note && <p>{billingPayment.review_note}</p>}
                                {billingPayment.stage === 'awaiting_receipt' && <ReceiptSubmission key={billingPayment.id}
                                    url={API + '/api/billing/payments/' + billingPayment.id + '/evidence'}
                                    token={evidenceToken}
                                    onSubmitted={receipt => {
                                        setBillingPayment(previous => previous ? { ...previous, ...receipt } : null);
                                        setMessage('Receipt submitted for review.');
                                    }} />}
                                <Button type="button" disabled={busy} onClick={checkPaymentStatus}>Check verification status</Button>
                                {billingPayment.status === 'failed' && <Button secondary type="button" onClick={() => {
                                    setBillingPayment(null); setMessage('');
                                }}>Start a new payment</Button>}
                            </div> : <>
                                <Field label="Payment method"><select value={billingMethod || methods?.[0]?.id || ''}
                                    onChange={event => setBillingMethod(event.target.value)}>
                                    {!methods?.length && <option value="">No payment methods available</option>}
                                    {methods?.map(method => <option key={method.id} value={method.id}>{method.name}</option>)}
                                </select></Field>
                                <Field label="Subscription discount code (optional)"><input maxLength={40} value={billingDiscount}
                                    onChange={e => setBillingDiscount(e.target.value)} /></Field>
                                <Button type="button" disabled={busy || plansLoading || !methods?.length || !plans.some(plan => plan.price_cents > 0)}
                                    onClick={() => requestMonthlyPayment(plans.find(plan => plan.id===billingPlan && plan.price_cents>0)?.id
                                        || plans.find(plan => plan.price_cents>0)?.id)}>Continue to payment instructions</Button>
                            </>}

                            <button
                                type="button"
                                className="text-link billing-back"
                                onClick={() =>
                                    switchMode('login')
                                }
                            >
                                Back to sign in
                            </button>
                        </div>

                    ) : (

                        /* ==========================
                            NORMAL AUTH FORM
                           ========================== */

                        <form
                            className="auth-form"
                            onSubmit={submit}
                        >

                            {['register', 'invite'].includes(mode) && (
                                <Field label="Full name">
                                    <input
                                        required
                                        value={form.name}
                                        placeholder="Enter your full name"
                                        onChange={event =>
                                            updateForm(
                                                'name',
                                                event.target.value
                                            )
                                        }
                                    />
                                </Field>
                            )}

                            {mode === 'register' && (
                                <Field label="Business name">
                                    <input
                                        required
                                        value={form.shopName}
                                        placeholder="e.g. ABC Trading"
                                        onChange={event =>
                                            updateForm(
                                                'shopName',
                                                event.target.value
                                            )
                                        }
                                    />
                                </Field>
                            )}

                            {[
                                'register',
                                'login',
                                'forgot'
                            ].includes(mode) && (
                                <Field label="Email address">
                                    <input
                                        required
                                        type="email"
                                        value={form.email}
                                        placeholder="you@business.com"
                                        onChange={event =>
                                            updateForm(
                                                'email',
                                                event.target.value
                                            )
                                        }
                                    />
                                </Field>
                            )}

                            {[
                                'register',
                                'login',
                                'reset',
                                'invite'
                            ].includes(mode) && (
                                <Field label="Password">
                                    <input
                                        required
                                        type="password"
                                        minLength={
                                            mode === 'login'
                                                ? 1
                                                : 12
                                        }
                                        value={form.password}
                                        placeholder={
                                            mode === 'login'
                                                ? 'Enter your password'
                                                : 'At least 12 characters'
                                        }
                                        onChange={event =>
                                            updateForm(
                                                'password',
                                                event.target.value
                                            )
                                        }
                                    />
                                </Field>
                            )}

                            {/* SUBSCRIPTION CARDS */}

                            {mode === 'register' && (
                                <div className="register-plans">

                                    <div className="register-plans-heading">
                                        <strong>
                                            Choose your subscription
                                        </strong>

                                        <span>
                                            Free Trial or Monthly Plans
                                        </span>
                                    </div>

                                    {plansLoading && (
                                        <p className="muted">
                                            Loading subscription plans...
                                        </p>
                                    )}

                                    <div className="register-plan-grid">
                                        {plans.map(plan => {
                                            const selected =
                                                form.plan === plan.id;

                                            return (
                                                <button
                                                    key={plan.id}
                                                    type="button"
                                                    className={
                                                        'register-plan-card ' +
                                                        (
                                                            selected
                                                                ? 'selected'
                                                                : ''
                                                        )
                                                    }
                                                    onClick={() =>
                                                        updateForm(
                                                            'plan',
                                                            plan.id
                                                        )
                                                    }
                                                >
                                                    <div className="plan-card-top">
                                                        <strong>
                                                            {plan.title}
                                                        </strong>

                                                        <span
                                                            className={
                                                                'plan-radio ' +
                                                                (
                                                                    selected
                                                                        ? 'checked'
                                                                        : ''
                                                                )
                                                            }
                                                        />
                                                    </div>

                                                    <div className="plan-card-price">
                                                        {plan.id === 'free'
                                                            ? 'FREE'
                                                            : money(
                                                                plan.promotional_price_cents ?? plan.price_cents
                                                            )}
                                                    </div>

                                                    <div className="plan-card-period">
                                                        {plan.id === 'free'
                                                            ? plan.trial_days + ' days'
                                                            : 'per month'}
                                                    </div>

                                                    <div className="plan-card-features">
                                                        {[plan.max_branches + ' branches', plan.max_staff + ' team accounts including owner'].map(feature => (
                                                            <div key={feature}>
                                                                <CheckCircle2
                                                                    size={14}
                                                                />

                                                                <span>
                                                                    {feature}
                                                                </span>
                                                            </div>
                                                        ))}
                                                    </div>
                                                </button>
                                            );
                                        })}
                                    </div>

                                    <div className="register-plan-notice">
                                        {startsTrial
                                            ? 'Your ' + trialPlan.trial_days + '-day trial starts immediately.'
                                            : `Your ${selectedPlan?.title || 'selected'} subscription requires verified payment before workspace access.`}
                                    </div>
                                    {trialPlan && form.plan!=='free' && <label className="check">
                                        <input type="checkbox" checked={skipTrial} onChange={e => setSkipTrial(e.target.checked)} />
                                        Skip the trial and continue to payment
                                    </label>}
                                </div>
                            )}

                            {mode === 'login' && (
                                <button
                                    type="button"
                                    className="text-link forgot"
                                    onClick={() =>
                                        switchMode('forgot')
                                    }
                                >
                                    Forgot password?
                                </button>
                            )}

                            <Button
                                type="submit"
                                disabled={
                                    busy ||
                                    (
                                        mode === 'register' &&
                                        (
                                            plansLoading ||
                                            !selectedPlan
                                        )
                                    )
                                }
                            >
                                {busy
                                    ? 'Please wait...'
                                    : mode === 'login'
                                        ? 'Sign in to workspace'
                                        : mode === 'register'
                                            ? startsTrial
                                                ? 'Start free trial'
                                                : 'Register & continue to payment'
                                            : mode === 'forgot'
                                                ? 'Send reset link'
                                                : mode === 'reset'
                                                    ? 'Reset password'
                                                    : 'Join workspace'}

                                <ArrowRight size={17} />
                            </Button>
                        </form>
                    )}

                    <div className="auth-switch">
                        {mode === 'login' ? (
                            <>
                                New to StratifyPOS?{' '}

                                <button
                                    type="button"
                                    onClick={() =>
                                        switchMode('register')
                                    }
                                >
                                    Register a business
                                </button>
                            </>

                        ) : (
                            <>
                                Already have an account?{' '}

                                <button
                                    type="button"
                                    onClick={goToLogin}
                                >
                                    Sign in
                                </button>
                            </>
                        )}
                    </div>
                </div>
                <a className="text-link" href={publicUrl("/")}>Back to website</a>
            </div>
        </div>
    );
}

function Overview({ request, go }) { const { data, err } = useLoad(request, 'overview'); if (err)
    return <div className="flash error">{err}</div>; if (!data)
    return <Load />; const { sales, low, top, recent, staff } = data; return <><Heading eyebrow="GOOD DAY ☀" title="Your business, at a glance." sub="Monitor your sales, inventory, and business activity in real time." action={<Button onClick={() => go('pos')}><Plus size={18}/> New sale</Button>}/><div className="metrics"><Metric label="Today's revenue" val={money(sales.revenue)} icon={Wallet} tint="brown" foot="From completed transactions"/><Metric label="Orders today" val={sales.orders} icon={ShoppingCart} tint="peach" foot="Completed orders"/><Metric label="Low stock alerts" val={low.count} icon={Package} tint="sand" foot="Ingredients to restock"/><Metric label="Team members" val={staff.count} icon={Users} tint="sage" foot="Active accounts"/></div><div className="dashboard-grid"><Panel title="Recent transactions" right={<button className="text-link" onClick={() => go('orders')}>View all <ArrowUpRight size={14}/></button>}><Table columns={[["order_number", "Order", v => '#' + String(v).padStart(5, '0')], ['created_at', 'Date', fmt], ['payment_method', 'Payment', v => v.toUpperCase()], ['total_cents', 'Total', money]]} items={recent}/></Panel><Panel title="Bestselling items" right={<span className="badge soft">By units sold</span>}>{top.length ? top.map((p, i) => <div className="ranking" key={p.name}><span className="rank">{String(i + 1).padStart(2, '0')}</span><strong>{p.name}</strong><span>{p.qty} sold</span></div>) : <Empty text="Your top-selling products will appear after your first sale."/>}</Panel></div><div className="tip-banner"><span className="tip-icon">✦</span><div><strong>Ready for your next sale?</strong><p>Your sales, products, and inventory work together in one system.</p></div><button onClick={() => go('pos')}>Open POS <ArrowRight size={16}/></button></div></>; }
function Metric({ label, val, icon: Icon, tint, foot }) { return <div className="metric"><div className="metric-top"><span>{label}</span><span className={'metric-icon ' + tint}><Icon size={20}/></span></div><strong>{val}</strong><small>{foot}</small></div>; }

function OfflineCatalogSetup({
    request,
    tenantId
}: {
    request: ApiRequest;
    tenantId: string;
}) {
    const [branches, setBranches] = useState<any[]>([]);
    const [branchId, setBranchId] = useState('');
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState('');
    const [error, setError] = useState('');
    const [status, setStatus] = useState<any>(null);

    useEffect(() => {
        let cancelled = false;

        setBranches([]);
        setBranchId('');
        setStatus(null);
        setMessage('');
        setError('');

        request('branches')
            .then((result: any) => {
                if (cancelled) return;

                if (!Array.isArray(result)) {
                    throw new Error('Invalid branch response.');
                }

                const active = result.filter(
                    (branch: any) => branch.active !== false
                );

                setBranches(active);
                setBranchId(active[0]?.id || '');
            })
            .catch((err: any) => {
                if (!cancelled) {
                    setError(
                        err.message || 'Unable to load branches.'
                    );
                }
            });

        return () => {
            cancelled = true;
        };
    }, [request, tenantId]);

    useEffect(() => {
        let cancelled = false;

        setStatus(null);

        if (!tenantId || !branchId) return;

        getCatalogStatus(tenantId, branchId)
            .then(result => {
                if (!cancelled) setStatus(result);
            })
            .catch((err: any) => {
                if (!cancelled) {
                    setError(err.message);
                }
            });

        return () => {
            cancelled = true;
        };
    }, [tenantId, branchId]);

    async function prepareCatalog() {
        if (!tenantId || !branchId || busy) return;

        setBusy(true);
        setError('');
        setMessage('');

        try {
            await requestOfflineStoragePersistence().catch(() => false);
            const result = await syncOfflineCatalog(
                request,
                tenantId,
                branchId
            );

            const latest = await getCatalogStatus(
                tenantId,
                branchId
            );

            setStatus(latest);


// Request a new server-signed offline permission.
// The API verifies user, tenant, subscription,
// role, and branch before issuing it.

const offlineAccess = await request(
    'offline/grant',
    'POST',
    {
        branchId,
        deviceId: getOfflineDeviceId()
    }
);

if (
    !offlineAccess ||
    typeof offlineAccess.grant !== 'string'
) {
    throw new Error(
        'Catalog saved, but offline authorization failed.'
    );
}

saveOfflineGrant(
    tenantId,
    offlineAccess.grant
);


            setMessage(
    `Saved ${result.products} products and ` +
    `${result.promotions} promotions. ` +
    `Signed offline access prepared.`
);

        } catch (err: any) {
            setError(
                err.message || 'Catalog download failed.'
            );

        } finally {
            setBusy(false);
        }
    }

    return (
        <section
            className="panel"
            style={{
                padding: 20,
                marginBottom: 20
            }}
        >

            <p
                style={{
                    fontSize: 12,
                    color: '#64748b',
                    marginTop: 8
                }}
            >
                Download your business catalog for offline use.
                Refresh before going offline to save the latest menu and renew cash checkout access.
            </p>

            <div
                style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    gap: 10,
                    alignItems: 'center',
                    marginBottom: 12
                }}
            >
                <select
                    value={branchId}
                    disabled={busy || branches.length === 0}
                    onChange={event =>
                        setBranchId(event.target.value)
                    }
                >
                    {branches.length === 0 && (
                        <option value="">
                            No branch available
                        </option>
                    )}

                    {branches.map(branch => (
                        <option
                            key={branch.id}
                            value={branch.id}
                        >
                            {branch.name}
                        </option>
                    ))}
                </select>

                <Button
                    onClick={prepareCatalog}
                    disabled={busy || !branchId}
                >
                    {busy
                        ? 'Downloading catalog...'
                        : 'Prepare Offline Catalog'}
                </Button>
            </div>

            {status && (
                <div
                    style={{
                        fontSize: 12,
                        lineHeight: 1.8
                    }}
                >
                    <div>
                        Cached products: {status.products}
                    </div>

                    <div>
                        Cached promotions: {status.promotions}
                    </div>

                    <div>
                        Last updated:{' '}
                        {status.lastUpdated
                            ? new Date(
                                status.lastUpdated
                            ).toLocaleString('en-PH')
                            : 'Never'}
                    </div>
                </div>
            )}

            {message && (
                <div className="flash success">
                    {message}
                </div>
            )}

            {error && (
                <div className="flash error">
                    {error}
                </div>
            )}
        </section>
    );
}

function useCheckoutQuote(request, payload, version) {
    const [quote, setQuote] = useState(null);
    useEffect(() => {
        if (!payload) return;
        const controller = new AbortController();
        const timer = window.setTimeout(async () => {
            try {
                const totals = await request('checkout/quote', 'POST', JSON.parse(payload), false, controller.signal);
                if (!controller.signal.aborted) setQuote({ payload, version, totals, error: '' });
            } catch (error) {
                if (!controller.signal.aborted) setQuote({ payload, version, totals: null, error: error.message });
            }
        }, 250);
        return () => { controller.abort(); window.clearTimeout(timer); };
    }, [request, payload, version]);
    return quote?.payload === payload && quote.version === version ? quote : null;
}

function POS({ request, act, busy, offline, scope, cashierId, role }) {
    const { data: products, load: reload, err: productError } = useLoad(request, 'products');
    const { data: cats, err: categoryError } = useLoad(request, 'categories');
    const { data: branches, err: branchError } = useLoad(request, 'branches');
    const { data: addons, err: addonError } = useLoad(request, 'addons');
    const { data: tables, load: reloadTables } = useLoad(request, 'tables');
    const { data: settings, load: reloadSettings, err: settingsError } = useLoad(request, 'settings');
    const { data: promotions, load: reloadPromotions, err: promotionError } = useLoad(request, 'promotions');
    const [branch, setBranch] = useState('');
    const {data:heldOrders,load:reloadHolds} = useLoad(request,!offline && branch ? 'holds?branch_id='+branch : null);
    const [heldOrderId,setHeldOrderId] = useState<string | null>(null);
    const [category, setCategory] = useState('all');
    const [search, setSearch] = useState('');
    const [cart, setCart] = useState([]);
    const [custom, setCustom] = useState(null);
    const [orderType, setOrderType] = useState('takeout');
    const [table, setTable] = useState('');
    const [method, setMethod] = useState('cash');
    const [tender, setTender] = useState('');
    const [registerId,setRegisterId] = useState<string | null>(null);
    const [promo, setPromo] = useState('');
    const [rewardCode, setRewardCode] = useState('');
    const [quoteVersion, setQuoteVersion] = useState(0);
    const [receipt, setReceipt] = useState(null);
    const submitting = useRef(false);
    const cartPayload = cart.map(line => ({
        product_id: line.product.id, variation_id: line.variation?.id,
        addon_ids: line.addonList.map(a => a.id), quantity: line.qty
    }));
    const promoKey = promo.trim();
    const rewardKey = offline ? '' : rewardCode.trim();
    const requiresQuote = !offline && Boolean(promoKey || rewardKey);
    const onlineQuote = useCheckoutQuote(request, requiresQuote && branch && cartPayload.length
        ? JSON.stringify({ branch_id: branch, promo_code: promoKey, loyalty_code: rewardKey, items: cartPayload }) : null, quoteVersion);
    const storageKey = 'stratifypos-checkout:' + scope;
    const [unconfirmed, setUnconfirmed] = useState(() => {
        try { return JSON.parse(sessionStorage.getItem(storageKey) || 'null'); }
        catch { return null; }
    });

    useEffect(() => {
        const active = branches?.filter(b => b.active) ?? [];
        if (!active.some(b => b.id === branch)) {
            setBranch(active[0]?.id || '');
            setTable('');
        }
    }, [branches, branch]);

    useEffect(() => {
        if (offline) return;
        const timer = window.setInterval(reloadTables, 15000);
        return () => window.clearInterval(timer);
    }, [offline, reloadTables]);

    const loadError = productError || categoryError || branchError || addonError || settingsError || promotionError;
    if (loadError) return <p className="flash error" role="alert">{loadError}</p>;
    if (!products || !branches || !addons || !cats || !settings || !promotions) return <Load />;

    function updateQuantity(key, delta) {
        setCart(lines => lines.map(line => line.key === key
            ? { ...line, qty: Math.min(100, line.qty + delta) } : line).filter(line => line.qty > 0));
    }

    function add(product, variationId = '', addonIds = []) {
        const key = [product.id, variationId, ...[...addonIds].sort()].join(':');
        const variant = product.variations?.find(v => v.id === variationId);
        const addonList = addons.filter(a => a.active && addonIds.includes(a.id));
        const unit = variationPrice(product, variant) +
            addonList.reduce((sum, addon) => sum + addon.price_cents, 0);
        setCart(lines => lines.some(line => line.key === key)
            ? lines.map(line => line.key === key ? { ...line, qty: Math.min(100, line.qty + 1) } : line)
            : [...lines, { key, product, variation: variant, addonList, qty: 1, unit }]);
        setCustom(null);
    }

    const pricedCart = cart.map(line => {
        const product = products.find(row => row.id === line.product.id && row.active);
        const variation = product?.variations?.find(row => row.id === line.variation?.id);
        const availableAddons = addons.filter(row => row.active && line.addonList.some(item => item.id === row.id));
        const available = Boolean(product && (!line.variation || variation) && availableAddons.length === line.addonList.length);
        return available ? { ...line, product, variation, addonList: availableAddons, available,
            unit: variationPrice(product, variation) + availableAddons.reduce((sum, item) => sum + item.price_cents, 0)
        } : { ...line, available };
    });
    const cartUnavailable = pricedCart.some(line => !line.available);
    const subtotal = pricedCart.reduce((sum, line) => sum + line.qty * line.unit, 0);
    const totals = requiresQuote ? onlineQuote?.totals :
        checkoutTotals(subtotal, promoKey, promotions, settings.tax_basis_points, settings.service_basis_points);
    const cash = offline || method === 'cash';
    const change = totals && pesos(tender) - totals.total_cents;
    const searchTerm=search.trim().toLowerCase();
    const filtered = products.filter(p => p.active && (category === 'all' || p.category_id === category) &&
        (p.name.toLowerCase().includes(searchTerm) ||
            p.sku?.toLowerCase().includes(searchTerm) ||
            p.barcode?.toLowerCase().includes(searchTerm) ||
            p.variations?.some(v=>v.sku?.toLowerCase().includes(searchTerm) ||
                v.barcode?.toLowerCase().includes(searchTerm))));

    async function parkOrder() {
        await act(async () => {
            if (offline || unconfirmed || heldOrderId || !branch || !cart.length) {
                throw new Error('Only a new online cart can be parked.');
            }
            await request('holds','POST',{
                id:crypto.randomUUID(),branch_id:branch,items:cartPayload,order_type:orderType,
                table_id:orderType==='dine_in' ? table||null : null,
                promo_code:promoKey||null,loyalty_code:rewardKey||null
            });
            setCart([]);setPromo('');setRewardCode('');setTable('');
            setTender('');
            reloadHolds();
        });
    }
    async function resumeOrder(id:string) {
        await act(async()=>{
            if(offline || unconfirmed) throw new Error('Reconnect and finish the pending checkout first.');
            if(cart.length && !window.confirm('Replace the current cart with the saved order?')) return;
            const draft=await request('holds/'+id);
            if(draft.status!=='held') throw new Error('This order has already been processed.');
            const restored=draft.items.map(item=>{
                const product=products.find(p=>p.id===item.product_id && p.active);
                const variation=item.variation_id ?
                    product?.variations?.find(v=>v.id===item.variation_id) : null;
                const addonList=(item.addon_ids||[]).map(id=>addons.find(a=>a.id===id && a.active));
                if(!product || item.variation_id && !variation || addonList.some(a=>!a)) {
                    throw new Error('An item in the held order is no longer available. Review or cancel this draft.');
                }
                const key=[product.id,variation?.id||'',...addonList.map(a=>a.id).sort()].join(':');
                const unit=variationPrice(product,variation)+addonList.reduce((sum,a)=>sum+a.price_cents,0);
                return {key,product,variation,addonList,qty:item.quantity,unit};
            });
            setBranch(draft.branch_id);
            setCart(restored);
            setOrderType(draft.order_type);
            setTable(draft.table_id||'');
            setPromo(draft.promo_code||'');
            setRewardCode(draft.loyalty_code||'');
            setHeldOrderId(draft.id);
            setTender('');
        });
    }
    async function cancelHeldOrder(id:string) {
        await act(async()=>{
            if(!window.confirm('Cancel this held order? This cannot be undone.')) return;
            await request('holds/'+id+'/cancel','POST',{});
            if(heldOrderId===id) {setHeldOrderId(null);setCart([]);}
            reloadHolds();
        });
    }
    async function checkout() {
        if (submitting.current) return;
        submitting.current = true;
        try {
            await act(async () => {
                if (offline && unconfirmed) throw new Error('Reconnect to finish the previous checkout.');
                if (!unconfirmed && (!branch || !totals)) throw new Error('Select a branch and confirm the order total.');
                const payload = unconfirmed || {
                    client_sale_id: crypto.randomUUID(), branch_id: branch,
                    held_order_id: !offline ? heldOrderId : null,
                    order_type: orderType,
                    table_id: orderType === 'dine_in' ? table || null : null,
                    payment_method: cash ? 'cash' : method,
                    register_session_id: !offline && cash ? registerId : null,
                    amount_tendered_cents: cash ? pesos(tender) : null,
                    promo_code: promoKey || null, loyalty_code: rewardKey || null, expected: totals, items: cartPayload
                };
                if (!offline) {
                    sessionStorage.setItem(storageKey, JSON.stringify(payload));
                    setUnconfirmed(payload);
                }
                try {
                    const result = await request('checkout', 'POST', payload, false, AbortSignal.timeout(20000));
                    if (!result?.order_number) throw new Error('No checkout acknowledgment received.');
                    setReceipt(result);
                    reloadTables();
                    setTable('');
                    setCart([]);
                    setHeldOrderId(null);
                    reloadHolds();
                    setPromo('');
                    setRewardCode('');
                    setTender('');
                    sessionStorage.removeItem(storageKey);
                    setUnconfirmed(null);
                } catch (error) {
                    if (!offline && [400, 404, 409, 413, 422].includes(error.status)) {
                        sessionStorage.removeItem(storageKey);
                        setUnconfirmed(null);
                        reload();
                        reloadSettings();
                        reloadPromotions();
                        setQuoteVersion(version => version + 1);
                    }
                    throw error;
                }
            });
        } finally {
            submitting.current = false;
        }
    }

    return <>
        <Heading title="Point of sale" action={<select aria-label="Branch" className="select-branch" value={branch}
            onChange={e => { setBranch(e.target.value); setTable(''); }} disabled={busy || !!unconfirmed}>
            {branches.filter(b => b.active).map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
        </select>} />
        <CashRegisterPanel request={request} branchId={branch} online={!offline} cashierId={cashierId}
            role={role} required={Boolean(settings.require_cash_register)}
            onSessionChange={setRegisterId} onPolicyUpdated={reloadSettings}/>
        {!offline && <details className="operations-compact">
            <summary><ClipboardList size={16}/> Held orders
                <span className="operations-state">{heldOrders?.length || 0} pending</span></summary>
            <div className="operations-body">
                <p className="operations-note">Parked orders do not reserve inventory, product prices or tables. Totals are recalculated at checkout.</p>
                {heldOrderId && <p className="flash warning">Resumed order selected. Completing checkout will finalize it.</p>}
                <div className="operations-held-list">{(heldOrders||[]).map(draft=>
                    <div className="operations-held-row" key={draft.id}>
                        <span><strong>{draft.items.reduce((total,item)=>total+item.quantity,0)} items · {draft.order_type.replace('_',' ')}</strong>
                            <small>{fmt(draft.created_at)} · {draft.id.slice(0,8)}</small></span>
                        <Button secondary disabled={busy || !!unconfirmed} onClick={()=>resumeOrder(draft.id)}>Resume</Button>
                        <button className="text-link" disabled={busy || !!unconfirmed}
                            onClick={()=>cancelHeldOrder(draft.id)}>Cancel</button>
                    </div>)}
                </div>
                {!heldOrders?.length && <p className="operations-note">No held orders in this branch.</p>}
                <button className="text-link" onClick={reloadHolds}>Refresh held orders</button>
            </div>
        </details>}
        {unconfirmed && <p className="flash warning" role="status">A checkout is awaiting confirmation. {offline ? 'Reconnect to check its status.' : 'Retry the same transaction below.'}</p>}
        <div className="pos-layout">
            <section className="pos-menu">
                <div className="pos-toolbar"><div className="search"><Search size={19} />
                    <input aria-label="Search products" value={search} onChange={e => setSearch(e.target.value)}
                        onKeyDown={e=>{
                            if(e.key!=='Enter' || offline && unconfirmed) return;
                            const code=search.trim().toUpperCase();
                            if(!code) return;
                            const match=products.find(p=>p.active && (p.sku===code || p.barcode===code ||
                                p.variations?.some(v=>v.sku===code || v.barcode===code)));
                            if(!match) return;
                            const variant=match.variations?.find(v=>v.sku===code || v.barcode===code);
                            add(match,variant?.id||'',[]);
                            setSearch('');
                        }}
                        placeholder="Search or scan barcode / SKU…" />
                </div></div>
                <div className="chip-row">
                    <button className={'chip ' + (category === 'all' ? 'chip-on' : '')} onClick={() => setCategory('all')}>All items</button>
                    {cats.map(c => <button className={'chip ' + (category === c.id ? 'chip-on' : '')} key={c.id}
                        onClick={() => setCategory(c.id)}>{c.name}</button>)}
                </div>
                <div className="product-grid">
                    {filtered.map(p => <button className="product-card" key={p.id} disabled={busy || !!unconfirmed}
                        onClick={() => p.variations?.length || addons.some(a => a.active) ? setCustom(p) : add(p)}>
                        <div className="product-illustration">{p.image_url
                            ? <img className="operations-product-photo" src={p.image_url} alt="" loading="lazy" />
                            : <span><ShoppingBag size={46} strokeWidth={1.5} /></span>}
                            <div className="product-add"><Plus size={18} /></div>
                        </div>
                        <div className="product-name">{p.name}</div>
                        <div className="product-desc">{p.category || 'General products'}</div>
                        <strong>{money(p.price_cents)}</strong>
                    </button>)}
                    {!filtered.length && <Empty text="No products found." />}
                </div>
            </section>
            <aside className="cart-panel">
                <div className="cart-head"><h2>Order details <span>({cart.reduce((n, x) => n + x.qty, 0)})</span></h2><ShoppingCart size={21} /></div>
                <div className="order-types">
                    {[['dine_in', 'Dine in'], ['takeout', 'Takeout'], ['delivery', 'Delivery']].map(([key, label]) =>
                        <button key={key} className={orderType === key ? 'on' : ''} disabled={busy || !!unconfirmed}
                            onClick={() => setOrderType(key)}>{label}</button>)}
                </div>
                {orderType === 'dine_in' && <select aria-label="Table" value={table} onChange={e => setTable(e.target.value)}>
                    <option value="">Select table (optional)</option>
                    {tables?.filter(t => t.branch_id === branch && ['available', 'reserved'].includes(t.status))
                        .map(t => <option key={t.id} value={t.id}>{t.label}{t.status === 'reserved' ? ' · Reserved' : ''}</option>)}
                </select>}
                {!offline && tables?.some(t => t.branch_id === branch && t.status === 'occupied') &&
                    <details><summary>Occupied tables</summary>
                        <div className="inline-form">{tables.filter(t => t.branch_id === branch && t.status === 'occupied').map(t =>
                            <button className="text-link" key={t.id} disabled={busy} onClick={() => act(async () => {
                                await request('tables/' + t.id + '/status', 'PUT', { status: 'available' });
                                reloadTables();
                            })}>Clear {t.label}</button>)}</div>
                    </details>}
                <div className="cart-items">
                    {pricedCart.length ? pricedCart.map(x => <div className="cart-item" key={x.key}>
                        <div className="cart-item-details"><strong>{x.product.name}</strong>
                            <small>{[x.variation?.name, ...x.addonList.map(a => a.name)].filter(Boolean).join(', ') || 'Regular'}</small>
                            <span>{money(x.unit * x.qty)}</span>
                            {!x.available && <small>Item or option unavailable</small>}
                        </div>
                        <div className="qty-control">
                            <button aria-label={'Remove one ' + x.product.name} disabled={busy || !!unconfirmed} onClick={() => updateQuantity(x.key, -1)}><Minus size={16} /></button>
                            <span>{x.qty}</span>
                            <button aria-label={'Add one ' + x.product.name} disabled={busy || !!unconfirmed || x.qty >= 100} onClick={() => updateQuantity(x.key, 1)}><Plus size={16} /></button>
                        </div>
                    </div>) : <Empty text="Your cart is empty." />}
                </div>
                <div className="checkout-form">
                    <div className="checkout-row"><span>Subtotal</span><strong>{money(subtotal)}</strong></div>
                    <Field label="Promo code"><input value={promo} maxLength={100} disabled={busy || !!unconfirmed} onChange={e => setPromo(e.target.value)} /></Field>
                    {!offline && <Field label="Reward account code"><input value={rewardCode} maxLength={32} disabled={busy || !!unconfirmed}
                        onChange={e => setRewardCode(e.target.value)} /></Field>}
                    {onlineQuote?.totals?.loyalty_points != null && <p>{onlineQuote.totals.loyalty_points} points available</p>}
                    {(promoKey || rewardKey) && !totals && cart.length > 0 && <p role={offline || onlineQuote?.error ? 'alert' : 'status'}>
                        {offline ? 'This promo code is unavailable offline.' : onlineQuote?.error || 'Checking discount and rewards…'}
                    </p>}
                    {!offline && <Field label="Payment method"><select value={method} disabled={busy || !!unconfirmed} onChange={e => setMethod(e.target.value)}>
                        <option value="cash">Cash</option><option value="gcash">GCash (record payment)</option>
                        <option value="maya">Maya (record payment)</option><option value="card">Card (record payment)</option>
                    </select></Field>}
                    {cash && <Field label="Amount tendered (PHP)"><input type="number" inputMode="decimal" min="0" step="0.01"
                        value={tender} disabled={busy || !!unconfirmed} onChange={e => setTender(e.target.value)} /></Field>}
                    {totals && <>
                        {totals.discount_cents > 0 && <div className="checkout-row"><span>Discount</span><strong>{money(-totals.discount_cents)}</strong></div>}
                        {totals.tax_cents > 0 && <div className="checkout-row"><span>Tax</span><strong>{money(totals.tax_cents)}</strong></div>}
                        {totals.service_cents > 0 && <div className="checkout-row"><span>Service charge</span><strong>{money(totals.service_cents)}</strong></div>}
                        <div className="total-row"><span>Total</span><strong>{money(totals.total_cents)}</strong></div>
                        {cash && cart.length > 0 && change >= 0 && <div className="checkout-row"><span>Change</span><strong>{money(change)}</strong></div>}
                    </>}
                    {!offline && heldOrderId && <button className="text-link"
                        disabled={busy || !!unconfirmed} onClick={()=>{
                            setCart([]);setHeldOrderId(null);setPromo('');setRewardCode('');setTender('');
                        }}>Return held order to list</button>}
                    {!offline && !heldOrderId && <Button secondary disabled={busy || !!unconfirmed ||
                        !branch || !cart.length || cartUnavailable} onClick={parkOrder}>Hold / park order</Button>}
                    <Button onClick={checkout} disabled={busy || (unconfirmed ? offline : !branch || !cart.length || cartUnavailable || !totals || (cash && change < 0) ||
                        (!offline && cash && settings.require_cash_register && !registerId))}>
                        {busy ? 'Processing…' : unconfirmed ? 'Retry checkout' : offline ? 'Save cash sale' : 'Complete sale'} <ArrowRight size={18} />
                    </Button>
                </div>
            </aside>
        </div>
        {custom && <Customize product={custom} addons={addons} close={() => setCustom(null)} add={add} />}
        {receipt && <ReceiptModal receipt={receipt} close={() => setReceipt(null)} />}
    </>;
}
function Customize({ product, addons, close, add }) { const [v, setV] = useState(''), [ids, setIds] = useState([]); const cost = variationPrice(product, product.variations.find(x => x.id === v)) + addons.filter(a => ids.includes(a.id)).reduce((s, x) => s + x.price_cents, 0); return <Modal title={'Customize ' + product.name} onClose={close}><div className="modal-body"><h4>Size / variation</h4><div className="option-list"><label><input type="radio" checked={!v} onChange={() => setV('')}/> Regular · {money(product.price_cents)}</label>{product.variations.map(a => <label key={a.id}><input type="radio" checked={v === a.id} onChange={() => setV(a.id)}/> {a.name} · {money(variationPrice(product, a))}</label>)}</div><h4>Add-ons</h4><div className="option-list">{addons.filter(a => a.active).map(a => <label key={a.id}><input type="checkbox" checked={ids.includes(a.id)} onChange={e => setIds(ids => e.target.checked ? [...ids, a.id] : ids.filter(x => x !== a.id))}/>{a.name} <span>+{money(a.price_cents)}</span></label>)}{!addons.length && <p className="muted">No add-ons configured.</p>}</div><Button onClick={() => add(product, v, ids)}>Add to order · {money(cost)}</Button></div></Modal>; }
function ReceiptModal({ receipt, close }) { return <Modal title={receipt.pending ? "Offline cash receipt" : "Sale complete"} onClose={close}><div className="modal-body"><div className="receipt-success"><CheckCircle2 size={42}/><h3>{receipt.pending ? "Saved locally · Awaiting synchronization" : "Payment recorded"}</h3><p>{receipt.pending ? "Transaction " : "Order #"}{String(receipt.order_number).padStart(5, '0')}</p></div><div className="receipt-paper"><div className="receipt-title">STRATIFYPOS</div><div className="receipt-center">{fmt(receipt.created_at)}<br />{receipt.order_type.replace('_', ' ').toUpperCase()}{receipt.pending && <><br />UNCONFIRMED OFFLINE SALE<br />{receipt.order_number}</>}</div><hr />{receipt.items?.map((x, i) => <div className="receipt-line" key={i}><span>{x.quantity} × {x.name}{x.variation ? ' (' + x.variation + ')' : ''}{x.addons?.length > 0 && <small>{' · ' + x.addons.map(a => a.name).join(', ')}</small>}</span><b>{money(x.total_cents)}</b></div>)}<hr />{[['Subtotal', receipt.subtotal_cents], ['Discount', -receipt.discount_cents], ['Tax', receipt.tax_cents], ['Service charge', receipt.service_cents], ['TOTAL', receipt.total_cents]].map(([l, v]) => <div key={l} className="receipt-line"><span>{l}</span><strong>{money(v)}</strong></div>)}<p>Paid by {receipt.payment_method.toUpperCase()}</p>{receipt.payment_method === 'cash' && <p>Change: {money(receipt.change_cents)}</p>}<div className="receipt-center">{receipt.receipt_footer ?? 'Thank you for your purchase!'}</div></div><Button onClick={() => window.print()}><Printer size={17}/> Print receipt</Button></div></Modal>; }
function variationPrice(product, option) {
    return option?.price_cents ?? product.price_cents + (option?.price_delta_cents || 0);
}

function RecipeEditor({ value, ingredients, onChange }) {
    function update(index, patch) {
        onChange(value.map((line, row) => row === index ? { ...line, ...patch } : line));
    }

    return <>
        {value.map((line, index) => <div className="repeat-row" key={index}>
            <select aria-label="Recipe stock item" value={line.ingredient_id} onChange={e => update(index, { ingredient_id: e.target.value })}>
                <option value="">Select stock item</option>
                {ingredients.map(item => <option value={item.id} key={item.id}>{item.name} ({item.unit})</option>)}
            </select>
            <input aria-label="Recipe quantity" type="number" min="0.001" step="0.001" value={line.quantity}
                onChange={e => update(index, { quantity: e.target.value })} />
            <button aria-label="Remove recipe item" onClick={() => onChange(value.filter((_, row) => row !== index))}><Trash2 size={17} /></button>
        </div>)}
        <button className="text-link" onClick={() => onChange([...value, { ingredient_id: '', quantity: 1 }])}>+ Add stock item</button>
    </>;
}

const emptyProduct = { name: '', description: '', price: '', cost: '', category_id: '', active: true,
    product_type:'food_beverage',sku:'',barcode:'',brand:'',manufacturer:'',stock_item_id:'',image_url:'',
    variations: [], recipe: [] };

function Products({ request, act, busy }) {
    const { data, load, err } = useLoad(request, 'products');
    const { data: cats, load: loadCats } = useLoad(request, 'categories');
    const { data: ingredients } = useLoad(request, 'ingredients');
    const [modal, setModal] = useState(null);
    const [catName, setCatName] = useState('');
    const [form, setForm] = useState(emptyProduct);
    const update = (key, value) => setForm(prev => ({ ...prev, [key]: value }));

    function open(product = null) {
        setModal(product || 'new');
        setForm(product ? {
            ...product, price: product.price_cents / 100, cost: product.cost_cents / 100,
            variations: product.variations.map(option => ({
                ...option, price: variationPrice(product, option) / 100, recipe: option.recipe ?? []
            }))
        } : emptyProduct);
    }

    function updateOption(index, patch) {
        setForm(prev => ({ ...prev, variations: prev.variations.map((option, row) =>
            row === index ? { ...option, ...patch } : option) }));
    }

    async function save() {
        await act(async () => {
            if (!form.name.trim()) throw new Error('Product name is required.');
            await request(modal?.id ? 'products/' + modal.id : 'products', modal?.id ? 'PUT' : 'POST', {
                name: form.name, description: form.description, price_cents: pesos(form.price), cost_cents: pesos(form.cost),
                category_id: form.category_id || null, active: form.active,
                product_type:form.product_type,sku:form.sku||null,barcode:form.barcode||null,
                brand:form.brand||'',manufacturer:form.manufacturer||'',
                stock_item_id:form.product_type==='physical' ? form.stock_item_id||null : null,
                image_url:form.image_url||null,
                variations: form.variations.map(option => ({
                    id: option.id, name: option.name, price_cents: pesos(option.price),
                    sku:option.sku||null,barcode:option.barcode||null,
                    stock_item_id:form.product_type==='physical' ? option.stock_item_id||null : null,
                    use_custom_recipe: option.use_custom_recipe === true, recipe: option.recipe
                })),
                recipe: form.recipe
            });
            setModal(null);
            load();
        });
    }

    if (err) return <p role="alert" className="flash error">{err}</p>;
    if (!data || !cats || !ingredients) return <Load />;
    return <>
        <Heading title="Products & services" action={<Button onClick={() => open()}><Plus size={17} /> Add product</Button>} />
        <Panel title="Product catalog" right={<span className="badge">{data.length} items</span>}>
            <Table items={data} columns={[
                ['name', 'Product', (_name,item)=><div className="operations-product-cell">
                    {item.image_url && <img src={item.image_url} alt="" loading="lazy" />}
                    <span><strong>{item.name}</strong><small>{item.sku || 'No SKU'}{item.barcode ? ' · '+item.barcode : ''}</small></span>
                </div>], ['category', 'Category'], ['product_type','Type',v=>String(v).replace('_',' ')], ['price_cents', 'Base price', money],
                ['active', 'Status', active => active ? 'Active' : 'Inactive'],
                ['id', 'Actions', (_, item) => <button className="text-link" onClick={() => open(item)}>Edit</button>]
            ]} />
        </Panel>
        <Panel title="Categories" right={<div className="inline-form">
            <input aria-label="New category name" placeholder="New category" value={catName} onChange={e => setCatName(e.target.value)} />
            <Button disabled={busy || !catName.trim()} onClick={() => act(async () => {
                await request('categories', 'POST', { name: catName });
                setCatName('');
                loadCats();
            })}>Add</Button>
        </div>}>
            <div className="chip-row">{cats.map(category => <span className="chip category-chip" key={category.id}>
                {category.name}<button aria-label={'Delete ' + category.name} onClick={() => act(async () => {
                    await request('categories/' + category.id, 'DELETE');
                    loadCats();
                    load();
                })}><X size={13} /></button>
            </span>)}</div>
        </Panel>
        {modal && <Modal title={modal?.id ? 'Edit product' : 'Add product'} onClose={() => setModal(null)}>
            <div className="modal-body">
                <div className="form-grid">
                    <Field label="Product name"><input value={form.name} onChange={e => update('name', e.target.value)} /></Field>
                    <Field label="Category"><select value={form.category_id || ''} onChange={e => update('category_id', e.target.value)}>
                        <option value="">Uncategorized</option>{cats.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </select></Field>
                    <Field label="Product type"><select value={form.product_type || 'food_beverage'} onChange={e=>update('product_type',e.target.value)}>
                        <option value="food_beverage">Food & beverage</option><option value="physical">Physical / stock item</option>
                        <option value="service">Service</option><option value="bundle">Bundle / package</option>
                        <option value="non_stock">Non-stock item</option>
                    </select></Field>
                    <Field label="SKU"><input value={form.sku||''} maxLength={64} placeholder="Generated automatically"
                        onChange={e=>update('sku',e.target.value)}/></Field>
                    <Field label="Barcode"><input value={form.barcode||''} maxLength={128} placeholder="Scan or enter code"
                        onChange={e=>update('barcode',e.target.value)}/></Field>
                    <Field label="Base price (PHP)"><input type="number" min="0" step=".01" value={form.price} onChange={e => update('price', e.target.value)} /></Field>
                    <Field label="Estimated cost (PHP)"><input type="number" min="0" step=".01" value={form.cost} onChange={e => update('cost', e.target.value)} /></Field>
                </div>
                <div className="form-grid">
                    <Field label="Brand"><input value={form.brand||''} maxLength={120} onChange={e=>update('brand',e.target.value)}/></Field>
                    <Field label="Manufacturer"><input value={form.manufacturer||''} maxLength={120} onChange={e=>update('manufacturer',e.target.value)}/></Field>
                    <Field label="Product photo HTTPS URL"><input type="url" value={form.image_url||''} maxLength={1024}
                        onChange={e=>update('image_url',e.target.value)} placeholder="https://example.com/product.jpg"/></Field>
                    {form.product_type==='physical' && <Field label="Direct stock item"><select
                        value={form.stock_item_id||''} onChange={e=>update('stock_item_id',e.target.value)}>
                        <option value="">No direct stock tracking</option>
                        {ingredients.map(item=><option key={item.id} value={item.id}>{item.name} ({item.unit})</option>)}
                    </select></Field>}
                </div>
                <Field label="Description"><textarea value={form.description || ''} onChange={e => update('description', e.target.value)} /></Field>
                <h4>Sizes and variations</h4>
                {form.variations.map((option, index) => <fieldset key={option.id ?? index}>
                    <legend>{option.name || 'New variation'}</legend>
                    <div className="repeat-row operations-variation-row">
                        <input aria-label="Variation name" value={option.name} onChange={e => updateOption(index, { name: e.target.value })} />
                        <input aria-label="Variation price in PHP" type="number" min="0" step=".01" value={option.price}
                            onChange={e => updateOption(index, { price: e.target.value })} />
                        <input aria-label="Variation SKU" value={option.sku||''} maxLength={64} placeholder="SKU"
                            onChange={e=>updateOption(index,{sku:e.target.value})}/>
                        <input aria-label="Variation barcode" value={option.barcode||''} maxLength={128} placeholder="Barcode"
                            onChange={e=>updateOption(index,{barcode:e.target.value})}/>
                        <button aria-label="Remove variation" onClick={() => update('variations',
                            form.variations.filter((_, row) => row !== index))}><Trash2 size={17} /></button>
                    </div>
                    {form.product_type==='physical' && <Field label="Variation-specific stock item (optional)">
                        <select value={option.stock_item_id||''} onChange={e=>updateOption(index,{stock_item_id:e.target.value})}>
                            <option value="">Use product stock item</option>
                            {ingredients.map(item=><option key={item.id} value={item.id}>{item.name} ({item.unit})</option>)}
                        </select>
                    </Field>}
                    <label className="check"><input type="checkbox" checked={!!option.use_custom_recipe}
                        onChange={e => updateOption(index, { use_custom_recipe: e.target.checked })} /> Use a custom recipe</label>
                    {option.use_custom_recipe && <RecipeEditor value={option.recipe} ingredients={ingredients}
                        onChange={recipe => updateOption(index, { recipe })} />}
                </fieldset>)}
                <button className="text-link" onClick={() => update('variations', [...form.variations,
                    { name: '', price: form.price, sku:'', barcode:'',stock_item_id:'',recipe: [] }])}>+ Add variation</button>
                <h4>Base recipe</h4>
                <RecipeEditor value={form.recipe} ingredients={ingredients} onChange={recipe => update('recipe', recipe)} />
                <label className="check"><input type="checkbox" checked={form.active} onChange={e => update('active', e.target.checked)} /> Available for sale</label>
                <Button onClick={save} disabled={busy}>Save product</Button>
            </div>
        </Modal>}
    </>;
}

function AddonRecipeButton({ addon, request, act }) {
    const [data, setData] = useState(null);
    const [busy, setBusy] = useState(false);
    const path = 'addons/' + addon.id + '/recipe';
    return <>
        <button className="text-link" disabled={busy} onClick={async () => {
            setBusy(true);
            await act(async () => {
                const [recipe, ingredients] = await Promise.all([request(path), request('ingredients')]);
                setData({ recipe, ingredients });
            });
            setBusy(false);
        }}>Recipe</button>
        {data && <Modal title={addon.name + ' recipe'} onClose={() => setData(null)}><div className="modal-body">
            <RecipeEditor value={data.recipe} ingredients={data.ingredients}
                onChange={recipe => setData(prev => ({ ...prev, recipe }))} />
            <Button disabled={busy} onClick={async () => {
                setBusy(true);
                await act(async () => { await request(path, 'PUT', { recipe: data.recipe }); setData(null); });
                setBusy(false);
            }}>Save recipe</Button>
        </div></Modal>}
    </>;
}

function Crud({
    title,
    sub,
    endpoint,
    fields,
    request,
    act,
    columns,
    extra
}: {
    title: string;
    sub: string;
    endpoint: string;
    fields: any[];
    request: ApiRequest;
    act: any;
    columns: any[];
    extra?: React.ReactNode;
}) {
    const { data, load, err } = useLoad(request, endpoint);

    const [modal, setModal] = useState<any>(null);
    const [form, setForm] = useState<Record<string, any>>({});
    const [saving, setSaving] = useState(false);
    const [formError, setFormError] = useState('');

    const open = (record?: any) => {
        setFormError('');

        if (record) {
            const values: Record<string, any> = {
                ...record
            };

            for (const field of fields) {
                if (field.type === 'money') {
                    values[field.key] =
                        Number(record[field.key] || 0) / 100;
                }

                if (field.type === 'datetime-local') {
                    if (record[field.key]) {
                        const date = new Date(record[field.key]);

                        values[field.key] =
                            Number.isNaN(date.getTime())
                                ? ''
                                : new Date(
                                    date.getTime() -
                                    date.getTimezoneOffset() * 60000
                                ).toISOString().slice(0, 16);
                    } else {
                        values[field.key] = '';
                    }
                }
            }

            setForm(values);
            setModal(record);
        } else {
            const defaults: Record<string, any> = {};

            for (const field of fields) {
                defaults[field.key] = field.default ?? '';
            }

            setForm(defaults);
            setModal('new');
        }
    };

    const close = () => {
        if (saving) return;

        setModal(null);
        setFormError('');
    };

    async function save() {
        if (saving) return;

        setFormError('');

        const payload: Record<string, any> = {
            ...form
        };

        try {
            for (const field of fields) {
                const key = field.key;
                const raw = form[key];

                if (field.type === 'money') {
                    if (
                        raw === '' ||
                        raw === null ||
                        raw === undefined ||
                        !Number.isFinite(Number(raw))
                    ) {
                        throw new Error(
                            `${field.label} must be a valid amount.`
                        );
                    }

                    payload[key] = pesos(raw);
                }

                else if (field.type === 'number') {
                    if (
                        raw === '' ||
                        raw === null ||
                        raw === undefined ||
                        !Number.isFinite(Number(raw))
                    ) {
                        throw new Error(
                            `${field.label} must be a valid number.`
                        );
                    }

                    payload[key] = Number(raw);
                }

                else if (field.type === 'datetime-local') {
                    if (
                        raw === '' ||
                        raw === null ||
                        raw === undefined
                    ) {
                        // NULL means no expiration.
                        payload[key] = null;
                    } else {
                        const date = new Date(raw);

                        if (Number.isNaN(date.getTime())) {
                            throw new Error(
                                `${field.label} is invalid.`
                            );
                        }

                        payload[key] = date.toISOString();
                    }
                }

                else if (
                    typeof raw === 'string' &&
                    !field.options
                ) {
                    payload[key] = raw.trim();
                }
            }

            if (endpoint === 'promotions') {
                const code = String(
                    payload.code || ''
                ).trim().toUpperCase();

                const value = Number(payload.value);

                if (!code) {
                    throw new Error(
                        'Please enter a promo code.'
                    );
                }

                if (!['percent', 'fixed'].includes(payload.kind)) {
                    throw new Error(
                        'Please select a discount type.'
                    );
                }

                if (
                    !Number.isFinite(value) ||
                    value <= 0
                ) {
                    throw new Error(
                        'Discount must be greater than zero.'
                    );
                }

                if (
                    payload.kind === 'percent' &&
                    value > 100
                ) {
                    throw new Error(
                        'Percentage cannot exceed 100%.'
                    );
                }

                if (
                    payload.kind === 'fixed' &&
                    !Number.isSafeInteger(value)
                ) {
                    throw new Error(
                        'Fixed discount must be whole centavos.'
                    );
                }

                payload.code = code;
                payload.value = value;
                payload.expires_at =
                    payload.expires_at || null;
            }

        } catch (error: any) {
            setFormError(
                error?.message || 'Invalid form values.'
            );
            return;
        }

        setSaving(true);

        try {
            const id =
                typeof modal === 'object' &&
                modal !== null
                    ? modal.id
                    : null;

            const path = id
                ? `${endpoint}/${id}`
                : endpoint;

            const method = id ? 'PUT' : 'POST';

            await request(path, method, payload);

            setModal(null);
            setFormError('');

            load();

        } catch (error: any) {
            setFormError(
                error?.message ||
                'Unable to save record.'
            );

        } finally {
            setSaving(false);
        }
    }

    function deleteRecord(record: any) {
        if (!window.confirm('Delete this record?')) {
            return;
        }

        act(async () => {
            await request(
                `${endpoint}/${record.id}`,
                'DELETE'
            );

            load();
        });
    }

    return (
        <>
            <Heading
                title={title}
                sub={sub}
                action={
                    <Button onClick={() => open()}>
                        <Plus size={17} />
                        Add new
                    </Button>
                }
            />

            {extra}

            <Panel
                title={title}
                right={
                    <span className="badge">
                        {data?.length || 0} records
                    </span>
                }
            >
                {err ? (
                    <div className="flash error">
                        {err}
                    </div>
                ) : !data ? (
                    <Load />
                ) : (
                    <Table
                        items={data}
                        columns={[
                            ...columns,
                            [
                                'actions',
                                'Actions',
                                (_: any, record: any) => (
                                    <>
                                        <button
                                            className="text-link"
                                            onClick={() => open(record)}
                                        >
                                            Edit
                                        </button>

                                        <button
                                            className="text-link danger-link"
                                            onClick={() =>
                                                deleteRecord(record)
                                            }
                                        >
                                            Delete
                                        </button>
                                    </>
                                )
                            ]
                        ]}
                    />
                )}
            </Panel>

            {modal && (
                <Modal
                    title={
                        modal?.id
                            ? 'Edit record'
                            : 'Add record'
                    }
                    onClose={close}
                >
                    <div className="modal-body">
                        {formError && (
                            <div className="flash error">
                                <AlertTriangle size={17} />
                                {formError}
                            </div>
                        )}

                        {fields.map(field => (
                            <Field
                                key={field.key}
                                label={field.label}
                            >
                                {field.options ? (
                                    <select
                                        value={
                                            form[field.key] ?? ''
                                        }
                                        onChange={event =>
                                            setForm(previous => ({
                                                ...previous,
                                                [field.key]:
                                                    event.target.value
                                            }))
                                        }
                                    >
                                        <option value="">
                                            Select…
                                        </option>

                                        {field.options.map(
                                            (option: any) => (
                                                <option
                                                    key={option.value}
                                                    value={option.value}
                                                >
                                                    {option.label}
                                                </option>
                                            )
                                        )}
                                    </select>
                                ) : (
                                    <input
                                        type={
                                            field.type === 'money' ||
                                            field.type === 'number'
                                                ? 'number'
                                                : field.type || 'text'
                                        }
                                        step={
                                            field.type === 'money'
                                                ? '0.01'
                                                : field.step || '1'
                                        }
                                        min={
                                            field.type === 'number'
                                                ? '0'
                                                : undefined
                                        }
                                        value={
                                            form[field.key] ?? ''
                                        }
                                        onChange={event =>
                                            setForm(previous => ({
                                                ...previous,
                                                [field.key]:
                                                    event.target.value
                                            }))
                                        }
                                    />
                                )}

                                {field.type === 'datetime-local' && (
                                    <small
                                        style={{
                                            color: '#64748b',
                                            fontSize: 11,
                                            marginTop: 5
                                        }}
                                    >
                                        Leave blank for no expiration.
                                    </small>
                                )}
                            </Field>
                        ))}

                        <Button
                            onClick={save}
                            disabled={saving}
                        >
                            {saving
                                ? 'Saving...'
                                : 'Save changes'}
                        </Button>
                    </div>
                </Modal>
            )}
        </>
    );
}

const stockTypes = [
    ['ingredient', 'Ingredient'], ['product', 'Product'], ['supply', 'Supply'], ['material', 'Material'], ['other', 'Other']
];
const newStockItem = { name: '', unit: 'g', item_type: 'ingredient', inventory_category: '', low_stock_at: '0', unit_cost_cents: 0, quantity: '0' };

function Inventory({ request, act, role, limited }) {
    const [selectedLocation, setLocation] = useState('');
    const [page, setPage] = useState(0);
    const [search, setSearch] = useState('');
    const { data: branches } = useLoad(request, 'branches');
    const location = selectedLocation || (limited ? branches?.[0]?.id || '' : '');
    const { data: balance, load, err } = useLoad(request, 'stock/balances' + (location ? '?branch_id=' + location : ''));
    const { data: movements, load: loadMovements, err: movementError } = useLoad(request,
        'stock/movements?offset=' + page * 50 + (location ? '&branch_id=' + location : ''));
    const [item, setItem] = useState(null);
    const [movement, setMovement] = useState(null);
    const [enabling, setEnabling] = useState(false);
    const [saving, setSaving] = useState(false);
    const mode = balance?.branch_stock_enabled;
    const poolLabel = mode ? 'Unallocated stock' : 'Shared stock';
    const stock = balance?.items || [];
    const filtered = stock.filter(row => (row.name + ' ' + row.inventory_category).toLowerCase().includes(search.toLowerCase()));
    const locations = <>
        {!limited && <option value="">{poolLabel}</option>}
        {(branches || []).map(branch => <option key={branch.id} value={branch.id}>{branch.name}</option>)}
    </>;

    function openItem(row = null) {
        setItem(row ? { ...row, unit_cost_cents: row.unit_cost_cents / 100 } : { ...newStockItem });
    }

    function openMovement(row) {
        setMovement({ row, kind: 'stock_in', quantity: '', reason: '', from: location, to: limited ? branches?.find(row => row.id!==location)?.id || location : '' });
    }

    async function save(action) {
        if (saving) return;
        setSaving(true);
        try { await act(action); }
        finally { setSaving(false); }
    }

    function reload() {
        load();
        if (page === 0) loadMovements();
        else setPage(0);
    }

    return <>
        <Heading title="Inventory management" action={!limited && <Button onClick={() => openItem()}><Plus size={17} /> Add stock item</Button>} />
        <div className="metrics">
            <Metric label="Stock items tracked" val={stock.length} icon={Package} tint="sage" foot={location ? branches?.find(b => b.id === location)?.name : poolLabel} />
            <Metric label="At or below reorder point" val={stock.filter(row => Number(row.available) <= Number(row.low_stock_at)).length}
                icon={AlertTriangle} tint="peach" foot="Current location" />
        </div>
        {!mode && balance && role === 'owner' && <Panel title="Branch inventory">
            <p className="padded">All locations currently draw from shared stock. Enable branch inventory when you are ready to allocate stock to each location.</p>
            <div className="padded"><Button secondary onClick={() => setEnabling(true)}>Set up branch inventory</Button></div>
        </Panel>}
        <Panel title="Stock levels" right={<div className="inline-form">
            {mode && <select aria-label="Stock location" value={location} onChange={e => { setLocation(e.target.value); setPage(0); }}>{locations}</select>}
            <input aria-label="Search stock items" placeholder="Search name or category" value={search} onChange={e => setSearch(e.target.value)} />
        </div>}>
            {err ? <p className="flash error" role="alert">{err}</p> : !balance ? <Load /> : <Table items={filtered} columns={[
                ['name', 'Stock item'], ['item_type', 'Type', type => stockTypes.find(([value]) => value === type)?.[1]],
                ['inventory_category', 'Category'], ['available', 'Available', (v, row) => v + ' ' + row.unit],
                ['low_stock_at', 'Reorder point'],
                ['status', 'Status', (_, row) => Number(row.available) <= Number(row.low_stock_at)
                    ? <span className="badge red">Low stock</span> : <span className="badge green">In stock</span>],
                ['id', 'Actions', (_, row) => <div className="inline-form">
                    <button className="text-link" onClick={() => openMovement(row)}>Move stock</button>
                    {!limited && <button className="text-link" onClick={() => openItem(row)}>Edit item</button>}
                </div>]
            ]} />}
        </Panel>
        <Panel title="Movement history" right={<div className="inline-form">
            <Button secondary disabled={page === 0} onClick={() => setPage(page - 1)}>Previous</Button>
            <Button secondary disabled={!movements || movements.length < 50} onClick={() => setPage(page + 1)}>Next</Button>
        </div>}>
            {movementError ? <p className="flash error" role="alert">{movementError}</p> : !movements ? <Load /> :
                <Table items={movements} columns={[
                    ['ingredient', 'Stock item'], ['branch', 'Location', v => v || poolLabel],
                    ['delta', 'Change', value => Number(value) > 0 ? '+' + value : value],
                    ['movement_type', 'Type', value => value?.replace('_', ' ') || 'Legacy'],
                    ['reason', 'Reason'], ['actor', 'Recorded by'], ['created_at', 'Date', fmt]
                ]} />}
        </Panel>
        {enabling && <Modal title="Enable branch inventory" onClose={() => setEnabling(false)}>
            <div className="modal-body">
                <p>Shared stock will become unallocated. Transfer it to each branch before selling items with recipes at that branch.</p>
                <Button disabled={saving} onClick={() => save(async () => {
                    await request('stock/branch-mode', 'PUT', { enabled: true });
                    setEnabling(false);
                    reload();
                })}>Enable branch inventory</Button>
            </div>
        </Modal>}
        {item && <Modal title={item.id ? 'Edit stock item' : 'Add stock item'} onClose={() => setItem(null)}>
            <div className="modal-body">
                <Field label="Name"><input value={item.name} onChange={e => setItem({ ...item, name: e.target.value })} /></Field>
                <Field label="Type"><select value={item.item_type} onChange={e => setItem({ ...item, item_type: e.target.value })}>
                    {stockTypes.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select></Field>
                <Field label="Category"><input value={item.inventory_category} onChange={e => setItem({ ...item, inventory_category: e.target.value })} /></Field>
                <Field label="Measurement unit"><input value={item.unit} onChange={e => setItem({ ...item, unit: e.target.value })} placeholder="g, mL, pcs" /></Field>
                <Field label="Reorder point"><input type="number" min="0" step=".001" value={item.low_stock_at}
                    onChange={e => setItem({ ...item, low_stock_at: e.target.value })} /></Field>
                <Field label="Unit cost (PHP)"><input type="number" min="0" step=".01" value={item.unit_cost_cents}
                    onChange={e => setItem({ ...item, unit_cost_cents: e.target.value })} /></Field>
                {!item.id && <Field label={mode ? 'Opening quantity in unallocated stock' : 'Opening quantity'}>
                    <input type="number" min="0" step=".001" value={item.quantity}
                        onChange={e => setItem({ ...item, quantity: e.target.value })} />
                </Field>}
                <Button disabled={saving} onClick={() => save(async () => {
                    const { id, quantity, unit_cost_cents, available, ...fields } = item;
                    await request(id ? 'ingredients/' + id : 'ingredients', id ? 'PUT' : 'POST', {
                        ...fields, unit_cost_cents: pesos(unit_cost_cents), ...(id ? {} : { quantity })
                    });
                    setItem(null);
                    reload();
                })}>Save stock item</Button>
            </div>
        </Modal>}
        {movement && <Modal title={'Move ' + movement.row.name} onClose={() => setMovement(null)}>
            <div className="modal-body">
                <p>{movement.row.available} {movement.row.unit} available at the selected location.</p>
                <Field label="Movement"><select value={movement.kind} onChange={e => setMovement({ ...movement, kind: e.target.value })}>
                    <option value="stock_in">Stock in</option><option value="stock_out">Stock out</option>
                    <option value="adjustment">Adjustment</option>{mode && <option value="transfer">Transfer</option>}
                </select></Field>
                {mode && <Field label={movement.kind === 'transfer' ? 'From' : 'Location'}>
                    <select value={movement.from} onChange={e => setMovement({ ...movement, from: e.target.value })}>{locations}</select>
                </Field>}
                {movement.kind === 'transfer' && <Field label="To">
                    <select value={movement.to} onChange={e => setMovement({ ...movement, to: e.target.value })}>{locations}</select>
                </Field>}
                <Field label={movement.kind === 'adjustment' ? 'Quantity change (+ / −)' : 'Quantity'}>
                    <input type="number" min={movement.kind === 'adjustment' ? undefined : '.001'} step=".001" value={movement.quantity}
                        onChange={e => setMovement({ ...movement, quantity: e.target.value })} />
                </Field>
                <Field label="Reason"><input value={movement.reason} maxLength={300} onChange={e => setMovement({ ...movement, reason: e.target.value })} /></Field>
                <Button disabled={saving || !movement.reason.trim() || !movement.quantity} onClick={() => save(async () => {
                    const { row, kind, reason, quantity, from, to } = movement;
                    if (kind !== 'adjustment' && Number(quantity) <= 0) throw new Error('Enter a positive quantity.');
                    if (kind === 'transfer') {
                        await request('stock/transfer', 'POST', {
                            ingredient_id: row.id, from_branch_id: from || null, to_branch_id: to || null, quantity, reason
                        });
                    } else {
                        await request('stock/adjust', 'POST', {
                            ingredient_id: row.id, branch_id: from || null, delta: kind === 'stock_out' ? -Number(quantity) : Number(quantity),
                            reason, movement_type: kind
                        });
                    }
                    setMovement(null);
                    reload();
                })}>Record movement</Button>
            </div>
        </Modal>}
    </>;
}
function Orders({ request, role, cashierId }) {
    const { data, load, err } = useLoad(request, 'orders');
    const [detail, setDetail] = useState(null);
    const [refunding, setRefunding] = useState(null);
    const [error,setError] = useState('');
    const canRefund = role === 'owner' || role === 'manager';
    return <>
        <Heading title="Sales & transactions" sub="Review the payment ledger, reprint receipts and authorize cash refunds."/>
        {(err || error) && <p role="alert" className="flash error">{err || error}</p>}
        <Panel title="Transaction history">
            <Table items={data || []} columns={[
                ['order_number','Order #',v=>'#'+v],
                ['created_at','Date & time',fmt],
                ['cashier','Cashier'],
                ['order_type','Type',v=>String(v).replace('_',' ')],
                ['payment_method','Payment',v=>String(v).toUpperCase()],
                ['status','Status',v=>String(v).replace('_',' ')],
                ['total_cents','Total',money],
                ['id','Actions',(_id,row)=><div className="operations-actions">
                    <button className="text-link" onClick={()=>
                        request('orders/'+row.id).then(setDetail).catch((e:any)=>setError(e.message))}>Receipt</button>
                    {canRefund && row.payment_method==='cash' && row.status!=='refunded' &&
                        <button className="text-link" onClick={()=>setRefunding(row)}>Refund</button>}
                </div>]
            ]}/>
        </Panel>
        {detail && <ReceiptModal receipt={{ ...detail,items:detail.items.map((i:any)=>({
            name:i.product_name,quantity:i.quantity,total_cents:i.total_cents,
            variation:i.variation_name,addons:i.addons
        })) }} close={()=>setDetail(null)}/>}
        {refunding && <RefundDialog request={request} order={refunding} cashierId={cashierId}
            onClose={()=>setRefunding(null)} onDone={()=>{
                setRefunding(null);load();
            }}/>}
    </>;
}
function Reports({ request }) {
    const [period, setPeriod] = useState('monthly');
    const [branch, setBranch] = useState('');
    const [from, setFrom] = useState('');
    const [to, setTo] = useState('');
    const [transactionPage, setTransactionPage] = useState(0);
    const [movementPage, setMovementPage] = useState(0);
    const [tab, setTab] = useState('sales');
    const [exporting, setExporting] = useState('');
    const [exportError, setExportError] = useState('');
    const { data: branches } = useLoad(request, 'branches');
    const query = new URLSearchParams({ period });
    if (branch) query.set('branch_id', branch);
    if (period === 'custom') { query.set('from', from); query.set('to', to); }
    const valid = period !== 'custom' || Boolean(from && to && from <= to);
    const { data, err } = useLoad(request, valid
        ? 'reports?' + query + '&transaction_page=' + transactionPage + '&movement_page=' + movementPage : null);

    function filter(set, value) {
        set(value);
        setTransactionPage(0);
        setMovementPage(0);
        setExportError('');
    }

    async function download(format) {
        setExporting(format);
        setExportError('');
        try {
            const file = await request('reports/export/' + format + '?' + query);
            if (!(file instanceof Blob)) throw new Error('The server returned an invalid export.');
            const url = URL.createObjectURL(file);
            const link = document.createElement('a');
            link.href = url;
            link.download = 'stratify-report-' + data.filters.from + '_' + data.filters.to + '.' + format;
            document.body.append(link);
            link.click();
            link.remove();
            window.setTimeout(() => URL.revokeObjectURL(url), 30000);
        } catch (error) {
            setExportError(error.message);
        } finally {
            setExporting('');
        }
    }

    function pagination(page, setPage, count) {
        return <div className="inline-form">
            <Button secondary disabled={!page} onClick={() => setPage(page - 1)}>Previous</Button>
            <span>Page {page + 1}</span>
            <Button secondary disabled={(page + 1) * 50 >= count} onClick={() => setPage(page + 1)}>Next</Button>
        </div>;
    }

    const summary = data?.summary;
    return <>
        <Heading title="Reports & analytics" action={<div className="inline-form">
            <Button secondary disabled={!data || !!exporting} onClick={() => download('xlsx')}>{exporting === 'xlsx' ? 'Preparing…' : 'Export Excel'}</Button>
            <Button secondary disabled={!data || !!exporting} onClick={() => download('pdf')}>{exporting === 'pdf' ? 'Preparing…' : 'Export PDF'}</Button>
        </div>} />
        <Panel title="Report filters">
            <div className="form-grid padded">
                <Field label="Period"><select value={period} onChange={e => filter(setPeriod, e.target.value)}>
                    <option value="daily">Today</option><option value="yesterday">Yesterday</option><option value="weekly">This week</option><option value="monthly">This month</option>
                    <option value="yearly">This year</option><option value="custom">Custom dates</option>
                </select></Field>
                <Field label="Branch"><select value={branch} onChange={e => filter(setBranch, e.target.value)}>
                    <option value="">All branches</option>
                    {branches?.map(row => <option value={row.id} key={row.id}>{row.name}</option>)}
                </select></Field>
                {period === 'custom' && <>
                    <Field label="Start date"><input type="date" value={from} onChange={e => filter(setFrom, e.target.value)} /></Field>
                    <Field label="End date"><input type="date" value={to} min={from || undefined} onChange={e => filter(setTo, e.target.value)} /></Field>
                </>}
            </div>
            {data && <p className="padded">{data.filters.from} through {data.filters.to} · {data.filters.zone}</p>}
        </Panel>
        {(err || exportError) && <p className="flash error" role="alert">{err || exportError}</p>}
        {!valid && <Empty text="Choose a start date and an end date." />}
        {valid && !data && !err && <Load />}
        {summary && <>
            <div className="operations-sales-summary"><span>Gross receipts <strong>{money(summary.gross_revenue_cents)}</strong></span>
                <span>Cash refunds <strong>{money(summary.refund_cents)}</strong></span>
                <span>Net receipts <strong>{money(summary.revenue_cents)}</strong></span>
                <span>Known COGS <strong>{money(summary.cogs_cents)} <small>({summary.cogs_covered_orders}/{summary.orders} costed)</small></strong></span>
                <span>Estimated gross profit <strong>{summary.estimated_gross_profit_cents == null
                    ? 'Unavailable · incomplete cost history' : money(summary.estimated_gross_profit_cents)}</strong></span></div>
            <div className="metrics">
                <Metric label="Net collected sales" val={money(summary.revenue_cents)} icon={Wallet} tint="brown" foot="Gross payments less cash refunds" />
                <Metric label="Sales transactions" val={summary.orders} icon={Receipt} tint="sage" foot="Including partially refunded" />
                <Metric label="Average order" val={money(summary.orders ? Number(summary.revenue_cents) / summary.orders : 0)}
                    icon={ShoppingBag} tint="peach" foot="Net sales per transaction" />
                <Metric label="Recorded expenses" val={money(summary.expenses_cents)} icon={CreditCard} tint="sand" foot="Selected period" />
            </div>
            <div className="chip-row">
                {[['sales','Sales'],['transactions','Transactions'],['inventory','Inventory'],['discounts','Discounts']].map(([id,label]) =>
                    <button key={id} className={'chip ' + (tab === id ? 'chip-on' : '')}
                        aria-pressed={tab === id} onClick={() => setTab(id)}>{label}</button>)}
            </div>
            {tab === 'sales' && <>
                <Panel title="Revenue trend">{data.daily.length ? <div className="chart">
                    <ResponsiveContainer><AreaChart data={data.daily.map(row => ({ day: row.day, revenue: Number(row.revenue) / 100 }))}>
                        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#ece8e2" />
                        <XAxis dataKey="day" tickLine={false} axisLine={false} />
                        <Tooltip formatter={value => money(Number(value) * 100)} />
                        <Area dataKey="revenue" stroke="#203A73" fill="#dce7f6" strokeWidth={3} />
                    </AreaChart></ResponsiveContainer>
                </div> : <Empty text="No paid sales in this period." />}</Panel>
                <div className="two-col">
                    <Panel title="Product and variation performance"><Table items={data.top} columns={[
                        ['name', 'Product'], ['variation', 'Variation', value => value || 'Regular'],
                        ['units', 'Units'], ['sales', 'Gross item sales', money]
                    ]} /></Panel>
                    <Panel title="Cashier performance"><Table items={data.cashiers} columns={[
                        ['name', 'Team member'], ['orders', 'Orders'], ['sales', 'Paid sales', money]
                    ]} /></Panel>
                </div>
            </>}
            {tab === 'transactions' && <Panel title="Transactions" right={pagination(transactionPage, setTransactionPage, data.counts.transactions)}>
                <Table items={data.transactions} columns={[
                    ['order_number', 'Order #'], ['local_time', 'Local date and time'], ['branch', 'Branch'],
                    ['cashier', 'Cashier'], ['status', 'Status'], ['payment_method', 'Payment'],
                    ['discount_cents', 'Discount', money], ['total_cents', 'Total', money]
                ]} />
            </Panel>}
            {tab === 'inventory' && <>
                <Panel title="Current inventory balances"><Table items={data.balances} columns={[
                    ['name', 'Item'], ['category', 'Category'], ['quantity', 'Balance'], ['unit', 'Unit'], ['low_stock_at', 'Reorder point']
                ]} /></Panel>
                <Panel title="Inventory movements" right={pagination(movementPage, setMovementPage, data.counts.movements)}>
                    <Table items={data.movements} columns={[
                        ['local_time', 'Local date and time'], ['name', 'Item'], ['branch', 'Branch'],
                        ['delta', 'Change'], ['unit', 'Unit'], ['reason', 'Reason']
                    ]} />
                </Panel>
            </>}
            {tab === 'discounts' && <Panel title="Promotion usage" right={<strong>{money(summary.discount_cents)} discounted</strong>}>
                <Table items={data.discounts} columns={[
                    ['code', 'Promo code'], ['orders', 'Paid orders'], ['discount_cents', 'Discounts', money]
                ]} />
            </Panel>}
        </>}
    </>;
}
const teamRoles = [['manager','Manager'], ['cashier','Cashier'], ['staff','Staff']];
const weekDays = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
const shiftDuration = seconds => seconds == null ? '—' : (Number(seconds) / 3600).toFixed(2) + ' h';

function Staff({ request, act, role, setNotice, access }) {
    const manages = access?.staff !== false && (role === 'owner' || role === 'manager');
    const attendanceAllowed = access?.attendance !== false;
    const { data: team, load: loadTeam } = useLoad(request, manages ? 'staff' : null);
    const { data: branchList } = useLoad(request, 'branches');
    const { data: status, load: loadStatus, err: statusError } = useLoad(request, attendanceAllowed ? 'attendance/status' : null);
    const { data: summary, load: loadSummary } = useLoad(request, attendanceAllowed ? 'attendance/summary' : null);
    const [employee, setEmployee] = useState('');
    const { data: attendance, load: loadAttendance } = useLoad(request, attendanceAllowed ? 'attendance' + (employee ? '?user_id=' + employee : '') : null);
    const [branch, setBranch] = useState('');
    const [accountMode, setAccountMode] = useState('');
    const [account, setAccount] = useState({ name: '', email: '', password: '', role: 'cashier' });
    const [schedule, setSchedule] = useState(null);
    const [accessForm,setAccessForm] = useState(null);
    const [roleForm,setRoleForm] = useState(null);
    const { data: roleDefaults, load: reloadRoleDefaults } = useLoad(request, role==='owner' && manages ? 'staff/role-permissions' : null);
    const [saving, setSaving] = useState(false);
    const shift = status?.shift;
    const branches = branchList || [];

    async function save(action) {
        if (saving) return;
        setSaving(true);
        try { await act(action); }
        finally { setSaving(false); }
    }

    function reloadAttendance() {
        loadStatus();
        loadAttendance();
        loadSummary();
    }

    async function openSchedule(person) {
        await save(async () => {
            const rows = await request('staff/' + person.user_id + '/schedule');
            const days = weekDays.map((_, index) => {
                const row = rows.find(shift => shift.weekday === index + 1);
                return { weekday: index + 1, enabled: !!row, branch_id: row?.branch_id || '',
                    starts_at: row?.starts_at.slice(0, 5) || '08:00', ends_at: row?.ends_at.slice(0, 5) || '17:00',
                    grace_minutes: row?.grace_minutes ?? 0 };
            });
            setSchedule({ person, days, time_zone: rows[0]?.time_zone || 'Asia/Manila' });
        });
    }

    function editShift(index, fields) {
        setSchedule(prev => ({ ...prev, days: prev.days.map((day, row) => row === index ? { ...day, ...fields } : day) }));
    }

    async function remove(person) {
        const confirmation = window.prompt('Type ' + person.email + ' to confirm removal. An account without other shops or protected history can be permanently deleted.');
        if (confirmation === null) return;
        await save(async () => {
            if (confirmation.trim().toLowerCase() !== person.email.toLowerCase()) throw new Error('Email confirmation does not match.');
            const result = await request('staff/' + person.user_id, 'DELETE');
            loadTeam();
            reloadAttendance();
            setNotice(result.message);
        });
    }

    async function attendanceAction(action, label) {
        await save(async () => {
            await request('attendance/' + action, 'POST', action === 'clock-in' ? { branch_id: branch || null } : {});
            reloadAttendance();
            setNotice(label);
        });
    }

    return <>
        <Heading title="Team & attendance" action={manages && <div className="inline-form">
            <Button onClick={() => { setAccount({ name: '', email: '', password: '', role: 'cashier' }); setAccountMode('create'); }}>
                <Plus size={17} /> Create account
            </Button>
            <Button secondary onClick={() => { setAccount({ name: '', email: '', password: '', role: 'cashier' }); setAccountMode('invite'); }}>
                Invite team member
            </Button>
            {role==='owner' && <Button secondary onClick={() => setRoleForm({
                role:'cashier',permissions:roleDefaults?.find(row => row.role==='cashier')?.permissions || {}
            })}>Role permissions</Button>}
        </div>} />
        {attendanceAllowed && <Panel title="My attendance">
            <div className="padded">
                {statusError ? <p role="alert">{statusError}</p> : !status ? <Load /> : <>
                    <p role="status">{shift?.open_break ? 'On break' : shift ? 'Clocked in at ' + fmt(shift.clock_in) : 'Clocked out'}</p>
                    <div className="inline-form">
                        {!shift && <>
                            <select aria-label="Clock-in branch" value={branch} onChange={e => setBranch(e.target.value)}>
                                <option value="">Use scheduled branch</option>
                                {branches.filter(b => b.active).map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
                            </select>
                            <Button disabled={saving} onClick={() => attendanceAction('clock-in', 'Clocked in')}><Clock size={17} /> Clock in</Button>
                        </>}
                        {shift && !shift.open_break && <>
                            <Button disabled={saving} onClick={() => attendanceAction('break-start', 'Break started')}>Start break</Button>
                            <Button secondary disabled={saving} onClick={() => attendanceAction('clock-out', 'Clocked out')}>Clock out</Button>
                        </>}
                        {shift?.open_break && <Button disabled={saving} onClick={() => attendanceAction('break-end', 'Break ended')}>End break</Button>}
                    </div>
                </>}
            </div>
        </Panel>}
        {manages && <Panel title="Team members"><Table items={team || []} columns={[
            ['name','Name'], ['email','Email'], ['role','Role'], ['active','Status', active => active ? 'Active' : 'Disabled'],
            ['user_id','Actions', (_, person) => <div className="inline-form">
                {(role === 'owner' || person.role !== 'owner') && <button className="text-link" disabled={saving} onClick={() => openSchedule(person)}>Schedule</button>}
                {role === 'owner' && person.role !== 'owner' && <>
                    <select aria-label={'Role for ' + person.name} value={person.role} disabled={saving} onChange={e => {
                        const next = e.target.value;
                        void save(async () => { await request('staff/' + person.user_id, 'PATCH', { role: next, active: person.active }); loadTeam(); });
                    }}>{teamRoles.map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select>
                    <button className="text-link" disabled={saving} onClick={() => save(async () => {
                        await request('staff/' + person.user_id, 'PATCH', { role: person.role, active: !person.active });
                        loadTeam();
                    })}>{person.active ? 'Disable' : 'Enable'}</button>
                    <button className="text-link" disabled={saving} onClick={() => setAccessForm({
                        person, modules:person.module_permissions || {}, branch_ids:person.branch_ids ?? null
                    })}>Access</button>
                    <button className="text-link" disabled={saving} onClick={() => remove(person)}>Delete</button>
                </>}
            </div>]
        ]} /></Panel>}
        {attendanceAllowed && <>
        <Panel title="Attendance summary · last 30 days"><Table items={summary || []} columns={[
            ['name','Employee'], ['shifts','Shifts'], ['late_shifts','Late starts'], ['work_seconds','Completed work time', shiftDuration]
        ]} /></Panel>
        <Panel title="Recent attendance" right={manages && <select aria-label="Filter employee" value={employee} onChange={e => setEmployee(e.target.value)}>
            <option value="">All employees</option>
            {team?.map(person => <option key={person.user_id} value={person.user_id}>{person.name}</option>)}
        </select>}>
            <Table items={attendance || []} columns={[
                ['name','Employee'], ['branch','Branch'], ['clock_in','Clocked in', fmt], ['clock_out','Clocked out', fmt],
                ['late_minutes','Late minutes', (v, row) => row.scheduled_start_at ? v : '—'],
                ['break_seconds','Break time', shiftDuration], ['work_seconds','Work time', shiftDuration]
            ]} />
        </Panel>
        </>}
        {roleForm && <Modal title="Role permissions" onClose={() => setRoleForm(null)}>
            <div className="modal-body">
                <Field label="Role"><select value={roleForm.role} onChange={e => {
                    const selected = e.target.value;
                    setRoleForm({ role:selected,permissions:roleDefaults?.find(row => row.role===selected)?.permissions || {} });
                }}>{teamRoles.map(([id,name]) => <option key={id} value={id}>{name}</option>)}</select></Field>
                <PermissionFields value={roleForm.permissions} onChange={permissions => setRoleForm({ ...roleForm,permissions })} inherited="Built-in default" />
                <Button disabled={saving} onClick={() => save(async () => {
                    await request('staff/role-permissions','PUT',roleForm);
                    setRoleForm(null); reloadRoleDefaults();
                })}>Save role permissions</Button>
            </div>
        </Modal>}
        {accessForm && <Modal title={accessForm.person.name + ' workspace access'} onClose={() => setAccessForm(null)}>
            <div className="modal-body">
                <PermissionFields value={accessForm.modules} onChange={modules => setAccessForm({ ...accessForm,modules })} inherited="Role default" />
                <label className="check"><input type="checkbox" checked={accessForm.branch_ids===null}
                    onChange={e => setAccessForm({ ...accessForm,branch_ids:e.target.checked ? null : [] })} /> Allow all branches</label>
                {accessForm.branch_ids!==null && <fieldset><legend>Assigned branches</legend>{branches.map(row =>
                    <label className="check" key={row.id}><input type="checkbox" checked={accessForm.branch_ids.includes(row.id)}
                        onChange={e => setAccessForm({ ...accessForm,branch_ids:e.target.checked
                            ? [...accessForm.branch_ids,row.id] : accessForm.branch_ids.filter(id => id!==row.id) })} /> {row.name}</label>)}</fieldset>}
                <Button disabled={saving} onClick={() => save(async () => {
                    await request('staff/'+accessForm.person.user_id+'/access','PUT',{
                        module_permissions:accessForm.modules,branch_ids:accessForm.branch_ids
                    });
                    setAccessForm(null); loadTeam();
                })}>Save member access</Button>
            </div>
        </Modal>}
        {accountMode && <Modal title={accountMode === 'create' ? 'Create team account' : 'Invite team member'} onClose={() => setAccountMode('')}>
            <div className="modal-body">
                {accountMode === 'create' && <Field label="Name"><input value={account.name} onChange={e => setAccount({ ...account, name: e.target.value })} /></Field>}
                <Field label="Email"><input type="email" value={account.email} onChange={e => setAccount({ ...account, email: e.target.value })} /></Field>
                <Field label="Role"><select value={account.role} onChange={e => setAccount({ ...account, role: e.target.value })}>
                    {teamRoles.filter(([id]) => role === 'owner' || id !== 'manager').map(([id,label]) => <option key={id} value={id}>{label}</option>)}
                </select></Field>
                {accountMode === 'create' && <Field label="Initial password (12+ characters)">
                    <input type="password" autoComplete="new-password" value={account.password}
                        onChange={e => setAccount({ ...account, password: e.target.value })} />
                </Field>}
                <Button disabled={saving} onClick={() => save(async () => {
                    if (accountMode === 'create') {
                        await request('staff', 'POST', account);
                        loadTeam();
                        setNotice('Team account created. Share the sign-in details securely.');
                    } else {
                        const result = await request('staff/invite', 'POST', { email: account.email, role: account.role });
                        if (!result.sent && !result.developmentInviteLink) throw new Error('Invitation email was not sent.');
                        setNotice(result.sent ? 'Invitation emailed' : 'Development invitation: ' + result.developmentInviteLink);
                    }
                    setAccount({ name: '', email: '', password: '', role: 'cashier' });
                    setAccountMode('');
                })}>{accountMode === 'create' ? 'Create account' : 'Send invitation'}</Button>
            </div>
        </Modal>}
        {schedule && <Modal title={schedule.person.name + ' · Work schedule'} onClose={() => setSchedule(null)}>
            <div className="modal-body">
                <Field label="Time zone"><input value={schedule.time_zone} placeholder="Asia/Manila"
                    onChange={e => setSchedule({ ...schedule, time_zone: e.target.value })} /></Field>
                {schedule.days.map((day, index) => <fieldset key={day.weekday}>
                    <legend>{weekDays[index]}</legend>
                    <label className="check"><input type="checkbox" checked={day.enabled}
                        onChange={e => editShift(index, { enabled: e.target.checked })} /> Scheduled workday</label>
                    {day.enabled && <div className="form-grid">
                        <Field label="Starts"><input type="time" value={day.starts_at} onChange={e => editShift(index, { starts_at: e.target.value })} /></Field>
                        <Field label="Ends"><input type="time" value={day.ends_at} onChange={e => editShift(index, { ends_at: e.target.value })} /></Field>
                        <Field label="Branch"><select value={day.branch_id} onChange={e => editShift(index, { branch_id: e.target.value })}>
                            <option value="">Any branch</option>
                            {branches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
                        </select></Field>
                        <Field label="Grace period (minutes)"><input type="number" min="0" max="180" value={day.grace_minutes}
                            onChange={e => editShift(index, { grace_minutes: e.target.value })} /></Field>
                    </div>}
                    {day.enabled && day.ends_at < day.starts_at && <small>Shift ends the next day.</small>}
                </fieldset>)}
                <Button disabled={saving} onClick={() => save(async () => {
                    await request('staff/' + schedule.person.user_id + '/schedule', 'PUT', {
                        time_zone: schedule.time_zone.trim(), shifts: schedule.days.filter(day => day.enabled).map(day => ({
                            ...day, branch_id: day.branch_id || null, grace_minutes: Number(day.grace_minutes)
                        }))
                    });
                    setSchedule(null);
                    setNotice('Work schedule saved');
                })}>Save schedule</Button>
            </div>
        </Modal>}
    </>;
}
function Branches({ request, act }) {
    const { data: branches, load, err } = useLoad(request, 'branches');
    const [branch, setBranch] = useState(null);
    const [calendar, setCalendar] = useState(null);
    const [tableVersion, setTableVersion] = useState(0);
    const [saving, setSaving] = useState(false);

    async function save(action) {
        if (saving) return;
        setSaving(true);
        try { await act(action); }
        finally { setSaving(false); }
    }

    const branchOptions = (branches || []).map(row => ({ value: row.id, label: row.name }));
    const editBranch = row => setBranch({ ...row, open_time: row.open_time?.slice(0, 5) || '07:00',
        close_time: row.close_time?.slice(0, 5) || '21:00' });

    async function openSchedule(location) {
        await save(async () => {
            const result = await request('branches/' + location.id + '/schedule');
            setCalendar({ ...result, weekly: weekDays.map((_, index) => {
                const day = result.weekly.find(row => row.weekday === index + 1);
                return { weekday: index + 1, enabled: !!day, closed: day?.closed ?? false,
                    opens_at: day?.opens_at?.slice(0, 5) || location.open_time?.slice(0, 5) || '07:00',
                    closes_at: day?.closes_at?.slice(0, 5) || location.close_time?.slice(0, 5) || '21:00' };
            }), overrides: result.overrides.map(day => ({ ...day, opens_at: day.opens_at?.slice(0, 5) || '07:00',
                closes_at: day.closes_at?.slice(0, 5) || '21:00' })) });
        });
    }

    function editHours(list, index, patch) {
        setCalendar(prev => ({ ...prev, [list]: prev[list].map((row, i) => i === index ? { ...row, ...patch } : row) }));
    }

    function hourFields(day, change) {
        return <>
            <label className="check"><input type="checkbox" checked={day.closed} onChange={e => change({ closed: e.target.checked })} /> Closed</label>
            {!day.closed && <div className="form-grid">
                <Field label="Opens"><input type="time" value={day.opens_at} onChange={e => change({ opens_at: e.target.value })} /></Field>
                <Field label="Closes"><input type="time" value={day.closes_at} onChange={e => change({ closes_at: e.target.value })} /></Field>
            </div>}
        </>;
    }

    return <>
        <Heading title="Branches & tables" action={<Button onClick={() => editBranch({ name: '', address: '', active: true })}><Plus size={17} /> Add branch</Button>} />
        <Panel title="Branches">
            {err ? <p role="alert">{err}</p> : !branches ? <Load /> : <Table items={branches} columns={[
                ['name','Branch'], ['address','Address'], ['open_time','Default opening'], ['close_time','Default closing'],
                ['time_zone','Time zone'], ['active','Status', active => active ? 'Active' : 'Inactive'],
                ['id','Actions', (_, row) => <div className="inline-form">
                    <button className="text-link" disabled={saving} onClick={() => editBranch(row)}>Edit</button>
                    <button className="text-link" disabled={saving} onClick={() => openSchedule(row)}>Hours & holidays</button>
                </div>]
            ]} />}
        </Panel>
        <Crud key={tableVersion} title="Dine-in tables" sub="Manage seats, reservations and availability." endpoint="tables"
            request={request} act={act} fields={[
                { key: 'branch_id', label: 'Branch', options: branchOptions }, { key: 'label', label: 'Table label' },
                { key: 'seats', label: 'Seats', type: 'number', default: 2 }
            ]} columns={[
                ['label','Table'], ['branch_id','Branch', id => branches?.find(row => row.id === id)?.name],
                ['seats','Seats'], ['status','Status', (status, row) => <select aria-label={'Status for ' + row.label}
                    value={status} disabled={saving} onChange={e => {
                        const next = e.target.value;
                        void save(async () => {
                            await request('tables/' + row.id + '/status', 'PUT', { status: next });
                            setTableVersion(prev => prev + 1);
                        });
                    }}>
                    <option value="available">{status === 'occupied' ? 'Clear table' : 'Available'}</option>
                    {status === 'occupied' ? <option value="occupied">Occupied</option> : <>
                        <option value="reserved">Reserved</option><option value="unavailable">Unavailable</option>
                    </>}
                </select>]
            ]} />
        {branch && <Modal title={branch.id ? 'Edit branch' : 'Add branch'} onClose={() => setBranch(null)}>
            <div className="modal-body">
                <Field label="Name"><input value={branch.name} onChange={e => setBranch({ ...branch, name: e.target.value })} /></Field>
                <Field label="Address"><input value={branch.address} onChange={e => setBranch({ ...branch, address: e.target.value })} /></Field>
                <div className="form-grid">
                    <Field label="Default opening"><input type="time" value={branch.open_time} onChange={e => setBranch({ ...branch, open_time: e.target.value })} /></Field>
                    <Field label="Default closing"><input type="time" value={branch.close_time} onChange={e => setBranch({ ...branch, close_time: e.target.value })} /></Field>
                </div>
                {branch.id && <label className="check"><input type="checkbox" checked={branch.active}
                    onChange={e => setBranch({ ...branch, active: e.target.checked })} /> Branch active</label>}
                <Button disabled={saving || !branch.name.trim()} onClick={() => save(async () => {
                    await request(branch.id ? 'branches/' + branch.id : 'branches', branch.id ? 'PUT' : 'POST', branch);
                    setBranch(null);
                    load();
                })}>Save branch</Button>
            </div>
        </Modal>}
        {calendar && <Modal title={calendar.branch.name + ' · Hours & holidays'} onClose={() => setCalendar(null)}>
            <div className="modal-body">
                <Field label="Time zone"><input value={calendar.branch.time_zone} onChange={e => setCalendar({
                    ...calendar, branch: { ...calendar.branch, time_zone: e.target.value }
                })} /></Field>
                <p>Today ({calendar.today.date}) · {calendar.today.closed ? 'Closed' :
                    [calendar.today.opens_at, calendar.today.closes_at].map(value => value?.slice(0, 5) || '—').join('–')}
                    {calendar.today.label && ' · ' + calendar.today.label}</p>
                <h4>Weekly hours</h4>
                {calendar.weekly.map((day, index) => <fieldset key={day.weekday}>
                    <legend>{weekDays[index]}</legend>
                    <label className="check"><input type="checkbox" checked={day.enabled}
                        onChange={e => editHours('weekly', index, { enabled: e.target.checked })} /> Override default hours</label>
                    {day.enabled && hourFields(day, patch => editHours('weekly', index, patch))}
                </fieldset>)}
                <h4>Date overrides</h4>
                {calendar.overrides.map((day, index) => <fieldset key={index}>
                    <legend>{day.label || 'Date override'}</legend>
                    <Field label="Date"><input type="date" value={day.day} onChange={e => editHours('overrides', index, { day: e.target.value })} /></Field>
                    <Field label="Label"><input value={day.label} onChange={e => editHours('overrides', index, { label: e.target.value })} /></Field>
                    {hourFields(day, patch => editHours('overrides', index, patch))}
                    <button className="text-link" onClick={() => setCalendar({
                        ...calendar, overrides: calendar.overrides.filter((_, row) => row !== index)
                    })}>Remove override</button>
                </fieldset>)}
                <button className="text-link" onClick={() => setCalendar({ ...calendar, overrides: [
                    ...calendar.overrides, { day: '', label: '', closed: true, opens_at: '07:00', closes_at: '21:00' }
                ] })}>+ Add date override</button>
                <Button disabled={saving} onClick={() => save(async () => {
                    await request('branches/' + calendar.branch.id + '/schedule', 'PUT', {
                        time_zone: calendar.branch.time_zone.trim(), weekly: calendar.weekly.filter(day => day.enabled),
                        overrides: calendar.overrides
                    });
                    setCalendar(null);
                    load();
                })}>Save operating hours</Button>
            </div>
        </Modal>}
    </>;
}

const promoKinds = [['percent','Percentage'], ['fixed','Fixed amount'], ['bogo','Buy 1 Take 1'], ['bundle','Bundle price'], ['loyalty','Loyalty reward']];
const dateTimeInput = value => {
    if (!value) return '';
    const date = new Date(value);
    return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};

function PromotionRules({ request, act }) {
    const { data, load, err } = useLoad(request, 'promotions');
    const { data: branches } = useLoad(request, 'branches');
    const { data: products } = useLoad(request, 'products');
    const { data: categories } = useLoad(request, 'categories');
    const [form, setForm] = useState(null);
    const [saving, setSaving] = useState(false);
    function edit(rule = null) {
        setForm(rule ? { ...rule, starts_at: dateTimeInput(rule.starts_at), expires_at: dateTimeInput(rule.expires_at),
            value: rule.kind === 'percent' ? rule.value : rule.value / 100 } : {
            code: '', kind: 'percent', scope: 'transaction', value: '', starts_at: '', expires_at: '',
            branch_ids: [], active: true, usage_limit: '', group_quantity: 2, points_required: '', requires_approval: false
        });
    }
    const field = (key, value) => setForm(prev => ({ ...prev, [key]: value }));
    async function save() {
        if (saving) return;
        setSaving(true);
        try {
            await act(async () => {
                await request(form.id ? 'promotions/' + form.id : 'promotions', form.id ? 'PUT' : 'POST', {
                    ...form, value: form.kind === 'percent' ? Number(form.value) : pesos(form.value),
                    starts_at: form.starts_at ? new Date(form.starts_at).toISOString() : null,
                    expires_at: form.expires_at ? new Date(form.expires_at).toISOString() : null,
                    usage_limit: form.usage_limit ? Number(form.usage_limit) : null,
                    group_quantity: Number(form.group_quantity), points_required: Number(form.points_required)
                });
                setForm(null);
                load();
            });
        } finally { setSaving(false); }
    }
    return <>
        <Heading title="Promotions & discounts" action={<Button onClick={() => edit()}><Plus size={17} /> Add promotion</Button>} />
        <Panel title="Promotion rules">
            <p className="padded">Checkout accepts one promotion code per sale.</p>
            {err ? <p role="alert">{err}</p> : !data ? <Load /> : <Table items={data} columns={[
                ['code','Code'], ['kind','Type', value => promoKinds.find(([id]) => id === value)?.[1]],
                ['scope','Applies to'], ['usage_limit','Usage limit', value => value || 'Unlimited'],
                ['expires_at','Expires', fmt], ['active','Status', value => value ? 'Active' : 'Inactive'],
                ['id','Action', (_, rule) => <button className="text-link" onClick={() => edit(rule)}>Edit</button>]
            ]} />}
        </Panel>
        {form && <Modal title={form.id ? 'Edit promotion' : 'Add promotion'} onClose={() => setForm(null)}>
            <div className="modal-body">
                <div className="form-grid">
                    <Field label="Promo code"><input maxLength={100} value={form.code} onChange={e => field('code', e.target.value)} /></Field>
                    <Field label="Discount type"><select value={form.kind} onChange={e => field('kind', e.target.value)}>
                        {promoKinds.map(([id,label]) => <option value={id} key={id}>{label}</option>)}
                    </select></Field>
                    {form.kind !== 'bogo' && <Field label={form.kind === 'percent' ? 'Discount (%)' : form.kind === 'bundle' ? 'Bundle price (PHP)' : 'Discount (PHP)'}>
                        <input type="number" min="0" step={form.kind === 'percent' ? 1 : 0.01} value={form.value} onChange={e => field('value', e.target.value)} />
                    </Field>}
                    {form.kind === 'bundle' && <Field label="Items per bundle"><input type="number" min="2" max="100"
                        value={form.group_quantity} onChange={e => field('group_quantity', e.target.value)} /></Field>}
                    {form.kind === 'loyalty' && <Field label="Points required"><input type="number" min="1"
                        value={form.points_required ?? ''} onChange={e => field('points_required', e.target.value)} /></Field>}
                    <Field label="Applies to"><select value={form.scope} onChange={e => field('scope', e.target.value)}>
                        <option value="transaction">Whole transaction</option><option value="product">Selected product</option><option value="category">Selected category</option>
                    </select></Field>
                    {form.scope === 'product' && <Field label="Product"><select value={form.product_id || ''} onChange={e => field('product_id', e.target.value)}>
                        <option value="">Choose product</option>{products?.map(row => <option value={row.id} key={row.id}>{row.name}</option>)}
                    </select></Field>}
                    {form.scope === 'category' && <Field label="Category"><select value={form.category_id || ''} onChange={e => field('category_id', e.target.value)}>
                        <option value="">Choose category</option>{categories?.map(row => <option value={row.id} key={row.id}>{row.name}</option>)}
                    </select></Field>}
                    <Field label="Starts (optional)"><input type="datetime-local" value={form.starts_at} onChange={e => field('starts_at', e.target.value)} /></Field>
                    <Field label="Expires (optional)"><input type="datetime-local" value={form.expires_at} onChange={e => field('expires_at', e.target.value)} /></Field>
                    <Field label="Usage limit (optional)"><input type="number" min="1" value={form.usage_limit ?? ''} onChange={e => field('usage_limit', e.target.value)} /></Field>
                </div>
                <fieldset><legend>Eligible branches</legend>
                    <p>Leave all branches unchecked to apply everywhere.</p>
                    {branches?.map(row => <label className="check" key={row.id}><input type="checkbox"
                        checked={form.branch_ids.includes(row.id)} onChange={e => field('branch_ids', e.target.checked
                            ? [...form.branch_ids, row.id] : form.branch_ids.filter(id => id !== row.id))} /> {row.name}</label>)}
                </fieldset>
                <label className="check"><input type="checkbox" checked={form.requires_approval}
                    onChange={e => field('requires_approval', e.target.checked)} /> Only owners and managers can apply this code</label>
                <label className="check"><input type="checkbox" checked={form.active} onChange={e => field('active', e.target.checked)} /> Active</label>
                <Button disabled={saving || !form.code.trim()} onClick={save}>Save promotion</Button>
            </div>
        </Modal>}
    </>;
}

function RewardAccounts({ request, act }) {
    const [page, setPage] = useState(0);
    const { data, load, err } = useLoad(request, 'loyalty/accounts?offset=' + page * 50);
    const [form, setForm] = useState(null);
    const [saving, setSaving] = useState(false);
    return <Panel title="Reward accounts" right={<Button secondary onClick={() => setForm({ name: '', code: '' })}>Add reward account</Button>}>
        {err ? <p role="alert">{err}</p> : !data ? <Load /> : <Table items={data} columns={[
            ['code', 'Account code'], ['name', 'Customer'], ['points', 'Points']
        ]} />}
        <div className="inline-form padded">
            <Button secondary disabled={page === 0} onClick={() => setPage(page - 1)}>Previous</Button>
            <Button secondary disabled={!data || data.length < 50} onClick={() => setPage(page + 1)}>Next</Button>
        </div>
        {form && <Modal title="Add reward account" onClose={() => setForm(null)}>
            <div className="modal-body">
                <Field label="Customer name"><input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} /></Field>
                <Field label="Account code"><input value={form.code} maxLength={32} onChange={e => setForm({ ...form, code: e.target.value })} /></Field>
                <Button disabled={saving || !form.name.trim() || !form.code.trim()} onClick={async () => {
                    setSaving(true);
                    try {
                        await act(async () => {
                            await request('loyalty/accounts', 'POST', form);
                            setForm(null);
                            load();
                        });
                    } finally { setSaving(false); }
                }}>Save reward account</Button>
            </div>
        </Modal>}
    </Panel>;
}

function Promotions({ request, act }) {
    return (<>
        <PromotionRules request={request} act={act} />
        <RewardAccounts request={request} act={act} />
            <Crud
                title="Add-ons"
                sub="Manage optional products and services."
                endpoint="addons"
                request={request}
                act={act}
                fields={[
                    {
                        key: 'name',
                        label: 'Add-on name'
                    },
                    {
                        key: 'price_cents',
                        label: 'Price (PHP)',
                        type: 'money'
                    }
                ]}
                columns={[
                    ['name', 'Add-on'],
                    [
                        'price_cents',
                        'Price',
                        money
                    ],
                    ['id', 'Stock', (_, item) => <AddonRecipeButton addon={item} request={request} act={act} />]
                ]}
            />
        </>
    );
}

const loadPaymentMethods = () => fetchPaymentMethods(API);

async function publicPlans() {
    const response = await fetch(API + '/api/plans');
    if (!response.ok) throw new Error('Unable to load subscription plans.');
    return response.json();
}

function SettingsPage({ request, act, role, token, tenant, access }) {
    const settingsAllowed = access?.settings !== false;
    const billingAllowed = access?.billing !== false;
    const { data: settings, load, err } = useLoad(request, settingsAllowed ? 'settings' : null);
    const { data: subscription, err: subscriptionError } = useLoad(request, billingAllowed ? 'subscription' : null);
    const { data: plans, err: planError } = useLoad(publicPlans, role === 'owner' && billingAllowed ? 'plans' : null);
    const { data: history, load: reloadHistory, err: historyError } = useLoad(request, role === 'owner' && billingAllowed ? 'subscription/history' : null);
    const [form, setForm] = useState(null);
    const [target, setTarget] = useState('');
    const [discount,setDiscount] = useState('');
    const [method, setMethod] = useState('');
    const { data: methods, err: methodError } = useLoad(loadPaymentMethods, role === 'owner' && billingAllowed ? 'methods' : null);
    const [saving, setSaving] = useState(false);
    useEffect(() => { if (settings) setForm(settings); }, [settings]);
    const open = history?.requests.some(row => ['pending', 'awaiting_payment'].includes(row.status));
    const payment = history?.payments.find(row => row.status === 'pending');
    useEffect(() => {
        if (!payment) return;
        const timer = window.setInterval(reloadHistory,15000);
        return () => window.clearInterval(timer);
    },[Boolean(payment),reloadHistory]);
    const planOptions = (plans || []).filter(plan => plan.price_cents > 0 && plan.id !== subscription?.plan_id);
    const pageError = err || subscriptionError || planError || historyError || methodError;

    async function save(action) {
        if (saving) return;
        setSaving(true);
        try { await act(action); }
        finally { setSaving(false); }
    }

    return <>
        <Heading title="Shop settings & billing" />
        {pageError && <p className="flash error" role="alert">{pageError}</p>}
        <div className="two-col">
            {settingsAllowed && <Panel title="Checkout settings">{form ? <div className="settings-form">
                <Field label="Tax rate (%)"><input type="number" min="0" max="100" step="0.01" value={form.tax_basis_points / 100}
                    onChange={e => setForm({ ...form, tax_basis_points: Math.round(Number(e.target.value) * 100) })} /></Field>
                <Field label="Service charge (%)"><input type="number" min="0" max="100" step="0.01" value={form.service_basis_points / 100}
                    onChange={e => setForm({ ...form, service_basis_points: Math.round(Number(e.target.value) * 100) })} /></Field>
                <Field label="Spend per loyalty point (PHP)"><input type="number" min="0.01" step="0.01" value={form.loyalty_cents_per_point / 100}
                    onChange={e => setForm({ ...form, loyalty_cents_per_point: pesos(e.target.value) })} /></Field>
                <Field label="Receipt footer"><textarea value={form.receipt_footer} onChange={e => setForm({ ...form, receipt_footer: e.target.value })} /></Field>
                <Button disabled={saving} onClick={() => save(async () => { await request('settings', 'PUT', form); load(); })}>Save settings</Button>
            </div> : <Load />}</Panel>}
            {billingAllowed && <Panel title="Subscription">{subscription ? <div className="subscription-card">
                <h2>{subscription.title}</h2>
                <strong>{money(subscription.price_cents)} <small>/ month</small></strong>
                <div className="sub-row"><span>Status</span><b>{subscription.status.replace('_', ' ')}</b></div>
                <div className="sub-row"><span>Branches included</span><b>{subscription.max_branches}</b></div>
                <div className="sub-row"><span>Team accounts</span><b>{subscription.max_staff}</b></div>
                <div className="sub-row"><span>{subscription.trial_ends_at ? 'Trial ends' : 'Billing period ends'}</span>
                    <b>{fmt(subscription.trial_ends_at || subscription.current_period_ends_at)}</b></div>
                {access && <details><summary>Modules available to your account</summary>
                    <ul>{Object.entries(access).filter(([,allowed]) => allowed).map(([key]) => <li key={key}>{moduleLabels[key] || key}</li>)}</ul>
                </details>}
                {role === 'owner' && history && (open ? <p>A plan-change request is open. Review its status below.</p> : <>
                    <Field label="Change plan"><select value={target} onChange={e => setTarget(e.target.value)}>
                        <option value="">Choose a plan</option>
                        {planOptions.map(plan => <option key={plan.id} value={plan.id}>{plan.title} · {money(plan.price_cents)} / month</option>)}
                    </select></Field>
                    <Field label="Payment method"><select value={method || methods?.[0]?.id || ''} onChange={e => setMethod(e.target.value)}>
                        {!methods?.length && <option value="">No payment methods available</option>}
                        {methods?.map(option => <option key={option.id} value={option.id}>{option.name}</option>)}
                    </select></Field>
                    <Field label="Subscription discount code (optional)"><input maxLength={40} value={discount} onChange={e => setDiscount(e.target.value)} /></Field>
                    <Button disabled={saving || !target || !methods?.length} onClick={() => save(async () => {
                        await request('subscription/request-plan', 'POST', { plan_id: target, method: method || methods[0].id, discount_code: discount || undefined });
                        setTarget('');
                        reloadHistory();
                    })}>Request plan change</Button>
                </>)}
            </div> : <Load />}</Panel>}
        </div>
        {role === 'owner' && history && <>
            {payment && <Panel title={paymentStageLabel[payment.stage] || 'Pending payment'}><div className="padded">
                <p>{money(payment.amount_cents)} via {payment.method_name}. Request <strong>{payment.reference_no}</strong>.</p>
                {payment.instructions_snapshot && <p style={{ whiteSpace: 'pre-wrap' }}>{payment.instructions_snapshot}</p>}
                {payment.stage === 'awaiting_receipt' && <ReceiptSubmission key={payment.id}
                    url={API + '/api/shop/subscription/payments/' + payment.id + '/evidence'}
                    token={token} tenant={tenant} onSubmitted={reloadHistory} />}
            </div></Panel>}
            <Panel title="Plan-change history"><Table items={history.requests} columns={[
                ['created_at','Requested',fmt], ['requested_plan_id','Requested plan'], ['approved_plan_id','Approved plan'],
                ['status','Status', value => value.replace('_',' ')], ['review_note','Review note']
            ]} /></Panel>
            <Panel title="Payment history"><Table items={history.payments} columns={[
                ['created_at','Created',fmt], ['plan_id','Plan'], ['reference_no','Reference'], ['amount_cents','Amount',money],
                ['method_name','Method'], ['stage','Status', value => paymentStageLabel[value] || value], ['paid_at','Paid at',fmt], ['review_note','Review note']
            ]} /></Panel>
            <Panel title="Subscription activity"><Table items={history.events} columns={[
                ['created_at','Date',fmt], ['action','Activity', action => ({
                    'subscription.adjusted':'Subscription adjusted',
                    'subscription.payment_verified':'Payment verified',
                    'subscription.payment_rejected':'Payment rejected'
                })[action]], ['details','Plan', details => details.plan],
                ['id','Period ends', (_, event) => fmt(event.details.expires)]
            ]} /></Panel>
        </>}
    </>;
}

function PlanChangeReview({ adminReq, request, reloadPayments, revision }) {
    const { data: requests, load, err } = useLoad(adminReq, 'plan-requests', [revision]);
    const { data: plans } = useLoad(publicPlans, 'plans');
    const { data: methods } = useLoad(loadPaymentMethods, 'methods', [revision]);
    const [review, setReview] = useState(null);
    const [note, setNote] = useState('');
    const [selected, setSelected] = useState('');
    const [method, setMethod] = useState('');
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);

    async function submit(decision) {
        setBusy(true);
        setError('');
        try {
            await request('plan-requests/' + review.id + '/review', 'POST',
                { decision, plan_id: selected, method: method || methods?.[0]?.id, note }, true);
            setReview(null);
            load();
            reloadPayments();
        } catch (error) {
            setError(error.message);
        } finally { setBusy(false); }
    }

    return <Panel title="Plan-change requests">
        {err ? <p role="alert">{err}</p> : !requests ? <Load /> : <Table items={requests} columns={[
            ['business','Business'], ['requested_by_name','Requested by'], ['requested_plan_id','Requested plan'],
            ['approved_plan_id','Approved plan'], ['status','Status', status => status.replace('_',' ')], ['review_note','Review note'],
            ['id','Action', (_, row) => row.status === 'pending' ? <button className="text-link" onClick={() => {
                setReview(row); setSelected(row.requested_plan_id);
                setMethod(methods?.some(option => option.id === row.requested_payment_method) ? row.requested_payment_method : '');
                setNote(''); setError('');
            }}>Review</button> : '—']
        ]} />}
        {review && <Modal title={'Review plan change for ' + review.business} onClose={() => setReview(null)}>
            <div className="modal-body">
                <Field label="Plan to approve"><select value={selected} onChange={e => setSelected(e.target.value)}>
                    {plans?.filter(plan => plan.price_cents > 0).map(plan => <option value={plan.id} key={plan.id}>
                        {plan.title} · {money(plan.price_cents)} / month
                    </option>)}
                </select></Field>
                <Field label="Payment method"><select value={method || methods?.[0]?.id || ''} onChange={e => setMethod(e.target.value)}>
                    {!methods?.length && <option value="">No customer payment methods available</option>}
                    {methods?.map(option => <option key={option.id} value={option.id}>{option.name}</option>)}
                </select></Field>
                <Field label="Review note (required to reject)"><textarea maxLength={500} value={note} onChange={e => setNote(e.target.value)} /></Field>
                {error && <p className="flash error" role="alert">{error}</p>}
                <div className="inline-form">
                    <Button disabled={busy || !selected || !methods?.length} onClick={() => submit('approve')}>Approve payment request</Button>
                    <Button secondary disabled={busy || !note.trim()} onClick={() => submit('reject')}>Reject</Button>
                </div>
            </div>
        </Modal>}
    </Panel>;
}

function PaymentMethodSettings({ methods, request, reload }) {
    const [form, setForm] = useState<(PaymentMethod & { existing?: boolean }) | null>(null);
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);
    async function save() {
        setBusy(true);
        setError('');
        try {
            await request('payment-methods/' + encodeURIComponent(form.id.trim()), 'PUT', {
                name: form.name, instructions: form.instructions, customer_enabled: form.customer_enabled
            }, true);
            setForm(null);
            reload();
        } catch (error) { setError(error.message); }
        finally { setBusy(false); }
    }
    return <Panel title="Payment methods" right={<Button secondary onClick={() => {
        setError(''); setForm({ id: '', name: '', instructions: '', customer_enabled: false });
    }}>Add method</Button>}>
        <Table items={methods || []} columns={[
            ['name','Method'], ['customer_enabled','Customer checkout', enabled => enabled ? 'Enabled' : 'Disabled'],
            ['id','Action', (_, option) => <button className="text-link" onClick={() => {
                setError(''); setForm({ ...option, existing: true });
            }}>Edit</button>]
        ]} />
        {form && <Modal title={form.existing ? 'Edit payment method' : 'Add payment method'} onClose={() => setForm(null)}>
            <div className="modal-body">
                <Field label="Method ID"><input disabled={form.existing} maxLength={32} value={form.id}
                    onChange={e => setForm({ ...form, id: e.target.value.toLowerCase() })} /></Field>
                <Field label="Display name"><input maxLength={80} value={form.name}
                    onChange={e => setForm({ ...form, name: e.target.value })} /></Field>
                <Field label="Customer payment instructions"><textarea maxLength={4000} rows={5} value={form.instructions}
                    onChange={e => setForm({ ...form, instructions: e.target.value })} /></Field>
                <label className="check"><input type="checkbox" checked={form.customer_enabled}
                    onChange={e => setForm({ ...form, customer_enabled: e.target.checked })} /> Enable for customer payments</label>
                {error && <p className="flash error" role="alert">{error}</p>}
                <Button disabled={busy || !form.id || !form.name || (form.customer_enabled && !form.instructions.trim())} onClick={save}>Save method</Button>
            </div>
        </Modal>}
    </Panel>;
}

function PaymentReview({ payment, request, onClose, onSaved }) {
    const [imageUrl, setImageUrl] = useState('');
    const [receiptError, setReceiptError] = useState('');
    const [reference, setReference] = useState(payment.submitted_reference || '');
    const [confirmed, setConfirmed] = useState(false);
    const [note, setNote] = useState('');
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);
    const pending = payment.status === 'pending';
    useEffect(() => {
        if (!payment.submitted_at) return;
        const controller = new AbortController();
        let url = '';
        request('payments/' + payment.id + '/evidence', 'GET', undefined, true, controller.signal).then(blob => {
            if (!controller.signal.aborted) {
                url = URL.createObjectURL(blob);
                setImageUrl(url);
            }
        }).catch(error => { if (!controller.signal.aborted) setReceiptError(error.message); });
        return () => { controller.abort(); if (url) URL.revokeObjectURL(url); };
    }, [payment.id, payment.submitted_at, request]);
    async function submit(approve) {
        setBusy(true);
        setError('');
        try {
            const path = 'payments/' + payment.id;
            if (approve) await request(path + '/verify-and-activate', 'POST', {
                verified_reference: reference, confirmed_received: confirmed, review_note: note
            }, true);
            else await request(path, 'PATCH', { status: 'failed', reason: note }, true);
            onSaved();
        } catch (error) { setError(error.message); }
        finally { setBusy(false); }
    }
    return <Modal title={'Payment for ' + payment.shop_name} onClose={onClose}>
        <div className="modal-body">
            <p>{money(payment.amount_cents)} via {payment.method_name || payment.method} · {payment.plan_id}</p>
            <p>Request {payment.reference_no} · {paymentStageLabel[payment.stage]}</p>
            {payment.submitted_at && <p>Submitted reference <strong>{payment.submitted_reference}</strong></p>}
            {receiptError && <p role="alert">{receiptError}</p>}
            {imageUrl && <img src={imageUrl} alt="Submitted payment receipt" style={{ maxWidth: '100%', maxHeight: '55vh', objectFit: 'contain' }} />}
            {payment.review_note && <p>{payment.review_note}</p>}
            {pending && <>
                <Field label="Verified transaction reference"><input value={reference} maxLength={80} onChange={e => setReference(e.target.value)} /></Field>
                <label className="check"><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />
                    I confirmed the amount, recipient, and transaction reference with the payment provider.</label>
                <Field label="Review note (required to reject)"><textarea maxLength={500} value={note} onChange={e => setNote(e.target.value)} /></Field>
                {error && <p className="flash error" role="alert">{error}</p>}
                <div className="inline-form">
                    <Button disabled={busy || !confirmed || !reference.trim() || (payment.evidence_required && !imageUrl)}
                        onClick={() => submit(true)}>Verify and activate</Button>
                    <Button secondary disabled={busy || !note.trim()} onClick={() => submit(false)}>Reject payment</Button>
                </div>
            </>}
        </div>
    </Modal>;
}

function Admin({ request, act, section }) {
    const adminReq = useCallback((path) => request(path, 'GET', undefined, true), [request]);
    const { data: overview, load: loadOverview, err: overviewError } = useLoad(adminReq, section==='dashboard' ? 'overview' : null);
    const { data: shops, load: loadShops, err: shopsError } = useLoad(adminReq, ['businesses','payments','subscriptions'].includes(section) ? 'tenants?include_archived=true' : null);
    const { data: payments, load: loadPayments, err: paymentsError } = useLoad(adminReq, section==='payments' ? 'payments' : null);
    const { data: methods, load: loadMethods } = useLoad(adminReq, section==='payments' ? 'payment-methods' : null);
    const [paymentReview, setPaymentReview] = useState(null);
    const [billingRevision, setBillingRevision] = useState(0);
    const [businessEditor,setBusinessEditor] = useState(null);
    const { data: platformPlans } = useLoad(adminReq, ['businesses','subscriptions'].includes(section) ? 'plans' : null);
    const { data: recent } = useLoad(adminReq, section==='dashboard' ? 'activity' : null);
    const [search, setSearch] = useState('');
    const [showArchived, setShowArchived] = useState(false);
    const [editing, setEditing] = useState(null);
    const [plan, setPlan] = useState('free');
    const [status, setStatus] = useState('active');
    const [expiry, setExpiry] = useState('');
    const [trialExpiry, setTrialExpiry] = useState('');
    const [payOpen, setPayOpen] = useState(false);
    const [paymentFilter, setPaymentFilter] = useState('');
    const [paymentForm, setPaymentForm] = useState({
        tenant_id: '',
        amount: '',
        method: 'gcash',
        reference_no: '',
        status: 'pending',
        notes: '',
        period_start: '',
        period_end: ''
    });
    const [busyAdmin, setBusyAdmin] = useState(false);
    const [actionError, setActionError] = useState('');
    const [success, setSuccess] = useState('');
    const dateInput = (value) => value
        ? new Date(value).toISOString().slice(0, 16)
        : '';
    const dateIso = (value) => value
        ? new Date(value).toISOString()
        : null;
    const niceDate = (value) => value
        ? new Date(value).toLocaleDateString('en-PH', {
            year: 'numeric',
            month: 'short',
            day: 'numeric'
        })
        : 'Not set';
    const formatStatus = (value) => String(value || 'unknown')
        .replace(/_/g, ' ')
        .toUpperCase();
    const reload = () => {
        loadShops();
        loadOverview();
        loadPayments();
        loadMethods();
        setBillingRevision(value => value + 1);
    };
    const run = async (fn) => {
        setBusyAdmin(true);
        setActionError('');
        setSuccess('');
        try {
            await fn();
            reload();
            setSuccess('Changes saved successfully.');
        }
        catch (error) {
            setActionError(error.message || 'Request failed');
        }
        finally {
            setBusyAdmin(false);
        }
    };
    const visibleShops = (shops || []).filter((shop) => {
        const archiveMatch = showArchived || !shop.archived_at;
        const searchMatch = `
      ${shop.name}
      ${shop.slug}
      ${shop.plan_id}
    `
            .toLowerCase()
            .includes(search.toLowerCase());
        return archiveMatch && searchMatch;
    });
    const shownPayments = (payments || []).filter((payment) => !paymentFilter ||
        payment.tenant_id === paymentFilter);
    const openEdit = (shop) => {
        setEditing(shop);
        setPlan(shop.plan_id || 'free');
        setStatus(shop.subscription_status || 'active');
        setExpiry(dateInput(shop.current_period_ends_at));
        setTrialExpiry(dateInput(shop.trial_ends_at));
        setActionError('');
    };
    return (<>
            <Heading eyebrow="PLATFORM CONTROL" title={platformNavigation.find(row => row[0]===section)?.[1] || 'Super Admin'} action={<Button secondary onClick={reload}>
                        <ArrowRight size={16}/>
                        Refresh data
                    </Button>}/>

            {(overviewError ||
            shopsError ||
            paymentsError ||
            actionError) && (<div className="flash error">
                        <AlertTriangle size={17}/>
                        {overviewError ||
                shopsError ||
                paymentsError ||
                actionError}
                    </div>)}

            {success && (<div className="flash success">
                    <CheckCircle2 size={17}/>
                    {success}
                </div>)}

            <PlatformPage section={section} adminReq={adminReq} request={request} />
            {section==='dashboard' && <>

            <div className="metrics">
                <Metric label="Registered shops" val={overview?.shops || 0} icon={Store} tint="brown" foot="Non-archived shops"/>

                <Metric label="Active subscriptions" val={overview?.active_subscriptions || 0} icon={CheckCircle2} tint="sage" foot="Active or valid trial"/>

                <Metric label="Total collected" val={money(overview?.collected_cents || 0)} icon={Wallet} tint="peach" foot="Verified subscription payments"/>

                <Metric label="Collected this month" val={money(overview?.collected_this_month_cents || 0)} icon={CreditCard} tint="sand" foot="From paid billing records"/>
                <Metric label="Merchant customer payments" val={money(overview?.customer_gross_collected_cents || 0)}
                    icon={Receipt} tint="sage" foot="Completed POS transactions, not SaaS revenue"/>
                <Metric label="Merchant customer refunds" val={money(overview?.customer_refunds_cents || 0)}
                    icon={Wallet} tint="sand" foot="Cash refunds recorded by businesses"/>
            </div>

            <div className="metrics" style={{
            gridTemplateColumns: 'repeat(auto-fit,minmax(190px,1fr))'
        }}>
                <Metric label="Registered users" val={overview?.users || 0} icon={Users} tint="sage" foot="Platform accounts"/>

                <Metric label="Expiring in 7 days" val={overview?.expiring_soon || 0} icon={Clock} tint="peach" foot="Subscription renewals to review"/>

                <Metric label="Pending payments" val={overview?.pending_payments || 0} icon={Receipt} tint="sand" foot="Not counted as collected"/>
            </div>
                <Metric label="Active trials" val={overview?.active_trials || 0} icon={Clock} tint="sage" foot="Within the trial period" />
                <Panel title="Recent activity"><Table items={(recent || []).slice(0,8)} columns={[
                    ['created_at','When',fmt], ['actor','Actor'], ['action','Action'], ['target','Record']
                ]} /></Panel>
            </>}
            {section==='subscriptions' && <PlanChangeReview adminReq={adminReq} request={request} reloadPayments={loadPayments} revision={billingRevision} />}
            {section==='payments' && <PaymentMethodSettings methods={methods} request={request} reload={reload} />}

            {section==='businesses' && <>

            <Panel title="Registered businesses" right={<div className="inline-form" style={{
                alignItems: 'center',
                flexWrap: 'wrap'
            }}>
                        <Button onClick={() => setBusinessEditor({})}>Create business</Button>
                        <input aria-label="Search businesses" placeholder="Search business" value={search} onChange={(e) => setSearch(e.target.value)}/>

                        <label className="check" style={{
                margin: 0,
                whiteSpace: 'nowrap'
            }}>
                            <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)}/>
                            Show archived
                        </label>
                    </div>}>
                <Table items={visibleShops} columns={[
            [
                'name',
                'Business',
                (value, shop) => (<div>
                                    <strong>{value}</strong>

                                    <div className="muted tiny">
                                        {shop.slug}
                                    </div>
                                </div>)
            ],
            [
                'created_at',
                'Registered',
                niceDate
            ],
            [
                'plan_id',
                'Plan',
                (value) => String(value || '—').toUpperCase()
            ],
            [
                'subscription_expires_at',
                'Subscription expiry',
                (value) => (<span style={{
                        color: value &&
                            new Date(value) < new Date()
                            ? '#b74b45'
                            : undefined
                    }}>
                                    {niceDate(value)}
                                </span>)
            ],
            [
                'subscription_status',
                'Subscription',
                (value) => (<span className={'badge ' +
                        (value === 'active'
                            ? 'green'
                            : value === 'expired'
                                ? 'red'
                                : '')}>
                                    {formatStatus(value)}
                                </span>)
            ],
            [
                'paid_cents',
                'Subscription payments',
                (value) => money(value)
            ],
            ['customer_gross_collected_cents','POS customer payments',money],
            ['customer_refunds_cents','Customer refunds',money],
            ['customer_net_collected_cents','Net POS collected',money],
            [
                'status',
                'Shop status',
                (_, shop) => (<span className={'badge ' +
                        (shop.archived_at
                            ? 'red'
                            : shop.status === 'active'
                                ? 'green'
                                : '')}>
                                    {shop.archived_at
                        ? 'Archived'
                        : formatStatus(shop.status)}
                                </span>)
            ],
            [
                'id',
                'Manage',
                (_, shop) => (<div className="button-bar" style={{ gap: 6 }}>
                                    <button className="text-link" onClick={() => openEdit(shop)}>
                                        Manage
                                    </button>
                                    <button className="text-link" onClick={() => setBusinessEditor(shop)}>Edit profile</button>


                                    {shop.archived_at ? (<button className="text-link" disabled={busyAdmin} onClick={() => run(() => request('tenants/' +
                            shop.id +
                            '/restore', 'POST', {}, true))}>
                                            Restore
                                        </button>) : (<button className="text-link danger-link" disabled={busyAdmin} onClick={() => {
                            const confirmation = window.prompt(`PERMANENT DELETE: ${shop.name}\n\n` +
                                `WARNING: This will permanently remove the shop, ` +
                                `its transactions, inventory, and subscription records.\n\n` +
                                `Owner and staff accounts used exclusively by this ` +
                                `shop will also be deleted, including their registered emails.\n\n` +
                                `This action CANNOT be undone.\n\n` +
                                `Type the EXACT shop name to confirm:`);
                            if (confirmation !== null) {
                                run(() => request('tenants/' + shop.id, 'DELETE', { confirmation }, true));
                            }
                        }}>
                                            Delete
                                        </button>)}
                                </div>)
            ]
        ]}/>
            </Panel>

                {businessEditor && <BusinessEditor business={businessEditor} adminReq={adminReq} request={request}
                    close={() => setBusinessEditor(null)} saved={reload} />}
            </>}
            {section==='payments' && <>

            <Panel title="Subscription payment tracking" right={<div className="inline-form" style={{
                alignItems: 'center'
            }}>
                        <select value={paymentFilter} onChange={(e) => setPaymentFilter(e.target.value)}>
                            <option value="">
                                All shops
                            </option>

                            {(shops || []).map((shop) => (<option key={shop.id} value={shop.id}>
                                    {shop.name}
                                </option>))}
                        </select>

                        <Button onClick={() => {
                setPaymentForm({
                    tenant_id: paymentFilter || '',
                    amount: '',
                    method: 'gcash',
                    reference_no: '',
                    status: 'pending',
                    notes: '',
                    period_start: '',
                    period_end: ''
                });
                setPayOpen(true);
                setActionError('');
            }}>
                            <Plus size={16}/>
                            Record payment
                        </Button>
                    </div>}>
                <div className="padded" style={{
            fontSize: 12,
            color: '#858782'
        }}>
                    These records are for SaaS subscription
                    payments, not café POS sales.
                    Only confirmed paid payments count
                    toward collections. Recording a payment
                    does not automatically activate or renew
                    a subscription.
                </div>

                <Table items={shownPayments} columns={[
            ['shop_name', 'Shop'],
            [
                'created_at',
                'Recorded',
                niceDate
            ],
            ['plan_id', 'Plan'],
            [
                'amount_cents',
                'Amount',
                money
            ],
            ['method_name','Method'],
            ['reference_no','Request reference'],
            ['stage','Status', (stage, payment) => <span className={'badge ' +
                (payment.status === 'paid' ? 'green' : payment.status === 'failed' ? 'red' : '')}>
                {paymentStageLabel[stage] || stage}
            </span>],
            [
                'paid_at',
                'Paid date',
                niceDate
            ],
            ['id','Action', (_, payment) => (payment.status === 'pending' || payment.submitted_at || payment.review_note)
                ? <Button secondary disabled={busyAdmin} onClick={() => setPaymentReview(payment)}>Review payment</Button>
                : '—']

        ]}/>
            </Panel>

            </>}
            {paymentReview && <PaymentReview key={paymentReview.id} payment={paymentReview} request={request}
                onClose={() => setPaymentReview(null)} onSaved={() => { setPaymentReview(null); reload(); }} />}

            {/* SHOP SUBSCRIPTION MANAGEMENT */}

            {editing && (<Modal title={'Manage ' + editing.name} onClose={() => setEditing(null)}>
                    <div className="modal-body">
                        <div className="sub-row">
                            <span>Registered</span>
                            <b>{niceDate(editing.created_at)}</b>
                        </div>

                        <div className="sub-row">
                            <span>Payments received</span>
                            <b>{money(editing.paid_cents)}</b>
                        </div>

                        <Field label="Subscription plan">
                            <select value={plan} onChange={(e) => setPlan(e.target.value)}>
                                {platformPlans?.map(option => <option key={option.id} value={option.id}>{option.title}</option>)}
                            </select>
                        </Field>

                        <Field label="Subscription status">
                            <select value={status} onChange={(e) => setStatus(e.target.value)}>
                                {[
                'trial',
                'active',
                'past_due',
                'expired',
                'cancelled'
            ].map((value) => (<option key={value} value={value}>
                                        {formatStatus(value)}
                                    </option>))}
                            </select>
                        </Field>

                        <Field label="Subscription expiration (paid period)">
                            <input type="datetime-local" value={expiry} onChange={(e) => setExpiry(e.target.value)}/>
                        </Field>

                        <Field label="Trial expiration">
                            <input type="datetime-local" value={trialExpiry} onChange={(e) => setTrialExpiry(e.target.value)}/>
                        </Field>

                        <Button disabled={busyAdmin} onClick={() => run(async () => {
                await request('subscriptions/' + editing.id, 'PATCH', {
                    plan_id: plan,
                    status,
                    current_period_ends_at: dateIso(expiry),
                    trial_ends_at: dateIso(trialExpiry)
                }, true);
                setEditing(null);
            })}>
                            Save subscription
                        </Button>

                        {!editing.archived_at && (<Button secondary disabled={busyAdmin} onClick={() => run(async () => {
                    await request('tenants/' + editing.id, 'PATCH', {
                        status: editing.status === 'active'
                            ? 'suspended'
                            : 'active'
                    }, true);
                    setEditing(null);
                })}>
                                {editing.status === 'active'
                    ? 'Suspend shop'
                    : 'Reactivate shop'}
                            </Button>)}

                        {editing.archived_at && (<Button secondary disabled={busyAdmin} onClick={() => run(async () => {
                    await request('tenants/' +
                        editing.id +
                        '/restore', 'POST', {}, true);
                    setEditing(null);
                })}>
                                Restore archived shop (suspended)
                            </Button>)}

                        <p className="muted">
                            Archive removes the shop from the
                            active list without destroying POS
                            sales or billing records.
                        </p>
                    </div>
                </Modal>)}

            {/* RECORD SUBSCRIPTION PAYMENT */}

            {payOpen && (<Modal title="Record subscription payment" onClose={() => setPayOpen(false)}>
                    <div className="modal-body">
                        <p className="muted">
                            Enter a payment only after checking
                            your actual bank, e-wallet, or cash
                            records. A pending record is not
                            counted as revenue.
                        </p>

                        <Field label="Business">
                            <select value={paymentForm.tenant_id} onChange={(e) => setPaymentForm((form) => ({
                ...form,
                tenant_id: e.target.value
            }))}>
                                <option value="">
                                    Select a shop
                                </option>

                                {(shops || [])
                .filter((shop) => !shop.archived_at)
                .map((shop) => (<option key={shop.id} value={shop.id}>
                                            {shop.name} — {shop.plan_id}
                                        </option>))}
                            </select>
                        </Field>

                        <Field label="Amount (PHP)">
                            <input type="number" min="0.01" step="0.01" value={paymentForm.amount} onChange={(e) => setPaymentForm((form) => ({
                ...form,
                amount: e.target.value
            }))}/>
                        </Field>

                        <Field label="Payment method">
                            <select value={paymentForm.method} onChange={(e) => setPaymentForm((form) => ({
                ...form,
                method: e.target.value
            }))}>
                                {methods?.map(method => <option key={method.id} value={method.id}>{method.name}</option>)}
                            </select>
                        </Field>

                        <Field label="Reference / transaction number">
                            <input value={paymentForm.reference_no} onChange={(e) => setPaymentForm((form) => ({
                ...form,
                reference_no: e.target.value
            }))}/>
                        </Field>

                        <Field label="Payment status">
                            <select value={paymentForm.status} onChange={(e) => setPaymentForm((form) => ({
                ...form,
                status: e.target.value
            }))}>
                                <option value="pending">
                                    Pending / not verified
                                </option>


                                <option value="failed">
                                    Failed
                                </option>
                            </select>
                        </Field>

                        <div className="form-grid">
                            <Field label="Billing period start (optional)">
                                <input type="date" value={paymentForm.period_start} onChange={(e) => setPaymentForm((form) => ({
                ...form,
                period_start: e.target.value
            }))}/>
                            </Field>

                            <Field label="Billing period end (optional)">
                                <input type="date" value={paymentForm.period_end} onChange={(e) => setPaymentForm((form) => ({
                ...form,
                period_end: e.target.value
            }))}/>
                            </Field>
                        </div>

                        <Field label="Notes">
                            <textarea value={paymentForm.notes} onChange={(e) => setPaymentForm((form) => ({
                ...form,
                notes: e.target.value
            }))}/>
                        </Field>

                        <Button disabled={busyAdmin} onClick={() => run(async () => {
                await request('payments', 'POST', {
                    tenant_id: paymentForm.tenant_id,
                    amount_cents: pesos(paymentForm.amount),
                    method: paymentForm.method,
                    reference_no: paymentForm.reference_no,
                    status: paymentForm.status,
                    notes: paymentForm.notes,
                    period_start: paymentForm.period_start || null,
                    period_end: paymentForm.period_end || null
                }, true);
                setPayOpen(false);
            })}>
                            Save payment record
                        </Button>
                    </div>
                </Modal>)}
        </>);
}
document.title = 'StratifyPOS Workspace';
registerSW({ immediate: true });
createRoot(document.getElementById('root')).render(<App />);
