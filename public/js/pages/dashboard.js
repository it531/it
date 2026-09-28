import { api, session } from '../core/api.js';
import { navigate } from '../core/router.js';
import { icon } from '../core/icons.js';
import { esc, $, h, inr, compactInr, num, ftime, fdate, badge, avatar, countUp, empty, errorState, skeletonKpis, skeletonBlock, toast, ageSex } from '../core/ui.js';
import { lineChart, barChart, donut, hbarChart, sparkline, ring, animateRings, PALETTE } from '../core/charts.js';
import { page, can } from '../shell.js';

const greet = () => { const h = new Date().getHours(); return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'; };

export default async function dashboard(ctx) {
  const me = session.me;
  const name = me.user.is_super_admin ? 'Administrator' : me.doctor ? me.user.full_name : me.user.full_name.split(' ')[0];
  const el = page({
    title: `${greet()}, ${name}`, subtitle: `${esc(me.hospital.name)} · ${new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}`,
    hero: { img: me.doctor ? '/img/consultation.jpg' : can('pharmacy') && !can('opd') ? '/img/pharmacy.jpg' : '/img/reception.jpg', eyebrow: `${me.roles.map((r) => r.name).join(' · ') || 'Dashboard'}`, stats: '<div class="hero-stats" id="hero-stats"></div>' },
    actions: [
      can('patients', 'add') ? `<a class="btn btn-primary" href="/patients/new">${icon('userPlus')}New patient</a>` : '',
      can('opd', 'add') ? `<a class="btn btn-secondary" href="/opd?new=1">${icon('ticket')}OPD token</a>` : '',
      me.doctor ? `<a class="btn btn-primary" href="/opd/doctor">${icon('stethoscope')}Open my queue</a>` : '',
    ].join(''),
  });
  el.innerHTML = `${skeletonKpis(5)}<div class="grid g-main mt-24">${skeletonBlock(320)}${skeletonBlock(320)}</div>`;
  let d;
  try { d = await api.get('/dashboard'); } catch (err) { el.innerHTML = errorState(err, 'retry'); $('#retry').onclick = () => dashboard(ctx); return; }
  if (!ctx.isCurrent()) return;
  el.innerHTML = '';
  const kind = me.dashboard;

  // Hero quick stats
  const hs = [];
  if (d.today) hs.push([d.today.opd_patients, 'OPD today'], [d.today.ipd_patients, 'In-patients']);
  if (d.finance) hs.push([d.finance.revenue_today, 'Collected today', 'inr']);
  if (d.doctor) hs.splice(0, hs.length, [d.doctor.queue.waiting.length, 'Waiting for you'], [d.doctor.stats.completed || 0, 'Seen today'], [d.doctor.appointments.length, 'Appointments']);
  if (d.pharmacy && !d.today) hs.push([d.pharmacy.pending, 'Pending orders'], [d.pharmacy.dispensed, 'Dispensed today']);
  if (d.hr && !d.today) hs.push([d.hr.present, 'Present today'], [d.hr.total, 'Employees']);
  $('#hero-stats').innerHTML = hs.slice(0, 4).map(([v, l, f]) => `<div><b data-count="${v || 0}" ${f ? `data-fmt="${f}"` : ''}>0</b><span>${l}</span></div>`).join('');

  const sections = [];
  if (d.doctor) sections.push(doctorSection(d));
  if (d.today) sections.push(kpiSection(d));
  if (kind === 'pharmacist' && d.pharmacy) sections.unshift(pharmacySection(d));
  if (d.live_opd && !d.doctor) sections.push(liveOpd(d));
  if (d.finance || d.opd_trend) sections.push(trendSection(d));
  if (d.appointments && (kind === 'reception' || kind === 'admin')) sections.push(receptionSection(d));
  if (d.pharmacy && kind !== 'pharmacist') sections.push(pharmacySection(d));
  if (d.ipd || d.lab || d.radiology) sections.push(clinicalSection(d));
  if (d.hr) sections.push(hrSection(d));
  if (d.live_opd && d.doctor) sections.push(liveOpd(d));
  for (const s of sections) if (s) el.appendChild(s);
  if (!sections.length) el.innerHTML = `<div class="panel">${empty({ title: 'Your dashboard is ready', text: 'Modules assigned to you will show live information here.' })}</div>`;
  countUp(document); animateRings(el);

  // Live refresh of queues every 30 s while the page is open.
  const t = setInterval(async () => {
    if (!ctx.isCurrent() || !document.body.contains(el)) return clearInterval(t);
    try { const nd = await api.get('/dashboard'); const lb = $('#live-opd'); if (lb && nd.live_opd) lb.replaceWith(liveOpd(nd)); const dq = $('#doc-queue'); if (dq && nd.doctor) dq.replaceWith(doctorSection(nd)); } catch {}
  }, 30000);
}

function delta(a, b) {
  if (b == null) return '';
  const diff = (a || 0) - (b || 0);
  if (!b) return diff ? `<div class="delta up">${icon('arrowUp')}${num(diff)} vs yesterday</div>` : '<div class="delta flat">Same as yesterday</div>';
  const pct = Math.round((diff / b) * 100);
  return `<div class="delta ${pct > 0 ? 'up' : pct < 0 ? 'down' : 'flat'}">${pct > 0 ? icon('arrowUp') : pct < 0 ? icon('arrowDown') : ''}${Math.abs(pct)}% vs yesterday</div>`;
}

function kpiSection(d) {
  const t = d.today; const f = d.finance; const y = d.yesterday || {};
  const spark = (arr, c) => sparkline((arr || []).map((x) => x.value), c);
  const k = [
    ['Total patients today', t.total_patients, 'patients', '', '/patients'],
    ['New registrations', t.new_patients, 'userPlus', delta(t.new_patients, y.new_patients), '/patients'],
    ['OPD patients', t.opd_patients, 'stethoscope', delta(t.opd_patients, y.opd_patients) + spark(d.opd_trend, PALETTE[0]), '/opd'],
    ['IPD in-patients', t.ipd_patients, 'bed', '', '/ipd'],
    ['Appointments', t.appointments, 'calendar', '', '/appointments'],
    ['Emergency', t.emergency, 'siren', '', '/opd', t.emergency ? 'alert' : ''],
    ['Pending prescriptions', t.pending_prescriptions, 'pill', '', '/pharmacy'],
    ['Pharmacy orders', t.pharmacy_orders, 'box', '', '/pharmacy'],
  ];
  if (f) k.push(['Revenue today', f.revenue_today, 'rupee', delta(f.revenue_today, f.revenue_yesterday) + spark(d.revenue_trend, PALETTE[2]), '/billing', 'accent', 'inr'], ['Outstanding', f.outstanding, 'wallet', '', '/billing?status=outstanding', '', 'cinr']);
  return h(`<div class="kpis ${k.length === 10 ? 'c5' : k.length === 8 ? 'c4' : ''}">${k.map(([l, v, ic, extra, href, cls, fmt]) => `<div class="kpi ${cls || ''}"><div class="label">${icon(ic)}${l}</div><div class="value" data-count="${v || 0}" ${fmt ? `data-fmt="${fmt}"` : ''}>0</div>${extra || ''}${href ? `<a class="stretched" href="${href}" aria-label="${l}"></a>` : ''}</div>`).join('')}</div>`);
}

function doctorSection(d) {
  const q = d.doctor.queue; const doc = session.me.doctor;
  const el = h(`<div class="grid g-main" id="doc-queue" style="margin-bottom:24px">
    <div class="now-serving">
      <div class="row between"><div class="eyebrow">Now serving · ${esc(doc.room || doc.department || '')}</div><span class="live-dot" style="color:#7ff0c4">Live</span></div>
      <div class="token ${q.serving ? 'flash' : ''}">${esc(q.serving ? q.serving.token : '—')}</div>
      <div class="who">${q.serving ? `${esc(q.serving.full_name)} <span>· ${esc(q.serving.uhid)} · ${esc(ageSex({ age: q.serving.dob ? new Date().getFullYear() - Number(q.serving.dob.slice(0, 4)) : null, gender: q.serving.gender }))}</span>` : '<span>No patient in consultation</span>'}</div>
      <div class="row wrap mt-24" style="gap:10px">
        ${q.serving ? `<a class="btn btn-primary" href="/opd/consult/${q.serving.id}">${icon('stethoscope')}Open consultation</a>` : ''}
        <button class="btn ${q.serving ? 'btn-secondary' : 'btn-primary'}" id="dash-call">${icon('skip')}Call next</button>
      </div>
      <div class="eyebrow mt-24" style="margin-bottom:10px">Up next</div>
      <div class="next-tokens">${q.waiting.slice(0, 4).map((w) => `<div class="next-token"><b style="color:#fff">${esc(w.token)}</b><span>${esc(w.full_name.split(' ')[0])}</span></div>`).join('') || '<span style="color:rgba(255,255,255,.6)">Queue is empty</span>'}</div>
    </div>
    <div class="panel"><div class="panel-head"><div><h3>Today at a glance</h3><div class="sub">${esc(doc.department || '')}</div></div></div>
      <div class="panel-body">
        <div class="stat-line"><span class="muted">Patients today</span><b>${num(d.doctor.stats.today)}</b></div>
        <div class="stat-line"><span class="muted">Completed</span><b>${num(d.doctor.stats.completed || 0)}</b></div>
        <div class="stat-line"><span class="muted">Waiting</span><b>${num(q.waiting.length)}</b></div>
        <div class="stat-line"><span class="muted">Average wait</span><b>${q.avg_wait_min != null ? `${q.avg_wait_min} min` : '—'}</b></div>
        <div class="stat-line"><span class="muted">In-patients under you</span><b>${num(d.doctor.ipd.length)}</b></div>
      </div></div>
  </div>`);
  const wrap = h('<div></div>'); wrap.id = 'doc-queue'; el.removeAttribute('id'); wrap.appendChild(el);
  wrap.appendChild(h(`<div class="grid g3" style="margin-bottom:24px">
    <div class="panel"><div class="panel-head"><h3>Today's appointments</h3><a class="small strong" href="/appointments">View all</a></div><div class="panel-body flush list">${d.doctor.appointments.length ? d.doctor.appointments.slice(0, 6).map((a) => `<div class="list-row"><div class="token-pill ghost">${ftime(a.scheduled_at)}</div><div class="grow"><div class="cell-main truncate">${esc(a.patient_name)}</div><div class="cell-sub truncate">${esc(a.reason || a.uhid)}</div></div>${badge(a.status)}</div>`).join('') : empty({ title: 'No appointments today', illo: 'calendar' })}</div></div>
    <div class="panel"><div class="panel-head"><h3>Recent prescriptions</h3></div><div class="panel-body flush list">${d.doctor.recent_prescriptions.length ? d.doctor.recent_prescriptions.map((r) => `<a class="list-row click" href="/print/prescription/${r.id}" target="_blank">${avatar(r.patient_name, 'sm')}<div class="grow"><div class="cell-main truncate">${esc(r.patient_name)}</div><div class="cell-sub">${esc(r.rx_no)} · ${r.items} item(s)</div></div><span class="small muted">${ftime(r.finalized_at)}</span></a>`).join('') : empty({ title: 'No prescriptions yet', illo: 'pill' })}</div></div>
    <div class="panel"><div class="panel-head"><h3>Follow-ups due (7 days)</h3></div><div class="panel-body flush list">${d.doctor.follow_ups.length ? d.doctor.follow_ups.map((f) => `<a class="list-row click" href="/patients/${f.patient_id}">${avatar(f.patient_name, 'sm')}<div class="grow"><div class="cell-main truncate">${esc(f.patient_name)}</div><div class="cell-sub">${esc(f.uhid)} · ${esc(f.mobile)}</div></div><span class="badge teal plain">${fdate(f.follow_up_date)}</span></a>`).join('') : empty({ title: 'No follow-ups this week', illo: 'calendar' })}</div></div>
  </div>`));
  $('#dash-call', wrap).onclick = async (e) => {
    e.currentTarget.classList.add('loading');
    try { const n = await api.post(`/opd/queue/${session.me.doctor.id}/call-next`); toast(`Calling ${n.token} — ${n.full_name}`); navigate(`/opd/consult/${n.id}`); }
    catch (err) { toast(err.message, 'error'); e.currentTarget.classList.remove('loading'); }
  };
  return wrap;
}

function liveOpd(d) {
  const rows = d.live_opd || [];
  const el = h(`<div class="panel section live-board" id="live-opd"><div class="panel-head"><div><h3>Live OPD</h3><div class="sub">Tokens update automatically</div></div><div class="row"><span class="live-dot">Live</span><a class="btn btn-ghost btn-sm" href="/display/opd" target="_blank">${icon('tv')}Display screen</a></div></div>
    <div class="panel-body flush">${rows.length ? `<div class="lb-row lb-head"><div>Doctor</div><div>Department</div><div>Current</div><div>Next</div><div>Waiting</div></div>${rows.map((r) => `<div class="lb-row"><div class="row" style="gap:10px">${avatar(r.name, 'sm')}<div class="truncate"><div class="cell-main truncate">${esc(r.name)}</div><div class="cell-sub">${esc(r.room || '')}${r.avg_wait_min != null ? ` · avg wait ${r.avg_wait_min} min` : ''}</div></div></div><div class="small muted truncate">${esc(r.department || '')}</div><div><span class="token-pill ${r.current ? 'now' : 'ghost'}">${esc(r.current || '—')}</span></div><div><span class="token-pill ${r.next ? '' : 'ghost'}">${esc(r.next || '—')}</span></div><div class="strong num">${r.waiting}</div></div>`).join('')}` : empty({ title: 'No OPD activity yet today', text: 'Register a walk-in or check in an appointment to start the queues.', action: can('opd', 'add') ? '<a class="btn btn-primary" href="/opd?new=1">+ New OPD visit</a>' : '' })}</div></div>`);
  return el;
}

function trendSection(d) {
  const el = h('<div class="grid g-main section"></div>');
  if (d.opd_trend || d.revenue_trend) {
    const p = h(`<div class="panel"><div class="panel-head"><div><h3>${d.revenue_trend ? 'Collections' : 'OPD visits'} · last 14 days</h3><div class="sub">${d.revenue_trend ? 'Net of refunds' : 'All departments'}</div></div><div id="tr-seg"></div></div><div class="panel-body" id="tr-chart"></div></div>`);
    el.appendChild(p);
    const draw = (which) => {
      const c = $('#tr-chart', p); c.innerHTML = '';
      if (which === 'rev' && d.revenue_trend) c.appendChild(lineChart({ data: d.revenue_trend, x: 'day', series: [{ key: 'value', label: 'Collected' }], money: true, area: true, height: 260 }));
      else c.appendChild(lineChart({ data: d.opd_trend || [], x: 'day', series: [{ key: 'value', label: 'OPD visits' }], area: true, height: 260 }));
      $('h3', p).textContent = `${which === 'rev' ? 'Collections' : 'OPD visits'} · last 14 days`;
    };
    if (d.revenue_trend && d.opd_trend) {
      const seg = $('#tr-seg', p); seg.className = 'seg';
      seg.innerHTML = '<button class="on" data-k="rev">Revenue</button><button data-k="opd">OPD</button>';
      seg.onclick = (e) => { const b = e.target.closest('button'); if (!b) return; seg.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b)); draw(b.dataset.k); };
    }
    draw(d.revenue_trend ? 'rev' : 'opd');
  }
  const side = h('<div class="panel"></div>');
  if (d.revenue_mix && d.revenue_mix.length) {
    side.innerHTML = '<div class="panel-head"><div><h3>Revenue mix</h3><div class="sub">This month, billed</div></div></div><div class="panel-body" id="mix"></div>';
    $('#mix', side).appendChild(donut({ data: d.revenue_mix, label: 'service', value: 'value', money: true, size: 170 }));
  } else if (d.department_load) {
    side.innerHTML = '<div class="panel-head"><div><h3>Department load</h3><div class="sub">OPD visits, last 30 days</div></div></div><div class="panel-body" id="mix"></div>';
    $('#mix', side).appendChild(hbarChart({ data: d.department_load, x: 'department', key: 'value' }));
  }
  if (side.innerHTML) el.appendChild(side);
  return el;
}

