import React, { useEffect, useState } from 'react';
import { CheckCircle2, ClipboardList, Plus, RefreshCw, Wallet } from 'lucide-react';
import { Button, Empty, Field, Heading, Modal, Panel, Table, fmt, money, pesos, useLoad } from './ui';
import type { ApiRequest } from './types';

function positiveAmount(value: string, decimals = 2) {
    const amount = Number(value);
    if (!value.trim() || !Number.isFinite(amount) || amount <= 0 ||
        Math.abs(amount * 10 ** decimals - Math.round(amount * 10 ** decimals)) > 0.00001) {
        throw new Error('Enter a valid positive amount.');
    }
    return amount;
}

export function CashRegisterPanel({request,branchId,online,cashierId,role,required,onSessionChange,onPolicyUpdated}: {
    request: ApiRequest; branchId: string; online: boolean; cashierId: string; role: string;
    required: boolean; onSessionChange: (id: string | null)=>void; onPolicyUpdated:()=>void;
}) {
    const {data: registers,load,err} = useLoad(request,online ? 'register' : null);
    const [opening,setOpening] = useState('0');
    const [counted,setCounted] = useState('');
    const [movementAmount,setMovementAmount] = useState('');
    const [movementReason,setMovementReason] = useState('');
    const [movementKind,setMovementKind] = useState('cash_in');
    const [busy,setBusy] = useState(false);
    const [error,setError] = useState('');
    const [notice,setNotice] = useState('');
    const active = registers?.find((r:any) =>
        r.status==='open' && r.branch_id===branchId && r.cashier_id===cashierId);
    const anotherBranch = registers?.find((r:any) => r.status==='open' && r.cashier_id===cashierId &&
        r.branch_id!==branchId);
    useEffect(() => { onSessionChange(online ? active?.id ?? null : null); },
        [active?.id,online,onSessionChange]);

    async function run(action:()=>Promise<any>) {
        if (busy) return;
        setBusy(true); setError(''); setNotice('');
        try { await action(); await load(); }
        catch (cause:any) { setError(cause?.message || 'Register operation failed'); }
        finally { setBusy(false); }
    }
    if (!online) return <p className="operations-note">Offline cash sales are saved separately and reconciled after reconnecting.</p>;
    return <details className="operations-compact" open={Boolean(required && !active)}>
        <summary><Wallet size={16}/> Cash register <span className="operations-state">{active ? 'Open · '+money(active.ledger_cents) : 'Not open'}{required ? ' · Required' : ' · Optional'}</span></summary>
        <div className="operations-body">
            {err && <p className="flash error">{err}</p>}
            {anotherBranch && !active && <p className="operations-note">Close your register at another branch before opening here.</p>}
            {role==='owner' && <label className="operations-toggle"><input type="checkbox" checked={required} disabled={busy} onChange={event => run(async () => {
                await request('register/policy','PUT',{require_cash_register:event.target.checked});
                onPolicyUpdated();
                setNotice('Register requirement updated.');
            })}/> Require an open register for online cash checkout</label>}
            {active ? <>
                <p className="operations-note">Opening: {money(active.opening_cents)} · Ledger balance: {money(active.ledger_cents)} · Opened {fmt(active.opened_at)}</p>
                <div className="operations-fields">
                    <Field label="Cash adjustment"><select value={movementKind} onChange={e=>setMovementKind(e.target.value)}>
                        <option value="cash_in">Cash in</option><option value="cash_out">Cash out</option>
                    </select></Field>
                    <Field label="Amount (PHP)"><input type="number" min="0.01" step="0.01" value={movementAmount} onChange={e=>setMovementAmount(e.target.value)}/></Field>
                    <Field label="Reason"><input value={movementReason} maxLength={300} onChange={e=>setMovementReason(e.target.value)} placeholder="Petty cash / deposit"/></Field>
                    <Button secondary disabled={busy} onClick={()=>run(async()=>{
                        positiveAmount(movementAmount);
                        await request('register/'+active.id+'/movements','POST',{
                            kind:movementKind,amount_cents:pesos(movementAmount),reason:movementReason
                        });
                        setMovementAmount('');setMovementReason('');setNotice('Cash movement recorded.');
                    })}>Record cash movement</Button>
                </div>
                <div className="operations-fields">
                    <Field label="Counted closing cash (PHP)"><input type="number" min="0" step="0.01" value={counted}
                        onChange={e=>setCounted(e.target.value)}/></Field>
                    <Button disabled={busy || !counted.trim()} onClick={()=>run(async()=>{
                        const value=Number(counted);
                        if (!Number.isFinite(value)||value<0) throw new Error('Enter the counted cash amount.');
                        await request('register/'+active.id+'/close','POST',{counted_cents:pesos(counted)});
                        setCounted('');setNotice('Register closed and variance recorded.');
                    })}>Close and reconcile</Button>
                </div>
            </> : <div className="operations-fields">
                <Field label="Opening balance (PHP)"><input type="number" min="0" step="0.01" value={opening}
                    onChange={e=>setOpening(e.target.value)}/></Field>
                <Button disabled={busy || !branchId || Boolean(anotherBranch)} onClick={()=>run(async()=>{
                    const value=Number(opening);
                    if (!Number.isFinite(value)||value<0) throw new Error('Enter a valid opening cash amount.');
                    await request('register/open','POST',{branch_id:branchId,opening_cents:pesos(opening)});
                    setNotice('Register opened.');
                })}>Open register</Button>
            </div>}
            {notice && <p className="flash success">{notice}</p>}
            {error && <p className="flash error" role="alert">{error}</p>}
        </div>
    </details>;
}

