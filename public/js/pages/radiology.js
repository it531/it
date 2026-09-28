import { api } from '../core/api.js';
import { setQuery } from '../core/router.js';
import { icon } from '../core/icons.js';
import { esc, $, $$, fdt, badge, ageSex, empty, errorState, skeletonRows, toast, modal, drawer, tabs, todayISO } from '../core/ui.js';
import { patientPicker, doctors } from '../core/pickers.js';
import { page, can } from '../shell.js';

const NEXT = { ordered: ['scanned', 'Mark scanned', 'scan'], scheduled: ['scanned', 'Mark scanned', 'scan'], scanned: ['reported', 'Write report', 'edit'], reported: ['verified', 'Verify', 'shield'] };
const STUDIES = { 'X-Ray': ['Chest PA view', 'Lumbosacral spine AP/Lat', 'Cervical spine AP/Lat', 'Knee AP/Lat', 'Wrist AP/Lat', 'PNS (Waters view)'], CT: ['CT Brain (plain)', 'HRCT Chest', 'CT Abdomen (contrast)', 'CT KUB'], MRI: ['MRI Brain', 'MRI Lumbar spine', 'MRI Knee', 'MRI Cervical spine'], Ultrasound: ['USG Abdomen & Pelvis', 'Obstetric USG', 'USG KUB', 'USG Thyroid', 'Doppler lower limb'], Other: ['2D Echo', 'Mammography', 'DEXA scan'] };

