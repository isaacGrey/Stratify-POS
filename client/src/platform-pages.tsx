import { useEffect, useState } from 'react';
import type { ApiRequest } from './types';
import { Button, Field, Load, Modal, Panel, Table, fmt, money, pesos, useLoad } from './ui';

export const moduleLabels = {
    overview: 'Dashboard', pos: 'Point of sale', kitchen: 'Kitchen display', menu: 'Customer QR menus', products: 'Products', inventory: 'Inventory', purchasing: 'Purchasing and suppliers',
    orders: 'Transactions', reports: 'Reports', staff: 'Team management', attendance: 'Attendance',
    branches: 'Branches and tables', promotions: 'Promotions', settings: 'Shop settings', billing: 'Billing', audit: 'Activity'
};

export function PermissionFields({ value, onChange, inherited = 'Default' }) {
    return <div className="form-grid">
        {Object.entries(moduleLabels).map(([key, name]) => <Field label={name} key={key}>
            <select value={value[key] === undefined ? '' : String(value[key])} onChange={event => {
                const next = { ...value };
                if (!event.target.value) delete next[key];
                else next[key] = event.target.value === 'true';
                onChange(next);
            }}>
                <option value="">{inherited}</option><option value="true">Allow</option><option value="false">Block</option>
            </select>
        </Field>)}
    </div>;
}

function useSave(request: ApiRequest) {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    async function save(path, method, body, done) {
        if (busy) return;
        setBusy(true);
        setError('');
        try { const result = await request(path, method, body, true); done?.(result); }
        catch (error) { setError(error.message || 'Changes could not be saved.'); }
        finally { setBusy(false); }
    }
    return { save, busy, error, clear: () => setError('') };
}

const errorText = error => error && <p className="flash error" role="alert">{error}</p>;
const userState = user => user.archived_at ? 'Archived' : user.suspended_at ? 'Suspended' : user.active ? 'Active' : 'Deactivated';
const localDateTime = value => {
    if (!value) return '';
    const time = new Date(value);
    return new Date(time.getTime() - time.getTimezoneOffset() * 60_000).toISOString().slice(0,16);
};

function usePage(adminReq, resource) {
    const [page, setPage] = useState(0);
    const [search, setSearch] = useState('');
    const state = useLoad(adminReq, resource + '?offset=' + page * 50 + '&q=' + encodeURIComponent(search));
    return { ...state, page, setPage, search, setSearch: value => { setSearch(value); setPage(0); } };
}

function Pagination({ page, setPage, more }) {
    return <div className="inline-form padded">
        <Button secondary disabled={page===0} onClick={() => setPage(page-1)}>Previous</Button>
        <span>Page {page+1}</span>
        <Button secondary disabled={!more} onClick={() => setPage(page+1)}>Next</Button>
    </div>;
}

