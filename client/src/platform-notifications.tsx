import React,{useCallback,useEffect,useState} from 'react';
import {Bell,Check,RefreshCcw} from 'lucide-react';
import type {ApiRequest} from './types';
import {fmt} from './ui';
type Notice={key:string;title:string;description:string;occurred_at:string;level:string;is_read:boolean};
export function PlatformNotifications({request}:{request:ApiRequest}){
 const [items,setItems]=useState<Notice[]>([]);
 const [expanded,setExpanded]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const refresh=useCallback(async()=>{
  try{const response=await request('notifications','GET',undefined,true);
   setItems(response.items||[]);setError('');}
  catch(e){setError(e instanceof Error?e.message:'Notifications unavailable');}
 },[request]);
 useEffect(()=>{void refresh();const interval=window.setInterval(()=>{void refresh()},30000);
  return ()=>window.clearInterval(interval);},[refresh]);
 const unread=items.filter(n=>!n.is_read).length;
 async function mark(key:string){setBusy(true);try{
  await request('notifications/read','POST',{key},true);
  setItems(rows=>rows.map(n=>n.key===key?{...n,is_read:true}:n));setError('');
 }catch(e){setError(e instanceof Error?e.message:'Unable to mark as read')}
 finally{setBusy(false)}}
 return <div className="platform-notifications">
  <button className="icon-btn platform-bell" type="button" aria-label={'Platform notifications'+(unread?' ('+unread+' unread)':'')}
   aria-expanded={expanded} onClick={()=>setExpanded(!expanded)}>
   <Bell size={19}/>{unread>0&&<span className="platform-unread">{unread>99?'99+':unread}</span>}
  </button>
  {expanded&&<section className="platform-notification-panel" aria-label="Platform notifications">
   <div className="platform-notice-head"><strong>Platform notifications</strong>
    <button className="text-link" onClick={()=>{void refresh()}}><RefreshCcw size={14}/> Refresh</button></div>
   {error&&<p className="flash error">{error}</p>}
   {!items.length&&<p className="padded">No recent notifications.</p>}
   <div className="platform-notice-list">{items.map(n=><div className={'platform-notice '+(n.is_read?'read':'unread')} key={n.key}>
    <div><strong>{n.title}</strong><small>{n.description}</small>
     <small>{fmt(n.occurred_at)}</small></div>
    {!n.is_read&&<button className="icon-btn" disabled={busy} title="Mark as read"
      onClick={()=>{void mark(n.key)}}><Check size={16}/></button>}
   </div>)}</div>
   <p className="platform-notice-foot">Updates automatically every 30 seconds while this page is open.</p>
  </section>}
 </div>
}
