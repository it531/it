// Application shell: sidebar navigation (permission-aware), glass header, global search
// (⌘K), notification centre, profile menu, mobile drawer & bottom navigation.
import { api, session } from './core/api.js';
import { navigate } from './core/router.js';
import { icon, LOGO } from './core/icons.js';
import { esc, h, $, $$, dropdown, ago, debounce, avatar, toast, modal, formData, showErrors } from './core/ui.js';

export const NAV = [
  { group: 'Overview', items: [['/', 'Dashboard', 'dashboard', 'dashboard']] },
  { group: 'Patient care', items: [['/patients', 'Patients', 'patients', 'patients'], ['/appointments', 'Appointments', 'calendar', 'appointments'], ['/opd', 'OPD', 'stethoscope', 'opd'], ['/opd/doctor', 'My Consultations', 'doctor', 'doctor', (me) => !!me.doctor], ['/ipd', 'IPD & Beds', 'bed', 'ipd'], ['/nursing', 'Nursing', 'heart', 'nursing'], ['/laboratory', 'Laboratory', 'flask', 'laboratory'], ['/radiology', 'Radiology', 'scan', 'radiology']] },
  { group: 'Pharmacy & stores', items: [['/pharmacy', 'Pharmacy', 'pill', 'pharmacy'], ['/inventory', 'Inventory', 'box', 'inventory']] },
  { group: 'Finance', items: [['/billing', 'Billing', 'receipt', 'billing'], ['/insurance', 'Insurance', 'umbrella', 'insurance']] },
  { group: 'People', items: [['/hr', 'HR & Employees', 'briefcase', 'hr'], ['/payroll', 'Payroll', 'wallet', 'payroll']] },
  { group: 'Insights', items: [['/reports', 'Reports & MIS', 'file', 'reports', (me, can) => can('reports') || can('mis')], ['/analytics', 'Analytics', 'chart', 'mis']] },
  { group: 'Administration', items: [['/patient-portal', 'Patient Portal', 'phone', 'portal'], ['/settings', 'Settings', 'settings', 'settings'], ['/audit', 'Audit Log', 'shield', 'audit']] },
];

export const can = (m, a = 'view') => !!session.me && session.me.permissions.includes(`${m}:${a}`);

