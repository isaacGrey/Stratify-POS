import React,{useCallback,useEffect,useState} from 'react';
import {Bell,Check,CheckCheck,RefreshCw,X} from 'lucide-react';
import type {ApiRequest} from './types';
import {useLoad} from './ui';

export function PlatformNotifications({request}:{request:ApiRequest}){
 const api=useCallback((path:string)=>request(path,'GET',undefined,true),[request]);
 const {data,err,load}=useLoad(api,'notifications');
 const [open,setOpen]=useState(false);
 const [busy,setBusy]=useState(false);
 const [message,setMessage]=useState('');
 useEffect(()=>{const id=window.setInterval(()=>{
  if(document.visibilityState==='visible')load();
 },20000);return ()=>window.clearInterval(id);},[load]);
 async function mark(keys:string[]){
  if(!keys.length||busy)return;
  setBusy(true);setMessage('');
  try{await request('notifications/read','POST',{keys},true);await load();}
  catch(e:any){setMessage(e.message||'Unable to mark notifications read');}
  finally{setBusy(false);}
 }
 const unread=Number(data?.unread||0);
 return <div className="platform-bell">
   <button type="button" className="icon-btn platform-bell-trigger" aria-label={'Platform notifications: '+unread+' unread'}
    aria-expanded={open} onClick={()=>{setOpen(v=>!v);load();}}>
    <Bell size={19}/>
    {unread>0&&<span className="platform-bell-count">{unread>99?'99+':unread}</span>}
   </button>
   {open&&<div className="platform-bell-panel">
    <div className="platform-bell-head">
     <strong>Platform notifications</strong>
     <div className="inline-form">
      <button className="icon-btn" aria-label="Refresh notifications" onClick={load}><RefreshCw size={15}/></button>
      <button className="icon-btn" aria-label="Close notifications" onClick={()=>setOpen(false)}><X size={15}/></button>
     </div>
    </div>
    {err&&<p className="flash error" role="alert">{err}</p>}
    {message&&<p className="flash error" role="alert">{message}</p>}
    <div className="platform-bell-list">
     {!data?.items?.length&&<p className="padded">No platform alerts at present.</p>}
     {(data?.items||[]).map((item:any)=><div className={'platform-bell-item '+(!item.read?'unread':'')} key={item.key}>
      <div><b>{item.title}</b><small>{item.detail}</small>
       <time>{new Date(item.created_at).toLocaleString('en-PH')}</time>
      </div>
      {!item.read&&<button className="icon-btn" disabled={busy} aria-label={'Mark '+item.title+' read'}
       onClick={()=>mark([item.key])}><Check size={16}/></button>}
     </div>)}
    </div>
    <div className="platform-bell-footer">
     <span>{unread} unread</span>
     <button type="button" disabled={busy||!data?.items?.some((x:any)=>!x.read)}
      onClick={()=>mark((data?.items||[]).filter((x:any)=>!x.read).map((x:any)=>x.key))}>
      <CheckCheck size={14}/> Mark shown as read</button>
    </div>
   </div>}
  </div>;
}
