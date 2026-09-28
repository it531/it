// Super Admin — software-owner SaaS console.
import { api, session } from '../core/api.js';
import { navigate } from '../core/router.js';
import { icon } from '../core/icons.js';
import { esc, $, $$, fdate, fdt, ago, num, compactInr, badge, empty, errorState, skeletonBlock, skeletonKpis, toast, modal, countUp, formData, showErrors, field, select, titleCase, confirmDialog } from '../core/ui.js';
import { barChart, lineChart } from '../core/charts.js';
import { page, reloadMe } from '../shell.js';

const COLORS = ['#1463ff', '#0c9a6a', '#eb6834', '#5a4bd1', '#0d8ea0', '#d6334a'];

export default async function platform(ctx) {
  if (ctx.params.id) return hospitalDetail(ctx);
  const el = page({ title: 'Deep Hospital Platform', subtitle: 'Every hospital on your network — subscriptions, modules, usage and health.',
    hero: { img: '/img/building.jpg', eyebrow: 'Software owner · Super Admin', stats: '<div class="hero-stats" id="hs"></div>' },
    actions: `<button class="btn btn-primary" id="add-h">${icon('plus')}Add hospital</button>` });
  el.innerHTML = `${skeletonKpis(6)}<div class="mt-24">${skeletonBlock(300)}</div>`;
  let s, hs;
  try { [s, hs] = await Promise.all([api.get('/platform/stats'), api.get('/platform/hospitals')]); } catch (err) { el.innerHTML = errorState(err); return; }
  const st = s.stats;
  $('#hs').innerHTML = [['Hospitals', st.hospitals], ['Patients', st.patients], ["Today's OPD", st.opd_today]].map(([l, v]) => `<div><b data-count="${v}">0</b><span>${l}</span></div>`).join('');
  el.innerHTML = `<div class="kpis c6">${[['Total hospitals', st.hospitals, 'building'], ['Active hospitals', st.active_hospitals, 'checkCircle'], ['Total users', st.users, 'patients'], ['Total patients', st.patients, 'user'], ["Today's OPD", st.opd_today, 'stethoscope'], ['Revenue this month', st.revenue_month, 'rupee', 'cinr']].map(([l, v, ic, f]) => `<div class="kpi"><div class="label">${icon(ic)}${l}</div><div class="value" data-count="${v || 0}" ${f ? `data-fmt="${f}"` : ''}>0</div></div>`).join('')}</div>
    <div class="section-title section"><h2>Hospitals</h2><span class="small muted">Click a hospital to manage it, or enter its administration.</span></div>
    <div class="grid g3" id="cards">${hs.map((h, i) => `<div class="panel hover hosp-card ${h.is_active ? '' : 'inactive'}" data-h="${h.id}">
      <div class="row"><div class="logo" style="background:${COLORS[i % COLORS.length]}">${esc(h.name.split(' ').map((w) => w[0]).slice(0, 2).join(''))}</div><div class="grow"><div class="cell-main">${esc(h.name)}</div><div class="cell-sub">${esc(h.code)} · ${esc(h.city || '')}</div></div>${badge(h.is_active ? 'active' : 'inactive', h.is_active ? 'Active' : 'Inactive')}</div>
      <div class="stats"><div><b>${num(h.patients)}</b><span>Patients</span></div><div><b>${num(h.users)}</b><span>Users</span></div><div><b>${num(h.opd_today)}</b><span>OPD today</span></div></div>
      <div class="mods">${h.modules.filter((m) => !['dashboard', 'patients', 'settings', 'audit'].includes(m)).slice(0, 9).map((m) => `<span>${esc(titleCase(m))}</span>`).join('')}${h.modules.length > 13 ? `<span>+${h.modules.length - 13}</span>` : ''}</div>
      <div class="row between small muted"><span>${esc(titleCase(h.plan))} plan · ${esc(h.subscription_status)}</span><span>Active ${h.last_activity_at ? ago(h.last_activity_at) : 'never'}</span></div>
      <div class="row" style="gap:8px"><button class="btn btn-primary btn-sm grow" data-enter="${h.id}" ${h.is_active ? '' : 'disabled'}>${icon('arrowRight')}Enter hospital</button><button class="btn btn-secondary btn-sm" data-manage="${h.id}">${icon('settings')}Manage</button></div></div>`).join('')}</div>
    <div class="grid g2 section"><div class="panel"><div class="panel-head"><div><h3>Network OPD · 14 days</h3><div class="sub">Visits per hospital</div></div></div><div class="panel-body" id="c-opd"></div></div>
      <div class="panel"><div class="panel-head"><div><h3>Patient growth</h3><div class="sub">New registrations per month, all hospitals</div></div></div><div class="panel-body" id="c-gr"></div></div></div>
    <div class="grid g2 section"><div class="panel"><div class="panel-head"><h3>Platform health</h3></div><div class="panel-body"><div class="stat-line"><span class="muted">Database size</span><b>${(s.db_size / 1048576).toFixed(1)} MB</b></div><div class="stat-line"><span class="muted">Last backup</span><b>${s.last_backup ? `${fdt(s.last_backup.created_at)} · ${s.last_backup.status}` : 'Never'}</b></div><div class="stat-line"><span class="muted">Patients admitted now</span><b>${num(st.ipd_now)}</b></div></div></div>
      <div class="panel"><div class="panel-head"><h3>Recent platform activity</h3><a class="small strong" href="#" id="all-audit">View</a></div><div class="panel-body flush list" id="pa"></div></div></div>`;
  countUp(document);
  const codes = [...new Set(s.opd.map((r) => r.code))];
  const days = [...new Set(s.opd.map((r) => r.day))];
  $('#c-opd').appendChild(barChart({ data: days.map((d) => Object.fromEntries([['day', d], ...codes.map((c) => [c, (s.opd.find((r) => r.day === d && r.code === c) || {}).visits || 0])])), x: 'day', series: codes.map((c) => ({ key: c, label: c })), stacked: true, height: 250 }));
  $('#c-gr').appendChild(lineChart({ data: s.growth, x: 'month', series: [{ key: 'patients', label: 'New patients' }], area: true, height: 250 }));
  api.get('/platform/audit').then((rows) => { $('#pa').innerHTML = rows.slice(0, 8).map((r) => `<div class="list-row"><span class="badge grey plain mono" style="font-size:11px">${esc(r.action)}</span><div class="grow small"><b>${esc(r.username || 'system')}</b> ${r.hospital_code ? `· ${esc(r.hospital_code)}` : ''}</div><span class="xs muted">${ago(r.created_at)}</span></div>`).join(''); });
  $('#all-audit').onclick = (e) => { e.preventDefault(); api.get('/platform/audit').then((rows) => modal({ title: 'Platform audit (latest 200)', size: 'xl', body: `<table class="table compact"><tbody>${rows.map((r) => `<tr><td class="small">${fdt(r.created_at)}</td><td class="mono small">${esc(r.hospital_code || '—')}</td><td class="small strong">${esc(r.username || '')}</td><td class="mono small">${esc(r.action)}</td><td class="small muted">${esc(r.ref || '')}</td></tr>`).join('')}</tbody></table>`, foot: null })); };
  $$('[data-enter]', el).forEach((b) => (b.onclick = (e) => { e.stopPropagation(); enter(Number(b.dataset.enter)); }));
  $$('[data-manage]', el).forEach((b) => (b.onclick = (e) => { e.stopPropagation(); navigate(`/platform/hospitals/${b.dataset.manage}`); }));
  $$('[data-h]', el).forEach((c) => (c.onclick = () => navigate(`/platform/hospitals/${c.dataset.h}`)));
  $('#add-h').onclick = addHospital;
}

