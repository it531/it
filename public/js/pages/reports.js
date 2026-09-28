import { api, download } from '../core/api.js';
import { setQuery } from '../core/router.js';
import { icon } from '../core/icons.js';
import { esc, $, $$, fdate, fdt, inr2, num, badge, empty, errorState, skeletonBlock, toast, modal, confirmDialog, titleCase } from '../core/ui.js';
import { doctors, departments } from '../core/pickers.js';
import { reportChart } from '../core/charts.js';
import { page, can } from '../shell.js';

const PRESETS = [['today', 'Today'], ['yesterday', 'Yesterday'], ['week', 'This week'], ['month', 'This month'], ['last_month', 'Last month'], ['quarter', 'Quarter'], ['year', 'Year'], ['custom', 'Custom']];
const GROUP_ICON = { Patients: 'patients', OPD: 'stethoscope', IPD: 'bed', Pharmacy: 'pill', Revenue: 'rupee', HR: 'briefcase' };

export default async function reports(ctx) {
  const el = page({ title: 'Reports & MIS', subtitle: 'Every figure is calculated live from the hospital database. Export to Excel, CSV or PDF.' });
  el.innerHTML = skeletonBlock(500);
  let cat, docs, deps;
  try { [cat, docs, deps] = await Promise.all([api.get('/reports'), doctors().catch(() => []), departments().catch(() => [])]); } catch (err) { el.innerHTML = errorState(err); return; }
  if (!cat.catalogue.length) { el.innerHTML = `<div class="panel">${empty({ title: 'No reports available for your role' })}</div>`; return; }
  const q = ctx.query;
  const state = { key: q.key || (cat.catalogue.find((c) => c.key === 'opd_daily') || cat.catalogue[0]).key, preset: q.preset || 'month', from: q.from || '', to: q.to || '', department_id: q.department_id || '', doctor_id: q.doctor_id || '', patient_type: q.patient_type || '', payment_mode: q.payment_mode || '', status: q.status || '' };
  const groups = [...new Set(cat.catalogue.map((c) => c.group))];
  el.innerHTML = `
    <div class="assist mb-16"><div class="row" style="gap:12px"><span class="spark-ico">${icon('sparkles')}</span><div class="grow"><h3>Ask Deep Assist</h3><div class="small muted">Plain-English questions are mapped onto the report catalogue — e.g. “Show me OPD patients for August”.</div></div></div>
      <form class="q mt-12" id="aq"><div class="input-icon grow">${icon('search')}<input class="input" id="aq-in" placeholder="Which medicines are below minimum stock?" value="${esc(q.ask || '')}"></div><button class="btn btn-primary">${icon('send')}Ask</button></form><div class="suggest" id="aq-s"></div><div id="aq-out"></div></div>
    <div class="grid" style="grid-template-columns:260px minmax(0,1fr);align-items:start" id="rgrid">
      <aside class="panel" style="position:sticky;top:90px"><div class="panel-body" style="padding:12px">${groups.map((g) => `<div class="nav-group-title" style="padding:10px 8px 4px">${esc(g)}</div>${cat.catalogue.filter((c) => c.group === g).map((c) => `<a href="#" class="nav-item" data-key="${c.key}" style="height:auto;min-height:36px;padding:8px 10px;white-space:normal;font-size:13px">${icon(GROUP_ICON[g] || 'file')}<span>${esc(c.title)}</span></a>`).join('')}`).join('')}
        ${cat.saved.length ? `<div class="nav-group-title" style="padding:14px 8px 4px">Saved reports</div>${cat.saved.map((s) => `<div class="row" style="gap:4px"><a href="#" class="nav-item grow" data-saved="${s.id}" style="height:auto;min-height:34px;padding:7px 10px;white-space:normal;font-size:13px">${icon('star')}<span>${esc(s.name)}${s.schedule && s.schedule !== 'none' ? ` <span class="badge teal plain" style="height:18px;font-size:10px">${esc(s.schedule)}</span>` : ''}</span></a><button class="icon-btn" data-del="${s.id}" style="width:28px;height:28px" aria-label="Delete">${icon('x')}</button></div>`).join('')}` : ''}</div></aside>
      <section class="col gap-16" style="min-width:0">
        <div class="panel"><div class="panel-body col gap-12">
          <div class="row wrap between" style="gap:10px"><h2 id="rtitle"></h2><div class="btn-group">
            <button class="btn btn-secondary btn-sm" id="save">${icon('star')}Save / schedule</button>
            <button class="btn btn-secondary btn-sm" id="xls">${icon('download')}Excel</button><button class="btn btn-secondary btn-sm" id="csv">${icon('download')}CSV</button><button class="btn btn-secondary btn-sm" id="pdf">${icon('printer')}PDF / Print</button></div></div>
          <div class="row wrap" style="gap:8px"><div class="seg" id="presets">${PRESETS.map(([k, l]) => `<button type="button" data-k="${k}" class="${state.preset === k ? 'on' : ''}">${l}</button>`).join('')}</div>
            <div class="row ${state.preset === 'custom' ? '' : 'hidden'}" id="custom" style="gap:6px"><input class="input input-sm" type="date" id="from" value="${esc(state.from)}"><span class="muted">→</span><input class="input input-sm" type="date" id="to" value="${esc(state.to)}"></div></div>
          <div class="row wrap" style="gap:8px">
            <select class="select input-sm" id="f-dept" style="width:190px"><option value="">All departments</option>${deps.filter((d) => d.kind === 'clinical').map((d) => `<option value="${d.id}" ${String(d.id) === state.department_id ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}</select>
            <select class="select input-sm" id="f-doc" style="width:200px"><option value="">All doctors</option>${docs.map((d) => `<option value="${d.id}" ${String(d.id) === state.doctor_id ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}</select>
            <select class="select input-sm" id="f-pt" style="width:160px"><option value="">All patients</option><option value="new" ${state.patient_type === 'new' ? 'selected' : ''}>New patients</option><option value="returning" ${state.patient_type === 'returning' ? 'selected' : ''}>Returning</option></select>
            <select class="select input-sm" id="f-pm" style="width:160px"><option value="">Any payment mode</option>${['cash', 'upi', 'card', 'bank_transfer', 'other'].map((m) => `<option value="${m}" ${state.payment_mode === m ? 'selected' : ''}>${titleCase(m)}</option>`).join('')}</select>
            <input class="input input-sm" id="f-st" style="width:150px" placeholder="Status filter" value="${esc(state.status)}" list="stl"><datalist id="stl">${['completed', 'waiting', 'cancelled', 'admitted', 'discharged', 'paid', 'unpaid', 'pending', 'approved', 'confirmed', 'no_show'].map((s) => `<option>${s}</option>`).join('')}</datalist>
            <button class="btn btn-primary btn-sm" id="gen">${icon('refresh')}Generate</button></div>
        </div></div>
        <div id="out"></div>
      </section></div>`;
  if (window.innerWidth < 1000) $('#rgrid').style.gridTemplateColumns = '1fr';

  const qs = () => new URLSearchParams(Object.fromEntries(Object.entries({ preset: state.preset === 'custom' ? '' : state.preset, from: state.from, to: state.to, department_id: state.department_id, doctor_id: state.doctor_id, patient_type: state.patient_type, payment_mode: state.payment_mode, status: state.status }).filter(([, v]) => v))).toString();
  const readFilters = () => { state.department_id = $('#f-dept').value; state.doctor_id = $('#f-doc').value; state.patient_type = $('#f-pt').value; state.payment_mode = $('#f-pm').value; state.status = $('#f-st').value.trim(); state.from = $('#from').value; state.to = $('#to').value; };
  const run = async () => {
    readFilters();
    setQuery({ key: state.key, ...Object.fromEntries(new URLSearchParams(qs())), ask: null });
    $$('[data-key]').forEach((a) => a.classList.toggle('active', a.dataset.key === state.key));
    const out = $('#out'); out.innerHTML = skeletonBlock(360);
    try { const r = await api.get(`/reports/${state.key}?${qs()}`); $('#rtitle').textContent = r.title; renderReport(out, r); }
    catch (err) { out.innerHTML = errorState(err); }
  };
  $$('[data-key]').forEach((a) => (a.onclick = (e) => { e.preventDefault(); state.key = a.dataset.key; run(); }));
  $('#presets').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; state.preset = b.dataset.k; $$('#presets button').forEach((x) => x.classList.toggle('on', x === b)); $('#custom').classList.toggle('hidden', state.preset !== 'custom'); if (state.preset !== 'custom') { state.from = ''; state.to = ''; run(); } };
  $('#gen').onclick = run;
  ['#f-dept', '#f-doc', '#f-pt', '#f-pm'].forEach((s) => ($(s).onchange = run));
  const exportAs = async (fmt) => { readFilters(); try { await download(`/reports/${state.key}?${qs()}&format=${fmt}`); toast(`${fmt.toUpperCase()} export downloaded`); } catch (err) { toast(err.message, 'error'); } };
  $('#xls').onclick = () => exportAs('xls'); $('#csv').onclick = () => exportAs('csv');
  $('#pdf').onclick = () => { readFilters(); window.open(`/print/report/${state.key}?${qs()}`, '_blank'); };
  $('#save').onclick = () => {
    const m = modal({ title: 'Save report', size: 'sm', body: `<div class="col gap-12"><div class="field"><label>Name</label><input class="input" id="sn" value="${esc($('#rtitle').textContent)}"></div><div class="field"><label>Schedule</label><select class="select" id="ss"><option value="none">Don't schedule</option><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option></select><div class="hint">Scheduled reports run automatically and notify you with the headline figures.</div></div></div>`, foot: '<button class="btn btn-secondary" data-close>Cancel</button><button class="btn btn-primary" id="sg">Save</button>' });
    $('#sg', m.el).onclick = async () => { readFilters(); try { await api.post('/reports/saved', { name: $('#sn', m.el).value, report_type: state.key, filters: { ...state, key: undefined }, schedule: $('#ss', m.el).value }); toast('Report saved'); m.el.remove(); reports(ctx); } catch (err) { toast(err.message, 'error'); } };
  };
  $$('[data-saved]').forEach((a) => (a.onclick = (e) => { e.preventDefault(); const s = cat.saved.find((x) => String(x.id) === a.dataset.saved); Object.assign(state, JSON.parse(s.filters || '{}'), { key: s.report_type }); $$('#presets button').forEach((x) => x.classList.toggle('on', x.dataset.k === state.preset)); run(); }));
  $$('[data-del]').forEach((b) => (b.onclick = async () => { if (!(await confirmDialog({ title: 'Delete saved report?', message: 'Any schedule on it stops.', confirm: 'Delete', danger: true }))) return; await api.del(`/reports/saved/${b.dataset.del}`); reports(ctx); }));

  // Deep Assist
  const sugg = await api.get('/assistant/suggestions').catch(() => []);
  $('#aq-s').innerHTML = sugg.map((s) => `<button class="chip" type="button" style="height:30px;font-size:12.5px">${esc(s)}</button>`).join('');
  $('#aq-s').onclick = (e) => { const c = e.target.closest('.chip'); if (c) { $('#aq-in').value = c.textContent; ask(); } };
  const ask = async () => {
    const text = $('#aq-in').value.trim(); if (!text) return;
    $('#aq-out').innerHTML = `<div class="answer">${skeletonBlock(40)}</div>`;
    try {
      const r = await api.post('/assistant/query', { q: text });
      $('#aq-out').innerHTML = `<div class="answer">${esc(r.answer).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')}${r.report ? ` <a href="#" id="aq-open" class="strong">Open full report →</a>` : ''}</div>`;
      if (r.report) {
        $('#aq-open').onclick = (e) => { e.preventDefault(); state.key = r.report.key; state.preset = 'custom'; state.from = r.report.filters.from; state.to = r.report.filters.to; state.doctor_id = r.report.filters.doctor_id ? String(r.report.filters.doctor_id) : ''; $('#from').value = state.from; $('#to').value = state.to; $('#custom').classList.remove('hidden'); $$('#presets button').forEach((x) => x.classList.toggle('on', x.dataset.k === 'custom')); run(); $('#out').scrollIntoView({ behavior: 'smooth' }); };
        $('#rtitle').textContent = r.report.title; renderReport($('#out'), r.report);
      }
    } catch (err) { $('#aq-out').innerHTML = `<div class="answer">${esc(err.message)}</div>`; }
  };
  $('#aq').onsubmit = (e) => { e.preventDefault(); ask(); };
  if (q.assist) setTimeout(() => $('#aq-in').focus(), 100);
  if (q.ask) ask(); else run();
  void can; void fdate;
}

export function renderReport(out, r) {
  const fmt = (c, v) => (v == null || v === '' ? '—' : c.type === 'money' ? inr2(v) : c.type === 'date' ? fdate(v) : c.type === 'datetime' ? fdt(v) : c.type === 'status' ? badge(v) : c.type === 'pct' ? `${v}%` : ['int', 'number'].includes(c.type) ? num(v) : esc(v));
  out.innerHTML = `${r.summary && r.summary.length ? `<div class="kpis" style="grid-template-columns:repeat(${Math.min(r.summary.length, 4)},1fr)">${r.summary.map((s) => `<div class="kpi"><div class="label">${esc(s.label)}</div><div class="value">${s.type === 'money' ? inr2(s.value) : esc(typeof s.value === 'number' ? num(s.value) : s.value)}</div></div>`).join('')}</div>` : ''}
    ${r.chart && r.chart.data && r.chart.data.length ? '<div class="panel mt-16"><div class="panel-body" id="rchart"></div></div>' : ''}
    <div class="panel mt-16"><div class="panel-head"><h3>${num(r.rows.length)} row${r.rows.length === 1 ? '' : 's'}</h3><span class="small muted">${fdate(r.filters.from)} – ${fdate(r.filters.to)}</span></div>
    <div class="panel-body flush">${r.rows.length ? `<div class="table-wrap" style="max-height:560px;overflow:auto"><table class="table compact" id="rtable"><thead><tr>${r.columns.map((c, i) => `<th class="${['int', 'number', 'money', 'pct'].includes(c.type) ? 'r' : ''}" data-sort="${i}" style="cursor:pointer">${esc(c.label)}</th>`).join('')}</tr></thead><tbody>${r.rows.slice(0, 1000).map((row) => `<tr>${r.columns.map((c) => `<td class="${['int', 'number', 'money', 'pct'].includes(c.type) ? 'r num' : ''}">${fmt(c, row[c.key])}</td>`).join('')}</tr>`).join('')}</tbody></table></div>${r.rows.length > 1000 ? '<div class="table-foot">Showing first 1,000 rows — export for the full data set.</div>' : ''}` : empty({ title: 'No data for this period', text: 'Try a wider date range or remove filters.', illo: 'search' })}</div></div>`;
  const c = $('#rchart', out); if (c) { const ch = reportChart(r.chart, { height: 280 }); if (ch) c.appendChild(ch); else c.parentElement.remove(); }
  // Client-side column sort.
  let dir = 1;
  $$('[data-sort]', out).forEach((th) => (th.onclick = () => {
    const col = r.columns[Number(th.dataset.sort)]; dir = -dir;
    r.rows.sort((a, b) => { const x = a[col.key]; const y = b[col.key]; return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x ?? '').localeCompare(String(y ?? ''))) * dir; });
    renderReport(out, r);
  }));
}
