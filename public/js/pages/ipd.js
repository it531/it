import { api } from '../core/api.js';
import { navigate, setQuery } from '../core/router.js';
import { icon } from '../core/icons.js';
import { esc, $, $$, fdate, ftime, fdt, inr, inr2, badge, avatar, ageSex, empty, errorState, skeletonBlock, skeletonKpis, toast, modal, drawer, countUp, tabs, todayISO, addDaysISO, formData, titleCase, confirmDialog } from '../core/ui.js';
import { patientPicker, doctorOptions, labTests, medicinePicker } from '../core/pickers.js';
import { lineChart } from '../core/charts.js';
import { page, can } from '../shell.js';

export default async function ipd(ctx) {
  if (ctx.params.id) return admissionPage(ctx);
  const el = page({ title: 'IPD & bed management', subtitle: 'Live bed map, admissions and discharges. IPD numbers are separate from UHIDs.',
    hero: { img: '/img/ward.jpg', eyebrow: 'In-patient department', compact: true, stats: '<div class="hero-stats" id="hs"></div>' },
    actions: can('ipd', 'add') ? `<button class="btn btn-primary" id="admit">${icon('plus')}Admit patient</button>` : '' });
  el.innerHTML = `<div class="tabs" id="tabs"></div><div id="body">${skeletonBlock(400)}</div>`;
  let tab = ctx.query.tab || 'beds';
  tabs($('#tabs'), [['beds', 'Bed map'], ['admitted', 'Current admissions'], ['discharged', 'Discharged']], tab, (k) => { tab = k; setQuery({ tab: k }); render(); });
  let bedData;
  const render = async () => {
    const body = $('#body'); body.innerHTML = skeletonBlock(400);
    try {
      bedData = await api.get('/ipd/beds');
      const s = bedData.stats;
      $('#hs').innerHTML = [['Occupied', s.occupied], ['Available', s.available], ['ICU', `${s.icu_occupied}/${s.icu_total}`], ['Occupancy', `${s.total ? Math.round((s.occupied / s.total) * 100) : 0}%`]].map(([l, v]) => `<div><b>${esc(v)}</b><span>${l}</span></div>`).join('');
      if (tab === 'beds') beds(body);
      else admissions(body, tab);
    } catch (err) { body.innerHTML = errorState(err); }
  };
  function beds(body) {
    const s = bedData.stats;
    body.innerHTML = `<div class="row wrap between mb-16"><div class="legend">${[['available', '#1baf7a', s.available], ['occupied', '#2a78d6', s.occupied], ['reserved', '#4a3aa7', s.reserved], ['cleaning', '#eda100', s.cleaning], ['maintenance', '#95a1b5', s.maintenance]].map(([k, c, n]) => `<span><i style="background:${c}"></i>${titleCase(k)} · ${n || 0}</span>`).join('')}</div><span class="small muted">${s.total} beds across ${bedData.wards.length} wards</span></div>
      ${bedData.wards.map((w) => { const occ = w.beds.filter((b) => b.status === 'occupied').length; return `<div class="ward"><div class="ward-head"><div><h3>${esc(w.name)}</h3><div class="small muted">${esc(titleCase(w.ward_type))} · ${esc(w.floor || '')} · ${inr(w.daily_rate)}/day</div></div><div class="row" style="gap:10px;min-width:200px"><div class="progress grow"><i style="width:${w.beds.length ? (occ / w.beds.length) * 100 : 0}%"></i></div><span class="small strong">${occ}/${w.beds.length}</span></div></div>
        <div class="beds">${w.beds.map((b) => `<div class="bed ${b.status}" data-bed="${b.id}" tabindex="0"><div class="bno">${esc(b.bed_no)}${icon(b.status === 'occupied' ? 'user' : b.status === 'cleaning' ? 'sparkles' : b.status === 'maintenance' ? 'settings' : 'bed')}</div>${b.status === 'occupied' ? `<div class="pt truncate">${esc(b.patient_name)}</div><div class="xs muted truncate">${esc(b.ipd_no)} · ${esc(ageSex(b))}</div>` : ''}<div class="st">${esc(b.status)}</div></div>`).join('')}</div></div>`; }).join('')}`;
    $$('[data-bed]', body).forEach((b) => (b.onclick = () => bedDrawer(Number(b.dataset.bed))));
  }
  function bedDrawer(id) {
    const b = bedData.wards.flatMap((w) => w.beds.map((x) => ({ ...x, ward: w.name }))).find((x) => x.id === id);
    const d = drawer({ title: `${b.ward} · ${b.bed_no}`, subtitle: badge(b.status), body: b.status === 'occupied' ? `<div class="row">${avatar(b.patient_name, 'lg')}<div><h3>${esc(b.patient_name)}</h3><div class="small muted">${esc(b.uhid)} · ${esc(ageSex(b))}</div></div></div>
      <div class="mt-16">${[['IPD number', b.ipd_no], ['Doctor', b.doctor_name], ['Admitted', fdt(b.admitted_at)], ['Expected discharge', b.expected_discharge ? fdate(b.expected_discharge) : '—'], ['Day', `Day ${Math.max(1, Math.ceil((Date.now() - new Date(b.admitted_at.replace(' ', 'T'))) / 864e5))}`]].map(([k, v]) => `<div class="stat-line"><span class="muted">${k}</span><b>${esc(v)}</b></div>`).join('')}</div>`
      : `<p class="muted">This bed is <b>${esc(b.status)}</b>.</p>${can('ipd', 'edit') || can('nursing', 'edit') ? `<div class="field mt-16"><label>Change status</label><div class="row wrap" style="gap:8px">${['available', 'reserved', 'cleaning', 'maintenance'].filter((s) => s !== b.status).map((s) => `<button class="btn btn-secondary btn-sm" data-st="${s}">${titleCase(s)}</button>`).join('')}</div></div>` : ''}${b.status === 'available' && can('ipd', 'add') ? `<button class="btn btn-primary mt-24" id="admit-here">${icon('plus')}Admit a patient to this bed</button>` : ''}`,
    foot: b.status === 'occupied' ? `<a class="btn btn-primary" href="/ipd/${b.admission_id}">Open admission</a>` : null });
    $$('[data-st]', d.el).forEach((x) => (x.onclick = async () => { try { await api.post(`/ipd/beds/${b.id}/status`, { status: x.dataset.st }); toast(`Bed ${b.bed_no} is now ${x.dataset.st}`); d.close(); render(); } catch (err) { toast(err.message, 'error'); } }));
    $('#admit-here', d.el)?.addEventListener('click', () => { d.close(); admit(null, b.id); });
  }
  async function admissions(body, status) {
    const rows = await api.get(`/ipd/admissions?status=${status}`);
    body.innerHTML = `<div class="panel">${rows.length ? `<div class="table-wrap"><table class="table"><thead><tr><th>IPD no.</th><th>Patient</th><th>Ward / bed</th><th>Doctor</th><th>Admitted</th><th>${status === 'admitted' ? 'Day' : 'Discharged'}</th><th>${status === 'admitted' ? 'Last vitals' : 'Status'}</th></tr></thead><tbody>${rows.map((a) => `<tr class="click" data-href="/ipd/${a.id}"><td class="mono strong">${esc(a.ipd_no)}</td><td><div class="cell-main">${esc(a.patient_name)}</div><div class="cell-sub">${esc(a.uhid)} · ${esc(ageSex(a))}</div></td><td>${esc(a.ward || '—')}<div class="cell-sub">${esc(a.bed_no || '')}</div></td><td class="small">${esc(a.doctor_name)}<div class="cell-sub">${esc(a.department || '')}</div></td><td class="small">${fdt(a.admitted_at)}</td><td>${status === 'admitted' ? `<span class="badge blue plain">Day ${a.day_no}</span>` : fdt(a.discharged_at)}</td><td>${status === 'admitted' ? (a.last_vitals ? `<span class="small">${ftime(a.last_vitals)}</span>` : '<span class="badge amber">Due</span>') : badge(a.status)}</td></tr>`).join('')}</tbody></table></div>` : empty({ title: status === 'admitted' ? 'No patients admitted' : 'No discharges yet', illo: 'bed' })}</div>`;
  }
  async function admit(patientId, bedId) {
    if (!bedData) bedData = await api.get('/ipd/beds');
    const free = bedData.wards.flatMap((w) => w.beds.filter((b) => ['available', 'reserved'].includes(b.status)).map((b) => ({ ...b, ward: w.name, rate: w.daily_rate })));
    const m = modal({ title: 'Admit patient', subtitle: 'Generates a new IPD number and marks the bed occupied.', size: 'lg',
      body: `<form class="form-grid" id="adm"><div class="field s12"><label>Patient <span class="req">*</span></label><input class="input" id="a-p" placeholder="Search UHID / name / mobile"></div>
        <div class="field s6"><label>Admitting doctor <span class="req">*</span></label><select class="select" name="doctor_id">${await doctorOptions()}</select></div>
        <div class="field s6"><label>Bed <span class="req">*</span></label><select class="select" name="bed_id">${free.map((b) => `<option value="${b.id}" ${b.id === bedId ? 'selected' : ''}>${esc(b.ward)} · ${esc(b.bed_no)} (${inr(b.rate)}/day)${b.status === 'reserved' ? ' — reserved' : ''}</option>`).join('')}</select></div>
        <div class="field s4"><label>Admission type</label><select class="select" name="admission_type"><option value="planned">Planned</option><option value="emergency">Emergency</option><option value="transfer">Transfer</option></select></div>
        <div class="field s4"><label>Expected discharge</label><input class="input" type="date" name="expected_discharge" min="${todayISO()}" value="${addDaysISO(todayISO(), 3)}"></div>
        <div class="field s12"><label>Reason for admission <span class="req">*</span></label><input class="input" name="reason" placeholder="e.g. Dengue fever with thrombocytopenia"></div></form>`,
      foot: `<button class="btn btn-secondary" data-close>Cancel</button><button class="btn btn-primary" id="a-go">${icon('bed')}Admit</button>` });
    let patient = null;
    patientPicker($('#a-p', m.el), (p) => { patient = p; $('#a-p', m.el).value = `${p.full_name} · ${p.uhid}`; });
    if (patientId) api.get(`/patients/${patientId}`).then((p) => { patient = p; $('#a-p', m.el).value = `${p.full_name} · ${p.uhid}`; });
    $('#a-go', m.el).onclick = async (e) => {
      if (!patient) return toast('Select a patient', 'error');
      const d = formData($('#adm', m.el));
      e.currentTarget.classList.add('loading');
      try { const r = await api.post('/ipd/admission', { ...d, patient_id: patient.id, doctor_id: Number(d.doctor_id), bed_id: Number(d.bed_id) }); m.el.remove(); toast(`Admitted — ${r.ipd_no}`, 'success', 'IPD number generated'); navigate(`/ipd/${r.id}`); }
      catch (err) { toast(err.message, 'error'); e.currentTarget.classList.remove('loading'); }
    };
  }
  $('#admit')?.addEventListener('click', () => admit());
  if (ctx.query.admit) { const p = ctx.query.admit; setQuery({ admit: null }); admit(p); }
  render();
}

