// UI toolkit: escaping, formatting, toasts, modals, drawers, dropdowns, skeletons,
// empty/error states, autocomplete, count-up. Everything user-provided is escaped.
import { icon, ILLO } from './icons.js';

export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export function h(html) { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; }
export const debounce = (fn, ms = 250) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

// ── Formatting (Indian locale)
export const inr = (n, d = 0) => '₹' + Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d === 0 ? 0 : 2 });
export const inr2 = (n) => '₹' + Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const num = (n) => Number(n || 0).toLocaleString('en-IN');
export const compactInr = (n) => { n = Number(n || 0); if (n >= 1e7) return `₹${(n / 1e7).toFixed(2)} Cr`; if (n >= 1e5) return `₹${(n / 1e5).toFixed(2)} L`; if (n >= 1e3) return `₹${(n / 1e3).toFixed(1)}K`; return inr(n); };
const toDate = (s) => (s instanceof Date ? s : new Date(String(s).replace(' ', 'T')));
export const fdate = (s) => (s ? toDate(s).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
export const fdateShort = (s) => (s ? toDate(s).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }) : '—');
export const ftime = (s) => (s ? toDate(s).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' }) : '—');
export const fdt = (s) => (s ? `${fdate(s)}, ${ftime(s)}` : '—');
export function ago(s) {
  if (!s) return '';
  const d = (Date.now() - toDate(s)) / 1000;
  if (d < 45) return 'just now';
  if (d < 3600) return `${Math.round(d / 60)} min ago`;
  if (d < 86400) return `${Math.round(d / 3600)} h ago`;
  if (d < 7 * 86400) return `${Math.round(d / 86400)} d ago`;
  return fdate(s);
}
export const todayISO = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
export const addDaysISO = (iso, n) => { const d = new Date(`${iso}T00:00:00`); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
export const ageSex = (p) => [p.age != null ? `${p.age}y` : null, p.gender ? p.gender[0] : null].filter(Boolean).join(' / ');
export const initials = (name = '') => name.replace(/^(Dr\.?|Mr\.?|Mrs\.?|Ms\.?|Sr\.?)\s+/i, '').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
export const avatar = (name, cls = '') => `<div class="avatar ${cls} c${(hash(name) % 6) + 1}">${esc(initials(name))}</div>`;
function hash(s = '') { let x = 0; for (const c of s) x = (x * 31 + c.charCodeAt(0)) >>> 0; return x; }
export const titleCase = (s) => String(s || '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

const STATUS = {
  waiting: 'amber', in_consultation: 'blue', completed: 'green', cancelled: 'grey', no_show: 'red',
  booked: 'violet', confirmed: 'blue', arrived: 'teal',
  processing: 'blue', ready: 'teal', dispensed: 'green',
  ordered: 'violet', sample_collected: 'amber', verified: 'green', scheduled: 'violet', scanned: 'amber', reported: 'teal',
  admitted: 'blue', discharged: 'green',
  unpaid: 'red', partial: 'amber', paid: 'green', refunded: 'violet', draft: 'grey',
  available: 'green', occupied: 'blue', reserved: 'violet', cleaning: 'amber', maintenance: 'grey',
  present: 'green', late: 'amber', absent: 'red', leave: 'violet', half_day: 'amber',
  pending: 'amber', approved: 'green', rejected: 'red', processed: 'blue', received: 'green',
  active: 'green', inactive: 'grey', exited: 'grey', on_notice: 'amber', submitted: 'blue', settled: 'green',
  routine: 'grey', urgent: 'amber', stat: 'red', emergency: 'red', new: 'blue', followup: 'teal', finalized: 'green',
};
export const badge = (status, label) => `<span class="badge ${STATUS[status] || 'grey'}">${esc(label || titleCase(status))}</span>`;

// ── Toasts
let toastRoot;
export function toast(message, type = 'success', title) {
  toastRoot = toastRoot || document.body.appendChild(h('<div class="toasts" role="status" aria-live="polite"></div>'));
  const ic = type === 'error' ? 'alert' : type === 'info' ? 'info' : 'checkCircle';
  const el = h(`<div class="toast ${type}">${icon(ic)}<div>${title ? `<b>${esc(title)}</b>` : ''}<span>${esc(message)}</span></div></div>`);
  toastRoot.appendChild(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 320); }, type === 'error' ? 6000 : 3800);
}

// ── Modal / drawer / confirm
export function modal({ title, subtitle = '', body = '', foot = '', size = '', onClose, drawer = false }) {
  const wrap = h(drawer
    ? `<div class="drawer-wrap"><aside class="drawer ${size}" role="dialog" aria-modal="true"><div class="modal-head"><div><h2>${esc(title)}</h2>${subtitle ? `<p>${subtitle}</p>` : ''}</div><button class="icon-btn" data-close aria-label="Close">${icon('x')}</button></div><div class="modal-body"></div>${foot !== null ? '<div class="modal-foot"></div>' : ''}</aside></div>`
    : `<div class="backdrop"><div class="modal ${size}" role="dialog" aria-modal="true"><div class="modal-head"><div><h2>${esc(title)}</h2>${subtitle ? `<p>${subtitle}</p>` : ''}</div><button class="icon-btn" data-close aria-label="Close">${icon('x')}</button></div><div class="modal-body"></div>${foot !== null ? '<div class="modal-foot"></div>' : ''}</div></div>`);
  const bodyEl = $('.modal-body', wrap); const footEl = $('.modal-foot', wrap);
  if (typeof body === 'string') bodyEl.innerHTML = body; else if (body) bodyEl.appendChild(body);
  if (footEl) { if (typeof foot === 'string') footEl.innerHTML = foot; else if (foot) footEl.appendChild(foot); if (!foot) footEl.remove(); }
  const close = () => { wrap.remove(); document.removeEventListener('keydown', onKey); onClose && onClose(); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  wrap.addEventListener('mousedown', (e) => { if (e.target === wrap) close(); });
  wrap.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) close(); });
  document.addEventListener('keydown', onKey);
  document.body.appendChild(wrap);
  setTimeout(() => { const f = $('input:not([type=hidden]), select, textarea', bodyEl); if (f && !f.readOnly) f.focus(); }, 60);
  return { el: wrap, body: bodyEl, foot: footEl, close };
}
export const drawer = (o) => modal({ ...o, drawer: true });
export function confirmDialog({ title, message, confirm = 'Confirm', danger = false, input }) {
  return new Promise((resolve) => {
    const m = modal({ title, size: 'sm', body: `<p class="muted">${esc(message)}</p>${input ? `<div class="field mt-16"><label>${esc(input)}</label><input class="input" id="cd-input"></div>` : ''}`,
      foot: `<button class="btn btn-secondary" data-close>Cancel</button><button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" id="cd-ok">${esc(confirm)}</button>`, onClose: () => resolve(null) });
    $('#cd-ok', m.el).onclick = () => { const v = input ? $('#cd-input', m.el).value.trim() : true; if (input && !v) { $('#cd-input', m.el).classList.add('invalid'); return; } resolve(v); m.el.remove(); };
  });
}