function receptionSection(d) {
  return h(`<div class="grid g2 section">
    <div class="panel"><div class="panel-head"><div><h3>Appointments today</h3><div class="sub">${d.appointments.length} scheduled</div></div><a class="btn btn-ghost btn-sm" href="/appointments">${icon('calendar')}Calendar</a></div>
      <div class="panel-body flush list">${d.appointments.length ? d.appointments.map((a) => `<div class="list-row"><div class="token-pill ghost">${ftime(a.scheduled_at)}</div><div class="grow"><div class="cell-main truncate">${esc(a.patient_name)} <span class="muted small">${esc(a.uhid)}</span></div><div class="cell-sub truncate">${esc(a.doctor_name)}</div></div>${badge(a.status)}</div>`).join('') : empty({ title: 'No appointments yet', text: 'Book an appointment to see it here.', illo: 'calendar', action: can('appointments', 'add') ? '<a class="btn btn-primary" href="/appointments?new=1">+ Create appointment</a>' : '' })}</div></div>
    <div class="panel"><div class="panel-head"><div><h3>Recent registrations</h3><div class="sub">Latest UHIDs issued</div></div><a class="btn btn-ghost btn-sm" href="/patients">${icon('patients')}All patients</a></div>
      <div class="panel-body flush list">${d.recent_patients.map((p) => `<a class="list-row click" href="/patients/${p.id}">${avatar(p.full_name, 'sm')}<div class="grow"><div class="cell-main">${esc(p.full_name)}</div><div class="cell-sub">${esc(p.uhid)} · ${esc(ageSex(p))} · ${esc(p.mobile)}</div></div><span class="small muted">${fdate(p.created_at)}</span></a>`).join('')}</div></div>
  </div>`);
}

