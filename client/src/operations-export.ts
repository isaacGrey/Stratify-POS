import type {ApiRequest} from './types';
/** Use authenticated tenant-bound API request and revoke temporary browser URLs. */
export async function downloadOperationsReport(request:ApiRequest,route:string,filename:string){
 const payload=await request(route,'GET');
 if(!(payload instanceof Blob))throw new Error('The server did not return a valid report file');
 const url=URL.createObjectURL(payload);
 try{
  const a=document.createElement('a');a.href=url;a.download=filename;
  document.body.appendChild(a);a.click();a.remove();
 }finally{window.setTimeout(()=>URL.revokeObjectURL(url),30000);}
}