let pollTimer;
export function shell() {
  let app = $('#app > .app');
  if (app) { updateActive(); return $('#content'); }
  const me = session.me;
  const root = $('#app');
  const collapsed = localStorage.getItem('dh.collapsed') === '1';
  const inHospital = !!me.hospital;
  const nav = inHospital ? NAV.map((g) => ({ ...g, items: g.items.filter(([, , , mod, cond]) => (cond ? cond(me, can) : can(mod))) })).filter((g) => g.items.length) : [];
  const platform = me.user.is_super_admin ? `<div class="nav-group-title">Platform</div><a class="nav-item" href="/platform">${icon('layers')}<span class="nav-label">SaaS Console</span></a>` : '';
  root.innerHTML = `<div class="app ${collapsed ? 'collapsed' : ''}">
    <aside class="sidebar" aria-label="Main navigation">
      <a class="brand" href="${inHospital ? '/' : '/platform'}">${LOGO}<div class="brand-name">Deep Hospital<small>Hospital OS</small></div></a>
      <nav class="nav">${platform}${nav.map((g) => `<div class="nav-group-title">${esc(g.group)}</div>${g.items.map(([href, label, ic, mod]) => `<a class="nav-item" href="${href}" data-mod="${mod}" title="${esc(label)}">${icon(ic)}<span class="nav-label">${esc(label)}</span></a>`).join('')}`).join('')}</nav>
      <div class="sidebar-foot"><button class="icon-btn desk-only" id="collapse" title="Collapse sidebar">${icon('sidebar')}</button><div class="grow small muted truncate">v1.0 · ${esc(me.hospital ? me.hospital.code : 'Platform')}</div></div>
    </aside>
    <div class="main">
      <header class="topbar">
        <button class="icon-btn mobile-only" id="menu" aria-label="Menu">${icon('menu')}</button>
        <div class="hospital">${me.hospital ? `<b>${esc(me.hospital.name)}</b><span>${esc(me.hospital.city || '')} · ${new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' })}</span>` : '<b>Deep Hospital Platform</b><span>Software owner console</span>'}</div>
        ${inHospital ? `<div class="searchbox" id="search-open" role="button" tabindex="0">${icon('search')}<span>Search patients, UHID, IPD, invoices…</span><span class="kbd">Ctrl K</span></div>` : '<div class="grow"></div>'}
        ${inHospital ? `<button class="icon-btn" id="notif-btn" aria-label="Notifications">${icon('bell')}<span class="dot-badge hidden" id="notif-count"></span></button>` : ''}
        <button class="profile-btn" id="profile-btn">${avatar(me.user.full_name, 'sm')}<div class="who"><b>${esc(me.user.full_name)}</b><span>${esc(me.roles.map((r) => r.name).join(', ') || 'User')}</span></div>${icon('chevronDown')}</button>
      </header>
      ${me.user.uses_demo_password ? `<div class="callout warn" style="border-radius:0;margin:0">${icon('alert')}<div>You are signed in with the temporary demo password. <a href="#" id="chg-now"><b>Change it now</b></a> — production deployments must never use demo credentials.</div></div>` : ''}
      <main class="content" id="content" tabindex="-1"></main>
    </div>
    ${inHospital ? `<nav class="staff-bottom">${bottomItems().map(([href, label, ic]) => `<a href="${href}">${icon(ic)}${esc(label)}</a>`).join('')}</nav>` : ''}
  </div>`;
  app = $('.app', root);
  $('#collapse').onclick = () => { app.classList.toggle('collapsed'); localStorage.setItem('dh.collapsed', app.classList.contains('collapsed') ? '1' : '0'); };
  $('#menu').onclick = () => { app.classList.add('drawer-open'); const s = h('<div class="scrim"></div>'); s.onclick = () => { app.classList.remove('drawer-open'); s.remove(); }; app.appendChild(s); };
  $('.sidebar', app).addEventListener('click', (e) => { if (e.target.closest('a')) { app.classList.remove('drawer-open'); $('.scrim')?.remove(); } });
  $('#profile-btn').onclick = (e) => profileMenu(e.currentTarget);
  $('#chg-now')?.addEventListener('click', (e) => { e.preventDefault(); changePassword(); });
  if (inHospital) {
    $('#search-open').onclick = openSearch;
    $('#search-open').onkeydown = (e) => { if (e.key === 'Enter') openSearch(); };
    $('#notif-btn').onclick = (e) => notifications(e.currentTarget);
    pollNotifications();
  }
  updateActive();
  return $('#content');
}

function bottomItems() {
  const all = [['/', 'Home', 'home', 'dashboard'], ['/patients', 'Patients', 'patients', 'patients'], ['/opd/doctor', 'Queue', 'doctor', 'doctor'], ['/opd', 'OPD', 'stethoscope', 'opd'], ['/pharmacy', 'Pharmacy', 'pill', 'pharmacy'], ['/ipd', 'IPD', 'bed', 'ipd'], ['/nursing', 'Nursing', 'heart', 'nursing'], ['/billing', 'Billing', 'receipt', 'billing'], ['/hr', 'HR', 'briefcase', 'hr'], ['/reports', 'Reports', 'file', 'reports']];
  return all.filter(([href, , , m]) => can(m) && (href !== '/opd/doctor' || session.me.doctor)).slice(0, 5);
}

export function updateActive() {
  const p = location.pathname;
  let best = null;
  for (const a of $$('.nav-item, .staff-bottom a')) {
    const href = a.getAttribute('href');
    const hit = href === '/' ? p === '/' : p === href || p.startsWith(href + '/');
    a.classList.toggle('active', false); a.classList.toggle('on', false);
    if (hit && (!best || href.length > best.getAttribute('href').length || a.closest('.staff-bottom'))) { if (!a.closest('.staff-bottom')) best = a; else a.classList.add('on'); }
  }
  if (best) best.classList.add('active');
  // Don't highlight "OPD" when "My Consultations" is the better match.
}

export function teardownShell() { clearInterval(pollTimer); pollTimer = null; }

// ── Page scaffold
export function page({ title, subtitle = '', crumbs = [], actions = '', hero = null }) {
  const content = shell();
  content.classList.remove('page-enter'); void content.offsetWidth; content.classList.add('page-enter');
  document.title = `${title} · Deep Hospital`;
  const crumbHtml = crumbs.length ? `<div class="crumbs">${crumbs.map(([href, l]) => (href ? `<a href="${href}">${esc(l)}</a>` : `<span>${esc(l)}</span>`)).join(`<span>${icon('chevronRight').replace('<svg', '<svg style="width:13px;height:13px"')}</span>`)}</div>` : '';
  content.innerHTML = hero
    ? `<section class="hero ${hero.compact ? 'compact' : ''}"><div class="hero-img" style="background-image:url('${hero.img}')"></div>${hero.eyebrow ? `<div class="eyebrow">${esc(hero.eyebrow)}</div>` : ''}<h1>${esc(title)}</h1>${subtitle ? `<p>${subtitle}</p>` : ''}${hero.stats || ''}${actions ? `<div class="actions">${actions}</div>` : ''}</section><div id="page"></div>`
    : `${crumbHtml}<div class="page-head"><div><h1>${esc(title)}</h1>${subtitle ? `<p>${subtitle}</p>` : ''}</div>${actions ? `<div class="actions">${actions}</div>` : ''}</div><div id="page"></div>`;
  window.scrollTo({ top: 0 });
  return $('#page', content);
}

// ── Global search (⌘K)
const TYPE_ICON = { patient: 'user', doctor: 'doctor', ipd: 'bed', appointment: 'calendar', prescription: 'file', medicine: 'pill', invoice: 'receipt', employee: 'briefcase', action: 'zap' };
export function openSearch() {
  if ($('.cmdk')) return;
  const el = h(`<div class="cmdk"><div class="cmdk-box"><div class="cmdk-input">${icon('search')}<input placeholder="Search patient name, UHID, mobile, IPD no., invoice, medicine…" aria-label="Global search"><span class="kbd">Esc</span></div><div class="cmdk-results"></div></div></div>`);
  document.body.appendChild(el);
  const inp = $('input', el); const results = $('.cmdk-results', el);
  let items = []; let hl = 0;
  const actions = [
    can('patients', 'add') && { type: 'action', title: 'Register new patient', subtitle: 'Create UHID', link: '/patients/new' },
    can('opd', 'add') && { type: 'action', title: 'New OPD visit / token', subtitle: 'Walk-in registration', link: '/opd?new=1' },
    can('appointments', 'add') && { type: 'action', title: 'Book appointment', subtitle: 'Calendar', link: '/appointments?new=1' },
    can('pharmacy') && { type: 'action', title: 'Pharmacy queue', subtitle: 'Now serving', link: '/pharmacy' },
    can('ipd') && { type: 'action', title: 'Bed map', subtitle: 'Live occupancy', link: '/ipd' },
    (can('reports') || can('mis')) && { type: 'action', title: 'Ask Deep Assist', subtitle: 'Natural-language MIS query', link: '/reports?assist=1' },
  ].filter(Boolean);
  const paint = () => {
    results.innerHTML = items.length ? items.map((it, i) => `<div class="ac-item ${i === hl ? 'hl' : ''}" data-i="${i}"><span class="type-ico">${icon(TYPE_ICON[it.type] || 'search')}</span><div class="grow"><div class="t">${esc(it.title)}</div><div class="s">${esc(it.subtitle || '')}</div></div><span class="badge grey plain">${esc(it.type)}</span></div>`).join('') : `<div class="ac-empty">No results. Try a UHID like #000001, a mobile number or a name.</div>`;
  };
  items = actions; paint();
  const close = () => { el.remove(); document.removeEventListener('keydown', key); };
  const go = (i) => { const it = items[i]; if (!it) return; close(); navigate(it.link); };
  const run = debounce(async () => {
    const q = inp.value.trim();
    if (q.length < 2) { items = actions; hl = 0; return paint(); }
    try { items = await api.get(`/search?q=${encodeURIComponent(q)}`); } catch { items = []; }
    hl = 0; paint();
  }, 180);
  inp.addEventListener('input', run);
  const key = (e) => {
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowDown') { hl = Math.min(items.length - 1, hl + 1); paint(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { hl = Math.max(0, hl - 1); paint(); e.preventDefault(); }
    else if (e.key === 'Enter') go(hl);
  };
  document.addEventListener('keydown', key);
  el.addEventListener('mousedown', (e) => { if (e.target === el) close(); const it = e.target.closest('.ac-item'); if (it) go(Number(it.dataset.i)); });
  setTimeout(() => inp.focus(), 30);
}
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k' && session.me && session.me.hospital) { e.preventDefault(); openSearch(); }
  if (e.key === '/' && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName) && session.me && session.me.hospital && !$('.cmdk')) { e.preventDefault(); openSearch(); }
});