function UsersPage({ adminReq, request }) {
    const page = usePage(adminReq,'users');
    const [form,setForm] = useState(null);
    const action = useSave(request);
    const change = (key,value) => setForm({ ...form,[key]:value });
    const finish = () => { setForm(null); page.load(); };
    return <Panel title="Platform users" right={<Button onClick={() => {
        action.clear(); setForm({ name:'', email:'', password:'', state:'' });
    }}>Create user</Button>}>
        <div className="padded"><input aria-label="Search users" placeholder="Search name or email" value={page.search} onChange={e => page.setSearch(e.target.value)} /></div>
        {errorText(page.err)}
        {page.data ? <Table items={page.data} columns={[
            ['name','Name'], ['email','Email'], ['active','State',(_,row) => userState(row)], ['workspaces','Workspaces'],
            ['id','Action',(_,row) => row.platform_admin ? 'Super Admin' : <button className="text-link" onClick={() => {
                action.clear(); setForm({ ...row,state:'' });
            }}>Manage</button>]
        ]} /> : !page.err && <Load />}
        <Pagination {...page} more={page.data?.length===50} />
        {form && <Modal title={form.id ? 'Manage user' : 'Create user'} onClose={() => setForm(null)}><div className="modal-body">
            <Field label="Name"><input value={form.name} onChange={e => change('name',e.target.value)} /></Field>
            <Field label="Email"><input type="email" value={form.email} onChange={e => change('email',e.target.value)} /></Field>
            {!form.id ? <Field label="Initial password"><input type="password" autoComplete="new-password" value={form.password} onChange={e => change('password',e.target.value)} /></Field> :
                <Field label="Account state"><select value={form.state} onChange={e => change('state',e.target.value)}>
                    <option value="">Keep current state</option><option value="active">Activate or restore</option>
                    <option value="suspended">Suspend</option><option value="deactivated">Deactivate</option><option value="archived">Archive</option>
                </select></Field>}
            {errorText(action.error)}
            <div className="inline-form">
                <Button disabled={action.busy} onClick={() => action.save(form.id ? 'users/'+form.id : 'users',form.id ? 'PATCH' : 'POST',
                    { name:form.name,email:form.email,password:form.password,state:form.state || undefined },finish)}>Save user</Button>
                {form.id && !form.active && <Button secondary disabled={action.busy} onClick={() => {
                    const confirmation = window.prompt('Enter the exact email address to permanently delete this account.');
                    if (confirmation !== null) void action.save('users/'+form.id,'DELETE',{ confirmation },finish);
                }}>Delete account</Button>}
            </div>
        </div></Modal>}
    </Panel>;
}

export function BusinessEditor({ business, adminReq, request, close, saved }) {
    const { data: plans } = useLoad(adminReq, business.id ? null : 'plans');
    const [form,setForm] = useState({ name:business.name || '', state:'', owner_email:'',
        plan_id:'free', status:'trial', period_end:'' });
    const action = useSave(request);
    const change = (key,value) => setForm({ ...form,[key]:value });
    return <Modal title={business.id ? 'Edit business' : 'Create business'} onClose={close}><div className="modal-body">
        <Field label="Business name"><input value={form.name} onChange={e => change('name',e.target.value)} /></Field>
        {business.id ? <Field label="Business state"><select value={form.state} onChange={e => change('state',e.target.value)}>
            <option value="">Keep current state</option><option value="active">Activate or restore</option>
            <option value="suspended">Suspend</option><option value="deactivated">Deactivate</option><option value="archived">Archive</option>
        </select></Field> : <>
            <Field label="Existing owner account email"><input type="email" value={form.owner_email} onChange={e => change('owner_email',e.target.value)} /></Field>
            <Field label="Subscription"><select value={form.plan_id} onChange={e => {
                setForm({ ...form,plan_id:e.target.value,status:e.target.value==='free' ? 'trial' : 'expired' });
            }}>{plans?.filter(plan => plan.active).map(plan => <option value={plan.id} key={plan.id}>{plan.title}</option>)}</select></Field>
            {form.plan_id !== 'free' && <Field label="Initial subscription status"><select value={form.status} onChange={e => change('status',e.target.value)}>
                <option value="expired">Awaiting payment</option><option value="active">Active</option>
            </select></Field>}
            {form.status === 'active' && <Field label="Period ends"><input type="datetime-local" value={form.period_end} onChange={e => change('period_end',e.target.value)} /></Field>}
        </>}
        {errorText(action.error)}
        <Button disabled={action.busy || !form.name.trim()} onClick={() => action.save(
            business.id ? 'tenants/'+business.id+'/profile' : 'tenants', business.id ? 'PUT' : 'POST',
            { ...form,state:form.state || undefined,period_end:form.period_end ? new Date(form.period_end).toISOString() : null },
            () => { close(); saved(); }
        )}>Save business</Button>
    </div></Modal>;
}

