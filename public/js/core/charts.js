// SVG chart kit: line / area / bar (grouped & stacked) / horizontal bar / donut /
// sparkline / heatmap / funnel / ring. Responsive (re-renders on resize), animated entry,
// hover tooltips with crosshair, legends for ≥2 series, recessive grid.
import { esc, inr, compactInr, num, fdateShort, h } from './ui.js';

export const PALETTE = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'];
const fmtVal = (v, money) => (money ? inr(v) : num(Math.round(v * 10) / 10));
const fmtAxis = (v, money) => (money ? compactInr(v).replace(/\.0+(?=\D*$)/, '').replace('.00', '') : Math.abs(v) >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 0 : 1)}k` : num(v));
const fmtX = (x) => (/^\d{4}-\d{2}-\d{2}$/.test(x) ? fdateShort(x) : /^\d{4}-\d{2}$/.test(x) ? new Date(`${x}-01T00:00:00`).toLocaleDateString('en-IN', { month: 'short', year: '2-digit' }) : String(x));

function niceMax(v) { if (v <= 0) return 1; const p = Math.pow(10, Math.floor(Math.log10(v))); const n = v / p; return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p; }

function responsive(draw, height) {
  const el = h(`<div class="chart" style="height:${height}px"></div>`);
  let w = 0;
  const paint = () => { const nw = el.clientWidth || 600; if (Math.abs(nw - w) < 2) return; w = nw; el.innerHTML = ''; draw(el, w); };
  const ro = new ResizeObserver(paint);
  requestAnimationFrame(() => { paint(); ro.observe(el); });
  return el;
}

function tooltip(el) {
  const tip = h('<div class="chart-tip"></div>'); el.appendChild(tip);
  return {
    show(x, y, html) { tip.innerHTML = html; tip.style.left = `${Math.max(70, Math.min(el.clientWidth - 70, x))}px`; tip.style.top = `${y}px`; tip.classList.add('on'); },
    hide() { tip.classList.remove('on'); },
  };
}

export function legend(series) {
  if (series.length < 2) return '';
  return `<div class="chart-legend">${series.map((s, i) => `<span><i style="background:${s.color || PALETTE[i]}"></i>${esc(s.label)}</span>`).join('')}</div>`;
}

/** Line / area chart. */
export function lineChart({ data, x, series, height = 260, money = false, area = false, yMin0 = true }) {
  const S = series.map((s, i) => ({ ...s, color: s.color || PALETTE[i] }));
  const wrap = h('<div></div>');
  if (S.length > 1) wrap.appendChild(h(legend(S)));
  wrap.appendChild(responsive((el, W) => {
    const H = height; const pad = { l: 48, r: 14, t: 12, b: 28 };
    const iw = W - pad.l - pad.r; const ih = H - pad.t - pad.b;
    const max = niceMax(Math.max(1, ...data.flatMap((d) => S.map((s) => Number(d[s.key]) || 0))));
    const X = (i) => pad.l + (data.length <= 1 ? iw / 2 : (i * iw) / (data.length - 1));
    const Y = (v) => pad.t + ih - (v / max) * ih;
    const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => t * max);
    const every = Math.max(1, Math.ceil(data.length / Math.max(2, Math.floor(iw / 70))));
    let svg = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img">`;
    svg += ticks.map((t) => `<line class="grid-line" x1="${pad.l}" x2="${W - pad.r}" y1="${Y(t)}" y2="${Y(t)}"/><text class="axis-label" x="${pad.l - 8}" y="${Y(t) + 4}" text-anchor="end">${esc(fmtAxis(t, money))}</text>`).join('');
    svg += data.map((d, i) => (i % every === 0 || i === data.length - 1 ? `<text class="axis-label" x="${X(i)}" y="${H - 8}" text-anchor="middle">${esc(fmtX(d[x]))}</text>` : '')).join('');
    S.forEach((s, si) => {
      const pts = data.map((d, i) => [X(i), Y(Number(d[s.key]) || 0)]);
      const path = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('');
      if (area && pts.length) svg += `<defs><linearGradient id="ga${si}${W | 0}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${s.color}" stop-opacity=".22"/><stop offset="1" stop-color="${s.color}" stop-opacity="0"/></linearGradient></defs><path class="area" d="${path}L${pts[pts.length - 1][0]},${Y(0)}L${pts[0][0]},${Y(0)}Z" fill="url(#ga${si}${W | 0})"/>`;
      let len = 0; for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
      svg += `<path class="line draw" d="${path}" stroke="${s.color}" style="--len:${Math.ceil(len) + 2};animation-delay:${si * 0.12}s"/>`;
    });
    svg += `<line class="xh" x1="0" x2="0" y1="${pad.t}" y2="${pad.t + ih}" stroke="#c9d3e1" stroke-dasharray="3 3" style="display:none"/>`;
    svg += S.map((s, si) => `<circle class="dot hd${si}" r="4.5" fill="#fff" stroke="${s.color}" stroke-width="2.5" style="display:none"/>`).join('');
    svg += `<rect class="hit" x="${pad.l}" y="${pad.t}" width="${iw}" height="${ih}"/></svg>`;
    el.innerHTML = svg;
    const tip = tooltip(el); const hit = el.querySelector('.hit'); const xh = el.querySelector('.xh');
    hit.addEventListener('mousemove', (e) => {
      const r = el.getBoundingClientRect(); const mx = e.clientX - r.left;
      const i = Math.max(0, Math.min(data.length - 1, Math.round(((mx - pad.l) / iw) * (data.length - 1))));
      const d = data[i]; if (!d) return;
      xh.setAttribute('x1', X(i)); xh.setAttribute('x2', X(i)); xh.style.display = '';
      S.forEach((s, si) => { const c = el.querySelector(`.hd${si}`); c.setAttribute('cx', X(i)); c.setAttribute('cy', Y(Number(d[s.key]) || 0)); c.style.display = ''; });
      tip.show(X(i), Math.min(...S.map((s) => Y(Number(d[s.key]) || 0))), `<b>${esc(fmtX(d[x]))}</b>${S.map((s) => `<div class="tr"><i style="background:${s.color}"></i>${esc(s.label)} <strong style="margin-left:auto;padding-left:12px">${esc(fmtVal(Number(d[s.key]) || 0, money))}</strong></div>`).join('')}`);
    });
    hit.addEventListener('mouseleave', () => { tip.hide(); xh.style.display = 'none'; el.querySelectorAll('.dot').forEach((c) => (c.style.display = 'none')); });
  }, height));
  return wrap;
}