async function enter(id) {
  await api.post('/auth/switch-hospital', { hospital_id: id });
  await reloadMe();
  toast(`Entered ${session.me.hospital.name}`);
  navigate('/');
}

async function addHospital() {
  const me = session.me;
  const mods = me.all_modules.filter((m) => !m.core);
  const m = modal({ title: 'Add hospital', subtitle: 'Creates an isolated tenant with default roles, settings and a hospital-admin login.', size: 'xl',
    body: `<form class="form-grid" id="hf">${field('Hospital code', '<input class="input" name="code" placeholder="e.g. DH-VAD" style="text-transform:uppercase">', { req: true, cls: 's3', hint: 'Letters, numbers and dashes. Cannot be changed later.' })}${field('Hospital name', '<input class="input" name="name">', { req: true, cls: 's5' })}${field('Plan', select('plan', [['starter', 'Starter'], ['standard', 'Standard'], ['enterprise', 'Enterprise']], 'standard', { blank: null }), { cls: 's2' })}${field('Max users', '<input class="input" type="number" name="max_users" value="100">', { cls: 's2' })}
      ${field('Address', '<input class="input" name="address">', { cls: 's6' })}${field('City', '<input class="input" name="city">', { cls: 's3' })}${field('State', '<input class="input" name="state" value="Gujarat">', { cls: 's3' })}
      ${field('Phone', '<input class="input" name="phone">', { cls: 's4' })}${field('Email', '<input class="input" name="email">', { cls: 's4' })}${field('Subscription valid till', '<input class="input" type="date" name="subscription_expires_on">', { cls: 's4' })}
      <div class="form-section">Modules</div><div class="s12 row wrap" style="gap:8px">${mods.map((x) => `<label class="chip on" style="cursor:pointer"><input type="checkbox" data-mod="${x.key}" checked hidden>${esc(x.name)}</label>`).join('')}</div>
      <div class="form-section">Hospital administrator login</div>${field('Username', '<input class="input" data-a="username" value="hadmin">', { req: true, cls: 's4' })}${field('Full name', '<input class="input" data-a="full_name">', { cls: 's4' })}${field('Temporary password', '<input class="input" data-a="password" type="text" autocomplete="new-password">', { req: true, cls: 's4', hint: 'Min 8 characters — must be changed at first sign-in.' })}</form>`,
    foot: `<button class="btn btn-secondary" data-close>Cancel</button><button class="btn btn-primary" id="hg">${icon('building')}Create hospital</button>` });
  $$('[data-mod]', m.el).forEach((c) => (c.onchange = () => c.parentElement.classList.toggle('on', c.checked)));
  $('#hg', m.el).onclick = async (e) => {
    const f = $('#hf', m.el); const body = formData(f);
    for (const k of Object.keys(body)) if (body[k] === '') delete body[k];
    if (body.max_users) body.max_users = Number(body.max_users);
    body.modules = $$('[data-mod]:checked', m.el).map((c) => c.dataset.mod);
    body.admin = {}; $$('[data-a]', m.el).forEach((i) => (body.admin[i.dataset.a] = i.value.trim()));
    e.currentTarget.classList.add('loading');
    try { const r = await api.post('/platform/hospitals', body); toast(`${body.name} created — hospital admin: ${body.admin.username}`); m.el.remove(); navigate(`/platform/hospitals/${r.id}`); }
    catch (err) { showErrors(f, err); toast(err.message, 'error'); e.currentTarget.classList.remove('loading'); }
  };
}

