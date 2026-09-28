// API client with bearer tokens, structured errors and client-side idle logout.
const KEY = 'dh.token';
const PKEY = 'dh.portal';

const store = {
  get(k) { try { return localStorage.getItem(k) || sessionStorage.getItem(k); } catch { return null; } },
  set(k, v, remember) { try { (remember ? localStorage : sessionStorage).setItem(k, v); } catch {} },
  del(k) { try { localStorage.removeItem(k); sessionStorage.removeItem(k); } catch {} },
};

export const session = {
  get token() { return store.get(KEY); },
  set(token, remember) { store.del(KEY); store.set(KEY, token, remember); },
  clear() { store.del(KEY); session.me = null; },
  me: null,
  get portalToken() { return store.get(PKEY); },
  setPortal(t) { store.set(PKEY, t, true); },
  clearPortal() { store.del(PKEY); },
};

export class ApiError extends Error { constructor(status, message, details) { super(message); this.status = status; this.details = details; } }

let onUnauthorized = () => {};
export const setUnauthorizedHandler = (fn) => { onUnauthorized = fn; };

export async function api(path, { method = 'GET', body, portal = false, raw = false } = {}) {
  const token = portal ? session.portalToken : session.token;
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  let res;
  try {
    res = await fetch(`/api${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  } catch {
    throw new ApiError(0, 'Network error — please check your connection.');
  }
  if (raw && res.ok) return res;
  let data = null;
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new ApiError(res.status, (data && data.error) || `Request failed (${res.status})`, data && data.details);
    if (res.status === 401 && token) onUnauthorized(err, portal);
    throw err;
  }
  touch();
  return data;
}
api.get = (p, o) => api(p, o);
api.post = (p, body, o = {}) => api(p, { ...o, method: 'POST', body: body || {} });
api.put = (p, body, o = {}) => api(p, { ...o, method: 'PUT', body: body || {} });
api.del = (p, o = {}) => api(p, { ...o, method: 'DELETE' });

// Authenticated file download (CSV/XLS exports, documents).
export async function download(path, filename) {
  const res = await api(path, { raw: true });
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: filename || '' });
  const cd = res.headers.get('content-disposition'); const m = cd && cd.match(/filename="([^"]+)"/);
  if (m && !filename) a.download = m[1];
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// Client-side idle timer mirrors the server's session timeout (server remains authoritative).
let idleTimer; let idleMinutes = 30;
export function setIdleTimeout(min, onIdle) { idleMinutes = min; touch.onIdle = onIdle; touch(); }
function touch() {
  clearTimeout(idleTimer);
  if (!touch.onIdle) return;
  idleTimer = setTimeout(() => touch.onIdle(), idleMinutes * 60e3);
}
['click', 'keydown'].forEach((e) => window.addEventListener(e, () => { if (touch.onIdle) touch(); }, { passive: true }));
