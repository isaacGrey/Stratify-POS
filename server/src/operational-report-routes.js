import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import {one,rows,scoped} from './db.js';
import {listBalances} from './inventory.js';

const bad=(status,message)=>Object.assign(new Error(message),{status});
const uuid=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const dateOnly=s=>typeof s==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(s)&&
 !Number.isNaN(Date.parse(s))&&new Date(s).toISOString().slice(0,10)===s;
const day=()=>new Date().toISOString().slice(0,10);
export function validateReportPeriod(query,maxDays=92){
 const to=query.to||day(),from=query.from||
  new Date(Date.parse(to)-29*86400000).toISOString().slice(0,10);
 if(!dateOnly(from)||!dateOnly(to)||from>to||Date.parse(to)-Date.parse(from)>maxDays*86400000||
   (query.branch_id&&!uuid.test(query.branch_id)))
   throw bad(400,'Select a valid date range, up to '+maxDays+' days, and branch');
 return {from,to,branch_id:query.branch_id||null};
}
const textColumn=(key,title,width=20)=>({key,title,width});
const inventoryColumns=[
 textColumn('name','Stock item',30),textColumn('item_type','Type'),
 textColumn('inventory_category','Category',24),textColumn('unit','Unit',9),
 textColumn('available','Available'),textColumn('low_stock_at','Reorder level'),
 textColumn('status','Status',14),textColumn('unit_cost','Unit cost (PHP)')];
const movementColumns=[
 textColumn('created_at','Recorded at',26),textColumn('name','Stock item',28),
 textColumn('branch','Branch',20),textColumn('delta','Change'),
 textColumn('movement_type','Type',18),textColumn('reason','Reason',32)];
const timeColumns=[
 textColumn('employee','Employee',25),textColumn('branch','Branch',20),
 textColumn('day','Date'),textColumn('scheduled','Scheduled',21),
 textColumn('clock_in','Time in',26),textColumn('clock_out','Time out',26),
 textColumn('break_hours','Break hours',14),textColumn('hours','Worked hours',15),
 textColumn('late_minutes','Late min',12),textColumn('status','Status',16)];
const summaryColumns=[
 textColumn('employee','Employee',25),textColumn('shifts','Completed shifts'),
 textColumn('hours','Worked hours'),textColumn('late_shifts','Late shifts'),
 textColumn('absent_days','Scheduled absences',22)];

function table(name,columns,rows){return {name,columns,rows};}
const show=x=>x===null||x===undefined?'':x instanceof Date?x.toISOString():String(x);
export async function createOperationalExport(data,format){
 const sheets=data.sheets;
 if(format==='xlsx'){
  const book=new ExcelJS.Workbook();book.creator='StratifyPOS';
  for(const sheet of sheets){
   const ws=book.addWorksheet(sheet.name);
   ws.columns=sheet.columns.map(c=>({header:c.title,key:c.key,width:c.width}));
   ws.getRow(1).font={bold:true,color:{argb:'FFFFFFFF'}};
   ws.getRow(1).fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF183D47'}};
   ws.addRows(sheet.rows.map(row=>Object.fromEntries(sheet.columns.map(c=>[c.key,
     row[c.key]===undefined?'':row[c.key]]))));
   ws.views=[{state:'frozen',ySplit:1}];
   if(sheet.columns.length)ws.autoFilter={from:{row:1,column:1},to:{row:1,column:sheet.columns.length}};
   ws.eachRow(row=>{row.alignment={vertical:'top',wrapText:true};});
  }
  return Buffer.from(await book.xlsx.writeBuffer());
 }
 if(format!=='pdf')throw bad(400,'Use xlsx or pdf');
 return new Promise((resolve,reject)=>{
  const doc=new PDFDocument({size:'A4',layout:'landscape',margin:30});
  const chunks=[];doc.on('data',b=>chunks.push(b));doc.on('error',reject);
  doc.on('end',()=>resolve(Buffer.concat(chunks)));
  doc.fontSize(17).fillColor('#183D47').text(data.title);
  doc.fontSize(9).fillColor('#485D62').text('From '+data.period.from+' to '+data.period.to+
   ' | '+(data.period.branch_name||'All permitted branches'));
  for(const sheet of sheets){
   doc.moveDown(1);
   if(doc.y>480)doc.addPage();
   doc.fontSize(12).fillColor('#183D47').text(sheet.name);
   if(!sheet.rows.length){doc.fontSize(9).text('No records');continue;}
   const headers=sheet.columns.map(c=>c.title);
   const rows=sheet.rows.map(r=>sheet.columns.map(c=>show(r[c.key])));
   doc.fontSize(7).fillColor('#172D33').table({
    maxWidth:doc.page.width-60,
    columnStyles:sheet.columns.map(() => '*'),
    defaultStyle:{padding:3,border:[0,0,0.2,0],borderColor:'#CCD8DB'},
    rowStyles:index=>index===0?{backgroundColor:'#EAF1F3'}:{},
    data:[headers,...rows]
   });
  }
  doc.end();
 });
}