/** Vertical bars — grouped or stacked. */
export function barChart({ data, x, series, height = 260, money = false, stacked = false }) {
  const S = series.map((s, i) => ({ ...s, color: s.color || PALETTE[i] }));
  const wrap = h('<div></div>');
  if (S.length > 1) wrap.appendChild(h(legend(S)));
  wrap.appendChild(responsive((el, W) => {
    const H = height; const pad = { l: 48, r: 10, t: 12, b: 28 };
    const iw = W - pad.l - pad.r; const ih = H - pad.t - pad.b;
    const totals = data.map((d) => (stacked ? S.reduce((a, s) => a + (Number(d[s.key]) || 0), 0) : Math.max(...S.map((s) => Number(d[s.key]) || 0))));
    const max = niceMax(Math.max(1, ...totals));
    const Y = (v) => pad.t + ih - (v / max) * ih;
    const band = iw / Math.max(1, data.length); const gap = Math.min(10, band * 0.28);
    const bw = stacked ? band - gap : (band - gap) / S.length;
    const every = Math.max(1, Math.ceil(data.length / Math.max(2, Math.floor(iw / 64))));
    let svg = `<svg width="${W}" height="${H}">`;
    svg += [0, 0.25, 0.5, 0.75, 1].map((t) => `<line class="grid-line" x1="${pad.l}" x2="${W - pad.r}" y1="${Y(t * max)}" y2="${Y(t * max)}"/><text class="axis-label" x="${pad.l - 8}" y="${Y(t * max) + 4}" text-anchor="end">${esc(fmtAxis(t * max, money))}</text>`).join('');
    data.forEach((d, i) => {
      const x0 = pad.l + i * band + gap / 2; let acc = 0;
      S.forEach((s, si) => {
        const v = Number(d[s.key]) || 0; const hgt = (v / max) * ih;
        const bx = stacked ? x0 : x0 + si * bw; const by = stacked ? Y(acc + v) : Y(v);
        const r = Math.min(4, bw / 2, hgt);
        if (hgt > 0) svg += `<path class="bar" data-i="${i}" style="animation-delay:${Math.min(i * 0.015, 0.4)}s" fill="${s.color}" d="${roundTop(bx, by, Math.max(bw - (stacked ? 0 : 2), 1), hgt - (stacked && si < S.length - 1 ? 1 : 0), stacked && si < S.length - 1 ? 0 : r)}"/>`;
        acc += v;
      });
      if (i % every === 0) svg += `<text class="axis-label" x="${x0 + (band - gap) / 2}" y="${H - 8}" text-anchor="middle">${esc(fmtX(d[x]))}</text>`;
      svg += `<rect class="hit" data-i="${i}" x="${pad.l + i * band}" y="${pad.t}" width="${band}" height="${ih}"/>`;
    });
    svg += '</svg>';
    el.innerHTML = svg;
    const tip = tooltip(el);
    el.querySelectorAll('.hit').forEach((hEl) => {
      hEl.addEventListener('mouseenter', () => {
        const i = Number(hEl.dataset.i); const d = data[i];
        el.querySelectorAll('.bar').forEach((b) => (b.style.opacity = b.dataset.i === String(i) ? 1 : 0.45));
        tip.show(pad.l + i * band + band / 2, Y(totals[i]), `<b>${esc(fmtX(d[x]))}</b>${S.map((s) => `<div class="tr"><i style="background:${s.color}"></i>${esc(s.label)} <strong style="margin-left:auto;padding-left:12px">${esc(fmtVal(Number(d[s.key]) || 0, money))}</strong></div>`).join('')}`);
      });
      hEl.addEventListener('mouseleave', () => { tip.hide(); el.querySelectorAll('.bar').forEach((b) => (b.style.opacity = 1)); });
    });
  }, height));
  return wrap;
}
function roundTop(x, y, w, hgt, r) {
  if (r <= 0) return `M${x},${y}h${w}v${hgt}h${-w}Z`;
  return `M${x},${y + hgt}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + hgt}Z`;
}