function pharmacySection(d) {
  const p = d.pharmacy;
  return h(`<div class="grid g-main section">
    <div class="panel"><div class="panel-head"><div><h3>Pharmacy</h3><div class="sub">Live queue and stock alerts</div></div><a class="btn btn-ghost btn-sm" href="/pharmacy">${icon('pill')}Open queue</a></div>
      <div class="panel-body"><div class="grid g4" style="gap:0">${[['Now serving', p.serving || '—'], ['Waiting tokens', p.waiting_tokens], ['Ready for pickup', p.ready], ['Dispensed today', p.dispensed]].map(([l, v]) => `<div style="padding:4px 0"><div class="small muted strong">${l}</div><div style="font-size:26px;font-weight:800;letter-spacing:-.02em" ${typeof v === 'number' ? `data-count="${v}"` : ''}>${esc(v)}</div></div>`).join('')}</div>
      <div class="row mt-16 small muted">${icon('arrowRight')}Next: ${p.next.length ? p.next.map((t) => `<span class="token-pill">${esc(t)}</span>`).join(' ') : 'none waiting'}<span class="grow"></span>Sales today <b style="color:var(--ink)">${inr(p.sales_today)}</b></div></div></div>
    <div class="panel"><div class="panel-head"><div><h3>Stock alerts</h3><div class="sub">${p.low_stock.length} low · ${p.expiring.length} expiring ≤30 days · ${p.expired} expired batches</div></div><a class="small strong" href="/inventory">Inventory</a></div>
      <div class="panel-body flush list">${[...p.low_stock.slice(0, 4).map((m) => `<div class="list-row"><span class="badge ${m.stock === 0 ? 'red' : 'amber'}">Low</span><div class="grow truncate strong small">${esc(m.name)} ${esc(m.strength || '')}</div><span class="small num"><b>${m.stock}</b> / ${m.min_stock}</span></div>`), ...p.expiring.slice(0, 4).map((b) => `<div class="list-row"><span class="badge ${b.expiry_date < new Date().toISOString().slice(0, 10) ? 'red' : 'violet'}">${b.expiry_date < new Date().toISOString().slice(0, 10) ? 'Expired' : 'Expiring'}</span><div class="grow truncate strong small">${esc(b.name)} · ${esc(b.batch_no)}</div><span class="small muted">${fdate(b.expiry_date)}</span></div>`)].join('') || empty({ title: 'All stock healthy', illo: 'pill' })}</div></div>
  </div>`);
}

