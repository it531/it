import { api, download } from '../core/api.js';
import { navigate, setQuery } from '../core/router.js';
import { icon } from '../core/icons.js';
import { esc, $, $$, fdate, inr, num, badge, avatar, empty, errorState, skeletonRows, skeletonKpis, toast, modal, countUp, tabs, debounce, formData, showErrors, field, select, titleCase, todayISO, confirmDialog } from '../core/ui.js';
import { departments } from '../core/pickers.js';
import { barChart, hbarChart } from '../core/charts.js';
import { page, can } from '../shell.js';

export default async function hr(ctx) {
  if (ctx.params.id) return employee(ctx);
  const el = page({ title: 'HR & employees', subtitle: 'Workforce, attendance, leave and documents.', actions: can('hr', 'add') ? `<button class="btn btn-primary" id="add-emp">${icon('userPlus')}Add employee</button>` : '' });
  el.innerHTML = `<div id="kp">${skeletonKpis(6)}</div><div class="tabs mt-24" id="tabs"></div><div id="body"></div>`;
  const d = await api.get('/hr/dashboard').catch(() => null);
  if (d) {
    $('#kp').innerHTML = `<div class="kpis c6">${[['Employees', d.total, 'briefcase'], ['Present', d.present, 'checkCircle', 'accent'], ['Late', d.late, 'clock'], ['On leave', d.on_leave, 'calendar'], ['Absent / unmarked', d.absent, 'alert', d.absent ? 'alert' : ''], ['Leave requests', d.pending_leave, 'file']].map(([l, v, ic, c]) => `<div class="kpi ${c || ''}"><div class="label">${icon(ic)}${l}</div><div class="value" data-count="${v || 0}">0</div></div>`).join('')}</div>`;
    countUp($('#kp'));
  }
  let tab = ctx.query.tab || 'overview';
  tabs($('#tabs'), [['overview', 'Overview'], ['employees', 'Employees'], ['attendance', 'Attendance'], ['leave', 'Leave']], tab, (k) => { tab = k; setQuery({ tab: k }); render(); });
  const render = () => ({ overview, employees, attendance, leave }[tab])($('#body'));

  function overview(body) {
    if (!d) return (body.innerHTML = errorState({ message: 'Unable to load HR dashboard' }));
    body.innerHTML = `<div class="grid g-main"><div class="panel"><div class="panel-head"><div><h3>Attendance · last 14 days</h3></div></div><div class="panel-body" id="att"></div></div><div class="panel"><div class="panel-head"><h3>Headcount by department</h3></div><div class="panel-body" id="dep"></div></div></div>
      ${d.payroll ? `<div class="callout mt-16">${icon('wallet')}<div>Last payroll: <b>${esc(d.payroll.month)}</b> · ${d.payroll.n} employees · net ${inr(d.payroll.net)}. <a href="/payroll">Open payroll</a></div></div>` : ''}`;
    $('#att').appendChild(barChart({ data: d.trend, x: 'day', series: [{ key: 'present', label: 'Present' }, { key: 'on_leave', label: 'Leave' }, { key: 'absent', label: 'Absent' }], stacked: true, height: 260 }));
    $('#dep').appendChild(hbarChart({ data: d.by_department, x: 'department', key: 'employees' }));
  }
  async function employees(body) {
    const deps = await departments();
    body.innerHTML = `<div class="panel"><div class="panel-body row wrap" style="gap:10px;padding-bottom:12px"><div class="input-icon grow">${icon('search')}<input class="input" id="eq" placeholder="Search name, employee ID, designation"></div><select class="select" id="ed" style="width:220px"><option value="">All departments</option>${deps.map((x) => `<option value="${x.id}">${esc(x.name)}</option>`).join('')}</select></div><div id="el"></div></div>`;
    const load = async () => {
      const rows = await api.get(`/hr/employees?q=${encodeURIComponent($('#eq').value)}&department_id=${$('#ed').value}`);
      $('#el').innerHTML = rows.length ? `<table class="table"><thead><tr><th>Employee</th><th>ID</th><th>Department</th><th>Shift</th><th>Joined</th><th>Today</th><th>Status</th></tr></thead><tbody>${rows.map((e) => `<tr class="click" data-href="/hr/employee/${e.id}"><td><div class="row" style="gap:10px">${avatar(e.full_name, 'sm')}<div><div class="cell-main">${esc(e.full_name)}</div><div class="cell-sub">${esc(e.designation || '')}</div></div></div></td><td class="mono small">${esc(e.emp_code)}</td><td class="small">${esc(e.department || '')}</td><td class="small">${esc(e.shift || '')}</td><td class="small">${fdate(e.joining_date)}</td><td>${e.today_status ? badge(e.today_status) : '<span class="badge grey plain">Unmarked</span>'}</td><td>${badge(e.status)}</td></tr>`).join('')}</tbody></table>` : empty({ title: 'No employees found' });
    };
    $('#eq').oninput = debounce(load, 220); $('#ed').onchange = load; load();
  }
  async function attendance(body) {
    let date = ctx.query.date || todayISO();
    const paint = async () => {
      const rows = await api.get(`/hr/attendance?date=${date}`);
      const unmarked = rows.filter((r) => !r.status);
      body.innerHTML = `<div class="panel"><div class="panel-body row wrap between" style="gap:10px"><div class="row"><input class="input" type="date" id="ad" value="${date}" max="${todayISO()}" style="width:180px"><span class="small muted">${rows.length - unmarked.length}/${rows.length} marked</span></div>${can('hr', 'edit') && unmarked.length ? `<button class="btn btn-secondary btn-sm" id="bulk">${icon('check')}Mark ${unmarked.length} unmarked as present</button>` : ''}</div>
        <table class="table"><thead><tr><th>Employee</th><th>Department</th><th>Shift</th><th>Check-in</th><th>Check-out</th><th class="r">OT h</th><th>Status</th><th></th></tr></thead><tbody>${rows.map((r) => `<tr><td><div class="cell-main">${esc(r.full_name)}</div><div class="cell-sub">${esc(r.emp_code)} · ${esc(r.designation || '')}</div></td><td class="small">${esc(r.department || '')}</td><td class="small">${esc(r.shift || r.default_shift || '')}</td><td class="num">${esc(r.check_in || '—')}</td><td class="num">${esc(r.check_out || '—')}</td><td class="r num">${r.overtime_hours || 0}</td><td>${r.status ? badge(r.status) : '<span class="badge grey plain">Unmarked</span>'}</td>
          <td class="r nowrap">${can('hr', 'edit') ? `${date === todayISO() && !r.check_in && r.status !== 'leave' ? `<button class="btn btn-soft btn-sm" data-ci="${r.employee_id}">Check in</button>` : ''}${date === todayISO() && r.check_in && !r.check_out ? `<button class="btn btn-soft btn-sm" data-co="${r.employee_id}">Check out</button>` : ''}<select class="select input-sm" data-mark="${r.employee_id}" style="width:120px;display:inline-block"><option value="">Mark…</option>${['present', 'late', 'half_day', 'absent', 'leave'].map((s) => `<option value="${s}">${titleCase(s)}</option>`).join('')}</select>` : ''}</td></tr>`).join('')}</tbody></table></div>`;
      $('#ad').onchange = (e) => { date = e.target.value; setQuery({ date }); paint(); };
      const post = async (b) => { try { await api.post('/hr/attendance', { ...b, date }); toast('Attendance updated'); paint(); } catch (err) { toast(err.message, 'error'); } };
      $$('[data-ci]', body).forEach((b) => (b.onclick = () => post({ employee_id: Number(b.dataset.ci), action: 'check_in' })));
      $$('[data-co]', body).forEach((b) => (b.onclick = () => post({ employee_id: Number(b.dataset.co), action: 'check_out' })));
      $$('[data-mark]', body).forEach((s) => (s.onchange = () => s.value && post({ employee_id: Number(s.dataset.mark), action: 'mark', status: s.value })));
      $('#bulk')?.addEventListener('click', async () => { try { const r = await api.post('/hr/attendance/bulk', { date, status: 'present', employee_ids: unmarked.map((u) => u.employee_id) }); toast(`${r.marked} marked present`); paint(); } catch (err) { toast(err.message, 'error'); } });
    };
    paint();
  }
  async function leave(body) {
    const rows = await api.get('/hr/leaves');
    body.innerHTML = `<div class="panel"><div class="panel-head"><h3>Leave requests</h3>${can('hr', 'add') ? `<button class="btn btn-soft btn-sm" id="new-leave">${icon('plus')}New request</button>` : ''}</div><div class="panel-body flush">${rows.length ? `<table class="table"><thead><tr><th>Employee</th><th>Type</th><th>From</th><th>To</th><th class="r">Days</th><th>Reason</th><th>Status</th><th></th></tr></thead><tbody>${rows.map((l) => `<tr><td><div class="cell-main">${esc(l.full_name)}</div><div class="cell-sub">${esc(l.emp_code)} · ${esc(l.department || '')}</div></td><td>${esc(titleCase(l.leave_type))}</td><td>${fdate(l.from_date)}</td><td>${fdate(l.to_date)}</td><td class="r num">${l.days}</td><td class="small">${esc(l.reason || '')}</td><td>${badge(l.status)}${l.approved_by_name ? `<div class="cell-sub">${esc(l.approved_by_name)}</div>` : ''}</td><td class="r nowrap">${l.status === 'pending' && can('hr', 'approve') ? `<button class="btn btn-success btn-sm" data-dec="${l.id}" data-s="approved">Approve</button><button class="btn btn-ghost btn-sm" data-dec="${l.id}" data-s="rejected">Reject</button>` : ''}</td></tr>`).join('')}</tbody></table>` : empty({ title: 'No leave requests' })}</div></div>`;
    $$('[data-dec]', body).forEach((b) => (b.onclick = async () => { try { await api.post(`/hr/leaves/${b.dataset.dec}/decision`, { status: b.dataset.s }); toast(`Leave ${b.dataset.s}`); leave(body); } catch (err) { toast(err.message, 'error'); } }));
    $('#new-leave')?.addEventListener('click', async () => {
      const emps = await api.get('/hr/employees');
      const m = modal({ title: 'New leave request', body: `<form class="form-grid" id="lf">${field('Employee', select('employee_id', emps.map((e) => [e.id, `${e.full_name} (${e.emp_code})`]), ''), { cls: 's12', req: true })}${field('Type', select('leave_type', [['casual', 'Casual'], ['sick', 'Sick'], ['earned', 'Earned'], ['unpaid', 'Unpaid']], 'casual', { blank: null }))}${field('From', `<input class="input" type="date" name="from_date" value="${todayISO()}">`)}${field('To', `<input class="input" type="date" name="to_date" value="${todayISO()}">`)}${field('Reason', '<input class="input" name="reason">', { cls: 's12' })}</form>`, foot: '<button class="btn btn-secondary" data-close>Cancel</button><button class="btn btn-primary" id="lg">Submit</button>' });
      $('#lg', m.el).onclick = async () => { const d2 = formData($('#lf', m.el)); try { await api.post('/hr/leaves', { ...d2, employee_id: Number(d2.employee_id) }); toast('Leave request created'); m.el.remove(); leave(body); } catch (err) { toast(err.message, 'error'); } };
    });
  }
  $('#add-emp')?.addEventListener('click', () => employeeModal(null, (id) => navigate(`/hr/employee/${id}`)));
  render();
}