// ── Notifications
const CAT_ICON = { appointment: 'calendar', opd: 'stethoscope', pharmacy: 'pill', inventory: 'box', lab: 'flask', radiology: 'scan', billing: 'receipt', ipd: 'bed', report: 'file', system: 'info' };
let lastUnread = 0;
async function pollNotifications() {
  const tick = async () => {
    try {
      const n = await api.get('/notifications?limit=1');
      const b = $('#notif-count'); if (!b) return;
      b.textContent = n.unread > 99 ? '99+' : n.unread; b.classList.toggle('hidden', !n.unread); b.classList.toggle('pulse', n.unread > lastUnread && lastUnread !== 0);
      if (n.unread > lastUnread && lastUnread !== 0 && n.items[0]) toast(n.items[0].body || '', n.items[0].severity === 'critical' ? 'error' : 'info', n.items[0].title);
      lastUnread = n.unread;
    } catch { /* offline */ }
  };
  clearInterval(pollTimer); tick(); pollTimer = setInterval(tick, 20000);
}
async function notifications(anchor) {
  const dd = dropdown(anchor, `<div class="notif-head"><h3>Notifications</h3><button class="btn btn-ghost btn-sm" id="mark-all">${icon('check')}Mark all read</button></div><div class="notif-list"><div class="skel skel-line" style="margin:12px"></div><div class="skel skel-line" style="margin:12px"></div></div>`, { className: 'notif-panel' });
  const n = await api.get('/notifications?limit=40');
  const list = $('.notif-list', dd);
  list.innerHTML = n.items.length ? n.items.map((x, i) => `<div class="notif ${x.read_at ? '' : 'unread'} ${x.severity}" data-id="${x.id}" data-link="${esc(x.link || '')}" style="animation-delay:${i * 0.02}s"><div class="ni">${icon(x.severity === 'critical' ? 'alert' : CAT_ICON[x.category] || 'bell')}</div><div class="grow"><b>${esc(x.title)}</b>${x.body ? `<p>${esc(x.body)}</p>` : ''}<time>${ago(x.created_at)}</time></div></div>`).join('') : '<div class="empty" style="padding:30px"><h3>You are all caught up</h3><p>New alerts about queues, stock and reports appear here.</p></div>';
  list.onclick = async (e) => {
    const it = e.target.closest('.notif'); if (!it) return;
    api.post('/notifications/read', { ids: [Number(it.dataset.id)] }).then(pollNotifications);
    dd.remove(); if (it.dataset.link) navigate(it.dataset.link);
  };
  $('#mark-all', dd).onclick = async () => { await api.post('/notifications/read', { all: true }); dd.remove(); lastUnread = 0; pollNotifications(); };
}