// ───────────────── Admission record ─────────────────
async function admissionPage(ctx) {
  const el = page({ title: 'Admission', crumbs: [['/ipd', 'IPD'], [null, 'Admission']] });
  el.innerHTML = skeletonKpis(4);
  let a;
  try { a = await api.get(`/ipd/admissions/${ctx.params.id}`); } catch (err) { el.innerHTML = errorState(err); return; }
  if (!ctx.isCurrent()) return;
  const active = a.status === 'admitted';
  const day = Math.max(1, Math.ceil(((a.discharged_at ? new Date(a.discharged_at.replace(' ', 'T')) : Date.now()) - new Date(a.admitted_at.replace(' ', 'T'))) / 864e5));
  $('.page-head h1').textContent = `${a.ipd_no} · ${a.patient_name}`;
  $('.page-head').insertAdjacentHTML('beforeend', `<div class="actions"><a class="btn btn-secondary" href="/print/admission/${a.id}" target="_blank">${icon('printer')}Admission form</a>${!active ? `<a class="btn btn-secondary" href="/print/discharge/${a.id}" target="_blank">${icon('file')}Discharge summary</a>${a.invoice ? `<a class="btn btn-primary" href="/billing/${a.invoice.id}">${icon('receipt')}Final bill</a>` : ''}` : ''}${active && can('ipd', 'edit') ? `<button class="btn btn-secondary" id="transfer">${icon('arrowRight')}Transfer bed</button><button class="btn btn-primary" id="discharge">${icon('home')}Discharge</button>` : ''}</div>`);
  el.innerHTML = `<div class="patient-strip">${avatar(a.patient_name, 'lg')}<div class="grow"><div class="row wrap" style="gap:10px"><h2>${esc(a.patient_name)}</h2>${badge(a.status)}${badge(a.admission_type === 'emergency' ? 'emergency' : 'new', titleCase(a.admission_type))}</div>
      <div class="facts mt-8"><div>IPD no.<b class="mono">${esc(a.ipd_no)}</b></div><div>UHID<b class="mono">${esc(a.uhid)}</b></div><div>Age / Sex<b>${esc(ageSex(a))}</b></div><div>Ward / bed<b>${esc(a.ward || '—')} · ${esc(a.bed_no || '')}</b></div><div>Doctor<b>${esc(a.doctor_name)}</b></div><div>Admitted<b>${fdt(a.admitted_at)}</b></div><div>Day<b>${day}</b></div></div></div>
      <div class="col" style="align-items:flex-end;gap:8px">${a.allergies ? `<span class="badge red lg">Allergy: ${esc(a.allergies)}</span>` : ''}<div class="small muted">${a.invoice ? 'Final bill' : 'Running bill (est.)'}</div><div style="font-size:24px;font-weight:800">${inr(a.invoice ? a.invoice.total : a.running_bill)}</div></div></div>
    ${a.reason ? `<div class="callout mb-16">${icon('info')}<div><b>Reason for admission:</b> ${esc(a.reason)}${a.diagnoses.length ? ` · <b>Diagnosis:</b> ${a.diagnoses.map((d) => esc(d.name)).join(', ')}` : ''}${a.final_diagnosis ? ` · <b>Final diagnosis:</b> ${esc(a.final_diagnosis)}` : ''}</div></div>` : ''}
    <div class="tabs" id="tabs"></div><div id="tb"></div>`;
  let tab = 'overview';
  tabs($('#tabs'), [['overview', 'Overview'], ['notes', 'Rounds & notes', a.notes.length], ['vitals', 'Vitals', a.vitals.length], ['meds', 'Medications (MAR)', a.medications.filter((m) => m.status === 'active').length], ['charges', 'Charges', a.charges.length], ['inv', 'Investigations', a.labs.length + a.radiology.length]], tab, (k) => { tab = k; show(); });
  const reload = async () => { a = await api.get(`/ipd/admissions/${ctx.params.id}`); show(); };
  const show = () => {
    const tb = $('#tb');
    if (tab === 'overview') {
      const v = [...a.vitals].reverse();
      tb.innerHTML = `<div class="grid g-main"><div class="panel"><div class="panel-head"><h3>Vitals trend</h3><span class="small muted">${a.vitals.length} readings</span></div><div class="panel-body" id="vt"></div></div>
        <div class="panel"><div class="panel-head"><h3>Latest</h3></div><div class="panel-body">${a.vitals[0] ? ['bp_sys:BP:mmHg', 'pulse:Pulse:/min', 'temp:Temp:°F', 'spo2:SpO₂:%', 'rr:Resp. rate:/min', 'blood_sugar:Blood sugar:mg/dL', 'pain_score:Pain:/10'].map((k) => { const [f, l, u] = k.split(':'); const val = f === 'bp_sys' ? (a.vitals[0].bp_sys ? `${a.vitals[0].bp_sys}/${a.vitals[0].bp_dia}` : null) : a.vitals[0][f]; return `<div class="stat-line"><span class="muted">${l}</span><b>${val != null ? `${esc(val)} <span class="muted small">${u}</span>` : '—'}</b></div>`; }).join('') + `<div class="xs muted mt-8">Recorded ${fdt(a.vitals[0].recorded_at)} by ${esc(a.vitals[0].user_name || '')}</div>` : empty({ title: 'No vitals yet' })}</div></div></div>
        <div class="grid g2 section"><div class="panel"><div class="panel-head"><h3>Latest doctor notes</h3></div><div class="panel-body">${a.notes.filter((n) => ['round', 'progress', 'instruction'].includes(n.note_type)).slice(0, 3).map(noteHtml).join('') || '<p class="muted small">No notes yet.</p>'}</div></div>
        <div class="panel"><div class="panel-head"><h3>Active medications</h3></div><div class="panel-body">${a.medications.filter((m) => m.status === 'active').map((m) => `<div class="stat-line"><span><b>${esc(m.name)}</b> ${esc(m.strength || '')}</span><span class="small">${esc(m.dose)} · ${esc(m.route)} · ${esc(m.frequency)}</span></div>`).join('') || '<p class="muted small">None.</p>'}</div></div></div>
        ${!active ? `<div class="panel section"><div class="panel-head"><h3>Discharge summary</h3>${badge(a.discharge_type || 'discharged')}</div><div class="panel-body"><p>${esc(a.discharge_summary || '')}</p>${a.discharge_advice ? `<p class="mt-12"><b>Advice:</b> ${esc(a.discharge_advice)}</p>` : ''}${a.follow_up_date ? `<p class="mt-8"><b>Follow-up:</b> ${fdate(a.follow_up_date)}</p>` : ''}</div></div>` : ''}`;
      if (v.length > 1) $('#vt').appendChild(lineChart({ data: v.map((x) => ({ t: x.recorded_at.slice(5, 16), pulse: x.pulse, sys: x.bp_sys, spo2: x.spo2 })), x: 't', series: [{ key: 'sys', label: 'BP systolic' }, { key: 'pulse', label: 'Pulse' }, { key: 'spo2', label: 'SpO₂' }], height: 240, yMin0: false }));
      else $('#vt').innerHTML = '<p class="muted small">Trend appears after two readings.</p>';
    }
    if (tab === 'notes') {
      tb.innerHTML = `${active ? `<div class="panel mb-16"><div class="panel-body"><div class="row wrap" style="gap:10px"><select class="select" id="nt" style="width:200px">${(can('ipd', 'edit') ? ['round', 'progress', 'instruction', 'procedure'] : []).concat(['nursing', 'handover']).map((t) => `<option value="${t}">${titleCase(t)}</option>`).join('')}</select><input class="input grow" id="nb" placeholder="Write a note… instructions notify the nursing station"><button class="btn btn-primary" id="ns">${icon('plus')}Add</button></div></div></div>` : ''}<div class="panel"><div class="panel-body">${a.notes.map(noteHtml).join('') || empty({ title: 'No notes yet' })}</div></div>`;
      $('#ns')?.addEventListener('click', async () => { try { await api.post(`/ipd/admissions/${a.id}/notes`, { note_type: $('#nt').value, body: $('#nb').value }); toast('Note added'); reload(); } catch (err) { toast(err.message, 'error'); } });
    }
    if (tab === 'vitals') {
      tb.innerHTML = `${active && (can('nursing', 'add') || can('ipd', 'edit')) ? `<div class="panel mb-16"><div class="panel-head"><h3>Record vitals</h3></div><div class="panel-body"><form id="vf" class="vitals-grid">${[['bp_sys', 'BP sys'], ['bp_dia', 'BP dia'], ['pulse', 'Pulse'], ['temp', 'Temp °F'], ['spo2', 'SpO₂'], ['rr', 'Resp. rate'], ['blood_sugar', 'Blood sugar'], ['pain_score', 'Pain 0-10'], ['intake_ml', 'Intake ml'], ['output_ml', 'Output ml']].map(([k, l]) => `<div class="vital"><label>${l}</label><input name="${k}" inputmode="decimal"></div>`).join('')}</form><div class="row mt-12"><input class="input grow" id="vnote" placeholder="Note (optional)"><button class="btn btn-primary" id="vs">${icon('save')}Save vitals</button></div></div></div>` : ''}
        <div class="panel"><div class="table-wrap"><table class="table compact"><thead><tr><th>Time</th><th>BP</th><th>Pulse</th><th>Temp</th><th>SpO₂</th><th>RR</th><th>Sugar</th><th>Pain</th><th>I/O ml</th><th>By</th></tr></thead><tbody>${a.vitals.map((x) => `<tr><td class="small">${fdt(x.recorded_at)}</td><td class="num">${x.bp_sys ? `${x.bp_sys}/${x.bp_dia}` : '—'}</td><td class="num">${x.pulse ?? '—'}</td><td class="num">${x.temp ?? '—'}</td><td class="num" style="${x.spo2 && x.spo2 < 92 ? 'color:var(--red);font-weight:800' : ''}">${x.spo2 ?? '—'}</td><td class="num">${x.rr ?? '—'}</td><td class="num">${x.blood_sugar ?? '—'}</td><td class="num">${x.pain_score ?? '—'}</td><td class="num">${x.intake_ml ?? '—'}/${x.output_ml ?? '—'}</td><td class="small">${esc(x.user_name || '')}</td></tr>`).join('')}</tbody></table></div>${a.vitals.length ? '' : empty({ title: 'No vitals recorded' })}</div>`;
      $('#vs')?.addEventListener('click', async () => {
        const d = formData($('#vf')); const body = {}; for (const [k, v] of Object.entries(d)) if (v !== '') body[k] = Number(v); body.note = $('#vnote').value || undefined;
        try { const r = await api.post(`/ipd/admissions/${a.id}/vitals`, body); toast(r.critical ? 'Critical values — doctor alerted' : 'Vitals saved', r.critical ? 'error' : 'success'); reload(); } catch (err) { toast(err.message, 'error'); }
      });
    }
    if (tab === 'meds') {
      tb.innerHTML = `${active && can('ipd', 'edit') ? `<div class="panel mb-16"><div class="panel-head"><h3>Order medication</h3></div><div class="panel-body form-grid"><div class="field s4"><label>Medicine</label><input class="input" id="mm"></div><div class="field s2"><label>Dose</label><input class="input" id="md" placeholder="1 vial"></div><div class="field s2"><label>Route</label><select class="select" id="mr">${['IV', 'IM', 'SC', 'Oral', 'Nebulisation', 'Topical'].map((r) => `<option>${r}</option>`).join('')}</select></div><div class="field s2"><label>Frequency</label><select class="select" id="mf">${['OD', 'BD', 'TDS', 'QID', 'HS', 'STAT'].map((r) => `<option>${r}</option>`).join('')}</select></div><div class="field s2" style="justify-content:flex-end"><button class="btn btn-primary" id="mo">${icon('plus')}Order</button></div></div></div>` : ''}
        <div class="col gap-12">${a.medications.map((m) => `<div class="panel"><div class="panel-body row wrap" style="gap:14px"><div class="grow"><div class="cell-main">${esc(m.name)} ${esc(m.strength || '')} ${badge(m.status === 'active' ? 'active' : 'inactive', m.status)}</div><div class="cell-sub">${esc(m.dose)} · ${esc(m.route)} · ${esc(m.frequency)} at ${esc(m.times || '—')} · ordered by ${esc(m.ordered_by_name || '')} · from ${fdate(m.start_date)}</div>
          <div class="row wrap mt-8" style="gap:6px">${m.administrations.slice(0, 8).map((x) => `<span class="badge ${x.status === 'given' ? 'green' : 'amber'} plain" title="${esc(x.user_name || '')}">${x.status} ${fdateTime(x.scheduled_for)}</span>`).join('') || '<span class="xs muted">No doses recorded</span>'}</div></div>
          ${m.status === 'active' && active ? `<div class="row" style="gap:8px">${can('nursing', 'add') || can('ipd', 'edit') ? `<button class="btn btn-soft btn-sm" data-give="${m.id}">${icon('check')}Record dose</button>` : ''}${can('ipd', 'edit') ? `<button class="btn btn-ghost btn-sm" data-stop="${m.id}">Stop</button>` : ''}</div>` : ''}</div></div>`).join('') || `<div class="panel">${empty({ title: 'No medication orders', illo: 'pill' })}</div>`}</div>`;
      let med = null;
      if ($('#mm')) medicinePicker($('#mm'), (x) => { med = x; $('#mm').value = `${x.name} ${x.strength || ''}`; $('#mr').value = x.default_route || 'IV'; });
      $('#mo')?.addEventListener('click', async () => { if (!med) return toast('Select a medicine', 'error'); try { await api.post(`/ipd/admissions/${a.id}/medications`, { medicine_id: med.id, dose: $('#md').value || '1 unit', route: $('#mr').value, frequency: $('#mf').value }); toast('Medication ordered'); reload(); } catch (err) { toast(err.message, 'error'); } });
      $$('[data-stop]', tb).forEach((b) => (b.onclick = async () => { if (!(await confirmDialog({ title: 'Stop medication?', message: 'The order will be discontinued.', confirm: 'Stop', danger: true }))) return; await api.post(`/ipd/medications/${b.dataset.stop}/stop`); reload(); }));
      $$('[data-give]', tb).forEach((b) => (b.onclick = () => recordDose(Number(b.dataset.give), reload)));
    }
    if (tab === 'charges') {
      const total = a.charges.reduce((s, c) => s + c.quantity * c.unit_price, 0);
      tb.innerHTML = `${active && (can('ipd', 'edit') || can('billing', 'add')) ? `<div class="panel mb-16"><div class="panel-body form-grid"><div class="field s3"><label>Category</label><select class="select" id="cc">${['procedure', 'consultation', 'consumable', 'nursing', 'other'].map((c) => `<option value="${c}">${titleCase(c)}</option>`).join('')}</select></div><div class="field s4"><label>Description</label><input class="input" id="cd" list="cpre"><datalist id="cpre">${['Doctor visit', 'Specialist consultation', 'Dressing', 'Catheterisation', 'Ryles tube insertion', 'Oxygen charges (per day)', 'Monitor charges (per day)', 'Physiotherapy'].map((x) => `<option>${x}</option>`).join('')}</datalist></div><div class="field s2"><label>Qty</label><input class="input" id="cq" type="number" value="1" min="1"></div><div class="field s2"><label>Rate ₹</label><input class="input" id="cr" type="number" min="0"></div><div class="field s1" style="justify-content:flex-end"><button class="btn btn-primary btn-icon" id="ca">${icon('plus')}</button></div></div></div>` : ''}
        <div class="panel"><table class="table"><thead><tr><th>Date</th><th>Category</th><th>Description</th><th class="r">Qty</th><th class="r">Rate</th><th class="r">Amount</th></tr></thead><tbody>${a.charges.map((c) => `<tr><td class="small">${fdt(c.created_at)}</td><td>${esc(titleCase(c.category))}</td><td>${esc(c.description)}</td><td class="r num">${c.quantity}</td><td class="r num">${inr2(c.unit_price)}</td><td class="r num strong">${inr2(c.quantity * c.unit_price)}</td></tr>`).join('')}</tbody></table>
        <div class="table-foot"><span>${active ? `Room charges (${inr(a.daily_rate)}/day) are added automatically at discharge or transfer.` : 'Final invoice generated at discharge.'}</span><b>${inr2(total)}</b></div></div>`;
      $('#ca')?.addEventListener('click', async () => { try { await api.post(`/ipd/admissions/${a.id}/charges`, { category: $('#cc').value, description: $('#cd').value, quantity: Number($('#cq').value), unit_price: Number($('#cr').value) }); toast('Charge added'); reload(); } catch (err) { toast(err.message, 'error'); } });
    }
    if (tab === 'inv') {
      tb.innerHTML = `${active && can('laboratory', 'add') || active && can('ipd', 'edit') ? '<div class="panel mb-16"><div class="panel-body"><div class="small strong mb-8">Order lab tests</div><div id="lt" class="row wrap" style="gap:6px"></div><button class="btn btn-soft btn-sm mt-12" id="lgo" disabled>Order selected</button></div></div>' : ''}
        <div class="panel"><table class="table"><thead><tr><th>Order</th><th>Test / study</th><th>Ordered</th><th>Status</th><th></th></tr></thead><tbody>${a.labs.map((l) => `<tr><td class="mono small">${esc(l.order_no)}</td><td class="strong">${esc(l.test)}</td><td class="small">${fdt(l.created_at)}</td><td>${badge(l.status)}</td><td>${['completed', 'verified'].includes(l.status) ? `<a class="btn btn-ghost btn-sm" href="/print/lab/${l.id}" target="_blank">${icon('file')}</a>` : ''}</td></tr>`).join('')}${a.radiology.map((r) => `<tr><td class="mono small">${esc(r.order_no)}</td><td class="strong">${esc(r.modality)} · ${esc(r.study)}</td><td class="small">${fdt(r.created_at)}</td><td>${badge(r.status)}</td><td></td></tr>`).join('')}</tbody></table>${a.labs.length + a.radiology.length ? '' : empty({ title: 'No investigations' })}</div>`;
      if ($('#lt')) labTests().then((tests) => { const sel = new Set(); $('#lt').innerHTML = tests.map((t) => `<button class="chip" data-t="${t.id}" style="height:30px">${esc(t.name)}</button>`).join(''); $$('#lt .chip').forEach((c) => (c.onclick = () => { const id = Number(c.dataset.t); sel.has(id) ? sel.delete(id) : sel.add(id); c.classList.toggle('on'); $('#lgo').disabled = !sel.size; })); $('#lgo').onclick = async () => { try { await api.post(`/ipd/admissions/${a.id}/lab-orders`, { test_ids: [...sel] }); toast('Sent to laboratory — charged to IPD bill'); reload(); } catch (err) { toast(err.message, 'error'); } }; }).catch(() => {});
    }
  };
  show();
  $('#discharge')?.addEventListener('click', () => {
    const m = modal({ title: `Discharge ${a.patient_name}`, subtitle: 'Generates the final IPD bill (room + charges), frees the bed for cleaning and publishes the discharge summary.', size: 'lg',
      body: `<form class="form-grid" id="df"><div class="field s4"><label>Discharge type</label><select class="select" name="discharge_type"><option value="normal">Normal</option><option value="lama">LAMA</option><option value="referred">Referred</option><option value="death">Death</option></select></div><div class="field s4"><label>Follow-up date</label><input class="input" type="date" name="follow_up_date" value="${addDaysISO(todayISO(), 7)}"></div>${can('billing', 'approve') ? '<div class="field s4"><label>Discount ₹</label><input class="input" type="number" name="discount" min="0" value="0"></div>' : ''}
        <div class="field s12"><label>Final diagnosis <span class="req">*</span></label><input class="input" name="final_diagnosis" value="${esc(a.diagnoses.map((d) => d.name).join(', ') || a.reason || '')}"></div>
        <div class="field s12"><label>Discharge summary <span class="req">*</span></label><textarea class="textarea" name="discharge_summary" rows="6">Patient admitted on ${fdate(a.admitted_at)} with ${a.reason || ''}. Managed with appropriate medical care. Condition improved and vitals stable at discharge.</textarea></div>
        <div class="field s12"><label>Advice on discharge</label><textarea class="textarea" name="discharge_advice" rows="3">Continue medicines as prescribed. Adequate rest and hydration. Report immediately if symptoms recur.</textarea></div></form>`,
      foot: `<button class="btn btn-secondary" data-close>Cancel</button><button class="btn btn-primary" id="d-go">${icon('home')}Discharge & generate bill</button>` });
    $('#d-go', m.el).onclick = async (e) => {
      const d = formData($('#df', m.el)); if (d.discount) d.discount = Number(d.discount); else delete d.discount;
      e.currentTarget.classList.add('loading');
      try { const r = await api.post(`/ipd/admissions/${a.id}/discharge`, d); m.el.remove(); toast('Discharged — final bill generated, bed sent for cleaning'); navigate(`/billing/${r.invoice_id}`); }
      catch (err) { toast(err.message, 'error'); e.currentTarget.classList.remove('loading'); }
    };
  });
  $('#transfer')?.addEventListener('click', async () => {
    const beds = await api.get('/ipd/beds');
    const free = beds.wards.flatMap((w) => w.beds.filter((b) => b.status === 'available').map((b) => ({ ...b, ward: w.name })));
    const m = modal({ title: 'Transfer bed', size: 'sm', body: `<div class="field"><label>New bed</label><select class="select" id="tb-sel">${free.map((b) => `<option value="${b.id}">${esc(b.ward)} · ${esc(b.bed_no)}</option>`).join('')}</select></div><p class="small muted mt-12">Room charges for the current bed are captured up to now.</p>`, foot: `<button class="btn btn-secondary" data-close>Cancel</button><button class="btn btn-primary" id="tb-go">Transfer</button>` });
    $('#tb-go', m.el).onclick = async () => { try { await api.post(`/ipd/admissions/${a.id}/transfer`, { bed_id: Number($('#tb-sel', m.el).value) }); toast('Bed transferred'); m.el.remove(); admissionPage(ctx); } catch (err) { toast(err.message, 'error'); } };
  });
}
const fdateTime = (s) => `${s.slice(8, 10)}/${s.slice(5, 7)} ${s.slice(11, 16)}`;
function noteHtml(n) {
  return `<div style="padding:12px 0;border-bottom:1px dashed var(--line)"><div class="row between"><span>${badge(n.note_type === 'instruction' ? 'urgent' : n.note_type === 'round' ? 'confirmed' : 'draft', titleCase(n.note_type))} <span class="small strong">${esc(n.user_name || '')}</span></span><span class="xs muted">${fdt(n.created_at)}</span></div><p class="small mt-8">${esc(n.body)}</p>${n.note_type === 'instruction' ? `<div class="xs mt-4 ${n.acknowledged_at ? 'muted' : ''}" style="${n.acknowledged_at ? '' : 'color:var(--amber);font-weight:700'}">${n.acknowledged_at ? `Acknowledged by ${esc(n.ack_name || '')} · ${fdt(n.acknowledged_at)}` : 'Awaiting nursing acknowledgement'}</div>` : ''}</div>`;
}
export function recordDose(medId, done, slot) {
  const now = new Date(); const def = slot || `${todayISO()} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const m = modal({ title: 'Record medication dose', size: 'sm', body: `<div class="col gap-12"><div class="field"><label>Scheduled time</label><input class="input" type="datetime-local" id="rd-t" value="${def.replace(' ', 'T').slice(0, 16)}"></div><div class="field"><label>Status</label><select class="select" id="rd-s"><option value="given">Given</option><option value="held">Held</option><option value="refused">Refused by patient</option></select></div><div class="field"><label>Note</label><input class="input" id="rd-n"></div></div>`,
    foot: `<button class="btn btn-secondary" data-close>Cancel</button><button class="btn btn-primary" id="rd-go">Save</button>` });
  $('#rd-go', m.el).onclick = async () => { try { await api.post(`/ipd/medications/${medId}/administer`, { scheduled_for: $('#rd-t', m.el).value.replace('T', ' '), status: $('#rd-s', m.el).value, note: $('#rd-n', m.el).value }); toast('Dose recorded'); m.el.remove(); done(); } catch (err) { toast(err.message, 'error'); } };
}
void countUp;