type PurchaseInput = {ingredient_id:string;quantity:string;price:string};
export function PurchasingPage({request}: {request:ApiRequest}) {
    const {data:orders,load,err}=useLoad(request,'purchases');
    const {data:suppliers,load:reloadSuppliers}=useLoad(request,'suppliers');
    const {data:branches}=useLoad(request,'branches');
    const {data:items}=useLoad(request,'ingredients');
    const [creating,setCreating]=useState(false);
    const [branchId,setBranchId]=useState('');
    const [supplierId,setSupplierId]=useState('');
    const [reference,setReference]=useState('');
    const [notes,setNotes]=useState('');
    const [lines,setLines]=useState<PurchaseInput[]>([{ingredient_id:'',quantity:'1',price:'0'}]);
    const [detail,setDetail]=useState<any>(null);
    const [quantities,setQuantities]=useState<Record<string,string>>({});
    const [receiptRequestId,setReceiptRequestId]=useState(()=>crypto.randomUUID());
    const [supplierName,setSupplierName]=useState('');
    const [busy,setBusy]=useState(false);
    const [error,setError]=useState('');
    const [notice,setNotice]=useState('');

    function updateLine(index:number,patch:Partial<PurchaseInput>) {
        setLines(current=>current.map((line,i)=>i===index?{...line,...patch}:line));
    }
    async function run(fn:()=>Promise<any>) {
        if (busy) return;
        setBusy(true);setError('');setNotice('');
        try { await fn(); await load(); }
        catch(cause:any) {setError(cause?.message || 'Purchasing request failed');}
        finally {setBusy(false);}
    }
    function openCreate() {
        setCreating(true);setError('');
        setBranchId(branches?.find((b:any)=>b.active)?.id || '');
        setSupplierId(suppliers?.[0]?.id || '');
        setLines([{ingredient_id:'',quantity:'1',price:'0'}]);
    }
    async function view(id:string) {
        try {
            setError('');
            const po=await request('purchases/'+id);
            setDetail(po);
            setReceiptRequestId(crypto.randomUUID());
            setQuantities(Object.fromEntries(po.lines.map((line:any)=>[
                line.id, String(Math.max(0,Number(line.ordered_quantity)-Number(line.received_quantity)))
            ])));
        } catch(cause:any) {setError(cause.message);}
    }
    const outstanding=detail?.lines.filter((line:any)=>
        Number(line.ordered_quantity)>Number(line.received_quantity)) || [];
    return <>
        <Heading title="Purchasing & suppliers" sub="Create purchase orders and receive stock with traceable, branch-aware inventory updates."
            action={<Button onClick={openCreate}><Plus size={16}/> New purchase order</Button>}/>
        {err && <p className="flash error">{err}</p>}
        {error && <p className="flash error" role="alert">{error}</p>}
        {notice && <p className="flash success">{notice}</p>}
        <Panel title="Purchase orders" right={<span className="badge">{orders?.length || 0} orders</span>}>
            <Table items={orders || []} columns={[
                ['reference','Reference',v=>v || '—'],['supplier','Supplier'],['branch','Branch'],
                ['created_at','Created',fmt],['status','Status',v=>String(v).replace('_',' ')],
                ['total_cost_cents','Ordered cost',v=>money(v)],
                ['id','Details',(_v,row)=><button className="text-link" onClick={()=>view(row.id)}>View / receive</button>]
            ]}/>
        </Panel>
        <Panel title="Suppliers" right={<div className="operations-fields">
            <input aria-label="New supplier name" placeholder="Supplier name" value={supplierName}
                onChange={e=>setSupplierName(e.target.value)} maxLength={200}/>
            <Button secondary disabled={busy || !supplierName.trim()} onClick={()=>run(async()=>{
                await request('suppliers','POST',{name:supplierName.trim(),contact:''});
                setSupplierName(''); await reloadSuppliers();setNotice('Supplier added.');
            })}>Add supplier</Button>
        </div>}>
            {suppliers?.length ? <div className="operations-chips">{suppliers.map((s:any)=><span key={s.id} className="chip">{s.name}</span>)}</div>:
                <Empty text="Create a supplier before adding your first purchase order."/>}
        </Panel>
        {creating && <Modal title="New purchase order" onClose={()=>setCreating(false)}>
            <div className="modal-body operations-modal">
                <div className="operations-fields">
                    <Field label="Receiving branch"><select value={branchId} onChange={e=>setBranchId(e.target.value)}>
                        <option value="">Choose branch</option>{branches?.filter((b:any)=>b.active).map((b:any)=>
                            <option key={b.id} value={b.id}>{b.name}</option>)}
                    </select></Field>
                    <Field label="Supplier"><select value={supplierId} onChange={e=>setSupplierId(e.target.value)}>
                        <option value="">Choose supplier</option>{suppliers?.map((s:any)=><option key={s.id} value={s.id}>{s.name}</option>)}
                    </select></Field>
                    <Field label="Reference"><input value={reference} maxLength={100} onChange={e=>setReference(e.target.value)} placeholder="Supplier PO reference"/></Field>
                </div>
                <Field label="Notes"><textarea rows={2} value={notes} maxLength={1000} onChange={e=>setNotes(e.target.value)}/></Field>
                <div className="operations-lines">
                    <strong>Ordered stock</strong>
                    {lines.map((line,index)=><div key={index} className="operations-line">
                        <select aria-label={'Stock item '+(index+1)} value={line.ingredient_id} onChange={e=>{
                            const selected=items?.find((x:any)=>x.id===e.target.value);
                            updateLine(index,{ingredient_id:e.target.value,price:String((selected?.unit_cost_cents||0)/100)});
                        }}><option value="">Select stock item</option>{items?.map((item:any)=>
                            <option key={item.id} value={item.id}>{item.name} ({item.unit})</option>)}</select>
                        <input aria-label="Quantity" type="number" min="0.001" step="0.001" value={line.quantity}
                            onChange={e=>updateLine(index,{quantity:e.target.value})}/>
                        <input aria-label="Unit cost (PHP)" type="number" min="0" step="0.01" value={line.price}
                            onChange={e=>updateLine(index,{price:e.target.value})}/>
                        <button type="button" className="text-link" disabled={lines.length===1}
                            onClick={()=>setLines(old=>old.filter((_x,i)=>i!==index))}>Remove</button>
                    </div>)}
                    <button type="button" className="text-link" disabled={lines.length>=100}
                        onClick={()=>setLines(old=>[...old,{ingredient_id:'',quantity:'1',price:'0'}])}>+ Add stock line</button>
                </div>
                <Button disabled={busy || !branchId || !supplierId} onClick={()=>run(async()=>{
                    const parsed=lines.map(line=>({
                        ingredient_id:line.ingredient_id,quantity:positiveAmount(line.quantity,3),
                        unit_cost_cents:pesos(line.price)
                    }));
                    await request('purchases','POST',{branch_id:branchId,supplier_id:supplierId,
                        reference,notes,lines:parsed});
                    setCreating(false);setNotice('Purchase order submitted.');
                })}>Save purchase order</Button>
                {error && <p className="flash error">{error}</p>}
            </div>
        </Modal>}
        {detail && <Modal title={'Purchase order '+(detail.reference || detail.id.slice(0,8))} onClose={()=>setDetail(null)}>
            <div className="modal-body operations-modal">
                <p className="operations-note">{detail.supplier} · {detail.branch} · {String(detail.status).replace('_',' ')}</p>
                <div className="operations-lines">
                    {detail.lines.map((line:any)=><div className="operations-line" key={line.id}>
                        <span><strong>{line.name}</strong><small>Ordered {line.ordered_quantity} {line.unit} · Received {line.received_quantity}</small></span>
                        <input aria-label={'Receive '+line.name} type="number" min="0" step="0.001"
                            max={Math.max(0,Number(line.ordered_quantity)-Number(line.received_quantity))}
                            disabled={detail.status==='cancelled' || detail.status==='received'}
                            value={quantities[line.id] || '0'} onChange={e=>setQuantities(q=>({...q,[line.id]:e.target.value}))}/>
                    </div>)}
                </div>
                {outstanding.length>0 && detail.status!=='cancelled' && <Button disabled={busy} onClick={()=>run(async()=>{
                    const receiving=outstanding.filter((line:any)=>Number(quantities[line.id])>0)
                        .map((line:any)=>({line_id:line.id,quantity:positiveAmount(quantities[line.id],3)}));
                    if (!receiving.length) throw new Error('Enter at least one received quantity.');
                    await request('purchases/'+detail.id+'/receive','POST',{
                        request_id:receiptRequestId,lines:receiving
                    });
                    setDetail(null);setNotice('Stock receipt posted to the inventory ledger.');
                })}><CheckCircle2 size={16}/> Receive selected stock</Button>}
                {detail.status==='submitted' && <Button secondary disabled={busy} onClick={()=>run(async()=>{
                    if (!window.confirm('Cancel this unreceived purchase order?')) return;
                    await request('purchases/'+detail.id+'/cancel','POST',{});
                    setDetail(null);setNotice('Purchase order cancelled.');
                })}>Cancel purchase order</Button>}
                {error && <p className="flash error">{error}</p>}
            </div>
        </Modal>}
    </>;
}