function PlansPage({ adminReq, request, trial = false }) {
    const { data, load, err } = useLoad(adminReq,'plans');
    const [form,setForm] = useState(null);
    const action = useSave(request);
    function open(plan = null) {
        action.clear();
        setForm(plan ? { ...plan, existing:true,price:plan.price_cents/100 } :
            { id:'', title:'', price:'', max_branches:1, max_staff:5, trial_days:0, active:true });
    }
    const change = (key,value) => setForm({ ...form,[key]:value });
    return <Panel title={trial ? 'Trial eligibility and duration' : 'Subscription plans'} right={!trial && <Button onClick={() => open()}>Create plan</Button>}>
        {trial && <p className="padded">New businesses can start a trial while the free plan is enabled and its duration is above zero.</p>}
        {errorText(err)}
        {data ? <Table items={data.filter(plan => !trial || plan.id==='free')} columns={[
            ['title','Plan'], ['price_cents','Monthly price',money], ['max_branches','Branches'], ['max_staff','Team accounts'],
            ['trial_days','Trial days'], ['active','Available', value => value ? 'Yes' : 'No'],
            ['id','Action',(_,row) => <button className="text-link" onClick={() => open(row)}>Edit plan</button>]
        ]} /> : !err && <Load />}
        {form && <Modal title={form.existing ? 'Edit ' + form.title : 'Create plan'} onClose={() => setForm(null)}><div className="modal-body">
            <div className="form-grid">
                <Field label="Plan ID"><input maxLength={40} disabled={form.existing} value={form.id} onChange={e => change('id',e.target.value.toLowerCase())} /></Field>
                <Field label="Plan name"><input value={form.title} onChange={e => change('title',e.target.value)} /></Field>
                <Field label="Monthly price (PHP)"><input type="number" min="0" step=".01" value={form.price} disabled={form.id==='free'} onChange={e => change('price',e.target.value)} /></Field>
                <Field label="Branches"><input type="number" min="1" value={form.max_branches} onChange={e => change('max_branches',e.target.value)} /></Field>
                <Field label="Team accounts"><input type="number" min="1" value={form.max_staff} onChange={e => change('max_staff',e.target.value)} /></Field>
                {form.id==='free' && <Field label="Trial duration (days)"><input type="number" min="0" max="365" value={form.trial_days} onChange={e => change('trial_days',e.target.value)} /></Field>}
            </div>
            <label className="check"><input type="checkbox" checked={form.active} onChange={e => change('active',e.target.checked)} /> Available to new customers</label>
            {errorText(action.error)}
            <Button disabled={action.busy} onClick={() => action.save(form.existing ? 'plans/'+form.id : 'plans',form.existing ? 'PUT' : 'POST',
                { ...form,price_cents:pesos(form.price),max_branches:Number(form.max_branches),max_staff:Number(form.max_staff),trial_days:Number(form.trial_days) },
                () => { setForm(null); load(); })}>Save plan</Button>
        </div></Modal>}
    </Panel>;
}

function AccessPage({ adminReq,request }) {
    const page = usePage(adminReq,'access');
    const [form,setForm] = useState(null);
    const action = useSave(request);
    function edit(row, resource) {
        action.clear();
        setForm({ id:row.id,name:row.title || row.name,resource, modules:row.module_access || row.module_overrides || {} });
    }
    return <>
        <Panel title="Plan entitlements">
            {errorText(page.err)}
            <Table items={page.data?.plans || []} columns={[
                ['title','Plan'], ['module_access','Blocked modules',value => Object.entries(value).filter(([,allowed]) => !allowed).map(([key]) => moduleLabels[key]).join(', ') || 'None'],
                ['id','Action',(_,row) => <button className="text-link" onClick={() => edit(row,'plans')}>Edit entitlements</button>]
            ]} />
        </Panel>
        <Panel title="Business overrides">
            <div className="padded"><input aria-label="Find business" placeholder="Find business" value={page.search} onChange={e => page.setSearch(e.target.value)} /></div>
            <Table items={page.data?.businesses || []} columns={[
                ['name','Business'], ['plan_id','Plan'],
                ['id','Action',(_,row) => <button className="text-link" onClick={() => edit(row,'tenants')}>Edit overrides</button>]
            ]} />
            <Pagination {...page} more={page.data?.businesses.length===50} />
        </Panel>
        {form && <Modal title={form.name + ' module access'} onClose={() => setForm(null)}><div className="modal-body">
            <PermissionFields value={form.modules} onChange={modules => setForm({ ...form,modules })} inherited={form.resource==='tenants' ? 'Use plan' : 'Enabled'} />
            {errorText(action.error)}
            <Button disabled={action.busy} onClick={() => action.save(form.resource+'/'+form.id+'/modules','PUT',{ modules:form.modules },
                () => { setForm(null); page.load(); })}>Save access</Button>
        </div></Modal>}
    </>;
}

