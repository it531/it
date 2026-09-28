import { api, session } from '../core/api.js';
import { setQuery } from '../core/router.js';
import { icon } from '../core/icons.js';
import { esc, $, $$, h, fdate, ftime, badge, avatar, empty, errorState, skeletonBlock, toast, modal, todayISO, addDaysISO, segmented, confirmDialog } from '../core/ui.js';
import { patientPicker, doctors, doctorOptions } from '../core/pickers.js';
import { page, can } from '../shell.js';
import { tokenIssued } from './patients.js';

const STATUSES = ['booked', 'confirmed', 'arrived', 'waiting', 'in_consultation', 'completed', 'cancelled', 'no_show'];
const COLORS = { booked: 'var(--violet)', confirmed: 'var(--brand)', arrived: 'var(--teal)', waiting: 'var(--amber)', in_consultation: 'var(--brand-700)', completed: 'var(--green)', cancelled: 'var(--ink-4)', no_show: 'var(--red)' };

export default async function appointments(ctx) {
  let view = ctx.query.view || 'day';
  let date = ctx.query.date || todayISO();
  let doctor = ctx.query.doctor || (session.me.doctor ? String(session.me.doctor.id) : '');
  const docs = await doctors().catch(() => []);
  const el = page({ title: 'Appointments', subtitle: 'Reception, doctor, patient-portal and API bookings in one calendar.',
    actions: can('appointments', 'add') ? `<button class="btn btn-primary" id="new-appt">${icon('plus')}Book appointment</button>` : '' });
  el.innerHTML = `<div class="panel"><div class="panel-body row wrap between" style="gap:12px">
      <div class="row" style="gap:8px"><button class="btn btn-secondary btn-icon" id="prev" aria-label="Previous">${icon('chevronLeft')}</button><button class="btn btn-secondary" id="today">Today</button><button class="btn btn-secondary btn-icon" id="next" aria-label="Next">${icon('chevronRight')}</button><h3 id="range-label" style="margin-left:8px"></h3></div>
      <div class="row wrap" style="gap:10px"><select class="select" id="doc" style="width:220px"><option value="">All doctors</option>${docs.map((d) => `<option value="${d.id}" ${String(d.id) === doctor ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}</select><div id="view"></div></div>
    </div><div id="cal" style="border-top:1px solid var(--line)"></div></div>
    <div class="row wrap mt-12 small" style="gap:14px">${STATUSES.map((s) => `<span><i style="display:inline-block;width:10px;height:10px;border-radius:3px;background:${COLORS[s]};margin-right:6px"></i>${s.replace('_', ' ')}</span>`).join('')}</div>`;
  segmented($('#view'), [['day', 'Day'], ['week', 'Week'], ['month', 'Month']], view, (k) => { view = k; load(); });
  const step = () => (view === 'day' ? 1 : view === 'week' ? 7 : 30);
  $('#prev').onclick = () => { date = view === 'month' ? shiftMonth(date, -1) : addDaysISO(date, -step()); load(); };
  $('#next').onclick = () => { date = view === 'month' ? shiftMonth(date, 1) : addDaysISO(date, step()); load(); };
  $('#today').onclick = () => { date = todayISO(); load(); };
  $('#doc').onchange = (e) => { doctor = e.target.value; load(); };

  async function load() {
    setQuery({ view, date, doctor });
    let from = date; let to = date;
    if (view === 'week') { const d = new Date(`${date}T00:00:00`); const dow = (d.getDay() + 6) % 7; from = addDaysISO(date, -dow); to = addDaysISO(from, 6); }
    if (view === 'month') { from = `${date.slice(0, 7)}-01`; const d = new Date(`${from}T00:00:00`); d.setMonth(d.getMonth() + 1); d.setDate(0); to = `${date.slice(0, 7)}-${String(d.getDate()).padStart(2, '0')}`; }
    $('#range-label').textContent = view === 'day' ? new Date(`${date}T00:00:00`).toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) : view === 'week' ? `${fdate(from)} – ${fdate(to)}` : new Date(`${from}T00:00:00`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
    const cal = $('#cal'); cal.innerHTML = `<div class="panel-body">${skeletonBlock(300)}</div>`;
    let rows;
    try { rows = await api.get(`/appointments?from=${from}&to=${to}${doctor ? `&doctor_id=${doctor}` : ''}`); } catch (err) { cal.innerHTML = `<div class="panel-body">${errorState(err)}</div>`; return; }
    if (!ctx.isCurrent()) return;
    if (view === 'day') renderDay(cal, rows);
    else if (view === 'week') renderWeek(cal, rows, from);
    else renderMonth(cal, rows, from, to);
  }

  function card(a) {
    return `<div class="appt" data-id="${a.id}" style="border-left:3px solid ${COLORS[a.status]};background:#fff;border-radius:10px;padding:8px 10px;box-shadow:var(--shadow-xs);border:1px solid var(--line);border-left-width:3px;cursor:pointer;margin-bottom:6px">
      <div class="row between" style="gap:6px"><b class="small truncate">${esc(a.patient_name)}</b><span class="xs muted nowrap">${ftime(a.scheduled_at)}</span></div>
      <div class="xs muted truncate">${esc(a.uhid)} · ${esc(a.doctor_name)}${a.token ? ` · <b style="color:var(--brand)">${esc(a.token)}</b>` : ''}</div></div>`;
  }
  function renderDay(cal, rows) {
    if (!rows.length) { cal.innerHTML = empty({ title: 'No appointments yet', text: 'This day is open. Book a slot for a patient.', illo: 'calendar', action: can('appointments', 'add') ? `<button class="btn btn-primary" id="e-new">${icon('plus')}Create appointment</button>` : '' }); $('#e-new')?.addEventListener('click', () => book()); return; }
    const hours = [...Array(13)].map((_, i) => i + 8);
    cal.innerHTML = `<div>${hours.map((hr) => { const list = rows.filter((a) => Number(a.scheduled_at.slice(11, 13)) === hr); return `<div class="row top" style="border-bottom:1px solid var(--line);min-height:58px;gap:0"><div class="small muted strong" style="width:78px;padding:10px 14px;flex-shrink:0">${hr > 12 ? hr - 12 : hr}:00 ${hr >= 12 ? 'PM' : 'AM'}</div><div class="grow" style="padding:8px 12px 2px;display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:0 8px">${list.map(card).join('')}</div></div>`; }).join('')}</div>`;
    wire(cal, rows);
  }
  function renderWeek(cal, rows, from) {
    const days = [...Array(7)].map((_, i) => addDaysISO(from, i));
    cal.innerHTML = `<div style="display:grid;grid-template-columns:repeat(7,minmax(140px,1fr));overflow-x:auto">${days.map((d) => { const list = rows.filter((a) => a.scheduled_at.startsWith(d)); const isT = d === todayISO(); return `<div style="border-right:1px solid var(--line);min-height:420px"><div style="padding:12px;border-bottom:1px solid var(--line);background:${isT ? 'var(--brand-50)' : '#fbfcfe'}"><div class="xs muted strong">${new Date(`${d}T00:00:00`).toLocaleDateString('en-IN', { weekday: 'short' }).toUpperCase()}</div><div style="font-size:20px;font-weight:800;color:${isT ? 'var(--brand)' : 'var(--ink)'}">${Number(d.slice(8))}</div><div class="xs muted">${list.length} appt${list.length === 1 ? '' : 's'}</div></div><div style="padding:8px">${list.map(card).join('')}</div></div>`; }).join('')}</div>`;
    wire(cal, rows);
  }
  function renderMonth(cal, rows, from, to) {
    const first = new Date(`${from}T00:00:00`); const lead = (first.getDay() + 6) % 7;
    const start = addDaysISO(from, -lead); const cells = [];
    for (let i = 0; i < 42; i++) { const d = addDaysISO(start, i); if (i >= 35 && d > to) break; cells.push(d); }
    cal.innerHTML = `<div style="display:grid;grid-template-columns:repeat(7,1fr)">${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => `<div class="xs muted strong" style="padding:10px 12px;border-bottom:1px solid var(--line);background:#fbfcfe">${d}</div>`).join('')}
      ${cells.map((d) => { const list = rows.filter((a) => a.scheduled_at.startsWith(d)); const inM = d >= from && d <= to; const isT = d === todayISO(); return `<div data-day="${d}" style="min-height:104px;padding:8px;border-right:1px solid var(--line);border-bottom:1px solid var(--line);cursor:pointer;background:${inM ? '#fff' : '#fafbfc'}"><div class="small strong" style="color:${isT ? '#fff' : inM ? 'var(--ink)' : 'var(--ink-4)'};${isT ? 'background:var(--brand);border-radius:8px;display:inline-block;padding:0 7px' : ''}">${Number(d.slice(8))}</div>${list.slice(0, 3).map((a) => `<div class="xs truncate" style="margin-top:4px;padding:2px 6px;border-radius:6px;background:var(--bg-soft);border-left:3px solid ${COLORS[a.status]}">${ftime(a.scheduled_at)} ${esc(a.patient_name.split(' ')[0])}</div>`).join('')}${list.length > 3 ? `<div class="xs muted mt-4">+${list.length - 3} more</div>` : ''}</div>`; }).join('')}</div>`;
    $$('[data-day]', cal).forEach((c) => (c.onclick = () => { date = c.dataset.day; view = 'day'; $$('#view button').forEach((b) => b.classList.toggle('on', b.dataset.k === 'day')); load(); }));
  }
  function wire(cal, rows) { $$('.appt', cal).forEach((c) => (c.onclick = () => detail(rows.find((a) => String(a.id) === c.dataset.id)))); }

  function detail(a) {
    const active = !['cancelled', 'no_show', 'completed'].includes(a.status);
    const m = modal({ title: a.patient_name, subtitle: `${esc(a.appt_no)} · ${esc(a.uhid)} · ${esc(a.mobile)}`, size: 'sm',
      body: `<div class="col gap-8"><div class="stat-line"><span class="muted">When</span><b>${fdate(a.scheduled_at)} · ${ftime(a.scheduled_at)}</b></div><div class="stat-line"><span class="muted">Doctor</span><b>${esc(a.doctor_name)}</b></div><div class="stat-line"><span class="muted">Status</span>${badge(a.status)}</div><div class="stat-line"><span class="muted">Source</span><b>${esc(a.source)}</b></div>${a.reason ? `<div class="stat-line"><span class="muted">Reason</span><b>${esc(a.reason)}</b></div>` : ''}${a.token ? `<div class="stat-line"><span class="muted">OPD token</span><b style="color:var(--brand)">${esc(a.token)}</b></div>` : ''}</div>`,
      foot: `<a class="btn btn-ghost" href="/patients/${a.patient_id}">Profile</a>${active && can('appointments', 'edit') ? `<button class="btn btn-secondary" data-st="cancelled">Cancel</button><button class="btn btn-secondary" data-st="no_show">No-show</button>${a.status === 'booked' ? '<button class="btn btn-secondary" data-st="confirmed">Confirm</button>' : ''}` : ''}${active && !a.visit_id && (can('opd', 'add') || can('reception', 'add')) ? `<button class="btn btn-primary" id="checkin">${icon('ticket')}Check in → token</button>` : ''}` });
    $$('[data-st]', m.el).forEach((b) => (b.onclick = async () => { if (b.dataset.st === 'cancelled' && !(await confirmDialog({ title: 'Cancel appointment?', message: 'The patient will be notified.', confirm: 'Cancel appointment', danger: true }))) return; try { await api.put(`/appointments/${a.id}`, { status: b.dataset.st }); toast('Appointment updated'); m.el.remove(); load(); } catch (err) { toast(err.message, 'error'); } }));
    $('#checkin', m.el)?.addEventListener('click', async (e) => { e.currentTarget.classList.add('loading'); try { const v = await api.post(`/appointments/${a.id}/check-in`); m.el.remove(); tokenIssued(v, a.patient_name, a.uhid); load(); } catch (err) { toast(err.message, 'error'); e.currentTarget.classList.remove('loading'); } });
  }

  async function book(presetPatientId) {
    const m = modal({ title: 'Book appointment', size: 'lg', body: `<div class="form-grid"><div class="field s12"><label>Patient <span class="req">*</span></label><input class="input" id="b-p" placeholder="Search UHID / name / mobile"><div class="small muted mt-4">New patient? <a href="/patients/new" data-close>Register first</a></div></div>
      <div class="field s6"><label>Doctor <span class="req">*</span></label><select class="select" id="b-doc">${await doctorOptions(doctor)}</select></div><div class="field s6"><label>Date</label><input class="input" type="date" id="b-date" min="${todayISO()}" value="${date < todayISO() ? todayISO() : date}"></div>
      <div class="field s12"><label>Available slots</label><div id="b-slots" class="row wrap" style="gap:6px"></div></div><div class="field s12"><label>Reason</label><input class="input" id="b-reason" placeholder="e.g. Follow-up for BP"></div></div>`,
      foot: `<button class="btn btn-secondary" data-close>Cancel</button><button class="btn btn-primary" id="b-go" disabled>${icon('calendar')}Book</button>` });
    let patient = null; let slot = null;
    const upd = () => ($('#b-go', m.el).disabled = !(patient && slot));
    patientPicker($('#b-p', m.el), (p) => { patient = p; $('#b-p', m.el).value = `${p.full_name} · ${p.uhid}`; upd(); });
    if (presetPatientId) api.get(`/patients/${presetPatientId}`).then((p) => { patient = p; $('#b-p', m.el).value = `${p.full_name} · ${p.uhid}`; upd(); });
    const loadSlots = async () => {
      slot = null; upd();
      const s = await api.get(`/appointments/slots?doctor_id=${$('#b-doc', m.el).value}&date=${$('#b-date', m.el).value}`);
      $('#b-slots', m.el).innerHTML = s.map((x) => `<button class="chip" data-t="${x.time}" ${x.available ? '' : 'disabled style="opacity:.35;text-decoration:line-through;cursor:not-allowed"'}>${x.time}</button>`).join('') || '<span class="muted small">No slots</span>';
      $$('#b-slots .chip:not([disabled])', m.el).forEach((c) => (c.onclick = () => { slot = c.dataset.t; $$('#b-slots .chip', m.el).forEach((x) => x.classList.toggle('on', x === c)); upd(); }));
    };
    $('#b-doc', m.el).onchange = loadSlots; $('#b-date', m.el).onchange = loadSlots; loadSlots();
    $('#b-go', m.el).onclick = async (e) => {
      e.currentTarget.classList.add('loading');
      try { const r = await api.post('/appointments', { patient_id: patient.id, doctor_id: Number($('#b-doc', m.el).value), scheduled_at: `${$('#b-date', m.el).value} ${slot}`, reason: $('#b-reason', m.el).value }); m.el.remove(); toast(`Appointment ${r.appt_no} booked — patient notified`); date = $('#b-date', m.el).value; load(); }
      catch (err) { toast(err.message, 'error'); e.currentTarget.classList.remove('loading'); }
    };
  }
  $('#new-appt')?.addEventListener('click', () => book());
  if (ctx.query.new) { const pid = ctx.query.patient; setQuery({ new: null, patient: null }); book(pid); }
  load();
  void h; void avatar;
}
function shiftMonth(iso, n) { const d = new Date(`${iso.slice(0, 7)}-01T00:00:00`); d.setMonth(d.getMonth() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`; }