export function RefundDialog({request,order,cashierId,onDone,onClose}: {
    request:ApiRequest;order:any;cashierId:string;onDone:()=>void;onClose:()=>void;
}) {
    const {data:refunds}=useLoad(request,'orders/'+order.id+'/refunds');
    const {data:registers}=useLoad(request,'register');
    const {data:settings}=useLoad(request,'settings');
    const already=(refunds||[]).reduce((sum:number,refund:any)=>sum+Number(refund.amount_cents),0);
    const remaining=Number(order.total_cents)-already;
    const [amount,setAmount]=useState('');
    const [reason,setReason]=useState('');
    const [registerId,setRegisterId]=useState('');
    const [requestId]=useState(()=>crypto.randomUUID());
    const [busy,setBusy]=useState(false);
    const [error,setError]=useState('');
    const ownRegisters=(registers||[]).filter((s:any)=>
        s.status==='open' && s.branch_id===order.branch_id && s.cashier_id===cashierId);
    async function refund() {
        if(busy) return;
        setBusy(true);setError('');
        try {
            positiveAmount(amount);
            const returned=pesos(amount);
            if(returned>remaining) throw new Error('Refund exceeds the remaining amount.');
            await request('orders/'+order.id+'/refunds','POST',{
                request_id:requestId,amount_cents:returned,reason:reason.trim(),
                register_session_id:registerId||null
            });
            onDone();
        } catch(cause:any) {setError(cause?.message || 'Refund failed');}
        finally {setBusy(false);}
    }
    return <Modal title={'Refund order #'+order.order_number} onClose={onClose}>
        <div className="modal-body operations-modal">
            <p className="operations-note">Original payment: {order.payment_method.toUpperCase()} · Paid {money(order.total_cents)} · Previously refunded {money(already)} · Remaining {money(remaining)}</p>
            {order.payment_method!=='cash' ? <p className="flash warning">External cashless refunds need verified gateway reversal and are not enabled.</p>:
                remaining>0 ? <>
                    <Field label="Refund amount (PHP)"><input type="number" min="0.01" max={remaining/100} step="0.01"
                        value={amount} onChange={e=>setAmount(e.target.value)} placeholder={(remaining/100).toFixed(2)}/></Field>
                    <Field label="Reason (required)"><textarea rows={2} maxLength={500} value={reason} onChange={e=>setReason(e.target.value)}
                        placeholder="Reason for authorized cash refund"/></Field>
                    <Field label="Pay refund from register"><select value={registerId} onChange={e=>setRegisterId(e.target.value)}>
                        <option value="">{settings?.require_cash_register ? 'Select an open register' : 'Outside register (optional)'}</option>
                        {ownRegisters.map((r:any)=><option key={r.id} value={r.id}>Cash register · {money(r.ledger_cents)}</option>)}
                    </select></Field>
                    <p className="operations-note">Refunds do not automatically restock goods. Inspect returned products before adjusting inventory.</p>
                    <Button disabled={busy || !amount || reason.trim().length<5 ||
                        Boolean(settings?.require_cash_register && !registerId)}
                        onClick={refund}>Authorize cash refund</Button>
                </>:<p className="operations-note">This transaction has already been fully refunded.</p>}
            <Panel title="Refund history">
                <Table items={refunds||[]} columns={[
                    ['created_at','Date',fmt],['amount_cents','Amount',money],
                    ['reason','Reason'],['authorized_by','Manager']
                ]}/>
            </Panel>
            {error && <p role="alert" className="flash error">{error}</p>}
        </div>
    </Modal>;
}
