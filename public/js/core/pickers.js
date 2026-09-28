// Shared data pickers & cached masters.
import { api } from './api.js';
import { autocomplete, esc, avatar, ageSex, badge } from './ui.js';

const cache = new Map();
export async function cached(key, loader, ttl = 60000) {
  const c = cache.get(key);
  if (c && Date.now() - c.t < ttl) return c.v;
  const v = await loader(); cache.set(key, { v, t: Date.now() }); return v;
}
export const invalidate = (key) => cache.delete(key);
export const doctors = () => cached('doctors', () => api.get('/doctors'));
export const departments = () => cached('departments', () => api.get('/departments'));
export const labTests = () => cached('labtests', () => api.get('/masters/lab-tests'));

export function patientPicker(inputEl, onSelect, { showOnFocus = false } = {}) {
  return autocomplete(inputEl, {
    minChars: 1, showOnFocus,
    fetcher: async (q) => (await api.get(`/patients?q=${encodeURIComponent(q)}&limit=8`)).rows.map((p) => ({ ...p, title: p.full_name, subtitle: `${p.uhid} · ${ageSex(p)} · ${p.mobile}` })),
    render: (p) => `${avatar(p.full_name, 'sm')}<div class="grow"><div class="t">${esc(p.full_name)}</div><div class="s">${esc(p.uhid)} · ${esc(ageSex(p))} · ${esc(p.mobile)}${p.last_visit ? ` · last visit ${esc(p.last_visit)}` : ''}</div></div>${p.ipd_no ? badge('admitted', p.ipd_no) : ''}`,
    onSelect,
  });
}

export async function doctorOptions(selected = '') {
  const list = (await doctors()).filter((d) => d.is_active);
  return list.map((d) => `<option value="${d.id}" ${String(d.id) === String(selected) ? 'selected' : ''}>${esc(d.name)} — ${esc(d.department || '')}${d.waiting ? ` (${d.waiting} waiting)` : ''}</option>`).join('');
}

export function medicinePicker(inputEl, onSelect) {
  return autocomplete(inputEl, {
    minChars: 1,
    fetcher: async (q) => (await api.get(`/medicines?q=${encodeURIComponent(q)}`)).map((m) => ({ ...m, title: `${m.name} ${m.strength || ''}`, subtitle: `${m.generic_name || ''} · ${m.dosage_form || ''}` })),
    render: (m) => `<div class="grow"><div class="t">${m.favourite ? '★ ' : ''}${esc(m.name)} <span class="muted">${esc(m.strength || '')}</span></div><div class="s">${esc(m.generic_name || '')} · ${esc(m.dosage_form || '')}${m.uses ? ` · used ${m.uses}×` : ''}</div></div><span class="badge ${m.stock <= 0 ? 'red' : m.stock < m.min_stock ? 'amber' : 'green'} plain">${m.stock} in stock</span>`,
    onSelect,
  });
}