async function inventory(db,req,period){
 const stockPolicy=await one(db,'SELECT branch_stock_enabled FROM shop_settings WHERE tenant_id=$1',[req.tenant]);
 const branch=period.branch_id;
 if(req.branchIds!==null&&!branch)throw bad(400,'Select an assigned branch for this report');
 if(branch){
  const b=await one(db,'SELECT name FROM branches WHERE tenant_id=$1 AND id=$2',[req.tenant,branch]);
  if(!b)throw bad(404,'Branch unavailable');period.branch_name=b.name;
 }
 // Match the existing stock/balances API, including unallocated vs branch stock.
 const balances=await listBalances(db,req.tenant,stockPolicy.branch_stock_enabled?branch:null);
 const stock=balances.map(p=>({
  name:p.name,item_type:p.item_type,inventory_category:p.inventory_category||'',
  unit:p.unit,available:Number(p.available),low_stock_at:Number(p.low_stock_at),
  status:Number(p.available)<=Number(p.low_stock_at)?'Low stock':'Available',
  unit_cost:Number(p.unit_cost_cents||0)/100
 }));
 const n=await one(db,`SELECT count(*)::int AS n FROM stock_movements m
  WHERE m.tenant_id=$1 AND ($2::uuid IS NULL OR m.branch_id=$2)
   AND m.created_at >= $3::date AND m.created_at < ($4::date+interval '1 day')`,
  [req.tenant,branch,period.from,period.to]);
 if(n.n>10000)throw bad(422,'Too many movements. Narrow the date range or branch.');
 const movements=await rows(db,`SELECT to_char(m.created_at AT TIME ZONE 'Asia/Manila',
    'YYYY-MM-DD HH24:MI') AS created_at,i.name,b.name AS branch,
    m.delta,m.movement_type,m.reason
    FROM stock_movements m JOIN ingredients i ON i.tenant_id=m.tenant_id AND i.id=m.ingredient_id
    LEFT JOIN branches b ON b.tenant_id=m.tenant_id AND b.id=m.branch_id
    WHERE m.tenant_id=$1 AND ($2::uuid IS NULL OR m.branch_id=$2)
      AND m.created_at >= $3::date AND m.created_at < ($4::date+interval '1 day')
    ORDER BY m.created_at DESC,m.id DESC LIMIT 10000`,
   [req.tenant,branch,period.from,period.to]);
 const summary=[
  {metric:'Tracked items',value:stock.length},
  {metric:'Low stock items',value:stock.filter(x=>x.status==='Low stock').length},
  {metric:'Recorded stock movements',value:movements.length},
  {metric:'Stock accounting',value:stockPolicy.branch_stock_enabled?
    (branch?'Branch balance':'Unallocated balance'):'Shared stock'}
 ];
 return {title:'Inventory Reports',period,sheets:[
  table('Overview',[textColumn('metric','Metric',30),textColumn('value','Value',24)],summary),
  table('Stock levels',inventoryColumns,stock),
  table('Stock movements',movementColumns,movements)
 ]};
}