export default async function radiology(ctx) {
  const el = page({ title: 'Radiology', subtitle: 'Order → schedule → scan → report → verification → doctor & patient access.', actions: can('radiology', 'add') ? `<button class="btn btn-primary" id="order">${icon('plus')}New imaging order</button>` : '' });
  el.innerHTML = '<div class="tabs" id="tabs"></div><div id="body"></div>';
  let tab = ctx.query.tab || 'ordered';
  tabs($('#tabs'), [['ordered', 'To scan'], ['scheduled', 'Scheduled'], ['scanned', 'To report'], ['reported', 'To verify'], ['verified', 'Verified'], ['all', 'All']], tab, (k) => { tab = k; setQuery({ tab: k }); load(); });
  const load = async () => {
    const body = $('#body'); body.innerHTML = skeletonRows(6, 6);
    try {
      const rows = await api.get(`/radiology/orders?status=${tab}`);
      body.innerHTML = `<div class="panel">${rows.length ? `<table class="table"><thead><tr><th>Order</th><th>Patient</th><th>Study</th><th>Ordered</th><th>Status</th><th></th></tr></thead><tbody>${rows.map((o) => `<tr><td class="mono small strong">${esc(o.order_no)}</td><td><div class="cell-main">${esc(o.patient_name)}</div><div class="cell-sub">${esc(o.uhid)} · ${esc(ageSex(o))}</div></td><td><div class="cell-main">${esc(o.modality)} · ${esc(o.study)}</div><div class="cell-sub">${esc(o.clinical_info || '')}</div>${o.impression ? `<div class="cell-sub"><b>Impression:</b> ${esc(o.impression)}</div>` : ''}</td><td class="small">${fdt(o.created_at)}<div class="cell-sub">${esc(o.doctor_name || '')}${o.scheduled_at ? ` · slot ${fdt(o.scheduled_at)}` : ''}</div></td><td>${badge(o.status)}</td>
        <td class="r nowrap">${o.status === 'ordered' && can('radiology', 'edit') ? `<button class="btn btn-ghost btn-sm" data-sched="${o.id}">${icon('calendar')}Schedule</button>` : ''}${NEXT[o.status] && can('radiology', 'edit') && (o.status !== 'reported' || can('radiology', 'approve')) ? `<button class="btn btn-soft btn-sm" data-act="${o.id}" data-st="${o.status}">${icon(NEXT[o.status][2])}${NEXT[o.status][1]}</button>` : ''}${['reported', 'verified'].includes(o.status) ? `<a class="btn btn-ghost btn-sm" href="/print/radiology/${o.id}" target="_blank">${icon('printer')}</a>` : ''}</td></tr>`).join('')}</tbody></table>` : empty({ title: 'No studies in this stage', illo: 'generic' })}</div>`;
      $$('[data-act]', body).forEach((b) => (b.onclick = () => act(Number(b.dataset.act), b.dataset.st, rows.find((r) => String(r.id) === b.dataset.act))));
      $$('[data-sched]', body).forEach((b) => (b.onclick = async () => { const m = modal({ title: 'Schedule scan', size: 'sm', body: `<div class="field"><label>Date & time</label><input class="input" type="datetime-local" id="sd" value="${todayISO()}T15:00"></div>`, foot: '<button class="btn btn-secondary" data-close>Cancel</button><button class="btn btn-primary" id="sg">Schedule</button>' }); $('#sg', m.el).onclick = async () => { try { await api.post(`/radiology/orders/${b.dataset.sched}/status`, { status: 'scheduled', scheduled_at: $('#sd', m.el).value.replace('T', ' ') }); toast('Scan scheduled'); m.el.remove(); load(); } catch (err) { toast(err.message, 'error'); } }; }));
    } catch (err) { body.innerHTML = errorState(err); }
  };
  const act = async (id, st, o) => {
    const next = NEXT[st][0];
    if (next === 'reported' || next === 'verified') {
      const d = drawer({ title: `${o.modality} · ${o.study}`, subtitle: `${esc(o.order_no)} · ${esc(o.patient_name)} · ${esc(o.uhid)}`, size: 'wide',
        body: `<div class="col gap-16"><div class="field"><label>Findings</label><textarea class="textarea" id="rf" rows="8" ${next === 'verified' ? 'readonly' : ''}>${esc(o.findings || '')}</textarea></div><div class="field"><label>Impression</label><textarea class="textarea" id="ri" rows="3" ${next === 'verified' ? 'readonly' : ''}>${esc(o.impression || '')}</textarea></div></div>`,
        foot: `<button class="btn btn-secondary" data-close>Cancel</button><button class="btn btn-primary" id="rs">${next === 'reported' ? 'Save report' : 'Verify & release'}</button>` });
      $('#rs', d.el).onclick = async () => { try { await api.post(`/radiology/orders/${id}/status`, { status: next, findings: $('#rf', d.el).value, impression: $('#ri', d.el).value }); toast(next === 'verified' ? 'Report verified and released' : 'Report saved'); d.close(); load(); } catch (err) { toast(err.message, 'error'); } };
      return;
    }
    try { await api.post(`/radiology/orders/${id}/status`, { status: next }); toast('Updated'); load(); } catch (err) { toast(err.message, 'error'); }
  };
  $('#order')?.addEventListener('click', async () => {
    const docs = await doctors();
    const m = modal({ title: 'New imaging order', size: 'lg', body: `<div class="form-grid"><div class="field s12"><label>Patient</label><input class="input" id="ro-p"></div><div class="field s4"><label>Modality</label><select class="select" id="ro-m">${Object.keys(STUDIES).map((k) => `<option>${k}</option>`).join('')}</select></div><div class="field s8"><label>Study</label><select class="select" id="ro-s"></select></div><div class="field s6"><label>Referring doctor</label><select class="select" id="ro-d"><option value="">—</option>${docs.map((d) => `<option value="${d.id}">${esc(d.name)}</option>`).join('')}</select></div><div class="field s6"><label>Clinical information</label><input class="input" id="ro-c"></div></div>`,
      foot: `<button class="btn btn-secondary" data-close>Cancel</button><button class="btn btn-primary" id="ro-go">${icon('scan')}Create order</button>` });
    let patient = null;
    patientPicker($('#ro-p', m.el), (p) => { patient = p; $('#ro-p', m.el).value = `${p.full_name} · ${p.uhid}`; });
    const fill = () => ($('#ro-s', m.el).innerHTML = STUDIES[$('#ro-m', m.el).value].map((s) => `<option>${s}</option>`).join('')); fill(); $('#ro-m', m.el).onchange = fill;
    $('#ro-go', m.el).onclick = async () => { if (!patient) return toast('Select a patient', 'error'); try { await api.post('/radiology/orders', { patient_id: patient.id, modality: $('#ro-m', m.el).value, study: $('#ro-s', m.el).value, clinical_info: $('#ro-c', m.el).value, doctor_id: $('#ro-d', m.el).value ? Number($('#ro-d', m.el).value) : undefined }); toast('Imaging ordered — invoice created'); m.el.remove(); load(); } catch (err) { toast(err.message, 'error'); } };
  });
  load();
}
