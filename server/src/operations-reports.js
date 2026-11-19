import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import {one,rows,scoped} from './db.js';
import {listBalances} from './inventory.js';
const fail=(status,message)=>Object.assign(new Error(message),{status});
export function dateFilters(query={}){
 const today=new Date().toISOString().slice(0,10);
 const from=String(query.from||new Date(Date.now()-29*86400000).toISOString().slice(0,10));
 const to=String(query.to||today);
 if(!/^\d{4}-\d\d-\d\d$/.test(from)||!/^\d{4}-\d\d-\d\d$/.test(to)||
   !Number.isFinite(Date.parse(from))||!Number.isFinite(Date.parse(to))||
   from>to||(Date.parse(to)-Date.parse(from))/86400000>92)
   throw fail(400,'Select a valid report period of up to 93 days');
 return {from,to};
}
const safe=x=>x==null?'':String(x);
export async function exportTabular({title,subtitle,columns,records,format}){
 if(format==='xlsx'){
  const wb=new ExcelJS.Workbook();wb.creator='StratifyPOS';
  const sheet=wb.addWorksheet(title.slice(0,31),{views:[{state:'frozen',ySplit:3}]});
  sheet.addRow([title]);sheet.addRow([subtitle]);sheet.addRow(columns.map(c=>c[1]));
  sheet.getRow(1).font={bold:true,size:15};
  sheet.getRow(3).font={bold:true,color:{argb:'FFFFFFFF'}};
  sheet.getRow(3).fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF164B46'}};
  sheet.columns=columns.map(c=>({width:c[2]||20}));
  for(const record of records)sheet.addRow(columns.map(([key])=>record[key]??''));
  sheet.autoFilter={from:'A3',to:sheet.getRow(3).getCell(columns.length).address};
  return {content:Buffer.from(await wb.xlsx.writeBuffer()),mime:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'};
 }
 if(format!=='pdf')throw fail(400,'Choose xlsx or pdf');
 const data=await new Promise((resolve,reject)=>{
  const doc=new PDFDocument({size:'A4',layout:'landscape',margin:28}),chunks=[];
  doc.on('data',chunk=>chunks.push(chunk));doc.on('end',()=>resolve(Buffer.concat(chunks)));doc.on('error',reject);
  doc.fontSize(18).text(title);doc.fontSize(9).text(subtitle);doc.moveDown();
  doc.fontSize(7);
  doc.table({maxWidth:doc.page.width-56,columnStyles:columns.map(() => '*'),
   defaultStyle:{padding:3,border:[0,0,0.3,0],borderColor:'#d3dfdb'},
   rowStyles:index=>index===0?{backgroundColor:'#e1f1ed'}:{},
   data:[columns.map(c=>c[1]),...records.map(record=>columns.map(([key])=>safe(record[key])))]});
  doc.end();
 });
 return {content:data,mime:'application/pdf'};
}
const inventoryCols=[
 ['name','Stock item',28],['item_type','Type',16],['inventory_category','Category',20],
 ['unit','Unit',10],['quantity','Total quantity',16],['available','Available',16],
 ['low_stock_at','Reorder level',16],['stock_status','Status',14],['branch_name','Location',22]
];
const attendanceCols=[
 ['name','Employee',25],['day','Work date',14],['branch','Branch',20],
 ['scheduled','Scheduled shift',24],['clock_in','Time in',25],['clock_out','Time out',25],
 ['break_hours','Break hours',14],['work_hours','Worked hours',16],['late_minutes','Late (min)',12],
 ['status','Attendance status',18]
];
export function registerOperationsReports(app,{wrap,permit}){
 const grant=permit('owner','manager');
 for(const section of ['inventory','attendance']){
  app.get('/api/shop/'+section+'/export.:format',grant,wrap(async(req,res)=>{
   const format=req.params.format;
   if(!['xlsx','pdf'].includes(format))throw fail(400,'Unsupported export format');
   const dates=dateFilters(req.query),branchId=req.query.branch_id||null;
   if(branchId&&!/^[0-9a-f-]{36}$/i.test(branchId))throw fail(400,'Invalid branch');
   const result=await scoped(req.tenant,async db=>{
    let branchName='All accessible branches';
    if(branchId){
     const branch=await one(db,'SELECT name FROM branches WHERE tenant_id=$1 AND id=$2',
      [req.tenant,branchId]);
     if(!branch)throw fail(403,'Branch unavailable');
     branchName=branch.name;
    }
    if(section==='inventory'){
     const mode=await one(db,'SELECT branch_stock_enabled FROM shop_settings WHERE tenant_id=$1',[req.tenant]);
     if(branchId&&!mode?.branch_stock_enabled)throw fail(409,'Enable branch inventory to export branch balances');
     const inventory=await listBalances(db,req.tenant,branchId);
     const movements=await rows(db,`SELECT i.name, m.delta, m.movement_type, m.reason,m.created_at
       FROM stock_movements m JOIN ingredients i ON i.tenant_id=m.tenant_id AND i.id=m.ingredient_id
       WHERE m.tenant_id=$1 AND ($2::uuid IS NULL OR m.branch_id=$2)
         AND m.created_at::date BETWEEN $3::date AND $4::date
       ORDER BY m.created_at DESC LIMIT 1000`,
      [req.tenant,branchId,dates.from,dates.to]);
     return {branchName,records:inventory.slice(0,1500).map(i=>({
      ...i,quantity:Number(i.quantity),available:Number(i.available),
      low_stock_at:Number(i.low_stock_at),
      stock_status:Number(i.available)<=Number(i.low_stock_at)?'Low stock':'In stock',
      branch_name:branchName
     })),movements};
    }
    // ISO weekday and each employee's configured schedule are used for absences.
    // No scheduled shift = no inferred absence. In-progress shifts are not finalized.
    const attendance=await rows(db,`WITH days AS (
      SELECT x::date AS day FROM generate_series($2::date,$3::date,interval '1 day') AS x
    ), scheduled AS (
      SELECT m.user_id,u.name,d.day,ws.branch_id,b.name AS branch,
        to_char(ws.starts_at,'HH24:MI')||'–'||to_char(ws.ends_at,'HH24:MI') AS scheduled
      FROM days d JOIN work_schedules ws ON ws.weekday=extract(isodow FROM d.day)
      JOIN memberships m ON m.tenant_id=ws.tenant_id AND m.user_id=ws.user_id AND m.active
      JOIN users u ON u.id=m.user_id
      LEFT JOIN branches b ON b.tenant_id=ws.tenant_id AND b.id=ws.branch_id
      WHERE ws.tenant_id=$1 AND ($4::uuid IS NULL OR ws.branch_id=$4)
    ), shifts AS (
      SELECT a.user_id,u.name,(a.clock_in AT TIME ZONE 'Asia/Manila')::date AS day,
        a.branch_id,b.name AS branch,a.clock_in,a.clock_out,a.late_minutes,
        COALESCE((SELECT sum(extract(epoch FROM (ab.ended_at-ab.started_at)))
         FROM attendance_breaks ab WHERE ab.tenant_id=a.tenant_id AND ab.attendance_id=a.id
           AND ab.ended_at IS NOT NULL),0) AS break_seconds
      FROM attendance a JOIN users u ON u.id=a.user_id
      LEFT JOIN branches b ON b.tenant_id=a.tenant_id AND b.id=a.branch_id
      WHERE a.tenant_id=$1 AND (a.clock_in AT TIME ZONE 'Asia/Manila')::date BETWEEN $2::date AND $3::date
        AND ($4::uuid IS NULL OR a.branch_id=$4)
    )
    SELECT COALESCE(s.name,a.name) AS name, COALESCE(s.day,a.day)::text AS day,
      COALESCE(a.branch,s.branch,'') AS branch,COALESCE(s.scheduled,'') AS scheduled,
      to_char(a.clock_in AT TIME ZONE 'Asia/Manila','YYYY-MM-DD HH24:MI') AS clock_in,
      to_char(a.clock_out AT TIME ZONE 'Asia/Manila','YYYY-MM-DD HH24:MI') AS clock_out,
      round(COALESCE(a.break_seconds,0)/3600.0,2) AS break_hours,
      round(GREATEST(0,COALESCE(extract(epoch FROM (a.clock_out-a.clock_in)),0)
        -COALESCE(a.break_seconds,0))/3600.0,2) AS work_hours,
      COALESCE(a.late_minutes,0) AS late_minutes,
      CASE WHEN a.clock_in IS NULL AND s.day<CURRENT_DATE THEN 'Absent'
           WHEN a.clock_in IS NULL THEN 'Scheduled'
           WHEN a.clock_out IS NULL THEN 'In progress'
           ELSE 'Completed' END AS status
    FROM scheduled s FULL JOIN shifts a ON a.user_id=s.user_id AND a.day=s.day
    ORDER BY day,name LIMIT 1500`,
     [req.tenant,dates.from,dates.to,branchId]);
    return {branchName,records:attendance};
   },{branchIds:req.branchIds,userId:req.user.id,consistentRead:true});
   const title=section==='inventory'?'Inventory stock report':'Employee attendance timecards';
   const subtitle=dates.from+' – '+dates.to+' · '+result.branchName+' · Generated '+new Date().toISOString()+
    (section==='attendance'?' · Time zone Asia/Manila · For payroll review, not automatic payroll':'');
   const exported=await exportTabular({title,subtitle,columns:section==='inventory'?inventoryCols:attendanceCols,
    records:result.records,format});
   res.set('Cache-Control','private, no-store').type(exported.mime)
    .attachment(section+'-'+dates.from+'-'+dates.to+'.'+format).send(exported.content);
  }));
 }
}