async function attendance(db,req,period){
 if(req.branchIds!==null&&!period.branch_id)throw bad(400,'Select an assigned branch for this report');
 if(period.branch_id){
  const b=await one(db,'SELECT name FROM branches WHERE tenant_id=$1 AND id=$2',[req.tenant,period.branch_id]);
  if(!b)throw bad(404,'Branch unavailable');period.branch_name=b.name;
 }
 const args=[req.tenant,period.from,period.to,period.branch_id];
 const sessions=await rows(db,`SELECT u.id AS user_id,u.name AS employee,
   b.name AS branch,to_char(a.clock_in AT TIME ZONE 'Asia/Manila','YYYY-MM-DD') AS day,
   COALESCE(to_char(a.scheduled_start_at AT TIME ZONE 'Asia/Manila','YYYY-MM-DD HH24:MI'),'—') AS scheduled,
   to_char(a.clock_in AT TIME ZONE 'Asia/Manila','YYYY-MM-DD HH24:MI') AS clock_in,
   to_char(a.clock_out AT TIME ZONE 'Asia/Manila','YYYY-MM-DD HH24:MI') AS clock_out,
   round(COALESCE(br.break_seconds,0)/3600.0,2) AS break_hours,
   CASE WHEN a.clock_out IS NOT NULL THEN
    round(greatest(0,extract(epoch FROM (a.clock_out-a.clock_in))-
      COALESCE(br.break_seconds,0))/3600.0,2) ELSE NULL END AS hours,
   a.late_minutes,
   CASE WHEN a.clock_out IS NULL THEN 'Open shift' ELSE 'Completed' END AS status
   FROM attendance a
   JOIN users u ON u.id=a.user_id
   LEFT JOIN branches b ON b.tenant_id=a.tenant_id AND b.id=a.branch_id
   LEFT JOIN LATERAL (
    SELECT sum(extract(epoch FROM
      (COALESCE(ab.ended_at,least(now(),COALESCE(a.clock_out,now())))-ab.started_at))) AS break_seconds
      FROM attendance_breaks ab WHERE ab.tenant_id=a.tenant_id AND ab.attendance_id=a.id
   ) br ON true
   WHERE a.tenant_id=$1 AND (a.clock_in AT TIME ZONE 'Asia/Manila')::date BETWEEN $2::date AND $3::date
    AND ($4::uuid IS NULL OR a.branch_id=$4)
   ORDER BY employee,day,a.clock_in LIMIT 10000`,args);
 // Absent only where a current weekly schedule exists and an entire past
 // scheduled date has no recorded shift. Historical schedule revisions are not versioned.
 const absent=await rows(db,`WITH days AS (
   SELECT day::date FROM generate_series($2::date,
    least($3::date,(now() AT TIME ZONE 'Asia/Manila')::date-1),
    interval '1 day') AS day
  )
  SELECT u.id AS user_id,u.name AS employee,b.name AS branch,
    d.day::text AS day,(d.day::text||' '||left(w.starts_at::text,5)) AS scheduled
  FROM days d JOIN work_schedules w
    ON w.weekday=extract(isodow FROM d.day)::int AND w.tenant_id=$1
  JOIN memberships m ON m.tenant_id=w.tenant_id AND m.user_id=w.user_id AND m.active
  JOIN users u ON u.id=w.user_id AND u.active
  LEFT JOIN branches b ON b.tenant_id=w.tenant_id AND b.id=w.branch_id
  WHERE ($4::uuid IS NULL OR w.branch_id=$4)
    AND NOT EXISTS (
     SELECT 1 FROM attendance a WHERE a.tenant_id=w.tenant_id AND a.user_id=w.user_id
      AND (a.clock_in AT TIME ZONE w.time_zone)::date=d.day
    )
  ORDER BY u.name,d.day LIMIT 10000`,args);
 const combined=[...sessions.map(r=>({...r,hours:r.hours===null?'':Number(r.hours),
  break_hours:Number(r.break_hours),late_minutes:r.late_minutes||0})),
 ...absent.map(r=>({...r,clock_in:'',clock_out:'',hours:'',break_hours:'',
   late_minutes:'',status:'Absent (scheduled)'}))].sort((a,b)=>
   a.employee.localeCompare(b.employee)||a.day.localeCompare(b.day));
 if(combined.length>10000)throw bad(422,'Too many attendance rows. Narrow the range.');
 const users=new Map();
 for(const record of combined){
  const entry=users.get(record.user_id)||{employee:record.employee,shifts:0,hours:0,late_shifts:0,absent_days:0};
  if(record.status==='Completed'){entry.shifts++;entry.hours+=Number(record.hours)||0;
    if(Number(record.late_minutes)>0)entry.late_shifts++;}
  if(record.status==='Absent (scheduled)')entry.absent_days++;
  users.set(record.user_id,entry);
 }
 const summary=[...users.values()].map(r=>({...r,hours:Math.round(r.hours*100)/100}));
 return {title:'Employee Attendance Time Cards',period,sheets:[
  table('Employee summary',summaryColumns,summary),
  table('Time cards',timeColumns,combined),
  table('Methodology',[textColumn('note','Important note',90)],[
   {note:'Hours are recorded time between clock-in and clock-out minus recorded breaks.'},
   {note:'An open shift is not counted as completed work. Review missing clock-outs.'},
   {note:'Scheduled absences are indicative only: current weekly schedules are compared with past dates. Prior schedule changes, approved leave and holidays are not recorded as historical revisions.'},
   {note:'This report is a payroll reference, not automatic payroll, wage calculations, or an approved timesheet.'}
  ])
 ]};
}

export function registerOperationalReportRoutes(app,{wrap,permit,scopeOptions}){
 const auth=permit('owner','manager');
 for(const kind of ['inventory','attendance']){
  app.get('/api/shop/'+kind+'-reports',auth,wrap(async(req,res)=>{
   const period=validateReportPeriod(req.query);
   const data=await scoped(req.tenant,db=>kind==='inventory'?
    inventory(db,req,period):attendance(db,req,period),
    {consistentRead:true,...scopeOptions(req)});
   res.set('Cache-Control','no-store').json(data);
  }));
  app.get('/api/shop/'+kind+'-reports/export/:format',auth,wrap(async(req,res)=>{
   const format=req.params.format;
   if(!['xlsx','pdf'].includes(format))throw bad(400,'Unknown export format');
   const period=validateReportPeriod(req.query);
   const data=await scoped(req.tenant,db=>kind==='inventory'?
    inventory(db,req,period):attendance(db,req,period),
    {consistentRead:true,...scopeOptions(req)});
   const output=await createOperationalExport(data,format);
   res.set('Cache-Control','no-store')
    .type(format==='xlsx'?
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':'application/pdf')
    .attachment('stratify-'+kind+'-'+period.from+'_'+period.to+'.'+format)
    .send(output);
  }));
 }
}
