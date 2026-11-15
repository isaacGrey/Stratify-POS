import React,{useEffect,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {apiOrigin} from './site-routing';
import {Button,Empty,Field,Heading,money} from './ui';
import './style.css';

function CustomerMenu(){
 const token=window.location.pathname.split('/')[2]||'';
 const [menu,setMenu]=useState<any>(null),[error,setError]=useState(''),[loading,setLoading]=useState(true);
 const [cart,setCart]=useState<Record<string,number>>({});
 const [variant,setVariant]=useState<Record<string,string>>({});
 const [method,setMethod]=useState('cash'),[submitted,setSubmitted]=useState<any>(null),[busy,setBusy]=useState(false);
 useEffect(()=>{let open=true;
  fetch(apiOrigin+'/api/public/menu/'+encodeURIComponent(token),{cache:'no-store'})
  .then(async r=>{if(!r.ok)throw new Error('Menu unavailable');return r.json();})
  .then(data=>{if(open){setMenu(data);setLoading(false);}})
  .catch(e=>{if(open){setError(e.message);setLoading(false);}});
  return ()=>{open=false;};
 },[token]);
 useEffect(()=>{if(!submitted?.request_id)return;
  const task=window.setInterval(async()=>{
   try{const r=await fetch(apiOrigin+'/api/public/menu/'+token+'/requests/'+submitted.request_id,{cache:'no-store'});
    if(!r.ok)return;const data=await r.json();setSubmitted(previous=>previous?.request_id===data.id?{...previous,status:data.status}:previous);
   }catch{}},5000);
  return ()=>window.clearInterval(task);
 },[submitted?.request_id,token]);
 const totals=(menu?.products||[]).reduce((sum,p)=>{
   const count=cart[p.id]||0;
   const option=p.variations.find(v=>v.id===variant[p.id]);
   return sum+Number(option?.price_cents??p.price_cents)*count;
 },0);
 async function submit(){
  if(!menu||!Object.values(cart).some(x=>x>0)||busy)return;
  setBusy(true);setError('');
  try{
   const id=crypto.randomUUID();
   const items=Object.entries(cart).filter(([,count])=>count>0).map(([pid,quantity])=>({
     product_id:pid,quantity,variation_id:variant[pid]||null,addon_ids:[]
   }));
   const res=await fetch(apiOrigin+'/api/public/menu/'+token+'/requests',{
     method:'POST',headers:{'Content-Type':'application/json'},
     body:JSON.stringify({request_id:id,items,payment_method:method})});
   const result=await res.json();
   if(!res.ok)throw new Error(result.error||'Cannot submit payment request');
   setSubmitted(result);
  }catch(e){setError(e.message||'Request failed');}finally{setBusy(false);}
 }
 return <div className="public-menu-page">
  <header className="public-menu-head"><img src="/stratify-logo.png" alt="StratifyPOS"/>
   <span>STRATIFY POS <small>TABLE MENU</small></span></header>
  {loading&&<p className="operations-note">Loading menu...</p>}
  {error&&<p role="alert" className="flash error">{error}</p>}
  {menu&&<><Heading eyebrow={menu.branch} title={'Table '+menu.table} sub="Explore available products without lining up."/>
  {submitted?<section className="panel public-menu-confirm">
   <h2>{submitted.status==='confirmed'?'Payment confirmed · sent to kitchen':
       submitted.status==='cancelled'?'Request cancelled':'Awaiting payment confirmation'}</h2>
   <p>Your request number: <strong>{submitted.request_id.slice(0,8)}</strong></p>
   <p>Quoted total: <strong>{money(submitted.total_cents)}</strong></p>
   <p>Pay at the cashier or follow the business's verified payment instructions. Staff must confirm full payment before preparation begins. This screen is not proof of payment.</p>
  </section>:<>
   <div className="public-menu-grid">{menu.products.map(p=><article className="public-menu-item" key={p.id}>
      {p.image_url?<img loading="lazy" src={p.image_url} alt=""/>:<div className="public-menu-placeholder">▣</div>}
      <div className="public-menu-item-body"><h3>{p.name}</h3><p>{p.description||p.category||'Available today'}</p>
       <strong>{money(p.variations.find(v=>v.id===variant[p.id])?.price_cents??p.price_cents)}</strong>
       {p.variations.length>0&&<Field label="Option"><select value={variant[p.id]||''}
         onChange={e=>setVariant(old=>({...old,[p.id]:e.target.value}))}>
        <option value="">Standard</option>{p.variations.map(v=><option key={v.id} value={v.id}>{v.name} · {money(v.price_cents)}</option>)}</select></Field>}
       <div className="public-menu-qty"><button aria-label={'Remove '+p.name} onClick={()=>setCart(old=>({...old,[p.id]:Math.max(0,(old[p.id]||0)-1)}))}>−</button>
         <span>{cart[p.id]||0}</span><button aria-label={'Add '+p.name} onClick={()=>setCart(old=>({...old,[p.id]:Math.min(100,(old[p.id]||0)+1)}))}>+</button></div>
      </div>
     </article>)}</div>
    {!menu.products.length&&<Empty text="No available menu items yet."/>}
    <aside className="public-menu-footer">
     <strong>Estimated items subtotal: {money(totals)}</strong>
     <small>Final amount includes taxes/service charges and is recalculated at payment review.</small>
     <Field label="Intended payment"><select value={method} onChange={e=>setMethod(e.target.value)}>
       <option value="cash">Pay cash at cashier</option>
       <option value="gcash">GCash — staff-verified</option>
       <option value="maya">Maya — staff-verified</option>
       <option value="card">Card — staff-verified</option>
     </select></Field>
     <Button disabled={busy||totals<=0} onClick={submit}>{busy?'Submitting...':'Request checkout'}</Button>
    </aside>
   </>}
  </>}
 </div>;
}
createRoot(document.getElementById('root')!).render(<CustomerMenu/>);
