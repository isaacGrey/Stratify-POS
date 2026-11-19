import React,{useState} from 'react';
import {Download,FileSpreadsheet,FileText,CalendarRange} from 'lucide-react';
import {Button,Field,Panel,Table,useLoad} from './ui';
import type {ApiRequest} from './types';

const localDay=()=>{
 const date=new Date();return new Date(date.getTime()-date.getTimezoneOffset()*60000)
  .toISOString().slice(0,10);
};
const monthAgo=()=>{
 const date=new Date(Date.now()-29*86400000);
 return new Date(date.getTime()-date.getTimezoneOffset()*60000).toISOString().slice(0,10);
};
export function OperationalReportPanel({kind,request,branchLimited=false}:{
 kind:'inventory'|'attendance';request:ApiRequest;branchLimited?:boolean
}){
 const [from,setFrom]=useState(monthAgo());
 const [to,setTo]=useState(localDay());
 const [branch,setBranch]=useState('');
 const [filters,setFilters]=useState('');
 const [busy,setBusy]=useState('');
 const [error,setError]=useState('');
 const {data:branches}=useLoad(request,'branches');
 const route=kind+'-reports';
 const query=new URLSearchParams({from,to,...(branch?{branch_id:branch}:{})}).toString();
 const preview=useLoad(request,filters?route+'?'+filters:null);
 const report=preview.data;
 const limitedBranches=branchLimited;
 async function saveFile(format:'xlsx'|'pdf'){
  if(limitedBranches&&!branch){setError('Select an assigned branch first.');return;}
  setError('');setBusy(format);
  try{
   const response=await request(route+'/export/'+format+'?'+query);
   if(!(response instanceof Blob))throw new Error('The report was not returned as a downloadable document');
   const url=URL.createObjectURL(response);
   const link=document.createElement('a');link.href=url;
   link.download='stratify-'+kind+'-'+from+'_'+to+'.'+format;
   document.body.appendChild(link);link.click();link.remove();
   window.setTimeout(()=>URL.revokeObjectURL(url),15000);
  }catch(e:any){setError(e?.message||'Export failed');}
  finally{setBusy('');}
 }
 const sections=report?.sheets||[];
 return <Panel title={kind==='inventory'?'Inventory Reports':'Attendance Reports & Time Cards'}
  right={<div className="inline-form">
   <Button secondary disabled={!!busy} onClick={()=>saveFile('xlsx')}><FileSpreadsheet size={15}/> Excel</Button>
   <Button secondary disabled={!!busy} onClick={()=>saveFile('pdf')}><FileText size={15}/> PDF</Button>
  </div>}>
  <div className="report-filter-grid">
   <Field label="From"><input type="date" value={from} onChange={e=>setFrom(e.target.value)}/></Field>
   <Field label="Through"><input type="date" value={to} onChange={e=>setTo(e.target.value)}/></Field>
   <Field label="Branch"><select value={branch} onChange={e=>setBranch(e.target.value)}>
    {!limitedBranches&&<option value="">All branches / shared inventory</option>}
    {limitedBranches&&<option value="">Select branch</option>}
    {(branches||[]).map(b=><option value={b.id} key={b.id}>{b.name}</option>)}
   </select></Field>
   <Button secondary onClick={()=>{if(limitedBranches&&!branch){setError('Select an assigned branch.');return;}
    setError('');setFilters(query);}}><CalendarRange size={15}/> Generate report</Button>
  </div>
  {(error||preview.err)&&<p className="flash error" role="alert">{error||preview.err}</p>}
  {kind==='attendance'&&<p className="operational-hint">
    Time cards include clock-in/out, breaks, net work hours and scheduled-day absence indicators.
    Absences depend on current weekly schedules and require payroll review.</p>}
  {kind==='inventory'&&<p className="operational-hint">
    Exports contain stock balances, available quantity, reorder thresholds, low-stock status and movement history.</p>}
  {report&&<div className="operational-preview">
    {sections.filter(s=>s.name==='Overview'||s.name==='Employee summary').map(section=><div key={section.name}>
      <h4>{section.name}</h4>
      <Table items={section.rows} columns={section.columns.map(c=>[c.key,c.title])}/>
    </div>)}
    <small>Exports include {sections.map(s=>s.name).join(', ')}.</small>
  </div>}
 </Panel>;
}
