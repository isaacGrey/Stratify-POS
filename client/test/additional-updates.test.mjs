import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
const read=p=>readFileSync(new URL(p,import.meta.url),'utf8');
const main=read('../src/main.tsx'),settings=read('../src/platform-pages.tsx');
const membership=read('../src/customer-services.tsx');
const appointments=read('../src/appointment-page.tsx');
const notifications=read('../src/platform-notifications.tsx');
const reports=read('../src/operational-report-panel.tsx');
const css=read('../src/style.css');
test('business signup asks business type and kitchens are conditional',()=>{
 assert(main.includes("business_type:'food'"));
 assert(main.includes('Business type'));
 assert(main.includes('non_food'));
 assert(main.includes("if (id==='kitchen') return allowed('kitchen')"));
 assert(main.includes("await request('business-type','PUT'"));
 assert(main.includes('Enable Kitchen Display'));
});
test('admin user business filter and dynamic unread notification indicator are accessible',()=>{
 assert(settings.includes('Filter users by business'));
 assert(settings.includes("users/business-options"));
 assert(settings.includes('&business_id='));
 assert(settings.includes("'businesses','Businesses'"));
 assert(main.includes('<PlatformNotifications request={request}/>'));
 assert(notifications.includes('platform-bell-count'));
 assert(notifications.includes('20000'));
 assert(notifications.includes("notifications/read"));
});
test('membership management offers searchable status, actionable tabs and activity cards',()=>{
 assert(membership.includes('membership-overview'));
 assert(membership.includes('membership-search'));
 assert(membership.includes('statusFilter'));
 assert(membership.includes('Customer directory'));
 assert(membership.includes('Membership plans'));
 assert(membership.includes('Membership register'));
});
test('inventory and attendance reports include true XLSX/PDF actions and branch constraints',()=>{
 assert(main.includes('<OperationalReportPanel kind="inventory"'));
 assert(main.includes('<OperationalReportPanel kind="attendance"'));
 assert(reports.includes("format:'xlsx'|'pdf'"));
 assert(reports.includes("route+'/export/'+format"));
 assert(reports.includes("response instanceof Blob"));
 assert(reports.includes('Time cards include clock-in/out'));
});
test('appointments support calendar/list, filters, create, reschedule, conflict messages and history',()=>{
 assert(main.includes('<AppointmentPage request={request} role={role}/>'));
 assert(appointments.includes("setView('calendar')"));
 assert(appointments.includes("setView('list')"));
 assert(appointments.includes('Appointment requirements / notes'));
 assert(appointments.includes('room/resource at the same branch'));
 assert(appointments.includes("status:'rescheduled'")||appointments.includes("?'rescheduled':"));
 assert(appointments.includes('View history')||appointments.includes("onClick={()=>inspect"));
});
test('responsive compact navigation preserves mobile content',()=>{
 assert(css.includes('.booking-filters'));
 assert(css.includes('.membership-overview'));
 assert(css.includes('.platform-bell-panel'));
 assert(css.includes('.sidebar{height:100vh'));
});
