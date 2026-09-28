import { api, session } from '../core/api.js';
import { navigate, setQuery } from '../core/router.js';
import { icon } from '../core/icons.js';
import { esc, $, $$, h, ftime, badge, avatar, ageSex, empty, errorState, skeletonKpis, skeletonBlock, toast, modal, drawer, countUp, confirmDialog, num } from '../core/ui.js';
import { patientPicker, doctorOptions, doctors, invalidate } from '../core/pickers.js';
import { page, can } from '../shell.js';
import { tokenIssued } from './patients.js';

export default async function opd(ctx) {
  if (location.pathname === '/opd/doctor') return doctorQueue(ctx);
  return board(ctx);
}

async function board(ctx) {
  const el = page({ title: 'OPD', subtitle: 'Live token queues across every consulting room.',
    actions: `${can('opd', 'add') ? `<button class="btn btn-primary" id="new-visit">${icon('ticket')}New OPD visit</button>` : ''}<a class="btn btn-secondary" href="/display/opd" target="_blank">${icon('tv')}Token display</a>` });
  el.innerHTML = `${skeletonKpis(6)}<div class="mt-24">${skeletonBlock(300)}</div>`;
  const load = async () => {
    let d, visits;
    try { [d, visits] = await Promise.all([api.get('/opd/dashboard'), api.get(`/opd/visits${ctx.query.doctor ? `?doctor_id=${ctx.query.doctor}` : ''}`)]); }
    catch (err) { el.innerHTML = errorState(err, 'retry'); $('#retry').onclick = load; return; }
    if (!ctx.isCurrent()) return;
    const s = d.stats;
    el.innerHTML = `<div class="kpis c4">${[['Today’s OPD', s.total, 'stethoscope'], ['Waiting', s.waiting, 'clock'], ['In consultation', s.in_consultation, 'doctor'], ['Completed', s.completed, 'checkCircle'], ['Appointments', s.appointments, 'calendar'], ['Walk-ins', s.walk_ins, 'patients'], ['Emergency', s.emergency, 'siren'], ['New patients', s.new_patients, 'userPlus']].map(([l, v, ic]) => `<div class="kpi ${l === 'Emergency' && v ? 'alert' : ''}"><div class="label">${icon(ic)}${l}</div><div class="value" data-count="${v || 0}">0</div></div>`).join('')}</div>
      <div class="section-title section"><h2>Consulting rooms</h2><span class="live-dot">Live · refreshes every 15 s</span></div>
      <div class="grid g3" id="rooms">${d.doctors.map((doc) => `<div class="panel hover" data-doc="${doc.id}" style="cursor:pointer">
        <div class="panel-body">
          <div class="row">${avatar(doc.name)}<div class="grow"><div class="cell-main truncate">${esc(doc.name)}</div><div class="cell-sub truncate">${esc(doc.department || '')} · ${esc(doc.room || '')}</div></div><span class="badge ${doc.waiting ? 'amber' : 'grey'} plain">${doc.waiting} waiting</span></div>
          <div class="row mt-16" style="align-items:flex-end;gap:16px"><div><div class="eyebrow">Now serving</div><div style="font-size:40px;font-weight:800;letter-spacing:-.03em;color:${doc.serving ? 'var(--brand)' : 'var(--ink-4)'};line-height:1.1">${esc(doc.serving || '—')}</div></div>
          <div class="grow"><div class="eyebrow" style="margin-bottom:6px">Next</div><div class="row wrap" style="gap:6px">${doc.next.map((t) => `<span class="token-pill">${esc(t)}</span>`).join('') || '<span class="small muted">—</span>'}</div></div></div>
          <div class="row mt-16 small muted nowrap" style="gap:8px">${doc.completed} done · ${doc.avg_wait_min != null ? `${doc.avg_wait_min} min avg wait` : 'no wait data yet'}<span class="grow"></span><span class="badge blue plain" title="Token series">${esc(doc.token_prefix)}-series</span></div>
        </div></div>`).join('')}</div>
      <div class="section-title section"><h2>Today’s visits</h2><div class="row"><select class="select input-sm" id="fdoc" style="width:220px"><option value="">All doctors</option>${d.doctors.map((x) => `<option value="${x.id}" ${String(x.id) === ctx.query.doctor ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></div></div>
      <div class="panel">${visits.length ? `<div class="table-wrap"><table class="table"><thead><tr><th>Token</th><th>Patient</th><th>Doctor</th><th>Type</th><th>Registered</th><th>Status</th><th></th></tr></thead><tbody>${visits.map((v) => `<tr><td><span class="token-pill ${v.status === 'in_consultation' ? 'now' : v.status === 'completed' ? 'ghost' : ''}">${esc(v.token)}</span></td>
        <td><div class="cell-main"><a href="/patients/${v.patient_id}">${esc(v.patient_name)}</a></div><div class="cell-sub">${esc(v.uhid)} · ${esc(ageSex({ gender: v.gender, age: v.dob ? new Date().getFullYear() - Number(v.dob.slice(0, 4)) : null }))}</div></td>
        <td>${esc(v.doctor_name)}<div class="cell-sub">${esc(v.department || '')}</div></td><td>${badge(v.visit_type)}</td><td>${ftime(v.registered_at)}</td><td>${badge(v.status)}</td>
        <td class="r nowrap"><a class="btn btn-ghost btn-sm" href="/print/opd-slip/${v.id}" target="_blank" title="Print OPD slip">${icon('printer')}</a>${v.status === 'waiting' && can('opd', 'edit') ? `<button class="btn btn-ghost btn-sm" data-cancel="${v.id}" title="Cancel visit">${icon('x')}</button>` : ''}</td></tr>`).join('')}</tbody></table></div>`
        : empty({ title: 'No OPD visits yet today', text: 'Register a walk-in or check in an appointment to start the queues.', action: can('opd', 'add') ? `<button class="btn btn-primary" id="new-visit-2">${icon('plus')}New OPD visit</button>` : '' })}</div>`;
    countUp(el);
    $('#rooms').onclick = (e) => { const c = e.target.closest('[data-doc]'); if (c) queueDrawer(Number(c.dataset.doc), load); };
    $('#fdoc').onchange = (e) => { setQuery({ doctor: e.target.value }); ctx.query.doctor = e.target.value; load(); };
    $('#new-visit-2')?.addEventListener('click', () => newVisit(load));
    $$('[data-cancel]', el).forEach((b) => (b.onclick = async () => { if (!(await confirmDialog({ title: 'Cancel this visit?', message: 'The token will be removed from the queue and any unpaid consultation invoice cancelled.', confirm: 'Cancel visit', danger: true }))) return; try { await api.post(`/opd/visits/${b.dataset.cancel}/status`, { status: 'cancelled' }); toast('Visit cancelled'); load(); } catch (err) { toast(err.message, 'error'); } }));
  };
  $('#new-visit')?.addEventListener('click', () => newVisit(load));
  if (ctx.query.new) { setQuery({ new: null }); newVisit(load); }
  await load();
  const t = setInterval(() => { if (!ctx.isCurrent() || !document.body.contains(el)) return clearInterval(t); if (!document.querySelector('.backdrop, .drawer-wrap')) load(); }, 15000);
}

export async function newVisit(onDone, preset = {}) {
  invalidate('doctors');
  const m = modal({ title: 'New OPD visit', subtitle: 'Search the patient — the token is generated automatically.', size: 'lg',
    body: `<div class="col gap-16">
      <div class="field"><label>Patient <span class="req">*</span></label><div class="input-icon">${icon('search')}<input class="input" id="nv-p" placeholder="UHID, name or mobile"></div><div id="nv-sel" class="mt-8"></div><div class="small muted">Patient not found? <a href="/patients/new" data-close>Register a new patient</a></div></div>
      <div class="form-grid"><div class="field s8"><label>Doctor <span class="req">*</span></label><select class="select" id="nv-doc">${await doctorOptions(preset.doctor_id)}</select></div>
      <div class="field s4"><label>Visit type</label><select class="select" id="nv-type"><option value="new">New consultation</option><option value="followup">Follow-up</option>${session.me.modules.includes('emergency') ? '<option value="emergency">Emergency (priority)</option>' : ''}</select></div>
      <div class="field s12"><label>Chief complaint</label><input class="input" id="nv-cc" placeholder="e.g. Fever since 2 days"></div></div></div>`,
    foot: `<button class="btn btn-secondary" data-close>Cancel</button><button class="btn btn-primary" id="nv-go" disabled>${icon('ticket')}Generate token</button>` });
  let patient = null;
  const pick = (p) => { patient = p; $('#nv-sel', m.el).innerHTML = `<div class="row" style="padding:12px;border:1px solid var(--brand-200);border-radius:14px;background:var(--brand-50)">${avatar(p.full_name)}<div class="grow"><div class="cell-main">${esc(p.full_name)}</div><div class="cell-sub">${esc(p.uhid)} · ${esc(ageSex(p))} · ${esc(p.mobile)}</div></div>${p.visits ? `<span class="badge teal plain">${p.visits} prior visits</span>` : '<span class="badge blue plain">First visit</span>'}</div>`; $('#nv-p', m.el).value = ''; $('#nv-go', m.el).disabled = false; if (p.visits) $('#nv-type', m.el).value = 'followup'; };
  patientPicker($('#nv-p', m.el), pick);
  if (preset.patient) pick(preset.patient);
  $('#nv-go', m.el).onclick = async (e) => {
    if (!patient) return;
    e.currentTarget.classList.add('loading');
    try {
      const v = await api.post('/opd/visit', { patient_id: patient.id, doctor_id: Number($('#nv-doc', m.el).value), visit_type: $('#nv-type', m.el).value, chief_complaint: $('#nv-cc', m.el).value });
      m.el.remove(); tokenIssued(v, patient.full_name, patient.uhid); onDone && onDone();
    } catch (err) { toast(err.message, 'error'); e.currentTarget.classList.remove('loading'); }
  };
}

async function queueDrawer(doctorId, onChange) {
  const d = drawer({ title: 'Doctor queue', size: 'wide', body: skeletonBlock(300), foot: null });
  const render = async () => {
    const q = await api.get(`/opd/queue/${doctorId}`);
    $('.modal-head h2', d.el).textContent = q.doctor.name;
    d.body.innerHTML = `<div class="now-serving" style="padding:22px"><div class="eyebrow">Now serving · ${esc(q.doctor.room || '')}</div><div class="token" style="font-size:64px">${esc(q.serving ? q.serving.token : '—')}</div><div class="who">${q.serving ? `${esc(q.serving.full_name)} <span>· ${esc(q.serving.uhid)}</span>` : '<span>No patient in consultation</span>'}</div>
      ${can('opd', 'edit') ? `<div class="row mt-16"><button class="btn btn-primary" id="q-next" ${q.waiting.length ? '' : 'disabled'}>${icon('skip')}Call next</button></div>` : ''}</div>
      <h3 class="mt-24 mb-16">Waiting (${q.waiting.length})</h3><div class="col gap-8">${q.waiting.map((w, i) => `<div class="queue-item ${w.visit_type === 'emergency' ? 'emergency' : ''}" style="animation-delay:${i * 0.03}s"><div class="tok">${esc(w.token)}</div><div class="grow"><div class="cell-main">${esc(w.full_name)}</div><div class="cell-sub">${esc(w.uhid)} · since ${ftime(w.registered_at)}${w.chief_complaint ? ` · ${esc(w.chief_complaint)}` : ''}</div></div>${w.visit_type === 'emergency' ? badge('emergency') : ''}${can('opd', 'edit') ? `<button class="btn btn-ghost btn-sm" data-call="${w.id}">Call</button><button class="btn btn-ghost btn-sm" data-ns="${w.id}" title="Mark no-show">No-show</button>` : ''}</div>`).join('') || empty({ title: 'Nobody waiting' })}</div>
      <h3 class="mt-24 mb-16">Completed (${q.completed.length})</h3><div class="col gap-8">${q.completed.map((w) => `<div class="queue-item"><div class="tok" style="background:var(--bg-sunken);color:var(--ink-3)">${esc(w.token)}</div><div class="grow"><div class="cell-main">${esc(w.full_name)}</div><div class="cell-sub">${esc(w.uhid)} · done ${ftime(w.completed_at)}</div></div>${badge('completed')}</div>`).join('') || '<p class="muted small">None yet</p>'}</div>`;
    $('#q-next', d.el)?.addEventListener('click', async () => { try { const n = await api.post(`/opd/queue/${doctorId}/call-next`); toast(`${n.token} called — ${n.full_name}`); render(); onChange(); } catch (err) { toast(err.message, 'error'); } });
    $$('[data-call]', d.el).forEach((b) => (b.onclick = async () => { try { const n = await api.post(`/opd/queue/${doctorId}/call-next`, { visit_id: Number(b.dataset.call) }); toast(`${n.token} called`); render(); onChange(); } catch (err) { toast(err.message, 'error'); } }));
    $$('[data-ns]', d.el).forEach((b) => (b.onclick = async () => { try { await api.post(`/opd/visits/${b.dataset.ns}/status`, { status: 'no_show' }); toast('Marked as no-show'); render(); onChange(); } catch (err) { toast(err.message, 'error'); } }));
  };
  render().catch((err) => (d.body.innerHTML = errorState(err)));
}

// ───────────────── Doctor's own queue ─────────────────
async function doctorQueue(ctx) {
  const me = session.me;
  const docs = await doctors().catch(() => []);
  let doctorId = me.doctor ? me.doctor.id : Number(ctx.query.doctor) || (docs[0] && docs[0].id);
  const el = page({ title: me.doctor ? 'My consultations' : 'Doctor queue', subtitle: me.doctor ? `${esc(me.doctor.department || '')} · ${esc(me.doctor.room || '')}` : 'Select a doctor to manage their queue.',
    actions: me.doctor ? '' : `<select class="select" id="doc-sel" style="width:260px">${docs.map((d) => `<option value="${d.id}" ${d.id === doctorId ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}</select>` });
  $('#doc-sel')?.addEventListener('change', (e) => { doctorId = Number(e.target.value); setQuery({ doctor: doctorId }); load(); });
  const load = async () => {
    let q;
    try { q = await api.get(`/opd/queue/${doctorId}`); } catch (err) { el.innerHTML = errorState(err, 'retry'); $('#retry').onclick = load; return; }
    if (!ctx.isCurrent()) return;
    el.innerHTML = `<div class="grid g-main">
      <div class="col gap-20">
        <div class="now-serving"><div class="row between"><div class="eyebrow">Now serving</div><span class="live-dot" style="color:#7ff0c4">Live</span></div>
          <div class="token">${esc(q.serving ? q.serving.token : '—')}</div>
          <div class="who">${q.serving ? `${esc(q.serving.full_name)} <span>· ${esc(q.serving.uhid)} · ${esc(ageSex({ gender: q.serving.gender, age: q.serving.dob ? new Date().getFullYear() - Number(q.serving.dob.slice(0, 4)) : null }))}</span>` : '<span>Press “Call next” to start</span>'}</div>
          <div class="row wrap mt-24" style="gap:10px">${q.serving ? `<a class="btn btn-primary btn-lg" href="/opd/consult/${q.serving.id}">${icon('stethoscope')}Open consultation</a>` : ''}<button class="btn ${q.serving ? 'btn-secondary' : 'btn-primary'} btn-lg" id="call-next" ${q.waiting.length ? '' : 'disabled'}>${icon('skip')}Call next</button></div>
          <div class="eyebrow mt-24" style="margin-bottom:10px">Up next</div><div class="next-tokens">${q.waiting.slice(0, 5).map((w) => `<div class="next-token"><b style="color:#fff">${esc(w.token)}</b><span>${esc(w.full_name.split(' ')[0])}</span></div>`).join('') || '<span style="color:rgba(255,255,255,.6)">No one waiting</span>'}</div></div>
        <div class="panel"><div class="panel-head"><h3>Waiting (${q.waiting.length})</h3><span class="small muted">~${q.est_per_patient} min per patient</span></div><div class="panel-body col gap-8">${q.waiting.map((w, i) => `<div class="queue-item ${w.visit_type === 'emergency' ? 'emergency' : ''}" style="animation-delay:${i * 0.03}s"><div class="tok">${esc(w.token)}</div><div class="grow"><div class="cell-main">${esc(w.full_name)} ${w.visit_type !== 'new' ? badge(w.visit_type) : ''}</div><div class="cell-sub">${esc(w.uhid)} · waiting since ${ftime(w.registered_at)}${w.chief_complaint ? ` · ${esc(w.chief_complaint)}` : ''}</div></div><button class="btn btn-soft btn-sm" data-call="${w.id}">${icon('play')}Start</button></div>`).join('') || empty({ title: 'Your queue is clear', text: 'New patients registered at reception appear here instantly.', illo: 'calendar' })}</div></div>
      </div>
      <div class="col gap-20">
        <div class="kpis c3"><div class="kpi"><div class="label">Waiting</div><div class="value">${q.waiting.length}</div></div><div class="kpi"><div class="label">Completed</div><div class="value">${q.completed.length}</div></div><div class="kpi"><div class="label">Avg wait</div><div class="value">${q.avg_wait_min != null ? q.avg_wait_min : '—'}<small>min</small></div></div></div>
        <div class="panel"><div class="panel-head"><h3>Completed today</h3></div><div class="panel-body flush list">${q.completed.map((w) => `<a class="list-row click" href="/opd/consult/${w.id}"><span class="token-pill ghost">${esc(w.token)}</span><div class="grow"><div class="cell-main truncate">${esc(w.full_name)}</div><div class="cell-sub">${esc(w.uhid)} · ${ftime(w.completed_at)}</div></div>${icon('chevronRight')}</a>`).join('') || `<div class="panel-body muted small">No completed consultations yet.</div>`}</div></div>
      </div></div>`;
    $('#call-next').onclick = async (e) => { e.currentTarget.classList.add('loading'); try { const n = await api.post(`/opd/queue/${doctorId}/call-next`); toast(`Calling ${n.token} — ${n.full_name}`); navigate(`/opd/consult/${n.id}`); } catch (err) { toast(err.message, 'error'); e.currentTarget.classList.remove('loading'); } };
    $$('[data-call]', el).forEach((b) => (b.onclick = async () => { try { const n = await api.post(`/opd/queue/${doctorId}/call-next`, { visit_id: Number(b.dataset.call) }); navigate(`/opd/consult/${n.id}`); } catch (err) { toast(err.message, 'error'); } }));
  };
  await load();
  const t = setInterval(() => { if (!ctx.isCurrent() || !document.body.contains(el)) return clearInterval(t); load(); }, 15000);
  void num;
}
