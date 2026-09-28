import { api, session } from '../core/api.js';
import { setQuery } from '../core/router.js';
import { icon } from '../core/icons.js';
import { esc, $, $$, fdt, ftime, badge, ageSex, empty, errorState, skeletonRows, toast, modal, drawer, countUp, tabs, titleCase } from '../core/ui.js';
import { patientPicker, labTests, doctors } from '../core/pickers.js';
import { page, can } from '../shell.js';

const FLOW = ['ordered', 'sample_collected', 'processing', 'completed', 'verified'];
const NEXT = { ordered: ['sample_collected', 'Collect sample', 'droplet'], sample_collected: ['processing', 'Start processing', 'play'], processing: ['completed', 'Enter results', 'edit'], completed: ['verified', 'Verify report', 'shield'] };

export default async function lab(ctx) {
  const el = page({ title: 'Laboratory', subtitle: 'Orders from OPD and IPD arrive here automatically. Verified reports are released to doctors and the patient portal.',
    hero: { img: '/img/diagnostics.jpg', eyebrow: 'Diagnostics', compact: true, stats: '<div class="hero-stats" id="ls"></div>' },
    actions: can('laboratory', 'add') ? `<button class="btn btn-primary" id="order">${icon('plus')}New lab order</button>` : '' });
  el.innerHTML = '<div class="tabs" id="tabs"></div><div id="body"></div>';
  let tab = ctx.query.tab || 'pending';
  tabs($('#tabs'), [['pending', 'Worklist'], ['ordered', 'Awaiting sample'], ['completed', 'To verify'], ['verified', 'Verified'], ['all', 'All']], tab, (k) => { tab = k; setQuery({ tab: k }); load(); });
  const load = async () => {
    const body = $('#body'); body.innerHTML = skeletonRows(8, 7);
    try {
      const [rows, s] = await Promise.all([api.get(`/lab/orders?${tab === 'pending' ? 'pending=1' : `status=${tab}`}`), api.get('/lab/stats')]);
      $('#ls').innerHTML = [['Awaiting sample', s.ordered], ['In process', (s.sample_collected || 0) + (s.processing || 0)], ['To verify', s.completed], ['Verified today', s.verified_today]].map(([l, v]) => `<div><b data-count="${v || 0}">0</b><span>${l}</span></div>`).join(''); countUp($('#ls'));
      body.innerHTML = `<div class="panel">${rows.length ? `<div class="table-wrap"><table class="table"><thead><tr><th>Order</th><th>Patient</th><th>Test</th><th>Priority</th><th>Ordered</th><th>Progress</th><th>Status</th><th></th></tr></thead><tbody>${rows.map((o) => `<tr><td class="mono small strong">${esc(o.order_no)}${o.sample_id ? `<div class="cell-sub">Sample ${esc(o.sample_id)}</div>` : ''}</td><td><div class="cell-main">${esc(o.patient_name)}</div><div class="cell-sub">${esc(o.uhid)} · ${esc(ageSex(o))}${o.ipd_no ? ` · ${esc(o.ipd_no)}` : ''}</div></td><td><div class="cell-main">${esc(o.test)}</div><div class="cell-sub">${esc(o.category || '')} · ${esc(o.sample_type || '')}</div></td><td>${badge(o.priority)}</td><td class="small">${fdt(o.created_at)}<div class="cell-sub">${esc(o.doctor_name || '')}</div></td>
        <td style="min-width:120px"><div class="row" style="gap:3px">${FLOW.map((f, i) => `<i style="flex:1;height:5px;border-radius:3px;background:${FLOW.indexOf(o.status) >= i ? 'var(--green)' : 'var(--bg-sunken)'}"></i>`).join('')}</div></td><td>${badge(o.status)}</td>
        <td class="r nowrap">${NEXT[o.status] && can('laboratory', 'edit') && (o.status !== 'completed' || can('laboratory', 'approve')) ? `<button class="btn btn-soft btn-sm" data-act="${o.id}" data-st="${o.status}">${icon(NEXT[o.status][2])}${NEXT[o.status][1]}</button>` : ''}${['completed', 'verified'].includes(o.status) ? `<a class="btn btn-ghost btn-sm" href="/print/lab/${o.id}" target="_blank">${icon('printer')}</a>` : ''}</td></tr>`).join('')}</tbody></table></div>` : empty({ title: 'Nothing here', text: 'Lab orders from consultations and IPD appear automatically.', illo: 'generic' })}</div>`;
      $$('[data-act]', body).forEach((b) => (b.onclick = () => act(Number(b.dataset.act), b.dataset.st)));
    } catch (err) { body.innerHTML = errorState(err); }
  };
  const act = async (id, st) => {
    const next = NEXT[st][0];
    if (next === 'completed' || next === 'verified') return resultsDrawer(id, next);
    try { await api.post(`/lab/orders/${id}/status`, { status: next }); toast(`${titleCase(next)}`); load(); } catch (err) { toast(err.message, 'error'); }
  };
  const resultsDrawer = async (id, next) => {
    const o = await api.get(`/lab/orders/${id}`);
    const d = drawer({ title: o.test, subtitle: `${esc(o.order_no)} · ${esc(o.patient_name)} · ${esc(o.uhid)} · ${esc(ageSex(o))}`, size: 'wide',
      body: `<table class="table"><thead><tr><th>Parameter</th><th>Result</th><th>Unit</th><th>Reference</th><th>Flag</th></tr></thead><tbody>${o.parameters.map((p) => { const r = o.results.find((x) => x.parameter === p.name); return `<tr><td class="strong">${esc(p.name)}</td><td>${next === 'completed' ? `<input class="input input-sm" data-p="${esc(p.name)}" value="${esc(r ? r.value : '')}" style="width:140px">` : `<b>${esc(r ? r.value : '—')}</b>`}</td><td class="small">${esc(p.unit || '')}</td><td class="small muted">${esc(p.ref_text || (p.ref_low !== undefined ? `${p.ref_low} – ${p.ref_high}` : ''))}</td><td>${r && r.flag && r.flag !== 'N' ? `<span class="badge ${r.flag === 'C' ? 'red' : 'amber'}">${r.flag === 'C' ? 'Critical' : r.flag === 'H' ? 'High' : 'Low'}</span>` : ''}</td></tr>`; }).join('')}</tbody></table>
        <div class="field mt-16"><label>Remarks</label><textarea class="textarea" id="rm" ${next === 'verified' ? 'readonly' : ''}>${esc(o.remarks || '')}</textarea></div>
        ${next === 'verified' ? `<div class="callout mt-16">${icon('shield')}<div>Results entered by <b>${esc(o.technician_name || '—')}</b> at ${fdt(o.completed_at)}. Verification releases the report to the doctor and the patient portal.</div></div>` : ''}`,
      foot: `<button class="btn btn-secondary" data-close>Cancel</button><button class="btn btn-primary" id="save">${next === 'completed' ? `${icon('save')}Save results` : `${icon('shield')}Verify & release`}</button>` });
    $('#save', d.el).onclick = async () => {
      const body = { status: next };
      if (next === 'completed') { body.results = $$('[data-p]', d.el).map((i) => ({ parameter: i.dataset.p, value: i.value.trim() })).filter((r) => r.value); body.remarks = $('#rm', d.el).value; }
      try { await api.post(`/lab/orders/${id}/status`, body); toast(next === 'verified' ? 'Report verified and released' : 'Results saved — awaiting verification'); d.close(); load(); } catch (err) { toast(err.message, 'error'); }
    };
  };
  $('#order')?.addEventListener('click', () => newOrder(load));
  if (ctx.query.order) { const pid = ctx.query.order; setQuery({ order: null }); newOrder(load, pid); }
  load();
  void ftime; void session;
}

