// Patient mobile portal — mobile-first, separate session from staff.
import { api, session } from '../core/api.js';
import { navigate } from '../core/router.js';
import { icon, LOGO } from '../core/icons.js';
import { esc, $, $$, h, fdate, ftime, fdt, ago, inr2, badge, empty, toast, modal, todayISO, addDaysISO, titleCase } from '../core/ui.js';

let timer;
export default async function portal(ctx) {
  clearInterval(timer);
  document.title = 'Patient Portal · Deep Hospital';
  const app = document.getElementById('app');
  if (location.pathname === '/portal/login' || !session.portalToken) return login(app);
  let d;
  try { d = await api.get('/portal/me', { portal: true }); } catch { return; }
  const tab = ctx.params.tab || 'home';
  render(app, d, tab);
  timer = setInterval(async () => {
    if (!location.pathname.startsWith('/portal') || !session.portalToken) return clearInterval(timer);
    try { const nd = await api.get('/portal/me', { portal: true }); if (tab === 'home' && JSON.stringify([nd.visits, nd.pharmacy, nd.unread]) !== JSON.stringify([d.visits, d.pharmacy, d.unread])) { const fresh = nd.unread > d.unread; d = nd; render(app, d, tab, true); if (fresh && nd.notifications[0]) toast(nd.notifications[0].body || '', 'info', nd.notifications[0].title); } } catch {}
  }, 10000);
}

