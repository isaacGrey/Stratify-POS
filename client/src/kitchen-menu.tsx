import React,{useEffect,useMemo,useState} from 'react';
import { ClipboardList, UtensilsCrossed, RefreshCw, CheckCircle2, QrCode } from 'lucide-react';
import {Button,Empty,Field,Heading,Panel,Table,fmt,money,pesos,useLoad} from './ui';
import type {ApiRequest} from './types';

export function RegisterSummary({request,role}:{request:ApiRequest;role:string}) {
 const {data,err,load}=useLoad(request,'register/summary');
 return <Panel title="Cash registers & collected payments" right={<Button secondary onClick={load}><RefreshCw size={15}/> Refresh</Button>}>
  {err&&<p className="flash error">{err}</p>}
  {data&&<div className="shift-summary">
    <div><small>Customer payments collected</small><strong>{money(data.gross_collected_cents)}</strong></div>
    <div><small>Customer cash refunds</small><strong>{money(data.refunds_cents)}</strong></div>
    <div><small>Net customer payments</small><strong>{money(data.net_collected_cents)}</strong></div>
    <div><small>Completed payments</small><strong>{data.completed_payments}</strong></div>
  </div>}
  <p className="operations-note">Customer collections exclude opening cash, cash transfers and petty cash. Offline sales are counted after successful server reconciliation.</p>
  <Table items={data?.sessions||[]} columns={[
    ['cashier_name','Cashier'],['branch','Branch'],
    ['opened_at','Opened',fmt],['closed_at','Closed',fmt],
    ['cash_sales_cents','Cash sales',money],
    ['cash_refunds_cents','Refunds',money],
    ['expected_live_cents','Expected drawer',money],
    ['variance_cents','Closing variance',v=>v===null?'—':money(v)],
    ['status','Status']
  ]}/>
 </Panel>;
}

export function KitchenDisplay({request}:{request:ApiRequest}) {
 const {data,load,err}=useLoad(request,'kitchen');
 const [busy,setBusy]=useState('');
 const [error,setError]=useState('');
 const [showCompleted,setShowCompleted]=useState(false);
 useEffect(()=>{
   const refresh=()=>{if(!document.hidden)load();};
   const id=window.setInterval(refresh,4000);
   window.addEventListener('focus',refresh);
   return ()=>{window.clearInterval(id);window.removeEventListener('focus',refresh);};
 },[load]);
 const tickets=(data||[]).filter(ticket=>showCompleted||ticket.status!=='completed').sort((a,b)=>new Date(a.created_at).getTime()-new Date(b.created_at).getTime());
 const next={pending:'preparing',preparing:'ready',ready:'completed'};
 const action={pending:'Start preparation',preparing:'Mark ready',ready:'Complete'};
 async function update(ticket) {
   if(busy)return;setBusy(ticket.id);setError('');
   try{await request('kitchen/'+ticket.id+'/status','PATCH',{status:next[ticket.status]});load();}
   catch(e){setError(e.message||'Unable to update ticket');}finally{setBusy('');}
 }
 return <div className="kds-page">
  <Heading eyebrow="KITCHEN OPERATIONS" title="Kitchen display" sub="Paid and cashier-confirmed tickets only. Updates automatically every four seconds."
   action={<Button secondary onClick={load}><RefreshCw size={16}/> Refresh</Button>}/>
  {err&&<p role="alert" className="flash error">{err}</p>}
  {error&&<p role="alert" className="flash error">{error}</p>}
  <label className="operations-toggle"><input type="checkbox" checked={showCompleted} onChange={e=>setShowCompleted(e.target.checked)}/> Show completed tickets</label>
  <div className="kds-grid">
   {tickets.map(t=><article key={t.id} className="kds-ticket">
     <header><div><strong>#{t.order_number}</strong><small>{t.table_label?'Table '+t.table_label:t.order_type?.replace('_',' ')}</small></div>
       <span className={'kds-status '+t.status}>{t.status}</span></header>
     <div className="kds-ticket-body">{(t.items||[]).map((item,i)=>
      <div key={i} className="kds-line"><b>{item.quantity}×</b><div>{item.name}
       {item.variation&&<small>{item.variation}</small>}
       {item.addons?.length>0&&<small>{item.addons.map(x=>x.name).join(', ')}</small>}</div></div>)}</div>
     <footer><small>{fmt(t.created_at)}</small>
      {next[t.status]&&<Button disabled={!!busy} onClick={()=>update(t)}>{action[t.status]}</Button>}</footer>
   </article>)}
  </div>
  {!tickets.length&&<Empty text="No paid kitchen tickets in the current queue."/>}
 </div>;
}

