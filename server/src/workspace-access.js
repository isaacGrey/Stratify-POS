export const modules = ['overview','pos','products','inventory','purchasing','orders','reports','staff','attendance','branches','promotions','settings','billing','audit','kitchen','menu','services','appointments'];
const defaultModules = {
    owner: modules,
    manager: modules,
    cashier: ['pos','orders','attendance','kitchen','services','appointments'],
    staff: ['attendance','kitchen']
};
const workspaceWide = ['staff','settings','billing','audit'];

export function moduleAccess(row) {
    const defaults = defaultModules[row.role] || [];
    return Object.fromEntries(modules.map(key => [key,
        (row.module_permissions?.[key] ?? row.role_permissions?.[key] ?? defaults.includes(key)) &&
        row.module_access?.[key] !== false && row.module_overrides?.[key] !== false &&
        !(row.branch_ids !== null && row.branch_ids !== undefined && workspaceWide.includes(key))
    ]));
}

export function validPermissions(value) {
    return value && typeof value === 'object' && !Array.isArray(value) &&
        Object.entries(value).every(([key, allowed]) => modules.includes(key) && typeof allowed === 'boolean');
}

export function canUseRoute(path, method, access, branchIds) {
    const [, resource, key, action] = path.split('/');
    const read = method === 'GET' || method === 'HEAD';
    const allow = (...keys) => keys.some(key => access[key]);
    const fullWorkspace = branchIds === null;
    switch (resource) {
        case 'checkout':
        case 'offline':
        case 'register':
        case 'holds': return allow('pos');
        case 'kitchen': return allow('kitchen');
        case 'appointments': return allow('appointments');
        case 'business-type': return allow('settings') && fullWorkspace;
        case 'inventory-reports': return allow('inventory','reports');
        case 'attendance-reports': return allow('staff','attendance');
        case 'menu':
            if (key==='policy' || key==='links') return allow('menu');
            if (key==='requests') return allow('pos');
            return false;
        case 'service-plans':
        case 'service-entitlements': return allow('services') && (read || fullWorkspace);
        case 'service-customers':
            return allow('services') && (read || fullWorkspace || (method==='POST' && allow('pos')));
        case 'purchases': return allow('purchasing');
        case 'overview': return allow('overview');
        case 'orders': return allow('orders');
        case 'products':
        case 'categories':
        case 'addons':
            if (action === 'recipe') return allow('products','promotions') && (read || fullWorkspace);
            return read ? allow('products','pos',...(resource === 'addons' ? ['promotions'] : [])) : fullWorkspace && allow('products');
        case 'ingredients':
            return read ? allow('inventory','products','promotions') : fullWorkspace && allow('inventory');
        case 'stock': return allow('inventory') && (read || key !== 'branch-mode' || fullWorkspace);
        case 'expenses':
        case 'suppliers': return allow('inventory') && (fullWorkspace || resource === 'expenses' || read);
        case 'reports': return allow('reports');
        case 'staff': return allow('staff');
        case 'attendance': return allow('attendance');
        case 'branches':
            if (action === 'schedule') return allow('branches');
            if (read) return allow('branches','pos','inventory','reports','staff','attendance','promotions');
            return (key || fullWorkspace) && allow('branches');
        case 'tables':
            return read || action === 'status' ? allow('pos','branches') : allow('branches');
        case 'promotions':
            return read ? allow('promotions','pos') : fullWorkspace && allow('promotions');
        case 'loyalty': return fullWorkspace && allow('promotions');
        case 'settings': return read ? allow('settings','pos') : allow('settings');
        case 'subscription': return allow('billing');
        case 'audit': return allow('audit');
        default: return false;
    }
}