async function employeeModal(e, done) {
  const deps = await departments();
  const v = e || {}; const s = (e && e.salary) || {};
  const m = modal({ title: e ? `Edit ${e.full_name}` : 'Add employee', subtitle: 'Bank account and PAN are encrypted at rest.', size: 'xl', body: `<form class="form-grid" id="ef">
    ${field('Full name', `<input class="input" name="full_name" value="${esc(v.full_name || '')}">`, { req: true, cls: 's4' })}${field('Department', select('department_id', deps.map((d) => [d.id, d.name]), v.department_id), { cls: 's4' })}${field('Designation', `<input class="input" name="designation" value="${esc(v.designation || '')}">`, { cls: 's4' })}
    ${field('Employment type', select('employment_type', [['full_time', 'Full-time'], ['part_time', 'Part-time'], ['contract', 'Contract'], ['consultant', 'Consultant']], v.employment_type || 'full_time', { blank: null }), { cls: 's3' })}${field('Joining date', `<input class="input" type="date" name="joining_date" value="${esc(v.joining_date || todayISO())}">`, { cls: 's3' })}${field('Shift', select('shift', ['General (09:00-17:00)', 'Morning (07:00-15:00)', 'Evening (15:00-23:00)', 'Night (23:00-07:00)'], v.shift || 'General (09:00-17:00)', { blank: null }), { cls: 's3' })}${field('Status', select('status', [['active', 'Active'], ['on_notice', 'On notice'], ['exited', 'Exited']], v.status || 'active', { blank: null }), { cls: 's3' })}
    ${field('Mobile', `<input class="input" name="phone" value="${esc(v.phone || '')}">`, { cls: 's4' })}${field('Email', `<input class="input" name="email" value="${esc(v.email || '')}">`, { cls: 's4' })}${field('Emergency contact', `<input class="input" name="emergency_contact" value="${esc(v.emergency_contact || '')}">`, { cls: 's4' })}
    ${field('Address', `<input class="input" name="address" value="${esc(v.address || '')}">`, { cls: 's12' })}
    <div class="form-section">Bank & statutory</div>
    ${field('Bank name', `<input class="input" name="bank_name" value="${esc(v.bank_name || '')}">`, { cls: 's3' })}${field('Account number', `<input class="input" name="bank_account" value="${esc(e && /^\d+$/.test(e.bank_account || '') ? e.bank_account : '')}" placeholder="${e && e.bank_account ? esc(e.bank_account) : ''}">`, { cls: 's3' })}${field('IFSC', `<input class="input" name="ifsc" value="${esc(v.ifsc || '')}">`, { cls: 's3' })}${field('PAN', `<input class="input" name="pan" value="${esc(e && e.pan ? e.pan : '')}">`, { cls: 's3' })}
    <div class="form-section">Salary structure (monthly ₹)</div>
    ${['basic', 'hra', 'allowances', 'bonus', 'overtime_rate', 'pf_percent', 'esi_percent', 'professional_tax', 'other_deductions'].map((k) => field({ basic: 'Basic', hra: 'HRA', allowances: 'Allowances', bonus: 'Bonus', overtime_rate: 'Overtime ₹/hour', pf_percent: 'PF %', esi_percent: 'ESI %', professional_tax: 'Professional tax', other_deductions: 'Other deductions' }[k], `<input class="input" type="number" step="0.01" data-sal="${k}" value="${esc(s[k] ?? { pf_percent: 12, esi_percent: 0.75, professional_tax: 200 }[k] ?? 0)}">`, { cls: 's3' })).join('')}
  </form>`, foot: `<button class="btn btn-secondary" data-close>Cancel</button><button class="btn btn-primary" id="eg">${icon('save')}Save</button>` });
  $('#eg', m.el).onclick = async () => {
    const f = $('#ef', m.el); const d = formData(f);
    if (d.department_id) d.department_id = Number(d.department_id); else delete d.department_id;
    if (!d.bank_account) delete d.bank_account; if (!d.pan) delete d.pan;
    d.salary = {}; $$('[data-sal]', m.el).forEach((i) => (d.salary[i.dataset.sal] = Number(i.value || 0)));
    try { const r = e ? await api.put(`/hr/employees/${e.id}`, d) : await api.post('/hr/employees', d); toast(e ? 'Employee updated' : `Employee ${r.emp_code} created`); m.el.remove(); done(e ? e.id : r.id); }
    catch (err) { showErrors(f, err); toast(err.message, 'error'); }
  };
}

