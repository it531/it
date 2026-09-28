// Doctor consultation (EMR) — history | consultation | prescription.
// Autosaves to the server (debounced) and to local storage, so no entry is ever lost.
import { api, session } from '../core/api.js';
import { navigate } from '../core/router.js';
import { icon } from '../core/icons.js';
import { esc, $, $$, h, fdate, ftime, badge, avatar, ageSex, empty, errorState, skeletonBlock, toast, modal, debounce, autocomplete, addDaysISO, todayISO, titleCase } from '../core/ui.js';
import { medicinePicker, labTests } from '../core/pickers.js';
import { page, can } from '../shell.js';

const FREQS = ['OD', 'BD', 'TDS', 'QID', 'HS', 'SOS', 'STAT', '1-0-1', '1-1-1', '1-0-0', '0-0-1', '0-1-0', 'Weekly'];
const ROUTES = ['Oral', 'Topical', 'IV', 'IM', 'SC', 'Nasal', 'Inhalation', 'Eye drops', 'Ear drops', 'Sublingual', 'Rectal', 'Vaginal'];
const VITALS = [['bp_sys', 'BP sys', 'mmHg', 90, 140], ['bp_dia', 'BP dia', 'mmHg', 60, 90], ['pulse', 'Pulse', '/min', 60, 100], ['temp', 'Temp', '°F', 97, 99.5], ['spo2', 'SpO₂', '%', 95, 100], ['rr', 'Resp. rate', '/min', 12, 20], ['weight', 'Weight', 'kg'], ['height', 'Height', 'cm']];
const QUICK_CC = ['Fever', 'Cough & cold', 'Headache', 'Body ache', 'Acidity', 'Loose motions', 'Vomiting', 'Breathlessness', 'Chest pain', 'Back pain', 'Joint pain', 'Skin rash', 'Follow-up'];

