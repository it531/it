import { api, session } from '../core/api.js';
import { navigate, setQuery } from '../core/router.js';
import { icon } from '../core/icons.js';
import { esc, $, $$, h, fdate, fdt, ftime, inr, num, badge, avatar, ageSex, empty, errorState, skeletonRows, toast, modal, formData, showErrors, debounce, field, select, fileToDataUrl, titleCase, countUp } from '../core/ui.js';
import { doctorOptions, doctors } from '../core/pickers.js';
import { page, can } from '../shell.js';

export default async function patients(ctx) {
  if (location.pathname === '/patients/new') return register(ctx);
  if (ctx.params.id) return profile(ctx);
  return list(ctx);
}

// ───────────────────────── List & search ─────────────────────────
async function list(ctx) {
  const q = ctx.query;
  const el = page({ title: 'Patients', subtitle: 'Search by UHID, name, mobile, date of birth, Aadhaar/ID, doctor or visit date.',
    actions: can('patients', 'add') ? `<a class="btn btn-primary" href="/patients/new">${icon('userPlus')}Register patient</a>` : '' });
  const docs = await doctors().catch(() => []);
  el.innerHTML = `<div class="panel">
    <div class="panel-body" style="padding-bottom:14px"><div class="row wrap" style="gap:12px">
      <div class="input-icon grow" style="min-width:260px">${icon('search')}<input class="input" id="pq" placeholder="Type UHID (#000001), name, mobile, DOB (DD/MM/YYYY) or ID number" value="${esc(q.q || '')}"></div>
      <select class="select" id="pdoc" style="width:220px"><option value="">Any doctor</option>${docs.map((d) => `<option value="${d.id}" ${String(d.id) === q.doctor_id ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}</select>
      <input class="input" type="date" id="pvisit" style="width:170px" value="${esc(q.visit_date || '')}" title="Visited on">
      <select class="select" id="pgender" style="width:140px"><option value="">Any gender</option>${['Male', 'Female', 'Other'].map((g) => `<option ${g === q.gender ? 'selected' : ''}>${g}</option>`).join('')}</select>
    </div></div>
    <div id="plist">${skeletonRows(8, 6)}</div></div>`;
  let offset = 0;
  const load = async () => {
    const params = { q: $('#pq').value.trim(), doctor_id: $('#pdoc').value, visit_date: $('#pvisit').value, gender: $('#pgender').value };
    setQuery(params);
    const qs = new URLSearchParams({ ...params, limit: 25, offset }).toString();
    const box = $('#plist');
    try {
      const r = await api.get(`/patients?${qs}`);
      if (!ctx.isCurrent()) return;
      if (!r.rows.length) {
        box.innerHTML = empty({ title: params.q ? `No patient matches “${params.q}”` : 'No patients found', text: params.q ? 'Check the spelling or search by mobile number. New patient? Register them to generate a UHID.' : 'Adjust the filters above.', illo: 'search', action: can('patients', 'add') ? `<a class="btn btn-primary" href="/patients/new${params.q && !/\d/.test(params.q) ? `?name=${encodeURIComponent(params.q)}` : params.q && /^\d{10}$/.test(params.q) ? `?mobile=${params.q}` : ''}">${icon('userPlus')}Register new patient</a>` : '' });
        return;
      }
      box.innerHTML = `<div class="table-wrap"><table class="table"><thead><tr><th>Patient</th><th>UHID</th><th class="hm">Mobile</th><th class="hm">Last visit</th><th class="hm">Visits</th><th class="hm">Status</th><th class="hm"></th></tr></thead><tbody>
        ${r.rows.map((p) => `<tr class="click" data-id="${p.id}"><td><div class="row" style="gap:12px">${avatar(p.full_name)}<div><div class="cell-main">${esc(p.full_name)}</div><div class="cell-sub">${esc(ageSex(p))}${p.blood_group ? ` · ${esc(p.blood_group)}` : ''}${p.city ? ` · ${esc(p.city)}` : ''}</div></div></div></td>
        <td class="mono strong">${esc(p.uhid)}</td><td class="num hm">${esc(p.mobile)}</td><td class="hm">${p.last_visit ? `${fdate(p.last_visit)}<div class="cell-sub">${esc(p.last_doctor || '')}</div>` : '<span class="muted">—</span>'}</td><td class="num hm">${p.visits}</td>
        <td class="hm">${p.ipd_no ? badge('admitted', `IPD ${p.ipd_no}`) : '<span class="badge grey plain">OPD</span>'}</td><td class="r hm">${icon('chevronRight')}</td></tr>`).join('')}</tbody></table></div>
        <div class="table-foot"><span>Showing ${offset + 1}–${offset + r.rows.length} of ${num(r.total)}</span><div class="btn-group"><button class="btn btn-secondary btn-sm" id="prev" ${offset ? '' : 'disabled'}>${icon('chevronLeft')}Prev</button><button class="btn btn-secondary btn-sm" id="next" ${offset + 25 < r.total ? '' : 'disabled'}>Next${icon('chevronRight')}</button></div></div>`;
      $('tbody', box).onclick = (e) => { const tr = e.target.closest('tr'); if (tr) navigate(`/patients/${tr.dataset.id}`); };
      $('#prev', box).onclick = () => { offset = Math.max(0, offset - 25); load(); };
      $('#next', box).onclick = () => { offset += 25; load(); };
    } catch (err) { box.innerHTML = `<div class="panel-body">${errorState(err, 'pretry')}</div>`; $('#pretry').onclick = load; }
  };
  const deb = debounce(() => { offset = 0; load(); }, 220);
  $('#pq').addEventListener('input', deb);
  ['#pdoc', '#pvisit', '#pgender'].forEach((s) => $(s).addEventListener('change', () => { offset = 0; load(); }));
  $('#pq').focus();
  load();
}

// ───────────────────────── Registration ─────────────────────────
const STATES = ['Gujarat', 'Maharashtra', 'Rajasthan', 'Madhya Pradesh', 'Delhi', 'Karnataka', 'Tamil Nadu', 'Uttar Pradesh', 'West Bengal', 'Telangana', 'Kerala', 'Punjab', 'Haryana', 'Bihar', 'Andhra Pradesh', 'Other'];
export function patientForm(p = {}) {
  return `<form class="form-grid" id="pform" novalidate>
    <div class="form-section">Identity</div>
    <div class="field s12" style="grid-column:span 12"><div class="row" style="gap:18px"><div id="photo-prev">${p.photo ? `<div class="avatar xl"><img src="${esc(p.photo)}" alt=""></div>` : `<div class="avatar xl c1">${icon('camera')}</div>`}</div><div class="col gap-8"><div class="strong">Patient photo</div><div class="small muted">JPG/PNG, resized automatically. Optional.</div><label class="btn btn-secondary btn-sm" style="width:max-content">${icon('upload')}Upload / capture<input type="file" accept="image/*" capture="user" id="photo-in" hidden></label></div></div><input type="hidden" name="photo" value="${esc(p.photo || '')}"></div>
    ${field('First name', `<input class="input" name="first_name" value="${esc(p.first_name || '')}" required>`, { req: true, cls: 's4' })}
    ${field('Last name', `<input class="input" name="last_name" value="${esc(p.last_name || '')}">`, { cls: 's4' })}
    ${field('Gender', select('gender', ['Male', 'Female', 'Other'], p.gender, { blank: 'Select' }), { req: true, cls: 's4' })}
    ${field('Date of birth', `<input class="input" type="date" name="dob" value="${esc(p.dob || '')}" max="${new Date().toISOString().slice(0, 10)}">`, { cls: 's4', hint: 'Or enter age →' })}
    ${field('Age (years)', '<input class="input" type="number" min="0" max="120" id="age-in" placeholder="e.g. 42">', { cls: 's2' })}
    ${field('Blood group', select('blood_group', ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-', 'Unknown'], p.blood_group), { cls: 's2' })}
    ${field('Marital status', select('marital_status', ['Single', 'Married', 'Divorced', 'Widowed', 'Other'], p.marital_status), { cls: 's2' })}
    ${field('Occupation', `<input class="input" name="occupation" value="${esc(p.occupation || '')}" list="occ">`, { cls: 's2' })}
    <datalist id="occ">${['Business', 'Service', 'Homemaker', 'Student', 'Retired', 'Self-employed', 'Farmer', 'Teacher', 'Engineer'].map((o) => `<option>${o}</option>`).join('')}</datalist>
    <div class="form-section">Contact</div>
    ${field('Mobile number', `<input class="input" name="mobile" inputmode="numeric" maxlength="10" value="${esc(p.mobile || '')}" required>`, { req: true, cls: 's4' })}
    ${field('Alternate mobile', `<input class="input" name="alt_mobile" inputmode="numeric" maxlength="10" value="${esc(p.alt_mobile || '')}">`, { cls: 's4' })}
    ${field('Email', `<input class="input" type="email" name="email" value="${esc(p.email || '')}">`, { cls: 's4' })}
    ${field('Address', `<input class="input" name="address" value="${esc(p.address || '')}">`, { cls: 's12' })}
    ${field('City', `<input class="input" name="city" value="${esc(p.city || 'Ahmedabad')}">`, { cls: 's4' })}
    ${field('State', select('state', STATES, p.state || 'Gujarat'), { cls: 's4' })}
    ${field('PIN code', `<input class="input" name="pincode" inputmode="numeric" maxlength="6" value="${esc(p.pincode || '')}">`, { cls: 's4' })}
    <div class="form-section">Emergency contact & guardian</div>
    ${field('Emergency contact name', `<input class="input" name="emergency_name" value="${esc(p.emergency_name || '')}">`, { cls: 's4' })}
    ${field('Relation', `<input class="input" name="emergency_relation" value="${esc(p.emergency_relation || '')}" list="rel">`, { cls: 's4' })}
    ${field('Emergency phone', `<input class="input" name="emergency_phone" inputmode="numeric" maxlength="10" value="${esc(p.emergency_phone || '')}">`, { cls: 's4' })}
    <datalist id="rel">${['Spouse', 'Father', 'Mother', 'Son', 'Daughter', 'Sibling', 'Friend'].map((o) => `<option>${o}</option>`).join('')}</datalist>
    ${field('Guardian name (minors)', `<input class="input" name="guardian_name" value="${esc(p.guardian_name || '')}">`, { cls: 's4' })}
    ${field('Guardian relation', `<input class="input" name="guardian_relation" value="${esc(p.guardian_relation || '')}" list="rel">`, { cls: 's4' })}
    ${field('Guardian phone', `<input class="input" name="guardian_phone" inputmode="numeric" maxlength="10" value="${esc(p.guardian_phone || '')}">`, { cls: 's4' })}
    <div class="form-section">ID proof & medical</div>
    ${field('ID type', select('id_type', [['aadhaar', 'Aadhaar'], ['abha', 'ABHA'], ['pan', 'PAN'], ['passport', 'Passport'], ['voter', 'Voter ID'], ['driving', 'Driving licence'], ['other', 'Other']], ''), { cls: 's4', hint: 'Stored encrypted; searchable by exact number.' })}
    ${field('ID number', '<input class="input" name="id_number" autocomplete="off">', { cls: 's4' })}
    ${field('Known allergies', `<input class="input" name="allergies" value="${esc(p.allergies || '')}" placeholder="e.g. Penicillin">`, { cls: 's4' })}
    ${field('Chronic conditions', `<input class="input" name="chronic_conditions" value="${esc(p.chronic_conditions || '')}" placeholder="e.g. Hypertension, Type 2 diabetes">`, { cls: 's12' })}
    <div class="form-section">Insurance (optional)</div>
    ${field('Insurance provider', `<input class="input" name="insurance_provider" value="${esc(p.insurance_provider || '')}" list="ins">`, { cls: 's4' })}
    <datalist id="ins">${['Star Health', 'HDFC ERGO', 'ICICI Lombard', 'Niva Bupa', 'Care Health', 'PMJAY / Ayushman Bharat', 'MA Yojana', 'New India Assurance'].map((o) => `<option>${o}</option>`).join('')}</datalist>
    ${field('Policy number', `<input class="input" name="insurance_policy_no" value="${esc(p.insurance_policy_no || '')}">`, { cls: 's4' })}
    ${field('Valid till', `<input class="input" type="date" name="insurance_valid_till" value="${esc(p.insurance_valid_till || '')}">`, { cls: 's4' })}
  </form>`;
}
export function wirePatientForm(root) {
  const age = $('#age-in', root); const dob = $('[name=dob]', root);
  age.addEventListener('input', () => { const a = Number(age.value); if (a >= 0 && a < 121 && age.value) { const y = new Date().getFullYear() - a; dob.value = `${y}-01-01`; } });
  dob.addEventListener('change', () => { if (dob.value) age.value = Math.floor((Date.now() - new Date(dob.value)) / 3.15576e10); });
  if (dob.value) age.value = Math.floor((Date.now() - new Date(dob.value)) / 3.15576e10);
  $('#photo-in', root).addEventListener('change', async (e) => {
    const f = e.target.files[0]; if (!f) return;
    const url = await fileToDataUrl(f, 420);
    $('[name=photo]', root).value = url;
    $('#photo-prev', root).innerHTML = `<div class="avatar xl"><img src="${url}" alt=""></div>`;
  });
}

async function register(ctx) {
  const el = page({ title: 'Register new patient', subtitle: 'A permanent UHID is generated automatically on save.', crumbs: [['/patients', 'Patients'], [null, 'New registration']] });
  const pre = { first_name: ctx.query.name ? ctx.query.name.split(' ')[0] : '', last_name: ctx.query.name ? ctx.query.name.split(' ').slice(1).join(' ') : '', mobile: ctx.query.mobile || '' };
  el.innerHTML = `<div class="grid g-side"><div class="panel"><div class="panel-body">${patientForm(pre)}</div></div>
    <div class="col gap-16" style="position:sticky;top:90px;align-self:start">
      <div class="panel"><div class="panel-body"><div class="eyebrow">Next UHID</div><div style="font-size:30px;font-weight:800;letter-spacing:-.03em" class="mono" id="next-uhid">Auto-generated</div><p class="small muted mt-8">Numbers are issued by the server in sequence and never reused.</p></div></div>
      <div id="dupes"></div>
      <div class="panel"><div class="panel-body col gap-12">
        <label class="check"><input type="checkbox" id="portal-on"> Give patient portal access</label>
        <input class="input hidden" id="portal-pw" type="text" placeholder="Temporary portal password (min 6)">
        <button class="btn btn-primary btn-lg btn-block" id="save">${icon('save')}Register patient</button>
        <span class="small muted" style="text-align:center">Shortcut: Ctrl + Enter</span>
      </div></div>
    </div></div>`;
  wirePatientForm(el);
  $('#portal-on').onchange = (e) => $('#portal-pw').classList.toggle('hidden', !e.target.checked);
  // Duplicate detection while typing.
  const checkDupes = debounce(async () => {
    const f = formData($('#pform'));
    if (!(f.mobile && f.mobile.length === 10) && !(f.first_name && f.dob)) return ($('#dupes').innerHTML = '');
    const r = await api.get(`/patients/check-duplicate?mobile=${encodeURIComponent(f.mobile || '')}&first_name=${encodeURIComponent(f.first_name || '')}&dob=${encodeURIComponent(f.dob || '')}`).catch(() => []);
    $('#dupes').innerHTML = r.length ? `<div class="callout warn">${icon('alert')}<div><b>Possible existing patient</b><div class="col gap-6 mt-8">${r.map((p) => `<a href="/patients/${p.id}" class="row" style="gap:8px">${avatar(p.full_name, 'sm')}<span><b>${esc(p.full_name)}</b><br><span class="small muted">${esc(p.uhid)} · ${esc(ageSex(p))} · ${esc(p.mobile)}</span></span></a>`).join('')}</div></div></div>` : '';
  }, 350);
  $('#pform').addEventListener('input', (e) => { if (['mobile', 'first_name', 'dob'].includes(e.target.name)) checkDupes(); });
  const save = async () => {
    const form = $('#pform'); const body = formData(form); delete body[''];
    if (!body.photo) delete body.photo;
    if ($('#portal-on').checked) body.portal_password = $('#portal-pw').value;
    const btn = $('#save'); btn.classList.add('loading');
    try {
      const out = await api.post('/patients', body);
      success(out, body);
    } catch (err) { showErrors(form, err); toast(err.message, 'error', 'Please check the form'); }
    finally { btn.classList.remove('loading'); }
  };
  $('#save').onclick = save;
  el.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) save(); });
}

async function success(out, body) {
  const opts = await doctorOptions();
  const m = modal({ title: 'Patient registered', size: 'sm', body: `<div style="text-align:center"><div class="eyebrow">UHID</div><div class="mono" style="font-size:44px;font-weight:800;color:var(--brand);letter-spacing:-.02em">${esc(out.uhid)}</div><div class="strong mt-8">${esc(body.first_name)} ${esc(body.last_name || '')}</div><div class="small muted">${esc(body.mobile)}</div></div>
    ${can('opd', 'add') ? `<div class="divider"></div><div class="field"><label>Send to OPD — doctor</label><select class="select" id="s-doc">${opts}</select></div><div class="row mt-12" style="gap:8px"><label class="check small"><input type="radio" name="vt" value="new" checked> New</label><label class="check small"><input type="radio" name="vt" value="emergency"> Emergency</label></div>` : ''}`,
    foot: `<a class="btn btn-secondary" href="/patients/${out.id}">View profile</a>${can('opd', 'add') ? `<button class="btn btn-primary" id="s-token">${icon('ticket')}Generate OPD token</button>` : ''}`, onClose: () => navigate(`/patients/${out.id}`) });
  $('#s-token', m.el)?.addEventListener('click', async (e) => {
    e.currentTarget.classList.add('loading');
    try {
      const v = await api.post('/opd/visit', { patient_id: out.id, doctor_id: Number($('#s-doc', m.el).value), visit_type: $('input[name=vt]:checked', m.el).value });
      m.el.remove();
      tokenIssued(v, `${body.first_name} ${body.last_name || ''}`, out.uhid);
    } catch (err) { toast(err.message, 'error'); e.target.closest('button')?.classList.remove('loading'); }
  });
}

export function tokenIssued(v, name, uhid) {
  modal({ title: 'OPD token issued', size: 'sm', body: `<div style="text-align:center"><div class="eyebrow">Token</div><div style="font-size:72px;font-weight:800;letter-spacing:-.04em;color:var(--brand);line-height:1.1">${esc(v.token)}</div><div class="strong">${esc(name)}</div><div class="small muted">${esc(uhid || '')} · ${esc(v.visit_no)}</div>
    <div class="callout ok mt-16" style="text-align:left">${icon('send')}<div>The patient has been notified on SMS/WhatsApp and can track the queue live in the patient portal.</div></div>${v.invoice_id ? `<div class="small muted mt-12">Consultation invoice created — collect at billing.</div>` : ''}</div>`,
  foot: `${v.invoice_id && can('billing', 'add') ? `<a class="btn btn-secondary" href="/billing/${v.invoice_id}">${icon('receipt')}Collect fee</a>` : ''}<a class="btn btn-secondary" href="/print/opd-slip/${v.id}" target="_blank">${icon('printer')}Print slip</a><button class="btn btn-primary" data-close>Done</button>`, onClose: () => { if (location.pathname.startsWith('/patients/') && location.pathname !== '/patients/new') navigate(location.pathname, { replace: true }); } });
}

// ───────────────────────── Profile ─────────────────────────
const TL_ICON = { registration: 'userPlus', appointment: 'calendar', opd: 'stethoscope', prescription: 'file', pharmacy: 'pill', lab: 'flask', radiology: 'scan', ipd: 'bed', discharge: 'home', invoice: 'receipt', payment: 'wallet', refund: 'wallet', followup: 'clock' };

async function profile(ctx) {
  const id = ctx.params.id;
  const el = page({ title: 'Patient profile', crumbs: [['/patients', 'Patients'], [null, 'Profile']] });
  el.innerHTML = skeletonRows(4, 3);
  let p;
  try { p = await api.get(`/patients/${id}`); } catch (err) { el.innerHTML = errorState(err, 'retry'); $('#retry').onclick = () => profile(ctx); return; }
  if (!ctx.isCurrent()) return;
  document.title = `${p.full_name} · Deep Hospital`;
  $('.page-head h1').textContent = p.full_name;
  $('.page-head').insertAdjacentHTML('beforeend', `<div class="actions">
    ${can('opd', 'add') ? `<button class="btn btn-primary" id="a-opd">${icon('ticket')}OPD token</button>` : ''}
    ${can('appointments', 'add') ? `<a class="btn btn-secondary" href="/appointments?new=1&patient=${p.id}">${icon('calendar')}Appointment</a>` : ''}
    <button class="btn btn-secondary btn-icon" id="a-more" aria-label="More actions">${icon('moreH')}</button></div>`);
  el.innerHTML = `
    <div class="panel" style="overflow:hidden">
      <div class="row wrap" style="padding:24px;gap:24px;align-items:center;background:linear-gradient(120deg,#f5f8ff,#fff 60%)">
        ${p.photo ? `<div class="avatar xl"><img src="${esc(p.photo)}" alt=""></div>` : avatar(p.full_name, 'xl')}
        <div class="grow" style="min-width:240px">
          <div class="row wrap" style="gap:10px"><h2 style="font-size:24px">${esc(p.full_name)}</h2>${p.active_admission ? `<a href="/ipd/${p.active_admission.id}">${badge('admitted', `Admitted · ${p.active_admission.ipd_no} · ${p.active_admission.ward || ''} ${p.active_admission.bed_no || ''}`)}</a>` : ''}${p.portal ? '<span class="badge teal">Portal active</span>' : ''}</div>
          <div class="row wrap mt-8" style="gap:18px;color:var(--ink-2)"><span class="mono strong" style="font-size:16px;color:var(--brand)">${esc(p.uhid)}</span><span>${esc(ageSex(p))}${p.dob ? ` · DOB ${fdate(p.dob)}` : ''}</span>${p.blood_group ? `<span class="badge red plain">${esc(p.blood_group)}</span>` : ''}<span>${icon('phone')} ${esc(p.mobile)}</span>${p.email ? `<span>${esc(p.email)}</span>` : ''}</div>
          ${p.allergies ? `<div class="callout danger mt-12" style="padding:9px 12px">${icon('alert')}<div><b>Allergies:</b> ${esc(p.allergies)}</div></div>` : ''}
          ${p.chronic_conditions ? `<div class="small mt-8"><span class="muted">Known conditions:</span> <b>${esc(p.chronic_conditions)}</b></div>` : ''}
        </div>
        <div class="kpis" style="min-width:320px;grid-template-columns:repeat(2,1fr)">
          <div class="kpi"><div class="label">OPD visits</div><div class="value" data-count="${p.stats.visits}">0</div></div>
          <div class="kpi"><div class="label">Admissions</div><div class="value" data-count="${p.stats.admissions}">0</div></div>
          <div class="kpi"><div class="label">Total billed</div><div class="value" style="font-size:22px" data-count="${p.stats.billed}" data-fmt="cinr">0</div></div>
          <div class="kpi ${p.balance > 0 ? 'alert' : ''}"><div class="label">Outstanding</div><div class="value" style="font-size:22px" data-count="${p.balance}" data-fmt="inr">0</div></div>
        </div>
      </div>
    </div>
    <div class="tabs mt-24" id="ptabs"></div><div id="ptab"></div>`;
  countUp(el);
  const tabsEl = $('#ptabs');
  const tabList = [['timeline', 'Medical timeline'], ['summary', 'Clinical summary'], ['details', 'Details'], ['bills', 'Bills']];
  tabsEl.innerHTML = tabList.map(([k, l], i) => `<button data-k="${k}" class="${i === 0 ? 'on' : ''}">${l}</button>`).join('');
  tabsEl.onclick = (e) => { const b = e.target.closest('button'); if (!b) return; $$('button', tabsEl).forEach((x) => x.classList.toggle('on', x === b)); showTab(b.dataset.k); };
  const showTab = async (k) => {
    const box = $('#ptab'); box.innerHTML = skeletonRows(4, 2);
    try {
      if (k === 'timeline') box.innerHTML = timeline(await api.get(`/patients/${id}/timeline`));
      if (k === 'summary') { const s = await api.get(`/patients/${id}/summary`); box.innerHTML = `<div class="assist"><div class="row">${'<span class="spark-ico">' + icon('sparkles') + '</span>'}<div><h3>Deep Assist · history summary</h3><div class="small muted">${esc(s.disclaimer)}</div></div></div><div class="answer">${s.summary.map((l) => `<p style="margin:6px 0">${esc(l)}</p>`).join('')}</div></div>`; }
      if (k === 'details') box.innerHTML = details(p);
      if (k === 'bills') {
        const inv = await api.get(`/billing/invoices?patient_id=${id}`).catch(() => null);
        box.innerHTML = inv ? `<div class="panel"><table class="table"><thead><tr><th>Invoice</th><th>Date</th><th>Type</th><th class="r">Total</th><th class="r">Paid</th><th class="r">Balance</th><th>Status</th></tr></thead><tbody>${inv.map((i) => `<tr class="click" data-href="/billing/${i.id}"><td class="mono strong">${esc(i.invoice_no)}</td><td>${fdate(i.created_at)}</td><td>${esc(titleCase(i.bill_type))}</td><td class="r num">${inr(i.total)}</td><td class="r num">${inr(i.paid)}</td><td class="r num strong">${inr(i.balance)}</td><td>${badge(i.status)}</td></tr>`).join('')}</tbody></table>${inv.length ? '' : empty({ title: 'No bills yet' })}</div>` : `<div class="panel">${empty({ title: 'Billing is not available for your role' })}</div>`;
      }
    } catch (err) { box.innerHTML = errorState(err); }
  };
  showTab('timeline');

  $('#a-opd')?.addEventListener('click', async () => {
    const m = modal({ title: 'New OPD visit', subtitle: `${esc(p.full_name)} · ${esc(p.uhid)}`, size: 'sm', body: `<div class="col gap-16"><div class="field"><label>Doctor</label><select class="select" id="v-doc">${await doctorOptions()}</select></div><div class="field"><label>Visit type</label><div class="seg" id="v-type"><button class="on" data-k="new">New</button><button data-k="followup">Follow-up</button><button data-k="emergency">Emergency</button></div></div><div class="field"><label>Chief complaint (optional)</label><input class="input" id="v-cc"></div></div>`,
      foot: `<button class="btn btn-secondary" data-close>Cancel</button><button class="btn btn-primary" id="v-go">${icon('ticket')}Generate token</button>` });
    let vt = 'new';
    $('#v-type', m.el).onclick = (e) => { const b = e.target.closest('button'); if (!b) return; vt = b.dataset.k; $$('#v-type button', m.el).forEach((x) => x.classList.toggle('on', x === b)); };
    $('#v-go', m.el).onclick = async (e) => {
      e.currentTarget.classList.add('loading');
      try { const v = await api.post('/opd/visit', { patient_id: p.id, doctor_id: Number($('#v-doc', m.el).value), visit_type: vt, chief_complaint: $('#v-cc', m.el).value }); m.el.remove(); tokenIssued(v, p.full_name, p.uhid); }
      catch (err) { toast(err.message, 'error'); e.target.closest('button')?.classList.remove('loading'); }
    };
  });
  $('#a-more').onclick = (e) => {
    const dd = document.createElement('div');
    import('../core/ui.js').then(({ dropdown }) => {
      const d = dropdown(e.currentTarget, `
        ${can('patients', 'edit') ? `<div class="item" data-a="edit">${icon('edit')}Edit details</div>` : ''}
        ${can('ipd', 'add') && !p.active_admission ? `<div class="item" data-a="admit">${icon('bed')}Admit (IPD)</div>` : ''}
        ${can('laboratory', 'add') ? `<div class="item" data-a="lab">${icon('flask')}Order lab test</div>` : ''}
        ${can('billing', 'add') ? `<div class="item" data-a="bill">${icon('receipt')}New bill</div>` : ''}
        ${can('portal', 'edit') || can('patients', 'edit') ? `<div class="item" data-a="portal">${icon('phone')}${p.portal ? 'Reset portal password' : 'Enable patient portal'}</div>` : ''}
        <div class="item" data-a="print">${icon('printer')}Print registration card</div>`);
      d.onclick = (ev) => {
        const a = ev.target.closest('.item')?.dataset.a; d.remove();
        if (a === 'edit') editPatient(p);
        if (a === 'admit') navigate(`/ipd?admit=${p.id}`);
        if (a === 'lab') navigate(`/laboratory?order=${p.id}`);
        if (a === 'bill') navigate(`/billing?new=1&patient=${p.id}`);
        if (a === 'print') window.open(`/print/registration/${p.id}`, '_blank');
        if (a === 'portal') portalAccess(p);
      };
    });
    void dd;
  };
}

function timeline(ev) {
  if (!ev.length) return `<div class="panel">${empty({ title: 'No history yet' })}</div>`;
  return `<div class="panel"><div class="panel-body"><div class="timeline">${ev.map((e, i) => `<div class="tl-item t-${e.type} ${e.future ? 'future' : ''}" style="animation-delay:${Math.min(i * 0.03, 0.6)}s"><div class="tl-dot">${icon(TL_ICON[e.type] || 'info')}</div>
    <div class="when">${fdt(e.at)}${e.future ? ' · upcoming' : ''}</div>
    <div class="tl-card"><div class="row between"><div><h4>${esc(e.title)}</h4><div class="meta">${esc(e.subtitle || '')}</div></div>${e.status ? badge(e.status) : ''}</div>
    ${tlDetail(e)}</div></div>`).join('')}</div></div></div>`;
}
function tlDetail(e) {
  const d = e.detail; if (!d) return '';
  const out = [];
  if (d.diagnoses && d.diagnoses.length) out.push(`<div class="row wrap mt-8" style="gap:6px">${d.diagnoses.map((x) => `<span class="badge blue plain">${esc(x.code ? `${x.code} · ` : '')}${esc(x.name)}</span>`).join('')}</div>`);
  if (d.vitals) { const v = d.vitals; out.push(`<div class="small muted mt-8">${[v.bp_sys && `BP ${v.bp_sys}/${v.bp_dia}`, v.pulse && `Pulse ${v.pulse}`, v.temp && `Temp ${v.temp}°F`, v.spo2 && `SpO₂ ${v.spo2}%`, v.weight && `Wt ${v.weight} kg`, v.bmi && `BMI ${v.bmi}`].filter(Boolean).join(' · ')}</div>`); }
  if (d.items && d.items.length) out.push(`<table class="table compact mt-8" style="font-size:12.5px"><tbody>${d.items.map((i) => `<tr><td class="strong">${esc(i.name)} ${esc(i.strength || '')}</td><td>${esc(i.dose || '')}</td><td>${esc(i.frequency || '')}</td><td>${i.duration_days ? `${i.duration_days} days` : ''}</td><td class="muted">${esc(i.instructions || '')}</td></tr>`).join('')}</tbody></table>`);
  if (d.results && d.results.length) out.push(`<div class="row wrap mt-8" style="gap:6px">${d.results.map((r) => `<span class="badge ${r.flag === 'N' ? 'grey' : r.flag === 'C' ? 'red' : 'amber'} plain">${esc(r.parameter)}: <b>${esc(r.value)}</b> ${esc(r.unit || '')}${r.flag && r.flag !== 'N' ? ` (${r.flag})` : ''}</span>`).join('')}</div>`);
  if (d.impression) out.push(`<div class="small mt-8"><b>Impression:</b> ${esc(d.impression)}</div>`);
  if (d.summary) out.push(`<div class="small mt-8">${esc(d.summary)}</div>`);
  if (d.advice) out.push(`<div class="small mt-8"><b>Advice:</b> ${esc(d.advice)}</div>`);
  if (e.type === 'prescription') out.push(`<a class="small strong mt-8" style="display:inline-block" href="/print/prescription/${e.id}" target="_blank">${icon('printer')} Print prescription</a>`);
  if (e.type === 'lab' && ['completed', 'verified'].includes(e.status)) out.push(`<a class="small strong mt-8" style="display:inline-block" href="/print/lab/${e.id}" target="_blank">${icon('printer')} View report</a>`);
  if (e.type === 'discharge') out.push(`<a class="small strong mt-8" style="display:inline-block" href="/print/discharge/${e.id}" target="_blank">${icon('printer')} Discharge summary</a>`);
  return out.join('');
}

function details(p) {
  const rows = [['Registered', `${fdt(p.created_at)}${p.registered_by ? ` by ${p.registered_by}` : ''}`], ['Address', [p.address, p.city, p.state, p.pincode].filter(Boolean).join(', ')], ['Alternate mobile', p.alt_mobile], ['Marital status', p.marital_status], ['Occupation', p.occupation],
    ['Emergency contact', [p.emergency_name, p.emergency_relation, p.emergency_phone].filter(Boolean).join(' · ')], ['Guardian', [p.guardian_name, p.guardian_relation, p.guardian_phone].filter(Boolean).join(' · ')],
    ['Insurance', [p.insurance_provider, p.insurance_policy_no, p.insurance_valid_till && `valid till ${fdate(p.insurance_valid_till)}`].filter(Boolean).join(' · ')],
    ['ID documents', p.identifiers.map((i) => `${titleCase(i.id_type)}: ${i.value || i.masked}`).join(', ')]];
  return `<div class="panel"><div class="panel-body">${rows.map(([k, v]) => `<div class="stat-line"><span class="muted">${esc(k)}</span><b style="text-align:right">${esc(v || '—')}</b></div>`).join('')}</div></div>`;
}

function editPatient(p) {
  const m = modal({ title: 'Edit patient', subtitle: `${esc(p.uhid)} — UHID never changes`, size: 'xl', body: patientForm(p), foot: `<button class="btn btn-secondary" data-close>Cancel</button><button class="btn btn-primary" id="e-save">${icon('save')}Save changes</button>` });
  wirePatientForm(m.el);
  $('#e-save', m.el).onclick = async (e) => {
    const form = $('#pform', m.el); const body = formData(form);
    if (!body.id_number) { delete body.id_type; delete body.id_number; }
    e.currentTarget.classList.add('loading');
    try { await api.put(`/patients/${p.id}`, body); toast('Patient details updated'); m.el.remove(); navigate(`/patients/${p.id}`, { replace: true }); }
    catch (err) { showErrors(form, err); toast(err.message, 'error'); e.target.closest('button')?.classList.remove('loading'); }
  };
}

function portalAccess(p) {
  const pw = Math.random().toString(36).slice(2, 8) + Math.floor(Math.random() * 90 + 10);
  const m = modal({ title: p.portal ? 'Reset portal password' : 'Enable patient portal', size: 'sm', body: `<p class="muted">The patient signs in at <b>${location.origin}/portal</b> with UHID <b>${esc(p.uhid)}</b> or mobile <b>${esc(p.mobile)}</b>.</p><div class="field mt-16"><label>Temporary password</label><input class="input mono" id="pp" value="${pw}"></div><div class="small muted mt-8">Share it with the patient in person or by SMS. They can change it after signing in.</div>`,
    foot: `<button class="btn btn-secondary" data-close>Cancel</button><button class="btn btn-primary" id="pp-go">${icon('key')}Save</button>` });
  $('#pp-go', m.el).onclick = async () => { try { await api.post(`/patients/${p.id}/portal`, { password: $('#pp', m.el).value }); toast('Portal access enabled'); m.el.remove(); } catch (err) { toast(err.message, 'error'); } };
}
