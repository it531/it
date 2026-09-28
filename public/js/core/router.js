// Tiny history-API router with lazy page modules and route params.
const routes = [];
let current = null; let beforeEach = null; let notFound = null;

export function route(pattern, loader, meta = {}) {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/\/:(\w+)/g, (_, k) => { keys.push(k); return '/([^/]+)'; }) + '/?$');
  routes.push({ pattern, re, keys, loader, meta });
}
export const onBefore = (fn) => { beforeEach = fn; };
export const onNotFound = (fn) => { notFound = fn; };

export function match(path) {
  for (const r of routes) {
    const m = path.match(r.re);
    if (m) return { ...r, params: Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])) };
  }
  return null;
}

export function navigate(to, { replace = false } = {}) {
  if (to === location.pathname + location.search && !replace) return render();
  history[replace ? 'replaceState' : 'pushState']({}, '', to);
  render();
}
export const query = () => Object.fromEntries(new URLSearchParams(location.search));
export function setQuery(params, { replace = true } = {}) {
  const q = new URLSearchParams(location.search);
  for (const [k, v] of Object.entries(params)) { if (v === null || v === undefined || v === '') q.delete(k); else q.set(k, v); }
  const s = q.toString();
  history[replace ? 'replaceState' : 'pushState']({}, '', location.pathname + (s ? `?${s}` : ''));
}

export async function render() {
  const path = location.pathname;
  const m = match(path);
  if (!m) return notFound && notFound(path);
  if (beforeEach) { const ok = await beforeEach(m); if (ok === false) return; }
  const token = {}; current = token;
  const mod = await m.loader();
  if (current !== token) return;
  await mod.default({ params: m.params, query: query(), meta: m.meta, isCurrent: () => current === token });
}

window.addEventListener('popstate', render);
document.addEventListener('click', (e) => {
  const row = e.target.closest('[data-href]');
  if (row && !e.target.closest('a, button, input, select, label')) { e.preventDefault(); navigate(row.dataset.href); return; }
  const a = e.target.closest('a[href]');
  if (!a || a.target === '_blank' || a.hasAttribute('download') || a.dataset.external !== undefined) return;
  const href = a.getAttribute('href');
  if (!href.startsWith('/') || href.startsWith('/api/') || e.metaKey || e.ctrlKey || e.shiftKey) return;
  e.preventDefault();
  navigate(href);
});
