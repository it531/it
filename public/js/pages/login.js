import { api, session, setIdleTimeout } from '../core/api.js';
import { navigate, query } from '../core/router.js';
import { icon, LOGO } from '../core/icons.js';
import { esc, $, $$, modal, toast } from '../core/ui.js';
import { logout } from '../shell.js';

const SLIDES = ['/img/reception.jpg', '/img/doctor.jpg', '/img/ward.jpg', '/img/operating-room.jpg'];

export default async function login() {
  document.title = 'Sign in · Deep Hospital';
  const q = query();
  if (session.token && !q.m) {
    try { session.me = await api.get('/auth/me'); return navigate(session.me.hospital ? (q.next || '/') : '/platform', { replace: true }); } catch { session.clear(); }
  }
  const [hospitals, cfg] = await Promise.all([api.get('/public/hospitals').catch(() => []), api.get('/public/config').catch(() => ({}))]);
  const last = localStorage.getItem('dh.hospital') || (hospitals[0] && hospitals[0].code) || '';
  const app = document.getElementById('app');
  app.innerHTML = `<div class="login">
    <section class="login-visual" aria-hidden="true">
      ${SLIDES.map((s, i) => `<div class="slide ${i === 0 ? 'on' : ''}" style="background-image:url('${s}')"></div>`).join('')}
      <svg class="pulse-line" viewBox="0 0 1200 120" preserveAspectRatio="none"><path d="M0 60 H380 L410 60 L430 20 L455 100 L480 40 L500 60 H760 L790 60 L810 25 L835 95 L860 45 L880 60 H1200"/></svg>
      <div class="lv-inner">
        <div class="lv-brand">${LOGO}<span>Deep Hospital</span></div>
        <div class="lv-copy">
          <div class="eyebrow" style="color:rgba(255,255,255,.7)">Hospital Operating System</div>
          <h2 style="margin-top:12px">Every department.<br>One patient record.</h2>
          <p>Registration to discharge — OPD, pharmacy, IPD, labs, billing, HR and MIS connected in real time, across every hospital in your network.</p>
          <div class="lv-stats"><div><b>28</b><span>Connected workflows</span></div><div><b>1</b><span>Unified patient record</span></div><div><b>24×7</b><span>Live queues & alerts</span></div></div>
        </div>
      </div>
    </section>
    <section class="login-form-wrap">
      <form class="login-form" id="login-form" novalidate>
        <div class="stagger">
          <div class="row">${LOGO}<div><b style="font-size:17px">Deep Hospital</b><div class="small muted">Secure Healthcare Management Platform</div></div></div>
          <div><h1>Welcome to Deep Hospital</h1><p class="muted mt-8">Sign in with your staff credentials to continue.</p></div>
          ${q.m ? `<div class="callout warn">${icon('info')}<div>${esc(q.m)}</div></div>` : ''}
          <div class="col gap-16 mt-8">
            <div class="field"><label for="hospital">Hospital</label>
              <select class="select" id="hospital" name="hospital_code">${hospitals.map((h) => `<option value="${esc(h.code)}" ${h.code === last ? 'selected' : ''}>${esc(h.name)} — ${esc(h.city || h.code)}</option>`).join('')}<option value="" ${!last ? 'selected' : ''}>Platform console (Super Admin)</option></select></div>
            <div class="field"><label for="username">User ID / Email</label><div class="input-icon">${icon('user')}<input class="input" id="username" name="username" autocomplete="username" placeholder="e.g. reception01" required></div></div>
            <div class="field"><label for="password">Password</label><div class="pw-wrap"><input class="input" id="password" type="password" name="password" autocomplete="current-password" placeholder="••••••••" required><button type="button" id="pw-toggle" aria-label="Show password">${icon('eye')}</button></div></div>
            <div class="row between"><label class="check"><input type="checkbox" id="remember" ${localStorage.getItem('dh.remember') === '1' ? 'checked' : ''}> Remember me</label><a href="#" id="forgot" class="small strong">Forgot password?</a></div>
            <div id="login-error"></div>
            <button class="btn btn-primary btn-lg btn-block" id="login-btn" type="submit">${icon('lock')}Sign in securely</button>
          </div>
          <div class="secure-note">${icon('shield')}256-bit TLS · Encrypted at rest · Role-based access · Every action audited</div>
          ${cfg.demo ? `<div class="demo-hint"><b>Development demo</b> · Super Admin <span class="mono">admin / 123</span> (any hospital). Staff: <span class="mono">reception01</span>, <span class="mono">dr.mehta</span>, <span class="mono">pharmacist01</span>, <span class="mono">nurse01</span>, <span class="mono">lab01</span>, <span class="mono">pathologist01</span>, <span class="mono">billing01</span>, <span class="mono">hr01</span>, <span class="mono">management01</span> — password <span class="mono">123</span>. Patient portal: <a href="/portal/login">UHID #000001 / 123</a>. Change these immediately in Settings.</div>` : ''}
        </div>
      </form>
      <div class="login-foot">© ${new Date().getFullYear()} Deep Hospital · Secure Healthcare Management Platform</div>
    </section>
  </div>`;

  // Slow cinematic slideshow on the visual panel.
  const slides = $$('.slide', app); let si = 0;
  const timer = setInterval(() => { if (!document.body.contains(slides[0])) return clearInterval(timer); slides[si].classList.remove('on'); si = (si + 1) % slides.length; slides[si].classList.add('on'); }, 6500);

  $('#pw-toggle').onclick = () => { const p = $('#password'); const show = p.type === 'password'; p.type = show ? 'text' : 'password'; $('#pw-toggle').innerHTML = icon(show ? 'eyeOff' : 'eye'); };
  $('#forgot').onclick = (e) => { e.preventDefault(); modal({ title: 'Reset your password', size: 'sm', body: `<p class="muted">For security, staff passwords are reset by your hospital administrator from <b>Settings → Users</b>. After a reset you will be asked to set a new password at next sign-in.</p><div class="callout mt-16">${icon('shield')}<div>Deep Hospital never emails passwords. If you suspect your account is compromised, inform your administrator immediately.</div></div>`, foot: '<button class="btn btn-primary" data-close>Got it</button>' }); };
  setTimeout(() => $('#username').focus(), 250);

  $('#login-form').onsubmit = async (e) => {
    e.preventDefault();
    const btn = $('#login-btn'); const errBox = $('#login-error');
    const body = { username: $('#username').value.trim(), password: $('#password').value, hospital_code: $('#hospital').value || undefined };
    if (!body.username || !body.password) { errBox.innerHTML = `<div class="callout danger">${icon('alert')}<div>Enter your user ID and password.</div></div>`; return; }
    btn.classList.add('loading'); errBox.innerHTML = '';
    try {
      const remember = $('#remember').checked;
      const { token } = await api.post('/auth/login', body);
      session.set(token, remember);
      localStorage.setItem('dh.remember', remember ? '1' : '0');
      if (body.hospital_code) localStorage.setItem('dh.hospital', body.hospital_code);
      session.me = await api.get('/auth/me');
      setIdleTimeout(session.me.session_timeout_min || 30, () => logout('You were signed out after a period of inactivity.'));
      clearInterval(timer);
      document.getElementById('app').innerHTML = '';
      toast(`Welcome, ${session.me.user.full_name}`, 'success');
      navigate(session.me.hospital ? (q.next || '/') : '/platform', { replace: true });
    } catch (err) {
      errBox.innerHTML = `<div class="callout danger">${icon('alert')}<div>${esc(err.message)}</div></div>`;
      $('#password').select();
    } finally { btn.classList.remove('loading'); }
  };
}