async function login(app) {
  const hospitals = await api.get('/public/hospitals').catch(() => []);
  app.innerHTML = `<div class="portal" style="padding-bottom:40px">
    <div class="portal-top" style="padding-bottom:90px;background:linear-gradient(160deg,rgba(11,37,69,.9),rgba(17,70,168,.85)),url('/img/patient-care.jpg') center/cover">
      <div class="row" style="gap:10px">${LOGO}<b style="font-size:17px">Deep Hospital</b></div>
      <h1 style="margin-top:34px;font-size:28px">Your health,<br>in your pocket.</h1>
      <p class="mt-8">Live token status, prescriptions, reports and bills — securely.</p>
    </div>
    <div class="portal-body"><form class="p-card col gap-16" id="pl">
      <h3>Patient sign in</h3>
      <div class="field"><label>Hospital</label><select class="select" id="ph">${hospitals.map((x) => `<option value="${esc(x.code)}" ${x.code === localStorage.getItem('dh.portal.h') ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></div>
      <div class="field"><label>UHID or registered mobile</label><input class="input" id="pu" placeholder="#000001 or 98XXXXXXXX" autocomplete="username"></div>
      <div class="field"><label>Password</label><input class="input" id="pp" type="password" autocomplete="current-password"></div>
      <div id="perr"></div>
      <button class="btn btn-primary btn-lg btn-block" id="pgo">${icon('lock')}Sign in</button>
      <p class="small muted" style="text-align:center">Don’t have a password? Ask the reception desk to activate your portal access.</p>
    </form>
    <div class="secure-note">${icon('shield')}Your records are private and encrypted</div>
    <p class="small" style="text-align:center;margin-top:12px"><a href="/login">Staff sign in</a></p></div></div>`;
  $('#pl').onsubmit = async (e) => {
    e.preventDefault(); $('#pgo').classList.add('loading'); $('#perr').innerHTML = '';
    try { const r = await api.post('/portal/login', { hospital_code: $('#ph').value, login: $('#pu').value.trim(), password: $('#pp').value }); session.setPortal(r.token); localStorage.setItem('dh.portal.h', $('#ph').value); navigate('/portal', { replace: true }); }
    catch (err) { $('#perr').innerHTML = `<div class="callout danger">${icon('alert')}<div>${esc(err.message)}</div></div>`; } finally { $('#pgo')?.classList.remove('loading'); }
  };
}

const STEPS_OPD = [['waiting', 'Waiting'], ['in_consultation', 'With doctor'], ['completed', 'Done']];
const STEPS_PH = [['waiting', 'Queued'], ['processing', 'Preparing'], ['ready', 'Ready'], ['dispensed', 'Collected']];
function steps(list, status) {
  const idx = list.findIndex(([k]) => k === status);
  return `<div class="status-steps">${list.map(([k, l], i) => `<div class="p-step ${i < idx || status === 'dispensed' || status === 'completed' ? 'done' : i === idx ? 'cur' : ''}"><i></i>${l}</div>`).join('')}</div>`;
}

function render(app, d, tab, quiet = false) {
  const p = d.patient;
  const first = p.first_name || p.full_name.split(' ')[0];
  const body = { home, appointments, prescriptions, reports, bills, ipd, alerts, profile }[tab] || home;
  const hr = new Date().getHours();
  app.innerHTML = `<div class="portal">
    <div class="portal-top"><div class="row between"><div class="row" style="gap:10px">${LOGO}<div><b>${esc(d.hospital.name)}</b><div class="xs" style="opacity:.7">Patient portal</div></div></div><a href="/portal/alerts" class="icon-btn" style="color:#fff;position:relative">${icon('bell')}${d.unread ? `<span class="dot-badge">${d.unread}</span>` : ''}</a></div>
      <h1 class="mt-24">${tab === 'home' ? `${hr < 12 ? 'Good morning' : hr < 17 ? 'Good afternoon' : 'Good evening'}, ${esc(first)}` : esc(TITLES[tab] || 'Home')}</h1><p class="mt-4">${esc(p.uhid)} · ${p.age != null ? `${p.age} y` : ''} ${esc(p.gender || '')}${p.blood_group ? ` · ${esc(p.blood_group)}` : ''}</p></div>
    <div class="portal-body" id="pbody">${body(d)}</div>
    <nav class="bottom-nav">${[['/portal', 'Home', 'home', 'home'], ['/portal/appointments', 'Visits', 'calendar', 'appointments'], ['/portal/prescriptions', 'Rx', 'file', 'prescriptions'], ['/portal/reports', 'Reports', 'flask', 'reports'], ['/portal/profile', 'Me', 'user', 'profile']].map(([href, l, ic, k]) => `<a href="${href}" class="${k === tab ? 'on' : ''}">${icon(ic)}${l}</a>`).join('')}</nav></div>`;
  if (quiet) $$('.p-card', app).forEach((c) => (c.style.animation = 'none'));
  wire(app, d, tab);
}
const TITLES = { appointments: 'Appointments', prescriptions: 'Prescriptions', reports: 'Lab & radiology reports', bills: 'Bills & payments', ipd: 'Hospital stays', alerts: 'Notifications', profile: 'My profile' };

function home(d) {
  const out = [];
  for (const v of d.visits.filter((x) => x.status !== 'cancelled')) {
    out.push(`<div class="p-card p-token"><div class="row between"><span class="eyebrow">OPD token · today</span><span class="live-dot">Live</span></div><div class="big">${esc(v.token)}</div><div class="strong">${esc(v.doctor_name)}</div><div class="small muted">${esc(v.department || '')}${v.room ? ` · ${esc(v.room)}` : ''}</div>
      ${v.status === 'waiting' ? `<div class="row mt-16" style="justify-content:center;gap:22px"><div><div class="xs muted strong">NOW SERVING</div><div style="font-size:22px;font-weight:800">${esc(v.now_serving || '—')}</div></div><div><div class="xs muted strong">AHEAD OF YOU</div><div style="font-size:22px;font-weight:800">${v.ahead}</div></div><div><div class="xs muted strong">EST. WAIT</div><div style="font-size:22px;font-weight:800">~${v.est_wait_min}m</div></div></div>` : v.status === 'in_consultation' ? '<div class="callout ok mt-16" style="text-align:left">' + icon('bell') + '<div><b>Please proceed to the consultation room.</b></div></div>' : ''}
      ${steps(STEPS_OPD, v.status)}</div>`);
  }
  const ph = d.pharmacy.find((o) => ['waiting', 'processing', 'ready'].includes(o.status)) || d.pharmacy.find((o) => o.status === 'dispensed' && (o.dispensed_at || '').startsWith(todayISO()));
  if (ph) out.push(`<div class="p-card p-token"><span class="eyebrow">Pharmacy token</span><div class="big" style="color:${ph.status === 'ready' ? 'var(--green)' : 'var(--brand)'}">${esc(ph.token)}</div><div class="strong">${ph.status === 'ready' ? 'Your medicines are ready for pickup' : ph.status === 'dispensed' ? 'Medicines collected' : ph.status === 'processing' ? 'Your medicines are being prepared' : 'Waiting at the pharmacy'}</div>${['waiting', 'processing'].includes(ph.status) ? `<div class="small muted mt-4">Now serving ${esc(ph.now_serving || '—')} · ${ph.ahead} ahead of you</div>` : ''}${steps(STEPS_PH, ph.status)}</div>`);
  out.push(`<div class="p-card"><div class="p-quick">${[['/portal/appointments?book=1', 'Book visit', 'calendar'], ['/portal/prescriptions', 'Prescriptions', 'file'], ['/portal/reports', 'Reports', 'flask'], ['/portal/bills', 'Bills', 'receipt']].map(([href, l, ic]) => `<a href="${href}"><i>${icon(ic)}</i>${l}</a>`).join('')}</div></div>`);
  const next = d.appointments.filter((a) => a.scheduled_at >= todayISO() && ['booked', 'confirmed'].includes(a.status)).sort((a, b) => a.scheduled_at.localeCompare(b.scheduled_at))[0];
  if (next) out.push(`<div class="p-card"><div class="row between"><h3>Next appointment</h3>${badge(next.status)}</div><div class="row mt-12" style="gap:14px"><div style="text-align:center;background:var(--brand-50);border-radius:14px;padding:8px 12px"><div class="xs strong" style="color:var(--brand)">${new Date(next.scheduled_at.replace(' ', 'T')).toLocaleDateString('en-IN', { month: 'short' }).toUpperCase()}</div><div style="font-size:24px;font-weight:800">${next.scheduled_at.slice(8, 10)}</div></div><div><div class="strong">${esc(next.doctor_name)}</div><div class="small muted">${ftime(next.scheduled_at)} · ${esc(next.department || '')}</div></div></div></div>`);
  if (d.followups.length) out.push(`<div class="p-card"><h3>Follow-up due</h3>${d.followups.map((f) => `<div class="stat-line"><span>${esc(f.doctor_name)}</span><b>${fdate(f.follow_up_date)}</b></div>`).join('')}<a class="btn btn-soft btn-sm mt-12" href="/portal/appointments?book=1">Book follow-up</a></div>`);
  const bal = d.bills.reduce((s, b) => s + b.balance, 0);
  if (bal > 0) out.push(`<a class="p-card" href="/portal/bills" style="display:block;color:inherit"><div class="row between"><div><h3>Payment due</h3><div class="small muted">Pay at the billing counter or via UPI</div></div><b style="font-size:20px;color:var(--red)">${inr2(bal)}</b></div></a>`);
  out.push(`<div class="p-card"><div class="row between"><h3>Recent updates</h3><a class="small strong" href="/portal/alerts">All</a></div>${d.notifications.slice(0, 4).map((n) => `<div class="stat-line" style="align-items:flex-start"><div><b class="small">${esc(n.title)}</b><div class="xs muted">${esc(n.body || '')}</div></div><span class="xs muted nowrap">${ago(n.created_at)}</span></div>`).join('') || '<p class="small muted mt-8">No updates yet.</p>'}</div>`);
  return out.join('');
}
function appointments(d) {
  return `<button class="btn btn-primary btn-lg btn-block" id="book">${icon('plus')}Book an appointment</button>${d.appointments.map((a) => `<div class="p-card"><div class="row between"><div><div class="strong">${esc(a.doctor_name)}</div><div class="small muted">${esc(a.department || '')}</div></div>${badge(a.status)}</div><div class="row mt-12 small" style="gap:14px"><span>${icon('calendar')} ${fdate(a.scheduled_at)}</span><span>${icon('clock')} ${ftime(a.scheduled_at)}</span></div>${a.reason ? `<div class="xs muted mt-8">${esc(a.reason)}</div>` : ''}${['booked', 'confirmed'].includes(a.status) && a.scheduled_at > todayISO() ? `<button class="btn btn-ghost btn-sm mt-8" data-cancel="${a.id}">Cancel appointment</button>` : ''}</div>`).join('') || `<div class="p-card">${empty({ title: 'No appointments yet', illo: 'calendar' })}</div>`}`;
}
function prescriptions(d) {
  return d.prescriptions.map((r) => `<div class="p-card"><div class="row between"><div><div class="strong">${esc(r.doctor_name)}</div><div class="small muted">${fdate(r.finalized_at)} · ${esc(r.rx_no)}</div></div><a class="btn btn-soft btn-sm" href="/print/portal-prescription/${r.id}" target="_blank">${icon('download')}PDF</a></div>${r.diagnoses.length ? `<div class="row wrap mt-8" style="gap:6px">${r.diagnoses.map((x) => `<span class="badge blue plain">${esc(x)}</span>`).join('')}</div>` : ''}
    <div class="mt-12 col gap-8">${r.items.map((i) => `<div style="padding:10px 12px;background:var(--bg-soft);border-radius:12px"><div class="strong small">${esc(i.name)} ${esc(i.strength || '')}</div><div class="xs muted">${esc(i.dose || '')} · ${esc(i.frequency || '')} · ${i.duration_days || '—'} days · ${esc(i.route || '')}${i.instructions ? ` · ${esc(i.instructions)}` : ''}</div></div>`).join('') || '<p class="small muted">No medicines prescribed.</p>'}</div>
    ${r.advice ? `<div class="small mt-12"><b>Advice:</b> ${esc(r.advice)}</div>` : ''}${r.follow_up_date ? `<div class="small mt-4"><b>Follow-up:</b> ${fdate(r.follow_up_date)}</div>` : ''}</div>`).join('') || `<div class="p-card">${empty({ title: 'No prescriptions yet', illo: 'pill' })}</div>`;
}
function reports(d) {
  return [...d.labs.map((l) => `<div class="p-card"><div class="row between"><div><div class="strong">${esc(l.test)}</div><div class="small muted">${fdate(l.created_at)} · ${esc(l.order_no)}</div></div>${badge(l.status === 'verified' ? 'completed' : 'pending', l.status === 'verified' ? 'Ready' : 'In progress')}</div>${l.results.length ? `<table class="table compact mt-8" style="font-size:12.5px"><tbody>${l.results.map((r) => `<tr><td>${esc(r.parameter)}</td><td class="r strong" style="color:${r.flag === 'N' || !r.flag ? 'var(--ink)' : r.flag === 'C' ? 'var(--red)' : 'var(--amber)'}">${esc(r.value)} ${esc(r.unit || '')}</td><td class="xs muted">${esc(r.ref_range || '')}</td></tr>`).join('')}</tbody></table>` : '<p class="xs muted mt-8">Results will appear here once verified by the laboratory.</p>'}</div>`),
    ...d.radiology.map((r) => `<div class="p-card"><div class="row between"><div><div class="strong">${esc(r.modality)} · ${esc(r.study)}</div><div class="small muted">${fdate(r.created_at)}</div></div>${badge(r.status === 'verified' ? 'completed' : 'pending', r.status === 'verified' ? 'Ready' : 'In progress')}</div>${r.impression ? `<div class="small mt-8"><b>Impression:</b> ${esc(r.impression)}</div>` : ''}</div>`)].join('') || `<div class="p-card">${empty({ title: 'No reports yet' })}</div>`;
}
function bills(d) {
  const bal = d.bills.reduce((s, b) => s + b.balance, 0);
  return `<div class="p-card"><div class="row between"><span class="muted">Outstanding</span><b style="font-size:22px;color:${bal > 0 ? 'var(--red)' : 'var(--green)'}">${inr2(bal)}</b></div></div>${d.bills.map((b) => `<div class="p-card"><div class="row between"><div><div class="strong">${esc(b.invoice_no)}</div><div class="small muted">${esc(titleCase(b.bill_type))} · ${fdate(b.created_at)}</div></div><div style="text-align:right"><b>${inr2(b.total)}</b><div>${badge(b.status)}</div></div></div><div class="row between mt-8"><span class="small muted">Paid ${inr2(b.paid)} · Balance ${inr2(b.balance)}</span><a class="btn btn-ghost btn-sm" href="/print/portal-invoice/${b.id}" target="_blank">${icon('download')}Invoice</a></div></div>`).join('')}`;
}
function ipd(d) {
  return d.ipd.map((a) => `<div class="p-card"><div class="row between"><div><div class="strong">${esc(a.ipd_no)}</div><div class="small muted">${esc(a.doctor_name)} · ${esc(a.ward || '')} ${esc(a.bed_no || '')}</div></div>${badge(a.status)}</div><div class="small mt-8">Admitted ${fdt(a.admitted_at)}${a.discharged_at ? ` · Discharged ${fdt(a.discharged_at)}` : ''}</div>${a.final_diagnosis ? `<div class="small mt-8"><b>Diagnosis:</b> ${esc(a.final_diagnosis)}</div>` : ''}${a.discharge_summary ? `<details class="mt-8"><summary class="small strong" style="cursor:pointer">Discharge summary</summary><p class="small mt-8">${esc(a.discharge_summary)}</p>${a.discharge_advice ? `<p class="small mt-8"><b>Advice:</b> ${esc(a.discharge_advice)}</p>` : ''}</details>` : ''}</div>`).join('') || `<div class="p-card">${empty({ title: 'No hospital stays', illo: 'bed' })}</div>`;
}
function alerts(d) {
  return `<div class="p-card">${d.notifications.map((n) => `<div class="stat-line" style="align-items:flex-start"><div><b class="small">${esc(n.title)}</b><div class="xs muted">${esc(n.body || '')}</div></div><span class="xs muted nowrap">${ago(n.created_at)}</span></div>`).join('') || '<p class="muted small">No notifications.</p>'}</div>`;
}
function profile(d) {
  const p = d.patient;
  return `<div class="p-card"><div class="row"><div class="avatar lg c1">${esc(p.full_name.split(' ').map((x) => x[0]).slice(0, 2).join(''))}</div><div><h3>${esc(p.full_name)}</h3><div class="small muted mono">${esc(p.uhid)}</div></div></div>
    <div class="mt-16">${[['Date of birth', p.dob ? fdate(p.dob) : '—'], ['Mobile', p.mobile], ['Email', p.email || '—'], ['Blood group', p.blood_group || '—'], ['Address', [p.address, p.city].filter(Boolean).join(', ') || '—'], ['Allergies', p.allergies || 'None recorded']].map(([k, v]) => `<div class="stat-line"><span class="muted">${k}</span><b class="small" style="text-align:right">${esc(v)}</b></div>`).join('')}</div></div>
    <a class="p-card row between" href="/portal/ipd" style="color:inherit"><b>Hospital stays</b>${icon('chevronRight')}</a><a class="p-card row between" href="/portal/bills" style="color:inherit"><b>Bills & payments</b>${icon('chevronRight')}</a>
    <button class="btn btn-secondary btn-block" id="chg">${icon('key')}Change password</button><button class="btn btn-danger btn-block" id="out">${icon('logout')}Sign out</button>
    <p class="xs muted" style="text-align:center">To correct your details, please contact the hospital reception.</p>`;
}

function wire(app, d, tab) {
  if (tab === 'alerts' && d.unread) api.post('/portal/notifications/read', {}, { portal: true }).catch(() => {});
  $('#out')?.addEventListener('click', async () => { try { await api.post('/portal/logout', {}, { portal: true }); } catch {} session.clearPortal(); navigate('/portal/login', { replace: true }); });
  $('#chg')?.addEventListener('click', () => {
    const m = modal({ title: 'Change password', size: 'sm', body: '<div class="col gap-12"><input class="input" type="password" id="c1" placeholder="Current password"><input class="input" type="password" id="c2" placeholder="New password (min 6)"></div>', foot: '<button class="btn btn-primary btn-block" id="cg">Update</button>' });
    $('#cg', m.el).onclick = async () => { try { await api.post('/portal/change-password', { current_password: $('#c1', m.el).value, new_password: $('#c2', m.el).value }, { portal: true }); toast('Password changed'); m.el.remove(); } catch (err) { toast(err.message, 'error'); } };
  });
  $$('[data-cancel]', app).forEach((b) => (b.onclick = async () => { try { await api.post(`/portal/appointments/${b.dataset.cancel}/cancel`, {}, { portal: true }); toast('Appointment cancelled'); navigate('/portal/appointments', { replace: true }); } catch (err) { toast(err.message, 'error'); } }));
  const book = async () => {
    const docs = await api.get('/portal/doctors', { portal: true });
    const m = modal({ title: 'Book an appointment', body: `<div class="col gap-12"><div class="field"><label>Doctor</label><select class="select" id="bd">${docs.map((x) => `<option value="${x.id}">${esc(x.name)} — ${esc(x.department || '')} (₹${x.consultation_fee})</option>`).join('')}</select></div><div class="field"><label>Date</label><div class="row wrap" style="gap:6px" id="bdates">${[0, 1, 2, 3, 4, 5, 6].map((i) => { const dt = addDaysISO(todayISO(), i); return `<button class="chip ${i === 1 ? 'on' : ''}" data-d="${dt}">${new Date(`${dt}T00:00:00`).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric' })}</button>`; }).join('')}</div></div><div class="field"><label>Time</label><div class="row wrap" style="gap:6px" id="bslots"></div></div><div class="field"><label>Reason (optional)</label><input class="input" id="br"></div></div>`, foot: `<button class="btn btn-primary btn-block" id="bgo" disabled>${icon('calendar')}Confirm booking</button>` });
    let date = addDaysISO(todayISO(), 1); let slot = null;
    const load = async () => { slot = null; $('#bgo', m.el).disabled = true; const s = await api.get(`/portal/slots?doctor_id=${$('#bd', m.el).value}&date=${date}`, { portal: true }); $('#bslots', m.el).innerHTML = s.filter((x) => x.available).map((x) => `<button class="chip" data-t="${x.time}">${x.time}</button>`).join('') || '<span class="small muted">No free slots — try another day</span>'; };
    $('#bd', m.el).onchange = load; load();
    $('#bdates', m.el).onclick = (e) => { const c = e.target.closest('[data-d]'); if (!c) return; date = c.dataset.d; $$('#bdates .chip', m.el).forEach((x) => x.classList.toggle('on', x === c)); load(); };
    $('#bslots', m.el).onclick = (e) => { const c = e.target.closest('[data-t]'); if (!c) return; slot = c.dataset.t; $$('#bslots .chip', m.el).forEach((x) => x.classList.toggle('on', x === c)); $('#bgo', m.el).disabled = false; };
    $('#bgo', m.el).onclick = async () => { try { const r = await api.post('/portal/appointments', { doctor_id: Number($('#bd', m.el).value), scheduled_at: `${date} ${slot}`, reason: $('#br', m.el).value }, { portal: true }); m.el.remove(); toast(`Appointment ${r.appt_no} requested`); navigate('/portal/appointments', { replace: true }); } catch (err) { toast(err.message, 'error'); } };
  };
  $('#book')?.addEventListener('click', book);
  if (tab === 'appointments' && new URLSearchParams(location.search).get('book')) { history.replaceState({}, '', '/portal/appointments'); book(); }
  void h;
}