export default async function consult(ctx) {
  const vid = Number(ctx.params.id);
  const el = page({ title: 'Consultation', crumbs: [['/opd/doctor', 'My consultations'], [null, 'Consultation']] });
  el.innerHTML = skeletonBlock(80) + '<div class="grid g3 mt-16">' + skeletonBlock(420) + skeletonBlock(420) + skeletonBlock(420) + '</div>';
  let emr;
  try { emr = await api.get(`/opd/visits/${vid}/emr`); } catch (err) { el.innerHTML = errorState(err, 'retry'); $('#retry').onclick = () => consult(ctx); return; }
  if (!ctx.isCurrent()) return;
  const { visit: v, patient: p } = emr;
  const locked = v.status === 'completed' || (emr.prescription && emr.prescription.status === 'finalized');
  const canEdit = can('doctor', 'edit') && !locked;
  document.title = `${p.full_name} · Consultation`;
  $('.page-head h1').textContent = `Consultation · ${v.token}`;

  // State
  const LS = `dh.consult.${vid}`;
  const state = {
    vitals: v.vitals || {}, chief_complaint: v.chief_complaint || '', clinical_notes: v.clinical_notes || '', advice: v.advice || '', follow_up_date: v.follow_up_date || '',
    diagnoses: v.diagnoses || [], items: (emr.prescription ? emr.prescription.items : []).map((i) => ({ ...i })), notes: emr.prescription ? emr.prescription.notes || '' : '', template_id: null,
  };
  try { const local = JSON.parse(localStorage.getItem(LS) || 'null'); if (local && canEdit && local.saved_at > (v.draft_saved_at || '')) { Object.assign(state, local.state); setTimeout(() => toast('Restored unsaved changes from this device', 'info'), 400); } } catch {}

  el.innerHTML = `
    <div class="patient-strip">
      ${p.photo ? `<div class="avatar lg"><img src="${esc(p.photo)}" alt=""></div>` : avatar(p.full_name, 'lg')}
      <div class="grow" style="min-width:220px"><div class="row wrap" style="gap:10px"><h2>${esc(p.full_name)}</h2>${badge(v.visit_type)}${badge(v.status)}</div>
        <div class="facts mt-8"><div>UHID<b class="mono">${esc(p.uhid)}</b></div><div>Age / Sex<b>${esc(ageSex(p))}</b></div><div>Blood<b>${esc(p.blood_group || '—')}</b></div><div>Token<b>${esc(v.token)}</b></div><div>Mobile<b>${esc(p.mobile)}</b></div><div>Doctor<b>${esc(v.doctor_name)}</b></div></div></div>
      <div class="col" style="align-items:flex-end;gap:8px">${p.allergies ? `<span class="badge red lg">${icon('alert')}Allergy: ${esc(p.allergies)}</span>` : '<span class="badge green">No known allergies</span>'}${p.chronic_conditions ? `<span class="badge amber">${esc(p.chronic_conditions)}</span>` : ''}</div>
    </div>
    ${locked ? `<div class="callout ok mb-16">${icon('checkCircle')}<div>This consultation is complete${emr.prescription && emr.prescription.rx_no ? ` — prescription <b>${esc(emr.prescription.rx_no)}</b> finalized ${fdate(emr.prescription.finalized_at)} ${ftime(emr.prescription.finalized_at)}` : ''}. Records are read-only.</div></div>` : ''}
    <div class="emr">
      <aside class="emr-col emr-history sticky" id="hist"></aside>
      <section class="emr-col col gap-16" id="center"></section>
      <section class="emr-col sticky" id="rx"></section>
    </div>
    <div class="sticky-bar">
      <span class="autosave" id="autosave">${v.draft_saved_at ? `Draft saved ${ftime(v.draft_saved_at)}` : 'Not saved yet'}</span>
      <span class="grow"></span>
      ${canEdit ? `<button class="btn btn-secondary" id="b-draft">${icon('save')}Save draft</button>
      <button class="btn btn-secondary" id="b-final">${icon('check')}Finalize only</button>
      <button class="btn btn-primary" id="b-send">${icon('send')}Finalize & send to pharmacy</button>` : ''}
      ${emr.prescription && emr.prescription.status === 'finalized' ? `<a class="btn btn-primary" href="/print/prescription/${emr.prescription.id}" target="_blank">${icon('printer')}Print prescription</a>` : `<button class="btn btn-ghost" id="b-print" ${locked ? '' : 'title="Available after finalizing"'} disabled>${icon('printer')}Print</button>`}
    </div>`;

  // ───── History column
  const hist = $('#hist');
  hist.innerHTML = `
    ${emr.summary ? `<div class="assist" style="padding:14px 16px"><div class="row" style="gap:10px"><span class="spark-ico">${icon('sparkles')}</span><div><h4>Deep Assist summary</h4><div class="xs muted">From structured records · for review</div></div></div><div class="small mt-12 col gap-6">${emr.summary.summary.map((l) => `<div>${esc(l)}</div>`).join('')}</div></div>` : ''}
    <h3 class="mt-16 mb-8" style="font-size:14px">Previous visits</h3>
    <div class="col gap-8">${emr.history.length ? emr.history.map((hv) => `<details class="panel" style="padding:12px 14px"><summary style="cursor:pointer;list-style:none"><div class="row between"><b class="small">${fdate(hv.visit_date)}</b><span class="xs muted">${esc(hv.doctor)}</span></div><div class="xs muted mt-4">${esc(hv.diagnoses.map((d) => d.name).join(', ') || hv.chief_complaint || '—')}</div></summary>
      <div class="small mt-8">${hv.chief_complaint ? `<div><span class="muted">C/o:</span> ${esc(hv.chief_complaint)}</div>` : ''}${hv.vitals ? `<div class="muted xs mt-4">BP ${hv.vitals.bp_sys || '—'}/${hv.vitals.bp_dia || '—'} · P ${hv.vitals.pulse || '—'} · T ${hv.vitals.temp || '—'} · Wt ${hv.vitals.weight || '—'}</div>` : ''}
      ${hv.prescription ? `<div class="mt-8">${hv.prescription.items.map((i) => `<div class="xs">• <b>${esc(i.name)}</b> ${esc(i.strength || '')} — ${esc(i.dose || '')} ${esc(i.frequency || '')} × ${i.duration_days || '—'}d</div>`).join('')}</div>${canEdit ? `<button class="btn btn-soft btn-sm mt-8" data-repeat="${hv.id}">${icon('copy')}Repeat prescription</button>` : ''}` : ''}</div></details>`).join('') : '<p class="small muted">First visit — no previous consultations.</p>'}</div>
    <h3 class="mt-16 mb-8" style="font-size:14px">Investigations</h3>
    <div class="col gap-6">${emr.labs.length ? emr.labs.map((l) => `<div class="panel" style="padding:10px 12px"><div class="row between"><b class="small">${esc(l.test)}</b>${badge(l.status)}</div><div class="xs muted">${fdate(l.created_at)} · ${esc(l.order_no)}</div>${l.results.length ? `<div class="row wrap mt-4" style="gap:4px">${l.results.map((r) => `<span class="badge ${r.flag === 'N' ? 'grey' : r.flag === 'C' ? 'red' : 'amber'} plain" style="height:20px;font-size:11px">${esc(r.parameter)} ${esc(r.value)}</span>`).join('')}</div>` : ''}</div>`).join('') : '<p class="small muted">No lab reports.</p>'}
    ${emr.radiology.map((r) => `<div class="panel" style="padding:10px 12px"><div class="row between"><b class="small">${esc(r.modality)} · ${esc(r.study)}</b>${badge(r.status)}</div>${r.impression ? `<div class="xs mt-4">${esc(r.impression)}</div>` : ''}</div>`).join('')}</div>`;
  $$('[data-repeat]', hist).forEach((b) => (b.onclick = () => {
    const hv = emr.history.find((x) => String(x.id) === b.dataset.repeat);
    for (const i of hv.prescription.items) if (!state.items.find((x) => x.medicine_id === i.medicine_id)) state.items.push({ medicine_id: i.medicine_id, name: i.name, strength: i.strength, stock: i.stock, dose: i.dose, frequency: i.frequency, duration_days: i.duration_days, route: i.route, instructions: i.instructions, quantity: i.quantity, confirmed: 0 });
    renderRx(); changed(); toast('Previous prescription added — review and confirm each medicine', 'info');
  }));

  // ───── Center column
  const center = $('#center');
  const dis = canEdit ? '' : 'disabled';
  center.innerHTML = `
    <div class="panel"><div class="panel-head"><h3>${icon('activity')} Vitals</h3><span class="small muted" id="bmi"></span></div><div class="panel-body"><div class="vitals-grid">${VITALS.map(([k, l, u]) => `<div class="vital" data-k="${k}"><label>${l}<span>${u}</span></label><input inputmode="decimal" data-v="${k}" value="${esc(state.vitals[k] ?? '')}" ${dis}></div>`).join('')}</div></div></div>
    <div class="panel"><div class="panel-head"><h3>Chief complaint</h3></div><div class="panel-body"><textarea class="textarea" id="cc" rows="2" style="min-height:64px" placeholder="Presenting complaints, duration…" ${dis}>${esc(state.chief_complaint)}</textarea>${canEdit ? `<div class="row wrap mt-8" style="gap:6px">${QUICK_CC.map((c) => `<button class="chip" data-cc="${esc(c)}" style="height:28px;font-size:12px">${esc(c)}</button>`).join('')}</div>` : ''}</div></div>
    <div class="panel"><div class="panel-head"><h3>Diagnosis</h3><span class="small muted">ICD-10 · hospital master</span></div><div class="panel-body">
      <div id="dx-chips" class="row wrap" style="gap:8px;margin-bottom:${canEdit ? 12 : 0}px"></div>
      ${canEdit ? `<div class="input-icon">${icon('search')}<input class="input" id="dx-in" placeholder="Search diagnosis or ICD code — frequently used appear first"></div>` : ''}
    </div></div>
    <div class="panel"><div class="panel-head"><h3>Clinical notes</h3>${canEdit ? `<button class="btn btn-ghost btn-sm" id="soap">${icon('sparkles')}Format as SOAP</button>` : ''}</div><div class="panel-body"><textarea class="textarea" id="notes" rows="6" placeholder="History, examination findings, assessment, plan…" ${dis}>${esc(state.clinical_notes)}</textarea></div></div>
    <div class="panel"><div class="panel-head"><h3>Investigations</h3></div><div class="panel-body" id="inv"></div></div>
    <div class="panel"><div class="panel-head"><h3>Advice & follow-up</h3></div><div class="panel-body col gap-12">
      <textarea class="textarea" id="advice" rows="3" style="min-height:70px" placeholder="Diet, lifestyle and precautions…" ${dis}>${esc(state.advice)}</textarea>
      <div class="row wrap" style="gap:8px"><span class="small strong">Follow-up</span>${canEdit ? [['3 days', 3], ['1 week', 7], ['2 weeks', 14], ['1 month', 30]].map(([l, n]) => `<button class="chip" data-fu="${n}" style="height:30px">${l}</button>`).join('') : ''}<input class="input input-sm" type="date" id="fu" value="${esc(state.follow_up_date)}" min="${todayISO()}" style="width:170px" ${dis}></div>
    </div></div>`;

  // Vitals
  const flagVitals = () => {
    for (const [k, , , lo, hi] of VITALS) {
      const n = Number(state.vitals[k]); const box = $(`.vital[data-k="${k}"]`, center);
      box.classList.toggle('bad', lo !== undefined && state.vitals[k] !== '' && state.vitals[k] != null && Number.isFinite(n) && (n < lo || n > hi));
    }
    const w = Number(state.vitals.weight); const ht = Number(state.vitals.height);
    $('#bmi').textContent = w && ht ? `BMI ${(w / ((ht / 100) ** 2)).toFixed(1)}` : '';
  };
  flagVitals();
  center.addEventListener('input', (e) => {
    const t = e.target;
    if (t.dataset.v) { state.vitals[t.dataset.v] = t.value; flagVitals(); }
    if (t.id === 'cc') state.chief_complaint = t.value;
    if (t.id === 'notes') state.clinical_notes = t.value;
    if (t.id === 'advice') state.advice = t.value;
    if (t.id === 'fu') state.follow_up_date = t.value;
    changed();
  });
  $$('[data-cc]', center).forEach((b) => (b.onclick = () => { const cc = $('#cc'); cc.value = cc.value ? `${cc.value.replace(/[,\s]+$/, '')}, ${b.dataset.cc.toLowerCase()}` : b.dataset.cc; state.chief_complaint = cc.value; changed(); }));
  $$('[data-fu]', center).forEach((b) => (b.onclick = () => { state.follow_up_date = addDaysISO(todayISO(), Number(b.dataset.fu)); $('#fu').value = state.follow_up_date; changed(); }));
  $('#soap')?.addEventListener('click', async () => { const r = await api.post('/assistant/format-note', { text: $('#notes').value }); if (r.text) { $('#notes').value = r.text; state.clinical_notes = r.text; changed(); toast('Notes formatted — please review', 'info'); } });

  // Diagnosis
  const renderDx = () => {
    $('#dx-chips').innerHTML = state.diagnoses.length ? state.diagnoses.map((d) => `<span class="chip on" style="cursor:default">${d.code ? `<span class="mono" style="opacity:.8">${esc(d.code)}</span>` : ''}${esc(d.name)}${canEdit ? `<span class="x" data-rm="${d.id}" style="cursor:pointer">${icon('x')}</span>` : ''}</span>`).join('') : '<span class="small muted">No diagnosis selected</span>';
    $$('[data-rm]', center).forEach((x) => (x.onclick = () => { state.diagnoses = state.diagnoses.filter((d) => String(d.id) !== x.dataset.rm); renderDx(); loadTemplates(); changed(); }));
  };
  renderDx();
  if (canEdit) {
    autocomplete($('#dx-in'), {
      minChars: 0, showOnFocus: true,
      fetcher: async (q) => {
        const r = await api.get(`/diagnoses/search?q=${encodeURIComponent(q)}`);
        const tag = (arr, group) => arr.map((d) => ({ ...d, group, title: d.name, subtitle: d.code }));
        const seen = new Set(state.diagnoses.map((d) => d.id));
        const out = q ? tag(r.results, 'Results') : [...tag(r.frequent, 'Frequently used'), ...tag(r.favourites.filter((f) => !r.frequent.find((x) => x.id === f.id)), 'Favourites'), ...tag(r.recent.filter((f) => !r.frequent.find((x) => x.id === f.id)), 'Recent'), ...tag(r.results, 'Common')];
        const uniq = []; const ids = new Set();
        for (const d of out) if (!ids.has(d.id) && !seen.has(d.id)) { ids.add(d.id); uniq.push(d); }
        return uniq.slice(0, 30);
      },
      render: (d) => `<div class="grow"><div class="t">${esc(d.name)}</div><div class="s">${d.code ? `<span class="mono">${esc(d.code)}</span> · ` : ''}${esc(d.specialty || '')}${d.uses ? ` · used ${d.uses}×` : ''}</div></div><span class="icon-btn" data-fav="${d.id}" title="Toggle favourite" style="width:30px;height:30px;color:${d.favourite ? 'var(--amber)' : 'var(--ink-4)'}">${icon('star')}</span>`,
      onSelect: (d) => { state.diagnoses.push({ id: d.id, name: d.name, code: d.code }); $('#dx-in').value = ''; renderDx(); loadTemplates(); changed(); },
    });
    center.addEventListener('mousedown', async (e) => { const f = e.target.closest('[data-fav]'); if (!f) return; e.preventDefault(); e.stopPropagation(); try { const r = await api.post(`/diagnoses/${f.dataset.fav}/favourite`); f.style.color = r.favourite ? 'var(--amber)' : 'var(--ink-4)'; toast(r.favourite ? 'Added to favourites' : 'Removed from favourites', 'info'); } catch (err) { toast(err.message, 'error'); } }, true);
  }

  // Investigations
  const inv = $('#inv');
  const tests = await labTests().catch(() => []);
  const radOpts = [['X-Ray', 'Chest PA view'], ['X-Ray', 'Lumbosacral spine AP/Lat'], ['X-Ray', 'Knee AP/Lat'], ['Ultrasound', 'USG Abdomen & Pelvis'], ['CT', 'CT Brain (plain)'], ['MRI', 'MRI Lumbar spine'], ['Ultrasound', 'Obstetric USG']];
  inv.innerHTML = canEdit ? `
    ${session.me.modules.includes('laboratory') ? `<div class="small strong mb-8">Laboratory</div><div class="row wrap" style="gap:6px" id="lab-chips">${tests.filter((t) => t.is_active).map((t) => `<button class="chip" data-test="${t.id}" style="height:30px;font-size:12.5px">${esc(t.code || '')} · ${esc(t.name)}</button>`).join('')}</div><div class="row mt-12"><select class="select input-sm" id="lab-pri" style="width:140px"><option value="routine">Routine</option><option value="urgent">Urgent</option><option value="stat">STAT</option></select><button class="btn btn-soft btn-sm" id="lab-go" disabled>${icon('flask')}Order selected tests</button></div>` : ''}
    ${session.me.modules.includes('radiology') ? `<div class="small strong mb-8 mt-16">Radiology</div><div class="row wrap" style="gap:8px"><select class="select input-sm" id="rad-sel" style="max-width:320px">${radOpts.map(([m, s], i) => `<option value="${i}">${m} · ${s}</option>`).join('')}</select><button class="btn btn-soft btn-sm" id="rad-go">${icon('scan')}Order imaging</button></div>` : ''}
    <div id="ordered" class="col gap-6 mt-12"></div>` : '<p class="small muted">No investigations ordered during this visit.</p>';
  const selTests = new Set();
  $$('[data-test]', inv).forEach((b) => (b.onclick = () => { const id = Number(b.dataset.test); if (selTests.has(id)) selTests.delete(id); else selTests.add(id); b.classList.toggle('on'); $('#lab-go').disabled = !selTests.size; }));
  $('#lab-go')?.addEventListener('click', async (e) => {
    e.currentTarget.classList.add('loading');
    try { const r = await api.post(`/opd/visits/${vid}/lab-orders`, { test_ids: [...selTests], priority: $('#lab-pri').value }); r.forEach((o) => $('#ordered').insertAdjacentHTML('beforeend', `<div class="small">${icon('check')} ${esc(o.test)} · <span class="mono">${esc(o.order_no)}</span> — sent to laboratory</div>`)); selTests.clear(); $$('[data-test].on', inv).forEach((b) => b.classList.remove('on')); toast(`${r.length} test(s) sent to the lab queue`); }
    catch (err) { toast(err.message, 'error'); } finally { e.target.closest('button')?.classList.remove('loading'); (e.target.closest('button') || {}).disabled = true; }
  });
  $('#rad-go')?.addEventListener('click', async () => { const [modality, study] = radOpts[Number($('#rad-sel').value)]; try { const r = await api.post(`/opd/visits/${vid}/radiology-orders`, { modality, study, clinical_info: state.chief_complaint }); $('#ordered').insertAdjacentHTML('beforeend', `<div class="small">${icon('check')} ${esc(modality)} · ${esc(study)} · <span class="mono">${esc(r.order_no)}</span></div>`); toast('Imaging ordered'); } catch (err) { toast(err.message, 'error'); } });

  // ───── Prescription column
  const rx = $('#rx');
  rx.innerHTML = `<div class="panel"><div class="panel-head"><div><h3><span class="rx-symbol" style="font-size:20px">℞</span> Prescription</h3><div class="sub" id="rx-sub"></div></div></div>
    <div class="panel-body col gap-12">
      <div id="tmpl"></div>
      ${canEdit ? `<div class="input-icon">${icon('pill')}<input class="input" id="med-in" placeholder="Add medicine — search brand or generic"></div>` : ''}
      <div id="rx-lines" class="col gap-10"></div>
      ${canEdit ? `<button class="btn btn-soft btn-sm hidden" id="confirm-all">${icon('checkCircle')}I have reviewed all medicines</button>` : ''}
      <textarea class="textarea" id="rx-notes" rows="2" style="min-height:56px" placeholder="Notes for pharmacist / patient" ${dis}>${esc(state.notes)}</textarea>
    </div></div>`;
  const renderRx = () => {
    const box = $('#rx-lines');
    const pending = state.items.filter((i) => !i.confirmed).length;
    $('#rx-sub').innerHTML = state.items.length ? `${state.items.length} medicine(s)${pending ? ` · <b style="color:var(--amber)">${pending} awaiting your review</b>` : ' · all reviewed'}` : 'No medicines added';
    $('#confirm-all')?.classList.toggle('hidden', pending < 2);
    box.innerHTML = state.items.length ? state.items.map((it, i) => `<div class="rx-line ${it.confirmed ? 'confirmed' : 'unconfirmed'}" data-i="${i}">
      <div class="row" style="gap:8px;align-items:flex-start"><div class="grow"><div class="strong" style="font-size:13.5px">${esc(it.name)} <span class="muted">${esc(it.strength || '')}</span></div><div class="xs ${it.stock <= 0 ? '' : 'muted'}" style="${it.stock <= 0 ? 'color:var(--red);font-weight:700' : ''}">${it.stock != null ? `${it.stock} in stock` : ''}${it.stock <= 0 ? ' — patient may need to buy outside' : ''}</div></div>
        ${canEdit ? `<label class="check xs" title="Doctor has reviewed dose, frequency, duration and route"><input type="checkbox" data-f="confirmed" ${it.confirmed ? 'checked' : ''}>Reviewed</label><button class="btn btn-ghost btn-sm btn-icon" data-del="${i}" aria-label="Remove">${icon('trash')}</button>` : badge('finalized', 'Confirmed')}</div>
      <div class="rx-grid"><div><div class="mini">Dose</div><input class="input" data-f="dose" value="${esc(it.dose || '')}" list="doses" ${dis}></div>
        <div><div class="mini">Frequency</div><select class="select" data-f="frequency" ${dis}>${FREQS.map((f) => `<option ${f === it.frequency ? 'selected' : ''}>${f}</option>`).join('')}</select></div>
        <div><div class="mini">Days</div><input class="input" type="number" min="1" max="365" data-f="duration_days" value="${esc(it.duration_days || '')}" ${dis}></div>
        <div><div class="mini">Route</div><select class="select" data-f="route" ${dis}>${ROUTES.map((r) => `<option ${r === it.route ? 'selected' : ''}>${r}</option>`).join('')}</select></div></div>
      <div class="row mt-8" style="gap:8px"><input class="input input-sm grow" data-f="instructions" value="${esc(it.instructions || '')}" placeholder="Instructions e.g. after food" list="instr" ${dis}><div class="xs muted nowrap">Qty <input class="input input-sm" style="width:64px;display:inline-block" type="number" min="1" data-f="quantity" value="${esc(it.quantity || '')}" ${dis}></div></div>
    </div>`).join('') : `<div class="empty" style="padding:18px"><p>Search to add medicines, or pick a hospital-approved template above. Nothing is prescribed automatically.</p></div>`;
    $$('[data-del]', box).forEach((b) => (b.onclick = () => { state.items.splice(Number(b.dataset.del), 1); renderRx(); changed(); }));
    updateButtons();
  };
  document.body.insertAdjacentHTML('beforeend', `<datalist id="doses">${['1 tab', '1/2 tab', '2 tab', '1 cap', '5 ml', '10 ml', '1 sachet', '2 puffs', 'Apply', 'Thin layer', '1 vial', '1 drop'].map((d) => `<option>${d}</option>`).join('')}</datalist><datalist id="instr">${['After food', 'Before food', 'Empty stomach', 'At bedtime', 'With milk', 'If fever > 100°F', 'For pain', 'Morning'].map((d) => `<option>${d}</option>`).join('')}</datalist>`);
  const qtyFor = (it) => { const f = String(it.frequency || '').toUpperCase(); const per = /^\d(-\d){2,3}$/.test(f) ? f.split('-').reduce((s, x) => s + Number(x), 0) : ({ OD: 1, BD: 2, TDS: 3, QID: 4, HS: 1, SOS: 0, STAT: 1, WEEKLY: 1 / 7 }[f] ?? 1); return Math.max(1, Math.ceil(per * (Number(it.duration_days) || 1))); };
  rx.addEventListener('input', (e) => {
    const line = e.target.closest('.rx-line'); if (!line) { if (e.target.id === 'rx-notes') { state.notes = e.target.value; changed(); } return; }
    const it = state.items[Number(line.dataset.i)]; const f = e.target.dataset.f; if (!f) return;
    if (f === 'confirmed') { it.confirmed = e.target.checked ? 1 : 0; line.classList.toggle('confirmed', !!it.confirmed); line.classList.toggle('unconfirmed', !it.confirmed); }
    else {
      it[f] = e.target.value;
      if (f === 'frequency' || f === 'duration_days') { it.quantity = qtyFor(it); const q = $('[data-f=quantity]', line); if (q) q.value = it.quantity; }
      // Any edit to a line requires the doctor to re-confirm it.
      if (it.confirmed && f !== 'instructions' && f !== 'quantity') { it.confirmed = 0; $('[data-f=confirmed]', line).checked = false; line.classList.add('unconfirmed'); line.classList.remove('confirmed'); }
    }
    const pending = state.items.filter((i) => !i.confirmed).length;
    $('#rx-sub').innerHTML = `${state.items.length} medicine(s)${pending ? ` · <b style="color:var(--amber)">${pending} awaiting your review</b>` : ' · all reviewed'}`;
    $('#confirm-all')?.classList.toggle('hidden', pending < 2);
    updateButtons(); changed();
  });
  $('#confirm-all')?.addEventListener('click', () => { state.items.forEach((i) => (i.confirmed = 1)); renderRx(); changed(); });
  if (canEdit) medicinePicker($('#med-in'), (m) => {
    if (state.items.find((i) => i.medicine_id === m.id)) return toast(`${m.name} is already in the prescription`, 'info');
    const it = { medicine_id: m.id, name: m.name, strength: m.strength, stock: m.stock, dose: /Syrup|Suspension/.test(m.dosage_form) ? '5 ml' : /Gel|Cream/.test(m.dosage_form) ? 'Apply' : /Capsule/.test(m.dosage_form) ? '1 cap' : '1 tab', frequency: 'BD', duration_days: 5, route: m.default_route || 'Oral', instructions: 'After food', confirmed: 0 };
    it.quantity = qtyFor(it);
    state.items.push(it); $('#med-in').value = ''; renderRx(); changed();
    setTimeout(() => $(`.rx-line[data-i="${state.items.length - 1}"] [data-f=dose]`)?.focus(), 30);
  });

  // Template suggestions — hospital-approved, never auto-applied.
  const loadTemplates = async () => {
    const box = $('#tmpl'); if (!canEdit) return (box.innerHTML = '');
    if (!state.diagnoses.length) return (box.innerHTML = '');
    const t = await api.get(`/prescription-templates/suggest?diagnosis_ids=${state.diagnoses.map((d) => d.id).join(',')}`).catch(() => []);
    box.innerHTML = t.length ? `<div class="callout" style="flex-direction:column;gap:10px"><div class="row" style="gap:8px">${icon('sparkles')}<b class="small">Suggested templates (hospital-approved)</b></div>${t.map((x) => `<div style="background:#fff;border-radius:12px;padding:10px 12px;border:1px solid var(--brand-100)"><div class="row between"><b class="small">${esc(x.name)}</b><button class="btn btn-soft btn-sm" data-tmpl="${x.id}">Add for review</button></div><div class="xs muted mt-4">${x.items.map((i) => `${esc(i.name)} ${esc(i.frequency)} × ${i.duration_days}d`).join(' · ')}</div></div>`).join('')}<div class="xs muted">Suggestions are added as unconfirmed lines. You must review and confirm every medicine, dose, frequency, duration and route.</div></div>` : '';
    $$('[data-tmpl]', box).forEach((b) => (b.onclick = () => {
      const x = t.find((y) => String(y.id) === b.dataset.tmpl);
      let added = 0;
      for (const i of x.items) if (!state.items.find((y) => y.medicine_id === i.medicine_id)) { state.items.push({ ...i, confirmed: 0 }); added++; }
      if (x.advice && !state.advice.includes(x.advice)) { state.advice = state.advice ? `${state.advice}\n${x.advice}` : x.advice; $('#advice').value = state.advice; }
      state.template_id = x.id; renderRx(); changed();
      toast(`${added} medicine(s) added for your review`, 'info');
    }));
  };
  renderRx(); loadTemplates();

  // ───── Save / finalize
  function updateButtons() {
    const pending = state.items.filter((i) => !i.confirmed).length;
    const fin = $('#b-final'); const send = $('#b-send');
    if (fin) { fin.disabled = pending > 0; fin.title = pending ? 'Review every medicine first' : ''; }
    if (send) { send.disabled = pending > 0 || !state.items.length; send.title = pending ? 'Review every medicine first' : !state.items.length ? 'Add at least one medicine' : ''; }
  }
  const status = (cls, text) => { const a = $('#autosave'); if (!a) return; a.className = `autosave ${cls}`; a.textContent = text; };
  const payloadConsult = () => ({ chief_complaint: state.chief_complaint, clinical_notes: state.clinical_notes, advice: state.advice, follow_up_date: state.follow_up_date || null, vitals: state.vitals, diagnosis_ids: state.diagnoses.map((d) => d.id) });
  const payloadRx = () => ({ items: state.items.map((i) => ({ medicine_id: i.medicine_id, dose: i.dose, frequency: i.frequency, duration_days: Number(i.duration_days) || null, route: i.route, instructions: i.instructions, quantity: Number(i.quantity) || undefined, confirmed: i.confirmed ? 1 : 0 })), notes: state.notes, template_id: state.template_id });
  let saving = null;
  const saveNow = async (quiet = true) => {
    if (!canEdit) return;
    status('saving', 'Saving…');
    const run = (async () => {
      await api.put(`/opd/visits/${vid}/consultation`, payloadConsult());
      if (state.items.length || emr.prescription) await api.put(`/opd/visits/${vid}/prescription`, payloadRx());
    })();
    saving = run;
    try { await run; localStorage.removeItem(LS); status('saved', `Draft saved ${new Date().toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', second: '2-digit' })}`); if (!quiet) toast('Draft saved'); return true; }
    catch (err) { status('', `Not saved — ${err.message}`); toast(err.message, 'error', 'Could not save'); return false; }
    finally { saving = null; }
  };
  const autosave = debounce(() => saveNow(true), 1200);
  function changed() {
    if (!canEdit) return;
    try { localStorage.setItem(LS, JSON.stringify({ saved_at: new Date().toISOString().replace('T', ' ').slice(0, 19), state })); } catch {}
    status('saving', 'Unsaved changes…');
    autosave();
  }
  const finalize = async (send) => {
    if (saving) await saving;
    if (!(await saveNow(true))) return;
    const btn = send ? $('#b-send') : $('#b-final'); btn.classList.add('loading');
    try {
      const r = await api.post(`/opd/visits/${vid}/finalize`, { send_to_pharmacy: send ? 1 : 0 });
      localStorage.removeItem(LS);
      done(r);
    } catch (err) { toast(err.message, 'error', 'Cannot finalize yet'); } finally { btn.classList.remove('loading'); }
  };
  $('#b-draft')?.addEventListener('click', () => saveNow(false));
  $('#b-final')?.addEventListener('click', () => finalize(false));
  $('#b-send')?.addEventListener('click', () => finalize(true));
  const keys = (e) => { if (!document.body.contains(el)) return document.removeEventListener('keydown', keys); if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); saveNow(false); } if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && canEdit) { e.preventDefault(); finalize(true); } };
  document.addEventListener('keydown', keys);
  window.addEventListener('beforeunload', () => { if (canEdit && localStorage.getItem(LS)) saveNow(true); }, { once: true });

  function done(r) {
    const m = modal({ title: 'Prescription finalized', size: 'sm', body: `<div style="text-align:center"><div class="eyebrow">Prescription</div><div class="mono strong" style="font-size:22px">${esc(r.rx_no)}</div>${r.pharmacy_order ? `<div class="divider"></div><div class="eyebrow">Pharmacy token</div><div style="font-size:60px;font-weight:800;color:var(--brand);letter-spacing:-.03em;line-height:1.1">${esc(r.pharmacy_order.token)}</div><div class="small muted">Order ${esc(r.pharmacy_order.order_no)} is now in the pharmacy queue.</div>` : '<p class="muted mt-12">Not sent to pharmacy.</p>'}<div class="callout ok mt-16" style="text-align:left">${icon('send')}<div>${esc(p.full_name)} has been notified${r.pharmacy_order ? ' with the pharmacy token' : ''}.</div></div></div>`,
      foot: `<a class="btn btn-secondary" href="/print/prescription/${r.prescription_id}" target="_blank">${icon('printer')}Print</a><button class="btn btn-primary" id="d-next">${icon('skip')}Next patient</button>`, onClose: () => navigate('/opd/doctor') });
    $('#d-next', m.el).onclick = async () => {
      try { const n = await api.post(`/opd/queue/${v.doctor_id}/call-next`); m.el.remove(); navigate(`/opd/consult/${n.id}`); } catch (err) { toast(err.message, 'info'); m.el.remove(); navigate('/opd/doctor'); }
    };
  }
  void h; void titleCase;
}