// ── Dropdown anchored to an element
export function dropdown(anchor, html, { className = '', align = 'right' } = {}) {
  document.querySelectorAll('.dropdown').forEach((d) => d.remove());
  const el = h(`<div class="dropdown ${className}">${html}</div>`);
  document.body.appendChild(el);
  const r = anchor.getBoundingClientRect();
  const w = el.offsetWidth;
  el.style.top = `${r.bottom + 8}px`;
  el.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, align === 'right' ? r.right - w : r.left))}px`;
  const off = (e) => { if (!el.contains(e.target) && !anchor.contains(e.target)) { el.remove(); document.removeEventListener('mousedown', off); } };
  setTimeout(() => document.addEventListener('mousedown', off));
  return el;
}

// ── States
export const skeletonRows = (n = 6, cols = 5) => `<div class="panel"><table class="table"><tbody>${Array.from({ length: n }, () => `<tr>${Array.from({ length: cols }, (_, i) => `<td><div class="skel skel-line" style="width:${i === 0 ? 70 : 40 + ((i * 17) % 40)}%"></div></td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
export const skeletonKpis = (n = 4) => `<div class="kpis">${Array.from({ length: n }, () => '<div class="kpi"><div class="skel skel-line" style="width:50%"></div><div class="skel" style="height:30px;width:60%;margin-top:14px"></div></div>').join('')}</div>`;
export const skeletonBlock = (h = 240) => `<div class="skel" style="height:${h}px;border-radius:18px"></div>`;
export function empty({ title, text = '', action = '', illo = 'generic' }) {
  return `<div class="empty">${ILLO[illo] || ILLO.generic}<h3>${esc(title)}</h3>${text ? `<p>${esc(text)}</p>` : ''}${action}</div>`;
}
export function errorState(err, retryId = '') {
  return `<div class="error-state"><div class="ico">${icon('alert')}</div><div><h3>${esc(err && err.status === 403 ? 'Access restricted' : 'Unable to load this information')}</h3><p>${esc((err && err.message) || 'Please check your connection and try again.')}</p>
    <div class="btn-group">${retryId ? `<button class="btn btn-secondary btn-sm" id="${retryId}">${icon('refresh')}Retry</button>` : ''}<a class="btn btn-ghost btn-sm" href="mailto:it-support@deephospital.in?subject=Deep%20Hospital%20support">${icon('mail')}Contact admin</a></div></div></div>`;
}

// ── Count-up animation for numbers
export function countUp(root = document) {
  for (const el of $$('[data-count]', root)) {
    const target = Number(el.dataset.count); const fmt = el.dataset.fmt || 'num';
    const render = (v) => (fmt === 'inr' ? inr(v) : fmt === 'cinr' ? compactInr(v) : fmt === 'pct' ? `${Math.round(v)}%` : num(Math.round(v)));
    if (!Number.isFinite(target) || matchMedia('(prefers-reduced-motion: reduce)').matches) { el.textContent = render(target || 0); continue; }
    const start = performance.now(); const dur = 900 + Math.min(600, Math.log10(Math.abs(target) + 1) * 120);
    const step = (t) => { const p = Math.min(1, (t - start) / dur); const e = 1 - Math.pow(1 - p, 4); el.textContent = render(target * e); if (p < 1) requestAnimationFrame(step); };
    requestAnimationFrame(step);
  }
}

// ── Form helpers
export function formData(form) {
  const o = {};
  for (const el of $$('[name]', form)) {
    if (el.type === 'checkbox') o[el.name] = el.checked;
    else if (el.type === 'radio') { if (el.checked) o[el.name] = el.value; }
    else o[el.name] = el.value.trim();
  }
  return o;
}
export function showErrors(form, err) {
  $$('.invalid', form).forEach((e) => e.classList.remove('invalid'));
  $$('.err', form).forEach((e) => e.remove());
  if (err && err.details) {
    for (const [k, msg] of Object.entries(err.details)) {
      const el = $(`[name="${k}"]`, form);
      if (el) { el.classList.add('invalid'); el.closest('.field')?.appendChild(h(`<div class="err">${esc(msg)}</div>`)); }
    }
    const first = $('.invalid', form); if (first) first.focus();
  }
}
export const field = (label, control, { req, hint, cls = '' } = {}) => `<div class="field ${cls}"><label>${esc(label)}${req ? '<span class="req">*</span>' : ''}</label>${control}${hint ? `<div class="hint">${esc(hint)}</div>` : ''}</div>`;
export const input = (name, { type = 'text', value = '', ph = '', attrs = '' } = {}) => `<input class="input" name="${name}" type="${type}" value="${esc(value)}" placeholder="${esc(ph)}" ${attrs}>`;
export const select = (name, options, value = '', { attrs = '', blank = '' } = {}) => `<select class="select" name="${name}" ${attrs}>${blank !== null ? `<option value="">${esc(blank || 'Select…')}</option>` : ''}${options.map((o) => { const [v, l] = Array.isArray(o) ? o : [o, o]; return `<option value="${esc(v)}" ${String(v) === String(value) ? 'selected' : ''}>${esc(l)}</option>`; }).join('')}</select>`;

/**
 * Autocomplete: attach to an <input>. fetcher(q) → [{ group?, id, title, subtitle, html?, data }]
 */
export function autocomplete(inputEl, { fetcher, onSelect, minChars = 1, showOnFocus = false, render }) {
  const wrap = inputEl.closest('.ac') || inputEl.parentElement;
  wrap.classList.add('ac');
  let list, items = [], hl = -1, seq = 0;
  const close = () => { list && list.remove(); list = null; hl = -1; };
  const open = async () => {
    const q = inputEl.value.trim();
    if (q.length < minChars && !showOnFocus) return close();
    const my = ++seq;
    let res; try { res = await fetcher(q); } catch { res = []; }
    if (my !== seq || document.activeElement !== inputEl) return;
    items = res;
    if (!list) { list = h('<div class="ac-list"></div>'); wrap.appendChild(list); }
    let g = null;
    list.innerHTML = items.length ? items.map((it, i) => { const head = it.group && it.group !== g ? `<div class="ac-group">${esc(it.group)}</div>` : ''; g = it.group; return `${head}<div class="ac-item" data-i="${i}">${render ? render(it) : `<div class="grow"><div class="t">${esc(it.title)}</div>${it.subtitle ? `<div class="s">${esc(it.subtitle)}</div>` : ''}</div>`}</div>`; }).join('') : `<div class="ac-empty">No matches for “${esc(q)}”</div>`;
  };
  const choose = (i) => { const it = items[i]; if (!it) return; close(); onSelect(it); };
  const deb = debounce(open, 160);
  inputEl.setAttribute('autocomplete', 'off');
  inputEl.addEventListener('input', deb);
  inputEl.addEventListener('focus', () => { if (showOnFocus || inputEl.value.trim().length >= minChars) open(); });
  inputEl.addEventListener('blur', () => setTimeout(close, 180));
  inputEl.addEventListener('keydown', (e) => {
    if (!list) return;
    const els = $$('.ac-item', list);
    if (e.key === 'ArrowDown') { hl = Math.min(els.length - 1, hl + 1); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { hl = Math.max(0, hl - 1); e.preventDefault(); }
    else if (e.key === 'Enter') { if (hl >= 0) { e.preventDefault(); choose(Number(els[hl].dataset.i)); } return; }
    else if (e.key === 'Escape') { close(); return; } else return;
    els.forEach((x, i) => x.classList.toggle('hl', i === hl));
    els[hl] && els[hl].scrollIntoView({ block: 'nearest' });
  });
  wrap.addEventListener('mousedown', (e) => { const it = e.target.closest('.ac-item'); if (it) { e.preventDefault(); choose(Number(it.dataset.i)); } });
  return { refresh: open, close };
}

export function tabs(el, list, active, onChange) {
  el.innerHTML = list.map(([k, l, c]) => `<button data-k="${k}" class="${k === active ? 'on' : ''}">${esc(l)}${c != null ? `<span class="count">${esc(c)}</span>` : ''}</button>`).join('');
  el.onclick = (e) => { const b = e.target.closest('button'); if (!b) return; $$('button', el).forEach((x) => x.classList.toggle('on', x === b)); onChange(b.dataset.k); };
}

export function segmented(el, list, active, onChange) {
  el.classList.add('seg');
  el.innerHTML = list.map(([k, l]) => `<button type="button" data-k="${k}" class="${k === active ? 'on' : ''}">${esc(l)}</button>`).join('');
  el.onclick = (e) => { const b = e.target.closest('button'); if (!b) return; $$('button', el).forEach((x) => x.classList.toggle('on', x === b)); onChange(b.dataset.k); };
}

export function fileToDataUrl(file, max = 480) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      if (!file.type.startsWith('image/')) return resolve(r.result);
      const img = new Image();
      img.onload = () => { const s = Math.min(1, max / Math.max(img.width, img.height)); const c = document.createElement('canvas'); c.width = img.width * s; c.height = img.height * s; c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); resolve(c.toDataURL('image/jpeg', 0.82)); };
      img.onerror = reject; img.src = r.result;
    };
    r.onerror = reject; r.readAsDataURL(file);
  });
}