// ── Profile / session
function profileMenu(anchor) {
  const me = session.me;
  const dd = dropdown(anchor, `<div style="padding:10px 12px 8px"><b>${esc(me.user.full_name)}</b><div class="small muted">@${esc(me.user.username)}${me.hospital ? ' · ' + esc(me.hospital.code) : ''}</div></div><div class="sep"></div>
    ${me.user.is_super_admin ? `<div class="item" data-a="platform">${icon('layers')}SaaS console</div>${me.hospital ? `<div class="item" data-a="leave">${icon('building')}Leave ${esc(me.hospital.code)}</div>` : ''}` : ''}
    <div class="item" data-a="password">${icon('key')}Change password</div>
    ${can('settings') ? `<div class="item" data-a="settings">${icon('settings')}Settings</div>` : ''}
    <div class="sep"></div><div class="item" data-a="logout" style="color:var(--red)">${icon('logout')}Sign out</div>`);
  dd.onclick = async (e) => {
    const a = e.target.closest('.item')?.dataset.a; if (!a) return; dd.remove();
    if (a === 'logout') logout();
    if (a === 'password') changePassword();
    if (a === 'settings') navigate('/settings');
    if (a === 'platform') navigate('/platform');
    if (a === 'leave') { await api.post('/auth/switch-hospital', { hospital_id: null }); await reloadMe(); navigate('/platform'); }
  };
}

export async function reloadMe() {
  session.me = await api.get('/auth/me');
  $('#app').innerHTML = '';
  teardownShell();
  return session.me;
}

export async function logout(message) {
  try { await api.post('/auth/logout'); } catch {}
  session.clear(); teardownShell();
  $('#app').innerHTML = '';
  navigate(`/login${message ? `?m=${encodeURIComponent(message)}` : ''}`, { replace: true });
}

export function changePassword() {
  const m = modal({ title: 'Change password', subtitle: 'Use at least 8 characters with letters and numbers. Other sessions will be signed out.', size: 'sm',
    body: `<form class="col" id="pw-form"><div class="field"><label>Current password</label><input class="input" type="password" name="current_password" autocomplete="current-password" required></div><div class="field"><label>New password</label><input class="input" type="password" name="new_password" autocomplete="new-password" minlength="8" required></div><div class="field"><label>Confirm new password</label><input class="input" type="password" name="confirm" autocomplete="new-password" required></div></form>`,
    foot: `<button class="btn btn-secondary" data-close>Cancel</button><button class="btn btn-primary" id="pw-save">${icon('lock')}Update password</button>` });
  $('#pw-save', m.el).onclick = async (e) => {
    const f = $('#pw-form', m.el); const d = formData(f);
    if (d.new_password !== d.confirm) return showErrors(f, { details: { confirm: 'Passwords do not match' } });
    e.currentTarget.classList.add('loading');
    try { await api.post('/auth/change-password', d); toast('Your password has been changed.'); m.close(); await reloadMe(); navigate(location.pathname + location.search, { replace: true }); }
    catch (err) { showErrors(f, err); toast(err.message, 'error'); } finally { e.currentTarget?.classList.remove('loading'); }
  };
}