async function hospitalDetail(ctx) {
  const el = page({ title: 'Hospital', crumbs: [['/platform', 'Platform'], [null, 'Hospital']] });
  el.innerHTML = skeletonBlock(400);
  let h;
  try { h = await api.get(`/platform/hospitals/${ctx.params.id}`); } catch (err) { el.innerHTML = errorState(err); return; }
  $('.page-head h1').textContent = h.name;
  $('.page-head').insertAdjacentHTML('beforeend', `<div class="actions"><button class="btn btn-secondary" id="toggle">${icon('power')}${h.is_active ? 'Deactivate' : 'Activate'}</button><button class="btn btn-primary" id="enter" ${h.is_active ? '' : 'disabled'}>${icon('arrowRight')}Enter hospital administration</button></div>`);
  const me = session.me;
  const enabled = Object.fromEntries(h.modules.map((m) => [m.module, !!m.enabled]));
  el.innerHTML = `<div class="grid g-side"><div class="col gap-20">
      <div class="panel"><div class="panel-head"><div><h3>Module access</h3><div class="sub">Switch modules on or off for ${esc(h.code)}. Changes apply immediately to every user of this hospital.</div></div></div>
        <div class="panel-body grid g3">${me.all_modules.map((m) => `<label class="row" style="padding:12px 14px;border:1px solid var(--line);border-radius:14px;cursor:${m.core ? 'default' : 'pointer'}"><div class="grow"><b class="small">${esc(m.name)}</b>${m.core ? '<div class="xs muted">Core — always on</div>' : ''}</div><span class="switch"><input type="checkbox" data-mod="${m.key}" ${m.core || enabled[m.key] ? 'checked' : ''} ${m.core ? 'disabled' : ''}><span></span></span></label>`).join('')}</div>
        <div class="modal-foot"><button class="btn btn-primary" id="save-mods">${icon('save')}Save modules</button></div></div>
      <div class="panel"><div class="panel-head"><h3>Hospital details & subscription</h3></div><div class="panel-body"><form class="form-grid" id="hf">
        ${field('Name', `<input class="input" name="name" value="${esc(h.name)}">`, { cls: 's6' })}${field('Legal name', `<input class="input" name="legal_name" value="${esc(h.legal_name || '')}">`, { cls: 's6' })}
        ${field('Address', `<input class="input" name="address" value="${esc(h.address || '')}">`, { cls: 's12' })}${field('City', `<input class="input" name="city" value="${esc(h.city || '')}">`, { cls: 's4' })}${field('State', `<input class="input" name="state" value="${esc(h.state || '')}">`, { cls: 's4' })}${field('Phone', `<input class="input" name="phone" value="${esc(h.phone || '')}">`, { cls: 's4' })}
        ${field('Plan', select('plan', [['starter', 'Starter'], ['standard', 'Standard'], ['enterprise', 'Enterprise']], h.plan, { blank: null }), { cls: 's3' })}${field('Subscription', select('subscription_status', [['trial', 'Trial'], ['active', 'Active'], ['past_due', 'Past due'], ['cancelled', 'Cancelled']], h.subscription_status, { blank: null }), { cls: 's3' })}${field('Valid till', `<input class="input" type="date" name="subscription_expires_on" value="${esc(h.subscription_expires_on || '')}">`, { cls: 's3' })}${field('Max users', `<input class="input" type="number" name="max_users" value="${esc(h.max_users)}">`, { cls: 's3' })}
      </form></div><div class="modal-foot"><button class="btn btn-primary" id="save-h">${icon('save')}Save details</button></div></div></div>
    <div class="col gap-20"><div class="panel"><div class="panel-body"><div class="row"><div class="logo" style="width:52px;height:52px;border-radius:16px;background:var(--brand);color:#fff;display:grid;place-items:center;font-weight:800">${esc(h.code.slice(0, 2))}</div><div><h3>${esc(h.code)}</h3><div class="small muted">Created ${fdate(h.created_at)}</div></div></div>
      <div class="mt-16">${[['Status', h.is_active ? 'Active' : 'Inactive'], ['Departments', h.counts.departments], ['Doctors', h.counts.doctors], ['Employees', h.counts.employees], ['Medicines', h.counts.medicines], ['Beds', h.counts.beds], ['Last activity', h.last_activity_at ? ago(h.last_activity_at) : '—']].map(([k, v]) => `<div class="stat-line"><span class="muted">${k}</span><b>${esc(v)}</b></div>`).join('')}</div></div></div>
      <div class="panel"><div class="panel-head"><h3>Hospital administrators</h3></div><div class="panel-body flush list">${h.admins.map((a) => `<div class="list-row"><div class="grow"><div class="cell-main">${esc(a.full_name)}</div><div class="cell-sub mono">@${esc(a.username)}</div></div><span class="xs muted">${a.last_login_at ? ago(a.last_login_at) : 'never signed in'}</span></div>`).join('') || '<div class="panel-body small muted">None</div>'}</div></div>
      <div class="panel"><div class="panel-head"><h3>Branches</h3></div><div class="panel-body flush list">${h.branches.map((b) => `<div class="list-row"><div class="grow"><div class="cell-main">${esc(b.name)}</div><div class="cell-sub">${esc(b.address || '')}</div></div>${b.is_main ? '<span class="badge blue plain">Main</span>' : ''}</div>`).join('')}</div></div></div></div>`;
  $('#save-mods').onclick = async () => { const body = {}; $$('[data-mod]:not(:disabled)', el).forEach((c) => (body[c.dataset.mod] = c.checked)); try { await api.put(`/platform/hospitals/${h.id}/modules`, body); toast('Modules updated'); } catch (err) { toast(err.message, 'error'); } };
  $('#save-h').onclick = async () => { const f = $('#hf'); const body = formData(f); if (body.max_users) body.max_users = Number(body.max_users); for (const k of Object.keys(body)) if (body[k] === '') delete body[k]; try { await api.put(`/platform/hospitals/${h.id}`, body); toast('Hospital updated'); } catch (err) { showErrors(f, err); toast(err.message, 'error'); } };
  $('#toggle').onclick = async () => { if (!(await confirmDialog({ title: `${h.is_active ? 'Deactivate' : 'Activate'} ${h.name}?`, message: h.is_active ? 'All staff sessions for this hospital end immediately and sign-in is blocked. Data is preserved.' : 'Staff will be able to sign in again.', confirm: h.is_active ? 'Deactivate' : 'Activate', danger: h.is_active }))) return; await api.post(`/platform/hospitals/${h.id}/status`, { is_active: !h.is_active }); toast('Status updated'); hospitalDetail(ctx); };
  $('#enter').onclick = () => enter(h.id);
  void compactInr;
}
