import { api } from '../core/api.js';
import { setQuery } from '../core/router.js';
import { icon } from '../core/icons.js';
import { esc, $, $$, inr, num, empty, errorState, skeletonBlock, skeletonKpis, countUp, segmented } from '../core/ui.js';
import { lineChart, barChart, donut, heatmap, funnel, hbarChart, PALETTE } from '../core/charts.js';
import { page } from '../shell.js';

export default async function analytics(ctx) {
  let preset = ctx.query.preset || 'last90';
  const el = page({ title: 'Analytics', subtitle: 'Growth, utilisation and performance across the hospital.', hero: { img: '/img/analytics.jpg', eyebrow: 'Advanced analytics', compact: true, stats: '<div class="hero-stats" id="hs"></div>' }, actions: '<div id="range"></div>' });
  segmented($('#range'), [['month', 'This month'], ['last30', '30 days'], ['last90', '90 days'], ['quarter', 'Quarter'], ['year', 'Year']], preset, (k) => { preset = k; setQuery({ preset }); load(); });
  const load = async () => {
    el.innerHTML = `${skeletonKpis(5)}<div class="grid g2 mt-24">${skeletonBlock(300)}${skeletonBlock(300)}</div>`;
    let d;
    try { d = await api.get(`/analytics?preset=${preset}`); } catch (err) { el.innerHTML = errorState(err, 'retry'); $('#retry').onclick = load; return; }
    if (!ctx.isCurrent()) return;
    const k = d.kpi;
    $('#hs').innerHTML = [['New patients', k.new_patients], ['OPD visits', k.opd], ['Revenue', inr(k.revenue)]].map(([l, v]) => `<div><b>${esc(typeof v === 'number' ? num(v) : v)}</b><span>${l}</span></div>`).join('');
    el.innerHTML = `<div class="kpis c5">${[['New patients', k.new_patients, 'userPlus'], ['OPD visits', k.opd, 'stethoscope'], ['Admissions', k.admissions, 'bed'], ['Net revenue', k.revenue, 'rupee', 'cinr'], ['Avg length of stay', k.alos || 0, 'clock', null, 'days']].map(([l, v, ic, f, suf]) => `<div class="kpi"><div class="label">${icon(ic)}${l}</div><div class="value">${suf ? `${v}<small>${suf}</small>` : `<span data-count="${v || 0}" ${f ? `data-fmt="${f}"` : ''}>0</span>`}</div></div>`).join('')}</div>
      <div class="grid g2 section">
        <div class="panel"><div class="panel-head"><div><h3>Revenue growth</h3><div class="sub">Daily net collections</div></div></div><div class="panel-body" id="c-rev"></div></div>
        <div class="panel"><div class="panel-head"><div><h3>OPD trend</h3><div class="sub">Visits and new patients per day</div></div></div><div class="panel-body" id="c-opd"></div></div>
        <div class="panel"><div class="panel-head"><div><h3>Patient growth</h3><div class="sub">New registrations by month</div></div></div><div class="panel-body" id="c-pg"></div></div>
        <div class="panel"><div class="panel-head"><div><h3>IPD occupancy</h3><div class="sub">% of beds occupied per day</div></div></div><div class="panel-body" id="c-occ"></div></div>
        <div class="panel"><div class="panel-head"><div><h3>Revenue by service</h3><div class="sub">Billed, by month</div></div></div><div class="panel-body" id="c-svc"></div></div>
        <div class="panel"><div class="panel-head"><div><h3>Pharmacy sales</h3><div class="sub">Daily</div></div></div><div class="panel-body" id="c-ph"></div></div>
        <div class="panel"><div class="panel-head"><div><h3>OPD load heatmap</h3><div class="sub">Registrations by weekday and hour</div></div></div><div class="panel-body" id="c-heat"></div></div>
        <div class="panel"><div class="panel-head"><div><h3>Patient journey funnel</h3><div class="sub">Registration → consultation → prescription → dispensing → paid</div></div></div><div class="panel-body" id="c-fun"></div></div>
      </div>
      <div class="panel section"><div class="panel-head"><div><h3>Doctor performance</h3><div class="sub">Volume, waiting time, consultation time and attributed revenue</div></div></div><div class="panel-body flush"><div class="table-wrap"><table class="table"><thead><tr><th>Doctor</th><th>Department</th><th class="r">Visits</th><th class="r">Avg wait</th><th class="r">Avg consult</th><th class="r">Follow-up %</th><th class="r">Revenue</th><th style="width:160px">Share</th></tr></thead><tbody>${(() => { const max = Math.max(1, ...d.doctors.map((x) => x.visits)); return d.doctors.map((x) => `<tr><td class="strong">${esc(x.doctor)}</td><td class="small">${esc(x.department || '')}</td><td class="r num">${num(x.visits)}</td><td class="r num">${x.avg_wait != null ? `${x.avg_wait} min` : '—'}</td><td class="r num">${x.avg_consult != null ? `${x.avg_consult} min` : '—'}</td><td class="r num">${x.followup_pct}%</td><td class="r num">${inr(x.revenue)}</td><td><div class="progress"><i style="width:${(x.visits / max) * 100}%"></i></div></td></tr>`).join(''); })()}</tbody></table></div></div></div>
      <div class="grid g2 section"><div class="panel"><div class="panel-head"><div><h3>Department utilisation</h3><div class="sub">OPD visits</div></div></div><div class="panel-body" id="c-dep"></div></div><div class="panel"><div class="panel-head"><div><h3>Department mix</h3><div class="sub">OPD + IPD</div></div></div><div class="panel-body" id="c-depd"></div></div></div>`;
    countUp(el);
    const put = (id, node) => { const c = $(id); if (!c) return; c.innerHTML = ''; c.appendChild(node); };
    d.revenue.length ? put('#c-rev', lineChart({ data: d.revenue, x: 'day', series: [{ key: 'value', label: 'Net revenue' }], money: true, area: true })) : ($('#c-rev').innerHTML = empty({ title: 'No revenue in range' }));
    put('#c-opd', lineChart({ data: d.opd_trend, x: 'day', series: [{ key: 'value', label: 'Visits' }, { key: 'new_patients', label: 'New patients' }] }));
    put('#c-pg', barChart({ data: d.patient_growth, x: 'month', series: [{ key: 'value', label: 'New patients' }] }));
    put('#c-occ', lineChart({ data: d.occupancy, x: 'day', series: [{ key: 'value', label: 'Occupancy %', color: PALETTE[2] }], area: true }));
    const months = [...new Set(d.revenue_by_service.map((r) => r.month))];
    const types = [...new Set(d.revenue_by_service.map((r) => r.bill_type))].sort();
    put('#c-svc', barChart({ data: months.map((m) => Object.fromEntries([['month', m], ...types.map((t) => [t, (d.revenue_by_service.find((r) => r.month === m && r.bill_type === t) || {}).value || 0])])), x: 'month', series: types.map((t) => ({ key: t, label: t.toUpperCase() })), stacked: true, money: true }));
    put('#c-ph', lineChart({ data: d.pharmacy_sales, x: 'day', series: [{ key: 'value', label: 'Pharmacy sales', color: PALETTE[1] }], money: true, area: true }));
    put('#c-heat', heatmap(d.heatmap));
    put('#c-fun', funnel(d.funnel));
    put('#c-dep', hbarChart({ data: d.departments, x: 'department', key: 'opd' }));
    put('#c-depd', donut({ data: d.departments.map((x) => ({ department: x.department, total: x.opd + x.ipd })), label: 'department', value: 'total' }));
    void $$;
  };
  load();
}
