import { api } from '../core/api.js';
import { icon } from '../core/icons.js';
import { esc, $, $$, ftime, fdt, badge, avatar, ageSex, empty, errorState, skeletonBlock, skeletonKpis, toast, countUp, segmented } from '../core/ui.js';
import { page, can } from '../shell.js';
import { recordDose } from './ipd.js';

export default async function nursing(ctx) {
  const el = page({ title: 'Nursing station', subtitle: 'Assigned patients, vitals and medication due, doctor instructions and shift handover.', actions: '<div id="mine"></div>' });
  let mine = ctx.query.mine === '1';
  segmented($('#mine'), [['all', 'All patients'], ['mine', 'Assigned to me']], mine ? 'mine' : 'all', (k) => { mine = k === 'mine'; load(); });
  el.innerHTML = `${skeletonKpis(5)}<div class="mt-24">${skeletonBlock(360)}</div>`;
  const load = async () => {
    let d;
    try { d = await api.get(`/nursing/dashboard${mine ? '?mine=1' : ''}`); } catch (err) { el.innerHTML = errorState(err, 'retry'); $('#retry').onclick = load; return; }
    if (!ctx.isCurrent()) return;
    const s = d.stats;
    el.innerHTML = `<div class="kpis c5">${[['In-patients', s.patients, 'bed'], ['Vitals due', s.vitals_due, 'activity', s.vitals_due ? 'alert' : ''], ['Medication due', s.meds_due, 'pill'], ['Overdue doses', s.overdue, 'alert', s.overdue ? 'alert' : ''], ['New instructions', s.instructions, 'clipboard', s.instructions ? 'accent' : '']].map(([l, v, ic, c]) => `<div class="kpi ${c || ''}"><div class="label">${icon(ic)}${l}</div><div class="value" data-count="${v || 0}">0</div></div>`).join('')}</div>
    <div class="grid g-main section">
      <div class="panel"><div class="panel-head"><h3>Medication due (±2 h)</h3><span class="live-dot">Live</span></div><div class="panel-body flush list">${d.medications_due.map((m) => `<div class="list-row"><span class="token-pill ${m.done ? 'ghost' : m.overdue ? '' : ''}" style="${m.overdue ? 'background:var(--red-50);color:var(--red)' : ''}">${m.scheduled_for.slice(11, 16)}</span><div class="grow"><div class="cell-main">${esc(m.name)} · ${esc(m.dose || '')} ${esc(m.route || '')}</div><div class="cell-sub">${esc(m.patient_name)} · ${esc(m.bed)} · ${esc(m.ipd_no)}</div></div>${m.done ? badge(m.done === 'given' ? 'completed' : 'pending', m.done) : m.overdue ? '<span class="badge red">Overdue</span>' : '<span class="badge amber">Due</span>'}${!m.done && (can('nursing', 'add')) ? `<button class="btn btn-soft btn-sm" data-dose="${m.medication_id}" data-slot="${m.scheduled_for}">${icon('check')}Record</button>` : ''}</div>`).join('') || `<div class="panel-body">${empty({ title: 'No doses due right now', illo: 'pill' })}</div>`}</div></div>
      <div class="panel"><div class="panel-head"><h3>Doctor instructions</h3></div><div class="panel-body col gap-10">${d.instructions.map((n) => `<div class="callout warn" style="flex-direction:column;gap:6px"><div class="row between" style="width:100%"><b class="small">${esc(n.patient_name)} · ${esc(n.bed_no || n.ipd_no)}</b><span class="xs muted">${ftime(n.created_at)}</span></div><div class="small">${esc(n.body)}</div><div class="row between" style="width:100%"><span class="xs muted">— ${esc(n.user_name || '')}</span>${can('nursing', 'edit') ? `<button class="btn btn-secondary btn-sm" data-ack="${n.id}">${icon('check')}Acknowledge</button>` : ''}</div></div>`).join('') || '<p class="small muted">No pending instructions.</p>'}</div></div>
    </div>
    <div class="section-title section"><h2>Patients</h2></div>
    <div class="grid g3">${d.patients.map((p) => `<a class="panel hover" href="/ipd/${p.id}" style="color:inherit"><div class="panel-body"><div class="row">${avatar(p.patient_name)}<div class="grow"><div class="cell-main truncate">${esc(p.patient_name)}</div><div class="cell-sub">${esc(p.ward || '')} · <b>${esc(p.bed_no || '')}</b> · ${esc(ageSex(p))}</div></div>${p.vitals_due ? '<span class="badge amber">Vitals due</span>' : '<span class="badge green plain">OK</span>'}</div>
      ${p.allergies ? `<div class="xs mt-8" style="color:var(--red);font-weight:700">Allergy: ${esc(p.allergies)}</div>` : ''}
      <div class="row mt-12 small" style="gap:14px;color:var(--ink-2)">${p.last_vitals ? `<span>BP <b>${p.last_vitals.bp_sys || '—'}/${p.last_vitals.bp_dia || '—'}</b></span><span>HR <b>${p.last_vitals.pulse || '—'}</b></span><span>SpO₂ <b style="${p.last_vitals.spo2 && p.last_vitals.spo2 < 92 ? 'color:var(--red)' : ''}">${p.last_vitals.spo2 || '—'}</b></span><span>T <b>${p.last_vitals.temp || '—'}</b></span>` : '<span class="muted">No vitals yet</span>'}</div>
      <div class="xs muted mt-8">${esc(p.ipd_no)} · ${esc(p.doctor_name)} · last vitals ${p.last_vitals_at ? ftime(p.last_vitals_at) : '—'}</div></div></a>`).join('') || `<div class="panel" style="grid-column:1/-1">${empty({ title: 'No admitted patients', illo: 'bed' })}</div>`}</div>
    <div class="panel section"><div class="panel-head"><h3>Shift handover & nursing notes (24 h)</h3></div><div class="panel-body">${d.handovers.map((n) => `<div class="stat-line" style="align-items:flex-start"><div><b class="small">${esc(n.patient_name)} · ${esc(n.ipd_no)}</b><div class="small">${esc(n.body)}</div></div><span class="xs muted nowrap">${esc(n.user_name || '')} · ${fdt(n.created_at)}</span></div>`).join('') || '<p class="small muted">No handover notes in the last 24 hours. Add them from a patient’s admission record.</p>'}</div></div>`;
    countUp(el);
    $$('[data-dose]', el).forEach((b) => (b.onclick = () => recordDose(Number(b.dataset.dose), load, b.dataset.slot)));
    $$('[data-ack]', el).forEach((b) => (b.onclick = async () => { try { await api.post(`/ipd/notes/${b.dataset.ack}/acknowledge`); toast('Instruction acknowledged'); load(); } catch (err) { toast(err.message, 'error'); } }));
  };
  load();
  const t = setInterval(() => { if (!ctx.isCurrent() || !document.body.contains(el)) return clearInterval(t); if (!document.querySelector('.backdrop')) load(); }, 30000);
}