function clinicalSection(d) {
  const el = h('<div class="grid g3 section"></div>');
  if (d.ipd) {
    const pct = d.ipd.total ? (d.ipd.occupied / d.ipd.total) * 100 : 0;
    el.appendChild(h(`<div class="panel"><div class="panel-head"><div><h3>IPD & beds</h3><div class="sub">${d.ipd.occupied} of ${d.ipd.total} beds occupied</div></div><a class="small strong" href="/ipd">Bed map</a></div>
      <div class="panel-body row gap-24">${ring(pct, { label: 'occupancy', color: PALETTE[0] })}<div class="grow">
        <div class="stat-line"><span class="muted">Available beds</span><b>${d.ipd.available}</b></div>
        <div class="stat-line"><span class="muted">ICU occupancy</span><b>${d.ipd.icu_occupied}/${d.ipd.icu_total}</b></div>
        <div class="stat-line"><span class="muted">Admissions today</span><b>${d.ipd.admissions_today}</b></div>
        <div class="stat-line"><span class="muted">Discharges today</span><b>${d.ipd.discharges_today}</b></div></div></div></div>`));
  }
  if (d.lab) el.appendChild(h(`<div class="panel"><div class="panel-head"><div><h3>Laboratory</h3><div class="sub">Work in progress</div></div><a class="small strong" href="/laboratory">Worklist</a></div><div class="panel-body">
    <div class="stat-line"><span class="muted">Awaiting sample</span><b>${d.lab.ordered || 0}</b></div><div class="stat-line"><span class="muted">In process</span><b>${d.lab.in_process || 0}</b></div><div class="stat-line"><span class="muted">Awaiting verification</span><b>${d.lab.awaiting_verification || 0}</b></div><div class="stat-line"><span class="muted">Verified today</span><b>${d.lab.verified_today || 0}</b></div></div></div>`));
  if (d.radiology) el.appendChild(h(`<div class="panel"><div class="panel-head"><div><h3>Radiology</h3><div class="sub">Imaging workflow</div></div><a class="small strong" href="/radiology">Worklist</a></div><div class="panel-body">
    <div class="stat-line"><span class="muted">To scan</span><b>${d.radiology.pending || 0}</b></div><div class="stat-line"><span class="muted">To report</span><b>${d.radiology.to_report || 0}</b></div><div class="stat-line"><span class="muted">To verify</span><b>${d.radiology.to_verify || 0}</b></div></div></div>`));
  return el;
}

function hrSection(d) {
  const x = d.hr;
  return h(`<div class="section"><div class="section-title"><h2>Workforce today</h2><a class="small strong" href="/hr">HR dashboard</a></div><div class="kpis c6">
    ${[['Employees', x.total, 'briefcase'], ['Present', x.present, 'checkCircle'], ['Late', x.late, 'clock'], ['On leave', x.on_leave, 'calendar'], ['Absent / unmarked', x.absent, 'alert'], ['Leave requests', x.pending_leave, 'file']].map(([l, v, ic]) => `<div class="kpi"><div class="label">${icon(ic)}${l}</div><div class="value" data-count="${v || 0}">0</div></div>`).join('')}</div></div>`);
}