async function employee(ctx) {
  const el = page({ title: 'Employee', crumbs: [['/hr', 'HR'], [null, 'Employee']] });
  el.innerHTML = skeletonRows(6, 4);
  let e;
  try { e = await api.get(`/hr/employees/${ctx.params.id}`); } catch (err) { el.innerHTML = errorState(err); return; }
  $('.page-head h1').textContent = e.full_name;
  if (can('hr', 'edit')) $('.page-head').insertAdjacentHTML('beforeend', `<div class="actions"><button class="btn btn-secondary" id="edit">${icon('edit')}Edit</button><label class="btn btn-secondary">${icon('upload')}Upload document<input type="file" id="doc" accept="application/pdf,image/*" hidden></label></div>`);
  const att = e.attendance.reduce((a, r) => ((a[r.status] = (a[r.status] || 0) + 1), a), {});
  el.innerHTML = `<div class="patient-strip">${avatar(e.full_name, 'lg')}<div class="grow"><div class="row" style="gap:10px"><h2>${esc(e.full_name)}</h2>${badge(e.status)}</div><div class="facts mt-8"><div>Employee ID<b class="mono">${esc(e.emp_code)}</b></div><div>Department<b>${esc(e.department || '—')}</b></div><div>Designation<b>${esc(e.designation || '—')}</b></div><div>Joined<b>${fdate(e.joining_date)}</b></div><div>Shift<b>${esc(e.shift || '')}</b></div>${e.username ? `<div>Login<b>@${esc(e.username)}</b></div>` : ''}</div></div></div>
    <div class="grid g3"><div class="panel"><div class="panel-head"><h3>Contact & bank</h3></div><div class="panel-body">${[['Mobile', e.phone], ['Email', e.email], ['Address', e.address], ['Emergency', e.emergency_contact], ['Bank', e.bank_name], ['Account', e.bank_account], ['IFSC', e.ifsc], ['PAN', e.pan || (can('hr', 'edit') ? '—' : 'Restricted')]].map(([k, v]) => `<div class="stat-line"><span class="muted">${k}</span><b class="small" style="text-align:right">${esc(v || '—')}</b></div>`).join('')}</div></div>
      <div class="panel"><div class="panel-head"><h3>Salary structure</h3></div><div class="panel-body">${e.salary ? [['Basic', e.salary.basic], ['HRA', e.salary.hra], ['Allowances', e.salary.allowances], ['Bonus', e.salary.bonus]].map(([k, v]) => `<div class="stat-line"><span class="muted">${k}</span><b>${inr(v)}</b></div>`).join('') + `<div class="stat-line"><span class="strong">Gross</span><b>${inr(e.salary.basic + e.salary.hra + e.salary.allowances + e.salary.bonus)}</b></div><div class="small muted mt-8">PF ${e.salary.pf_percent}% · ESI ${e.salary.esi_percent}% · PT ${inr(e.salary.professional_tax)}</div>` : '<p class="muted small">Not configured</p>'}</div></div>
      <div class="panel"><div class="panel-head"><h3>Last 31 days</h3></div><div class="panel-body">${['present', 'late', 'half_day', 'absent', 'leave'].map((k) => `<div class="stat-line"><span>${badge(k)}</span><b>${att[k] || 0}</b></div>`).join('')}</div></div></div>
    <div class="grid g2 section"><div class="panel"><div class="panel-head"><h3>Documents</h3><span class="small muted">Encrypted at rest</span></div><div class="panel-body flush list">${e.documents.map((d) => `<div class="list-row">${icon('file')}<div class="grow"><div class="cell-main">${esc(d.file_name)}</div><div class="cell-sub">${esc(d.doc_type)} · ${num(Math.round(d.size / 1024))} KB · ${fdate(d.created_at)}</div></div>${can('hr', 'download') ? `<button class="btn btn-ghost btn-sm" data-dl="${d.id}" data-n="${esc(d.file_name)}">${icon('download')}</button>` : ''}</div>`).join('') || '<div class="panel-body small muted">No documents uploaded.</div>'}</div></div>
      <div class="panel"><div class="panel-head"><h3>Payslips</h3></div><div class="panel-body flush list">${e.payroll.map((p) => `<div class="list-row"><div class="grow"><div class="cell-main">${esc(p.month)}</div><div class="cell-sub">Gross ${inr(p.gross)} · deductions ${inr(p.total_deductions)}</div></div><b>${inr(p.net_pay)}</b>${badge(p.status)}<a class="btn btn-ghost btn-sm" href="/print/payslip/${p.id}" target="_blank">${icon('printer')}</a></div>`).join('') || '<div class="panel-body small muted">No payroll processed yet.</div>'}</div></div></div>`;
  $('#edit')?.addEventListener('click', () => employeeModal(e, () => employee(ctx)));
  $('#doc')?.addEventListener('change', async (ev) => {
    const f = ev.target.files[0]; if (!f) return;
    if (f.size > 5 * 1024 * 1024) return toast('File must be under 5 MB', 'error');
    const b64 = await new Promise((res) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.readAsDataURL(f); });
    const type = await confirmDialog({ title: 'Document type', message: `Uploading ${f.name}`, input: 'Type (e.g. Aadhaar, Degree certificate, Offer letter)', confirm: 'Upload' });
    if (!type) return;
    try { await api.post(`/hr/employees/${e.id}/documents`, { doc_type: type, file_name: f.name, mime: f.type, content_base64: b64 }); toast('Document uploaded securely'); employee(ctx); } catch (err) { toast(err.message, 'error'); }
  });
  $$('[data-dl]', el).forEach((b) => (b.onclick = () => download(`/hr/documents/${b.dataset.dl}`, b.dataset.n).catch((err) => toast(err.message, 'error'))));
}