function BranchOversight({ adminReq,request }) {
    const page = usePage(adminReq,'branches');
    const action = useSave(request);
    return <Panel title="All branch locations">
        <div className="padded"><input aria-label="Search branches" placeholder="Search business or branch" value={page.search} onChange={e => page.setSearch(e.target.value)} /></div>
        {errorText(page.err || action.error)}
        <Table items={page.data || []} columns={[
            ['business','Business'], ['name','Branch'], ['address','Address'], ['time_zone','Time zone'],
            ['active','State',value => value ? 'Active' : 'Inactive'],
            ['id','Action',(_,row) => <Button secondary disabled={action.busy || !!row.archived_at}
                onClick={() => action.save('branches/'+row.id,'PATCH',{ active:!row.active },page.load)}>{row.active ? 'Disable' : 'Enable'}</Button>]
        ]} />
        <Pagination {...page} more={page.data?.length===50} />
    </Panel>;
}

function ActivityPage({ adminReq }) {
    const page = usePage(adminReq,'activity');
    return <Panel title="Platform activity">
        <div className="padded"><input aria-label="Filter activity" placeholder="Filter action or record ID" value={page.search} onChange={e => page.setSearch(e.target.value)} /></div>
        {errorText(page.err)}
        <Table items={page.data || []} columns={[
            ['created_at','When',fmt], ['actor','Actor'], ['action','Action'], ['target','Record'],
            ['details','Details',value => Object.keys(value || {}).length ? JSON.stringify(value) : '—']
        ]} />
        <Pagination {...page} more={page.data?.length===50} />
    </Panel>;
}

function SystemSettings({ adminReq,request }) {
    const { data, load, err } = useLoad(adminReq,'system-settings');
    const [form,setForm] = useState(null);
    const action = useSave(request);
    const [saved,setSaved] = useState(false);
    useEffect(() => { if (data) setForm(data); },[data]);
    return <><Panel title="Platform settings">{errorText(err || action.error)}{form && <div className="settings-form padded">
        <Field label="Public product name"><input maxLength={80} value={form.public_name} onChange={e => setForm({ ...form,public_name:e.target.value })} /></Field>
        <Field label="Support email"><input type="email" value={form.support_email} onChange={e => setForm({ ...form,support_email:e.target.value })} /></Field>
        <Button disabled={action.busy} onClick={() => {
            setSaved(false);
            void action.save('system-settings','PUT',form,() => { setSaved(true); load(); });
        }}>Save platform settings</Button>
        {saved && <p role="status">Settings saved.</p>}
    </div>}</Panel><InquiryInbox adminReq={adminReq} request={request} /></>;
}

function InquiryInbox({ adminReq,request }) {
    const page = usePage(adminReq,'inquiries');
    const [open,setOpen] = useState(null);
    const action = useSave(request);
    return <Panel title="Website inquiries">
        <div className="padded"><input aria-label="Search inquiries" placeholder="Search name, email, or business"
            value={page.search} onChange={e => page.setSearch(e.target.value)} /></div>
        {errorText(page.err)}
        <Table items={page.data || []} columns={[
            ['created_at','Received',fmt], ['name','Name'], ['business','Business'], ['email','Email'],
            ['resolved_at','Status',value => value ? 'Resolved' : 'Open'],
            ['id','Action',(_,row) => <button className="text-link" onClick={() => { action.clear(); setOpen(row); }}>Read inquiry</button>]
        ]} />
        <Pagination {...page} more={page.data?.length===50} />
        {open && <Modal title={'Inquiry from '+open.name} onClose={() => setOpen(null)}><div className="modal-body">
            <p><a href={'mailto:'+open.email}>{open.email}</a></p>
            <p style={{ whiteSpace:'pre-wrap',overflowWrap:'anywhere' }}>{open.message}</p>
            {errorText(action.error)}
            <Button disabled={action.busy} onClick={() => action.save('inquiries/'+open.id,'PATCH',
                { resolved:!open.resolved_at },() => { setOpen(null); page.load(); })}>
                {open.resolved_at ? 'Reopen inquiry' : 'Mark resolved'}
            </Button>
        </div></Modal>}
    </Panel>;
}