function LocalQrCode({url,label}:{url:string;label:string}) {
 const container=React.useRef<HTMLDivElement>(null);
 const [failure,setFailure]=useState('');
 useEffect(()=>{
   let disposed=false;
   const global=window as Window & {QRCode?:any};
   const draw=()=>{
     if(disposed||!container.current||!global.QRCode)return;
     try{
       container.current.replaceChildren();
       new global.QRCode(container.current,{
         text:url,width:160,height:160,
         colorDark:'#152b20',colorLight:'#ffffff',
         correctLevel:global.QRCode.CorrectLevel.M
       });
       setFailure('');
     }catch{setFailure('Unable to generate QR. Copy the secure menu link instead.');}
   };
   if(global.QRCode){draw();return()=>{disposed=true;};}
   const script=document.querySelector<HTMLScriptElement>('script[data-stratify-qr]');
   const tag=script||document.createElement('script');
   const failed=()=>{if(!disposed)setFailure('QR encoder unavailable. Copy the link instead.');};
   tag.addEventListener('load',draw);
   tag.addEventListener('error',failed);
   if(!script){
     tag.src='/vendor/qrcode.min.js';tag.async=true;
     tag.dataset.stratifyQr='true';document.head.appendChild(tag);
   }
   return()=>{disposed=true;tag.removeEventListener('load',draw);tag.removeEventListener('error',failed);};
 },[url]);
 return <div className="qr-local">
   <div ref={container} role="img" aria-label={label}/>
   {failure&&<small role="status">{failure}</small>}
 </div>;
}

export function MenuManagement({request,appOrigin,role}:{request:ApiRequest;appOrigin:string;role:string}) {
 const {data:links,load}=useLoad(request,'menu/links');
 const {data:tables}=useLoad(request,'tables');
 const {data:settings,load:settingsLoad}=useLoad(request,'settings');
 const [tokens,setTokens]=useState<Record<string,string>>({});
 const [working,setWorking]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 async function run(job:()=>Promise<void>){setWorking(true);setError('');setNotice('');try{await job();load();}catch(e){setError(e.message||'Operation failed');}finally{setWorking(false);}}
 return <>
   <Heading title="Customer QR menus" sub="Issue or revoke a unique, revocable QR link for each branch table."/>
   {error&&<p role="alert" className="flash error">{error}</p>}{notice&&<p className="flash success">{notice}</p>}
   <Panel title="Public menu availability">
    <label className="operations-toggle"><input type="checkbox" checked={Boolean(settings?.customer_menu_enabled)}
      disabled={working||!settings||role!=='owner'}
      onChange={e=>run(async()=>{await request('menu/policy','PUT',{enabled:e.target.checked});settingsLoad();setNotice('Public menu policy saved.');})}/>
      Allow customers to view menus using their table QR codes</label>
    <p className="operations-note">Customers can submit a payment request; a manager must verify money was actually received before it becomes a completed POS sale or enters the kitchen. Rotating a QR invalidates older printed codes.</p>
   </Panel>
   <Panel title="Table QR links">
    <div className="qr-table-list">{(tables||[]).map(table=>{
      const current=links?.find(link=>link.table_id===table.id);
      const token=tokens[table.id];
      const url=token?appOrigin+'/menu/'+token:'';
      return <div className="qr-table-row" key={table.id}>
       <div><strong>{table.label}</strong><small>{current?.active?'Active · token only shown when generated':'No active QR link'}</small></div>
       {url&&<div className="qr-issued"><code>{url}</code><Button secondary onClick={()=>navigator.clipboard.writeText(url)}>Copy link</Button>
         <LocalQrCode url={url} label={'QR menu for table '+table.label}/>
       </div>}
       <Button secondary disabled={working} onClick={()=>run(async()=>{
        if(current?.active&&!window.confirm('Replace the printed QR for '+table.label+'?'))return;
        const issued=await request('menu/links/'+table.id+'/rotate','POST',{});
        setTokens(prev=>({...prev,[table.id]:issued.token}));setNotice('New QR generated; print or copy it now.');
       })}>{current?.active?'Rotate QR':'Generate QR'}</Button>
       {current?.active&&<button className="text-link danger-link" disabled={working} onClick={()=>run(async()=>{
        if(!window.confirm('Revoke this public menu QR?'))return;
        await request('menu/links/'+table.id+'/revoke','POST',{});
        setTokens(prev=>{const next={...prev};delete next[table.id];return next;});setNotice('QR revoked.');
       })}>Revoke</button>}
      </div>
    })}</div>
    {!tables?.length&&<Empty text="Create dining tables first to issue QR menus."/>}
   </Panel>
 </>;
}