async function newOrder(done, patientId) {
  const [tests, docs] = await Promise.all([labTests(), doctors()]);
  const m = modal({ title: 'New lab order', size: 'lg', body: `<div class="form-grid"><div class="field s8"><label>Patient</label><input class="input" id="lo-p" placeholder="Search patient"></div><div class="field s4"><label>Priority</label><select class="select" id="lo-pr"><option value="routine">Routine</option><option value="urgent">Urgent</option><option value="stat">STAT</option></select></div>
    <div class="field s12"><label>Referring doctor</label><select class="select" id="lo-d"><option value="">Self / walk-in</option>${docs.map((d) => `<option value="${d.id}">${esc(d.name)}</option>`).join('')}</select></div>
    <div class="field s12"><label>Tests</label><div class="row wrap" style="gap:6px" id="lo-t">${tests.filter((t) => t.is_active).map((t) => `<button class="chip" data-t="${t.id}">${esc(t.name)} · ₹${t.price}</button>`).join('')}</div></div></div>`,
    foot: `<button class="btn btn-secondary" data-close>Cancel</button><button class="btn btn-primary" id="lo-go">${icon('flask')}Create order & invoice</button>` });
  let patient = null; const sel = new Set();
  patientPicker($('#lo-p', m.el), (p) => { patient = p; $('#lo-p', m.el).value = `${p.full_name} · ${p.uhid}`; });
  if (patientId) api.get(`/patients/${patientId}`).then((p) => { patient = p; $('#lo-p', m.el).value = `${p.full_name} · ${p.uhid}`; });
  $$('#lo-t .chip', m.el).forEach((c) => (c.onclick = () => { const id = Number(c.dataset.t); sel.has(id) ? sel.delete(id) : sel.add(id); c.classList.toggle('on'); }));
  $('#lo-go', m.el).onclick = async () => {
    if (!patient || !sel.size) return toast('Select patient and at least one test', 'error');
    try { const r = await api.post('/lab/orders', { patient_id: patient.id, test_ids: [...sel], priority: $('#lo-pr', m.el).value, doctor_id: $('#lo-d', m.el).value ? Number($('#lo-d', m.el).value) : undefined }); m.el.remove(); toast(`${r.length} test(s) ordered — invoice created`); done(); } catch (err) { toast(err.message, 'error'); }
  };
}