function SubscriptionPromotions({ adminReq,request }) {
    const { data,load,err } = useLoad(adminReq,'subscription-promotions');
    const { data: plans } = useLoad(adminReq,'plans');
    const [form,setForm] = useState(null);
    const action = useSave(request);
    function open(row = null) {
        action.clear();
        setForm(row ? { ...row, code:row.code || '',plan_id:row.plan_id || '',
            value:row.kind==='fixed' ? row.value/100 : row.value,
            starts_at:localDateTime(row.starts_at),expires_at:localDateTime(row.expires_at) } :
            { name:'',code:'',plan_id:'',kind:'percent',value:'',starts_at:'',expires_at:'',active:true });
    }
    const change = (key,value) => setForm({ ...form,[key]:value });
    return <Panel title="Subscription promotions" right={<Button onClick={() => open()}>Create promotion</Button>}>
        {errorText(err)}
        <Table items={data || []} columns={[
            ['name','Promotion'], ['code','Code',value => value || 'Automatic'], ['plan_id','Plan',value => value || 'All paid plans'],
            ['value','Discount',(value,row) => row.kind==='fixed' ? money(value) : value+'%'],
            ['expires_at','Ends',fmt], ['active','State',value => value ? 'Enabled' : 'Disabled'],
            ['id','Action',(_,row) => <button className="text-link" onClick={() => open(row)}>Edit</button>]
        ]} />
        {form && <Modal title={form.id ? 'Edit promotion' : 'Create promotion'} onClose={() => setForm(null)}><div className="modal-body">
            <Field label="Promotion name"><input value={form.name} onChange={e => change('name',e.target.value)} /></Field>
            <Field label="Discount code (blank for automatic pricing)"><input maxLength={40} value={form.code} onChange={e => change('code',e.target.value)} /></Field>
            <Field label="Eligible plan"><select value={form.plan_id} onChange={e => change('plan_id',e.target.value)}>
                <option value="">All paid plans</option>{plans?.filter(plan => plan.id!=='free').map(plan => <option key={plan.id} value={plan.id}>{plan.title}</option>)}
            </select></Field>
            <div className="form-grid">
                <Field label="Discount type"><select value={form.kind} onChange={e => change('kind',e.target.value)}><option value="percent">Percentage</option><option value="fixed">Fixed amount</option></select></Field>
                <Field label={form.kind==='fixed' ? 'Amount (PHP)' : 'Percent'}><input type="number" min="0" step={form.kind==='fixed' ? '.01' : '1'} value={form.value} onChange={e => change('value',e.target.value)} /></Field>
                <Field label="Starts"><input type="datetime-local" value={form.starts_at} onChange={e => change('starts_at',e.target.value)} /></Field>
                <Field label="Expires"><input type="datetime-local" value={form.expires_at} onChange={e => change('expires_at',e.target.value)} /></Field>
            </div>
            <label className="check"><input type="checkbox" checked={form.active} onChange={e => change('active',e.target.checked)} /> Enabled</label>
            {errorText(action.error)}
            <Button disabled={action.busy} onClick={() => action.save(form.id ? 'subscription-promotions/'+form.id : 'subscription-promotions',form.id ? 'PUT' : 'POST',
                { ...form,plan_id:form.plan_id || null,value:form.kind==='fixed' ? pesos(form.value) : Number(form.value),
                    starts_at:form.starts_at ? new Date(form.starts_at).toISOString() : null, expires_at:form.expires_at ? new Date(form.expires_at).toISOString() : null },
                () => { setForm(null); load(); })}>Save promotion</Button>
        </div></Modal>}
    </Panel>;
}

