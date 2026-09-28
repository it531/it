import { api, session, setUnauthorizedHandler, setIdleTimeout } from './core/api.js';
import { route, onBefore, onNotFound, navigate, render } from './core/router.js';
import { logout, can, page, teardownShell } from './shell.js';
import { empty } from './core/ui.js';

const P = (name) => () => import(`./pages/${name}.js`);

// Public
route('/login', P('login'), { public: true });
route('/portal/login', P('portal'), { portal: true, publicPortal: true });
route('/portal', P('portal'), { portal: true });
route('/portal/:tab', P('portal'), { portal: true });
route('/display/opd', P('display'), { display: 'opd' });
route('/display/pharmacy', P('display'), { display: 'pharmacy' });
route('/print/:type/:id', P('print'), { bare: true });
// Platform
route('/platform', P('platform'), { superAdmin: true });
route('/platform/hospitals/:id', P('platform'), { superAdmin: true });
// Hospital
route('/', P('dashboard'), { module: 'dashboard' });
route('/patients', P('patients'), { module: 'patients' });
route('/patients/new', P('patients'), { module: 'patients', action: 'add' });
route('/patients/:id', P('patients'), { module: 'patients' });
route('/appointments', P('appointments'), { module: 'appointments' });
route('/opd', P('opd'), { module: 'opd' });
route('/opd/doctor', P('opd'), { module: 'doctor' });
route('/opd/consult/:id', P('consult'), { module: 'doctor' });
route('/ipd', P('ipd'), { module: 'ipd' });
route('/ipd/:id', P('ipd'), { anyOf: ['ipd', 'nursing'] });
route('/nursing', P('nursing'), { module: 'nursing' });
route('/laboratory', P('lab'), { module: 'laboratory' });
route('/radiology', P('radiology'), { module: 'radiology' });
route('/pharmacy', P('pharmacy'), { module: 'pharmacy' });
route('/inventory', P('inventory'), { module: 'inventory' });
route('/inventory/medicine/:id', P('inventory'), { anyOf: ['inventory', 'pharmacy'] });
route('/billing', P('billing'), { module: 'billing' });
route('/billing/:id', P('billing'), { module: 'billing' });
route('/insurance', P('billing'), { anyOf: ['insurance', 'billing'], insurance: true });
route('/hr', P('hr'), { module: 'hr' });
route('/hr/employee/:id', P('hr'), { module: 'hr' });
route('/payroll', P('payroll'), { module: 'payroll' });
route('/reports', P('reports'), { anyOf: ['reports', 'mis', 'billing', 'hr', 'pharmacy'] });
route('/analytics', P('analytics'), { module: 'mis' });
route('/patient-portal', P('portaladmin'), { module: 'portal' });
route('/settings', P('settings'), { module: 'settings' });
route('/audit', P('audit'), { module: 'audit' });

setUnauthorizedHandler((err, portal) => {
  if (portal) { session.clearPortal(); navigate('/portal/login', { replace: true }); return; }
  session.clear(); teardownShell(); document.getElementById('app').innerHTML = '';
  navigate(`/login?m=${encodeURIComponent(err.message)}`, { replace: true });
});

onBefore(async (m) => {
  if (m.meta.public || m.meta.portal || (m.meta.bare && String(m.params.type).startsWith('portal-'))) return true;
  if (!session.token) { navigate(`/login${location.pathname !== '/' ? `?next=${encodeURIComponent(location.pathname + location.search)}` : ''}`, { replace: true }); return false; }
  if (!session.me) {
    try { session.me = await api.get('/auth/me'); }
    catch { return false; }
    setIdleTimeout(session.me.session_timeout_min || 30, () => logout('You were signed out after a period of inactivity.'));
  }
  const me = session.me;
  if (m.meta.bare || m.meta.display) return true;
  if (m.meta.superAdmin) { if (!me.user.is_super_admin) { navigate('/', { replace: true }); return false; } return true; }
  if (!me.hospital) { navigate(me.user.is_super_admin ? '/platform' : '/login', { replace: true }); return false; }
  const allowed = m.meta.anyOf ? m.meta.anyOf.some((x) => can(x)) : m.meta.module ? can(m.meta.module, m.meta.action || 'view') : true;
  if (!allowed) {
    const el = page({ title: 'Access restricted' });
    el.innerHTML = `<div class="panel">${empty({ title: 'You do not have access to this module', text: me.modules.includes(m.meta.module) ? 'Your role does not include permission for this area. Ask your hospital administrator to update your access.' : 'This module is not enabled for your hospital. The platform owner controls module subscriptions.', illo: 'search', action: '<a class="btn btn-primary" href="/">Go to dashboard</a>' })}</div>`;
    return false;
  }
  return true;
});

onNotFound(async () => {
  if (!session.token) return navigate('/login', { replace: true });
  if (!session.me) { try { session.me = await api.get('/auth/me'); } catch { return; } }
  if (!session.me.hospital) return navigate('/platform', { replace: true });
  const el = page({ title: 'Page not found' });
  el.innerHTML = `<div class="panel">${empty({ title: 'We could not find that page', text: 'The link may be outdated or mistyped.', illo: 'search', action: '<a class="btn btn-primary" href="/">Back to dashboard</a>' })}</div>`;
});

render();