/** Horizontal ranked bars (single series). */
export function hbarChart({ data, x, key, money = false, color = PALETTE[0], max: maxRows = 10, label }) {
  const rows = data.slice(0, maxRows);
  const max = Math.max(1, ...rows.map((d) => Number(d[key]) || 0));
  const el = h(`<div class="chart">${rows.map((d, i) => `<div style="display:grid;grid-template-columns:minmax(90px,38%) 1fr auto;gap:12px;align-items:center;margin-bottom:9px" title="${esc(d[x])}: ${esc(fmtVal(Number(d[key]) || 0, money))}">
      <div class="small truncate strong" style="color:var(--ink-2)">${esc(d[x])}</div>
      <div style="height:12px;background:var(--bg-sunken);border-radius:6px;overflow:hidden"><div style="height:100%;width:${((Number(d[key]) || 0) / max) * 100}%;background:${color};border-radius:6px;transform-origin:left;animation:barRight .8s ${i * 0.04}s var(--ease) both"></div></div>
      <div class="small strong num" style="min-width:52px;text-align:right">${esc(money ? compactInr(d[key]) : num(d[key]))}</div></div>`).join('')}</div>`);
  if (label) el.setAttribute('aria-label', label);
  return el;
}

/** Donut with centre total and legend. Folds beyond 7 slices into "Other". */
export function donut({ data, label, value, money = false, size = 180, centerLabel = 'Total' }) {
  let rows = data.filter((d) => Number(d[value]) > 0).sort((a, b) => b[value] - a[value]);
  if (rows.length > 7) { const other = rows.slice(6).reduce((s, d) => s + Number(d[value]), 0); rows = [...rows.slice(0, 6), { [label]: 'Other', [value]: other }]; }
  const total = rows.reduce((s, d) => s + Number(d[value]), 0) || 1;
  const R = size / 2; const r0 = R * 0.64; let a0 = -Math.PI / 2;
  const segs = rows.map((d, i) => {
    const frac = Number(d[value]) / total; const a1 = a0 + frac * Math.PI * 2 - (rows.length > 1 ? 0.012 : 0);
    const large = a1 - a0 > Math.PI ? 1 : 0;
    const p = (a, rr) => `${R + rr * Math.cos(a)},${R + rr * Math.sin(a)}`;
    const dPath = rows.length === 1 ? `M${R},${R - R}A${R},${R} 0 1 1 ${R - 0.01},0L${R - 0.01},${R - r0}A${r0},${r0} 0 1 0 ${R},${R - r0}Z` : `M${p(a0, R)}A${R},${R} 0 ${large} 1 ${p(a1, R)}L${p(a1, r0)}A${r0},${r0} 0 ${large} 0 ${p(a0, r0)}Z`;
    const seg = `<path class="donut-seg" data-i="${i}" style="animation-delay:${i * 0.07}s" fill="${PALETTE[i % 8]}" d="${dPath}"/>`;
    a0 = a0 + frac * Math.PI * 2;
    return seg;
  }).join('');
  const el = h(`<div class="row gap-24 wrap" style="align-items:center">
    <div class="chart" style="width:${size}px;height:${size}px;flex-shrink:0"><svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${segs}</svg>
      <div style="position:absolute;inset:0;display:grid;place-items:center;text-align:center;pointer-events:none"><div><div class="xs muted strong dn-l">${esc(centerLabel)}</div><div class="strong dn-v" style="font-size:20px;letter-spacing:-.02em">${esc(money ? compactInr(total) : num(total))}</div></div></div></div>
    <div class="grow col gap-8" style="min-width:160px">${rows.map((d, i) => `<div class="row small dn-row" data-i="${i}" style="gap:10px;cursor:default"><i style="width:10px;height:10px;border-radius:3px;background:${PALETTE[i % 8]};flex-shrink:0"></i><span class="grow truncate" style="font-weight:650;color:var(--ink-2)">${esc(titleish(d[label]))}</span><b class="num">${esc(money ? compactInr(d[value]) : num(d[value]))}</b><span class="muted num" style="width:40px;text-align:right">${Math.round((Number(d[value]) / total) * 100)}%</span></div>`).join('')}</div></div>`);
  const hl = (i) => { el.querySelectorAll('.donut-seg').forEach((s) => (s.style.opacity = i === null || s.dataset.i === String(i) ? 1 : 0.35)); el.querySelectorAll('.dn-row').forEach((r) => (r.style.opacity = i === null || r.dataset.i === String(i) ? 1 : 0.5));
    if (i !== null) { el.querySelector('.dn-l').textContent = titleish(rows[i][label]); el.querySelector('.dn-v').textContent = money ? compactInr(rows[i][value]) : num(rows[i][value]); } else { el.querySelector('.dn-l').textContent = centerLabel; el.querySelector('.dn-v').textContent = money ? compactInr(total) : num(total); } };
  el.querySelectorAll('.donut-seg, .dn-row').forEach((s) => { s.addEventListener('mouseenter', () => hl(Number(s.dataset.i))); s.addEventListener('mouseleave', () => hl(null)); });
  return el;
}
const titleish = (s) => String(s ?? '').replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