function BackupsPage({ adminReq,request }) {
    const { data,load,err } = useLoad(adminReq,'backups');
    const [form,setForm] = useState(null);
    const [confirm,setConfirm] = useState(null);
    const [typed,setTyped] = useState('');
    const [message,setMessage] = useState('');
    const action = useSave(request);
    useEffect(() => { if (data) setForm(current => current ?? data.settings); },[data]);
    useEffect(() => {
        const timer = window.setInterval(load,5000);
        return () => window.clearInterval(timer);
    },[load]);
    const workerOnline = data?.settings.worker_heartbeat &&
        Date.now()-Date.parse(data.settings.worker_heartbeat)<90000;
    const change = (key,value) => setForm({ ...form,[key]:value });
    function download(id) {
        void action.save('backups/'+id+'/download','GET',undefined,file => {
            if (!(file instanceof Blob)) { setMessage('The archive download could not be opened.'); return; }
            const url = URL.createObjectURL(file);
            const link = document.createElement('a');
            link.href = url;
            link.download = 'stratifypos-'+id+'.dump.enc';
            document.body.append(link);
            link.click();
            link.remove();
            window.setTimeout(() => URL.revokeObjectURL(url),30000);
        });
    }
    function openConfirmation(job,kind) {
        action.clear(); setTyped(''); setConfirm({ job,kind });
    }
    const phrase = confirm?.kind==='restore' ? 'RESTORE TO EMPTY TARGET' : 'DELETE BACKUP';
    return <>
        {errorText(err || (!confirm && action.error))}
        {message && <p className="flash success" role="status">{message}</p>}
        <Panel title="Backup status" right={<Button disabled={!data?.storage_available || action.busy}
            onClick={() => action.save('backups','POST',{},() => { setMessage('Backup queued.'); load(); })}>Create backup</Button>}>
            {!data ? <Load /> : <div className="padded">
                <p>Encrypted storage: {data.storage_available ? 'Available' : 'Unavailable'}</p>
                <p>Backup worker: {workerOnline ? 'Online' : 'No recent heartbeat'}</p>
                <p>Recovery target: {data.restore_configured ? 'Configured' : 'Unconfigured'}</p>
                <p>Email notifications: {data.notifications_configured ? 'Configured' : 'Unconfigured'}</p>
                {data.maintenance && <p role="status">Recovery maintenance is active.</p>}
            </div>}
        </Panel>
        {form && <Panel title="Schedule and retention"><div className="settings-form padded">
            <label className="check"><input type="checkbox" checked={form.enabled} onChange={e => change('enabled',e.target.checked)} /> Enable scheduled backups</label>
            <div className="form-grid">
                <Field label="Frequency"><select value={form.frequency} onChange={e => change('frequency',e.target.value)}>
                    <option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option>
                </select></Field>
                <Field label="Hour (UTC)"><input type="number" min="0" max="23" value={form.hour_utc} onChange={e => change('hour_utc',e.target.value)} /></Field>
                {form.frequency==='weekly' && <Field label="Weekday (UTC)"><select value={form.weekday_utc} onChange={e => change('weekday_utc',e.target.value)}>
                    {['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'].map((day,index) => <option key={day} value={index}>{day}</option>)}
                </select></Field>}
                {form.frequency==='monthly' && <Field label="Day of month (1–28)"><input type="number" min="1" max="28" value={form.month_day_utc} onChange={e => change('month_day_utc',e.target.value)} /></Field>}
                <Field label="Retain backups (days)"><input type="number" min="1" max="3650" value={form.retention_days} onChange={e => change('retention_days',e.target.value)} /></Field>
            </div>
            <Button disabled={action.busy || (form.enabled && !data?.storage_available)} onClick={() => action.save('backups/settings','PUT',{
                ...form,hour_utc:Number(form.hour_utc),weekday_utc:Number(form.weekday_utc),
                month_day_utc:Number(form.month_day_utc),retention_days:Number(form.retention_days)
            },saved => { setForm(saved); setMessage('Backup schedule saved.'); load(); })}>Save schedule</Button>
        </div></Panel>}
        <Panel title="Backup and recovery history">
            <Table items={data?.jobs || []} columns={[
                ['kind','Job'], ['created_at','Requested',fmt], ['finished_at','Finished',fmt],
                ['status','Status',(value,row) => row.deleted_at ? 'Archive removed' : row.delete_requested_at ? 'Removal queued' : value],
                ['size_bytes','Size',value => value ? (Number(value)/1048576).toFixed(2)+' MiB' : '—'],
                ['error','Result',(value,row) => value || (row.kind==='restore' && row.status==='succeeded'
                    ? 'Verified ' + row.result.businesses + ' businesses, ' + row.result.orders + ' orders and ' + row.result.payment_receipts + ' receipts' : '—')],
                ['notification_status','Email'],
                ['id','Actions',(_,row) => row.kind==='restore' && row.status==='queued'
                    ? <button className="text-link" onClick={() => action.save('backups/'+row.id+'/cancel-restore','POST',{},
                        () => { setMessage('Recovery canceled.'); load(); })}>Cancel recovery</button>
                    : row.kind==='backup' && row.status==='succeeded' && !row.deleted_at && !row.delete_requested_at
                        ? <div className="inline-form">
                            <button className="text-link" disabled={action.busy} onClick={() => download(row.id)}>Download encrypted archive</button>
                            <button className="text-link" disabled={action.busy || !data?.restore_configured || data?.maintenance}
                                onClick={() => openConfirmation(row,'restore')}>Verify recovery</button>
                            <button className="text-link" disabled={action.busy} onClick={() => openConfirmation(row,'delete')}>Remove archive</button>
                        </div> : '—']
            ]} />
        </Panel>
        {confirm && <Modal title={confirm.kind==='restore' ? 'Verify recovery' : 'Remove backup archive'} onClose={() => setConfirm(null)}>
            <div className="modal-body">
                <p>{confirm.kind==='restore'
                    ? 'The worker restores this archive into the configured empty recovery database and verifies the result. Workspace writes pause during recovery.'
                    : 'The encrypted archive will be removed from storage. The job history will remain available.'}</p>
                <Field label={'Type ' + phrase}><input value={typed} onChange={e => setTyped(e.target.value)} /></Field>
                {errorText(action.error)}
                <Button disabled={action.busy || typed!==phrase} onClick={() => {
                    const path = 'backups/'+confirm.job.id+(confirm.kind==='restore' ? '/restore' : '');
                    void action.save(path,confirm.kind==='restore' ? 'POST' : 'DELETE',{ confirmation:typed },() => {
                        setMessage(confirm.kind==='restore' ? 'Recovery queued.' : 'Archive removal queued.');
                        setConfirm(null); load();
                    });
                }}>{confirm.kind==='restore' ? 'Queue recovery verification' : 'Queue removal'}</Button>
            </div>
        </Modal>}
    </>;
}

export function PlatformPage({ section,adminReq,request }) {
    switch (section) {
        case 'users': return <UsersPage adminReq={adminReq} request={request} />;
        case 'subscriptions': return <PlansPage adminReq={adminReq} request={request} />;
        case 'trials': return <PlansPage key="trials" adminReq={adminReq} request={request} trial />;
        case 'saas-promotions': return <SubscriptionPromotions adminReq={adminReq} request={request} />;
        case 'branches': return <BranchOversight adminReq={adminReq} request={request} />;
        case 'access': return <AccessPage adminReq={adminReq} request={request} />;
        case 'activity': return <ActivityPage adminReq={adminReq} />;
        case 'system': return <SystemSettings adminReq={adminReq} request={request} />;
        case 'backups': return <BackupsPage adminReq={adminReq} request={request} />;
        default: return null;
    }
}