export function CustomerOrdersQueue({request,role,cashierId}:{request:ApiRequest;role:string;cashierId:string}) {
 const {data,err,load}=useLoad(request,'menu/requests');
 const {data:registers,load:reloadRegisters}=useLoad(request,'register');
 const {data:products}=useLoad(request,'products');
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const [selected,setSelected]=useState<any>(null),[verified,setVerified]=useState(false),[tender,setTender]=useState('');
 const [paymentRef,setPaymentRef]=useState('');
 useEffect(()=>{
   const refresh=()=>{if(!document.hidden){load();reloadRegisters();}};
   const timer=window.setInterval(refresh,5000);
   return()=>window.clearInterval(timer);
 },[load,reloadRegisters]);
 async function run(fn:()=>Promise<any>){setBusy(true);setError('');setNotice('');try{await fn();load();}
 catch(e){setError(e.message||'Unable to process request');}finally{setBusy(false);}}
 const openRegister=(registers||[]).find(x=>x.status==='open'&&x.branch_id===selected?.branch_id&&x.cashier_id===cashierId);
 async function confirm(){
  if(!selected||!verified)return;
  const current=selected;
  await run(async()=>{
   const payload={
    branch_id:current.branch_id,table_id:current.table_id,order_type:'dine_in',
    items:current.cart,payment_method:current.payment_method,
    amount_tendered_cents:current.payment_method==='cash'?pesos(tender):null,
    register_session_id:current.payment_method==='cash'?openRegister?.id||null:null,
    customer_request_id:current.id,payment_verified:true,client_sale_id:current.id
   };
   if(payload.payment_method==='cash'&&(!openRegister||payload.amount_tendered_cents<current.quoted_total_cents))
     throw new Error('Use your open register and enter the received cash.');
   if(!['owner','manager'].includes(role)&&current.payment_method!=='cash') throw new Error('Electronic payments require manager verification.');
   await request('checkout','POST',payload);
   setSelected(null);setVerified(false);setTender('');
   setNotice('Payment confirmed; order recorded and sent to the kitchen.');
  });
 }
 return <Panel title="Customer QR checkout requests" right={<Button secondary onClick={load}>Refresh requests</Button>}>
  <p className="operations-note">Pending is not paid. Validate the actual cash receipt or external provider settlement before confirming. Non-cash payments are not automatically verified by StratifyPOS.</p>
  {err&&<p className="flash error">{err}</p>}{error&&<p role="alert" className="flash error">{error}</p>}{notice&&<p className="flash success">{notice}</p>}
  <Table items={(data||[]).filter(q=>q.status!=='confirmed')} columns={[
   ['table_label','Table'],['created_at','Requested',fmt],['payment_method','Method'],
   ['quoted_total_cents','Quoted',money],['status','Status'],
   ['id','Review',(_,q)=><button className="text-link" onClick={()=>{setSelected(q);setVerified(false);setPaymentRef('');setTender('');}}>Review</button>]
  ]}/>
  {selected&&<div className="qr-confirm-panel">
   <strong>Request at table {selected.table_label}</strong>
   <p className="operations-note">Quoted total {money(selected.quoted_total_cents)} · Current prices will be recalculated at checkout.</p>
   <ul>{selected.cart.map((x,i)=>{
      const product=(products||[]).find(p=>p.id===x.product_id);
      const variant=product?.variations?.find(v=>v.id===x.variation_id);
      return <li key={i}>{product?.name||'Unavailable item'}{variant?' · '+variant.name:''} · Qty {x.quantity}</li>;
    })}</ul>
   {selected.status==='awaiting_payment'&&<>
     <Field label="Customer payment reference or cash receipt ID"><input value={paymentRef} onChange={e=>setPaymentRef(e.target.value)} maxLength={120}/></Field>
     <Button secondary disabled={busy||!paymentRef.trim()} onClick={()=>run(async()=>{
      await request('menu/requests/'+selected.id+'/payment-review','POST',{reference:paymentRef.trim()});
      setSelected({...selected,status:'payment_review'});setNotice('Recorded. Verify payment before completing the sale.');
     })}>Record payment reference</Button>
   </>}
   {selected.status==='payment_review'&&<>
     {selected.payment_method==='cash'&&<Field label="Cash received (PHP)"><input type="number" min="0" step=".01" value={tender} onChange={e=>setTender(e.target.value)}/></Field>}
     <label className="operations-toggle"><input type="checkbox" checked={verified} onChange={e=>setVerified(e.target.checked)}/>
       {selected.payment_method==='cash'
         ? 'I received and counted the full cash payment for this customer.'
         : 'I verified full settlement through the external payment provider.'}</label>
     {!['owner','manager'].includes(role)&&selected.payment_method!=='cash'&&
       <p className="flash warning">Ask an owner or manager to verify this electronic payment.</p>}
     <Button disabled={busy||!verified||(!['owner','manager'].includes(role)&&selected.payment_method!=='cash')}
       onClick={confirm}>Confirm paid & send to kitchen</Button>
   </>}
   <Button secondary disabled={busy} onClick={()=>setSelected(null)}>Close review</Button>
  </div>}
 </Panel>;
}