export function sparkline(values, color = PALETTE[0], w = 84, hgt = 30) {
  if (!values || values.length < 2) return '';
  const max = Math.max(...values, 1); const min = Math.min(...values, 0);
  const pts = values.map((v, i) => [(i / (values.length - 1)) * w, hgt - 2 - ((v - min) / (max - min || 1)) * (hgt - 4)]);
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('');
  return `<svg class="spark" viewBox="0 0 ${w} ${hgt}" preserveAspectRatio="none"><path d="${d}L${w},${hgt}L0,${hgt}Z" fill="${color}" opacity=".1"/><path d="${d}" fill="none" stroke="${color}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

/** Weekday × hour heatmap (sequential single-hue ramp). */
export function heatmap(cells, { hours = [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20] } = {}) {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const order = [1, 2, 3, 4, 5, 6, 0];
  const map = new Map(cells.map((c) => [`${c.dow}-${c.hour}`, c.value]));
  const max = Math.max(1, ...cells.map((c) => c.value));
  const ramp = ['#eef4fd', '#cde2fb', '#9ec5f4', '#6da7ec', '#3987e5', '#256abf', '#184f95', '#0d366b'];
  const col = (v) => (v ? ramp[Math.min(ramp.length - 1, 1 + Math.floor((v / max) * (ramp.length - 1.01)))] : ramp[0]);
  return h(`<div><div class="heat" style="grid-template-columns:36px repeat(${hours.length},1fr)">
    <div></div>${hours.map((hh) => `<div class="hl" style="justify-content:center">${hh > 12 ? hh - 12 : hh}${hh >= 12 ? 'p' : 'a'}</div>`).join('')}
    ${order.map((d) => `<div class="hl">${days[d]}</div>${hours.map((hh) => { const v = map.get(`${d}-${hh}`) || 0; return `<div class="hc" style="background:${col(v)}" title="${days[d]} ${hh}:00 — ${v} registrations"></div>`; }).join('')}`).join('')}
  </div><div class="row small muted mt-8" style="gap:6px;justify-content:flex-end">Fewer ${ramp.slice(1).map((c) => `<i style="width:14px;height:10px;border-radius:2px;background:${c};display:inline-block"></i>`).join('')} More</div></div>`);
}

export function funnel(stages) {
  const max = Math.max(1, ...stages.map((s) => s.value));
  const ramp = ['#184f95', '#256abf', '#2a78d6', '#5598e7', '#86b6ef'];
  return h(`<div>${stages.map((s, i) => `<div class="funnel-row"><div class="truncate">${esc(s.stage)}</div><div style="background:var(--bg-sunken);border-radius:8px"><div class="funnel-bar" style="width:${Math.max(2, (s.value / max) * 100)}%;background:${ramp[i % ramp.length]};animation-delay:${i * 0.08}s"></div></div><div class="r num strong" style="text-align:right">${num(s.value)}<div class="xs muted">${i ? Math.round((s.value / Math.max(stages[0].value, 1)) * 100) + '%' : '100%'}</div></div></div>`).join('')}</div>`);
}

export function ring(pct, { size = 120, color = PALETTE[0], label = '' } = {}) {
  const r = size / 2 - 9; const c = 2 * Math.PI * r; const p = Math.max(0, Math.min(100, pct));
  return `<div class="meter-ring" style="width:${size}px;height:${size}px"><svg width="${size}" height="${size}" style="transform:rotate(-90deg)"><circle cx="${size / 2}" cy="${size / 2}" r="${r}" stroke="#eef2f7" stroke-width="10" fill="none"/><circle cx="${size / 2}" cy="${size / 2}" r="${r}" stroke="${color}" stroke-width="10" fill="none" stroke-linecap="round" stroke-dasharray="${c}" stroke-dashoffset="${c}" style="transition:stroke-dashoffset 1.2s cubic-bezier(.22,.9,.3,1)" data-off="${c * (1 - p / 100)}"/></svg><div class="v"><div><b>${Math.round(p)}%</b><span>${esc(label)}</span></div></div></div>`;
}
export function animateRings(root = document) { requestAnimationFrame(() => root.querySelectorAll('.meter-ring circle[data-off]').forEach((c) => (c.style.strokeDashoffset = c.dataset.off))); }

/** Picks a chart for a report definition returned by the API. */
export function reportChart(chart, { height = 280 } = {}) {
  if (!chart || !chart.data || !chart.data.length) return null;
  const series = chart.series.map((s) => ({ key: s.key, label: s.label }));
  if (chart.type === 'line') return lineChart({ data: chart.data, x: chart.x, series, height, money: chart.money });
  if (chart.type === 'area') return lineChart({ data: chart.data, x: chart.x, series, height, money: chart.money, area: true });
  if (chart.type === 'bar') return barChart({ data: chart.data, x: chart.x, series, height, money: chart.money, stacked: chart.stacked });
  if (chart.type === 'hbar') return hbarChart({ data: chart.data, x: chart.x, key: series[0].key, money: chart.money, max: 12 });
  if (chart.type === 'donut') return donut({ data: chart.data, label: chart.x, value: series[0].key, money: chart.money });
  return null;
}
