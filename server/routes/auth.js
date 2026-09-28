'use strict';
const express = require('express');
const db = require('../db');
const auth = require('../lib/auth');
const settings = require('../lib/settings');
const { hashPassword, verifyPassword } = require('../lib/crypto');
const { audit } = require('../lib/audit');
const { validate } = require('../lib/validate');
const { MODULES } = require('../lib/modules');
const { now, fmt, HttpError, bad } = require('../lib/util');

const r = express.Router();

// Public: hospital picker for the login screen (code + name only).
r.get('/public/hospitals', (req, res) => {
  res.json(db.all('SELECT code, name, city FROM hospitals WHERE is_active = 1 ORDER BY name'));
});

// Demo hint is shown only outside production while the seeded demo password is unchanged.
r.get('/public/config', (req, res) => {
  const demo = process.env.NODE_ENV !== 'production' && !!db.get('SELECT id FROM users WHERE is_super_admin = 1 AND uses_demo_password = 1');
  res.json({ demo, product: 'Deep Hospital', version: '1.0.0' });
});

r.post('/auth/login', (req, res) => {
  auth.throttle(req.ip);
  const b = validate(req.body, { username: 'required|max:60', password: 'required|max:200', hospital_code: 'max:40' });
  let hospital = null;
  if (b.hospital_code) {
    hospital = db.get('SELECT * FROM hospitals WHERE code = ?', b.hospital_code);
    if (!hospital) throw bad('Unknown hospital');
  }
  // Super admins live outside any hospital; hospital users are unique per hospital.
  let user = db.get('SELECT * FROM users WHERE hospital_id IS NULL AND username = ? AND is_super_admin = 1', b.username);
  if (!user && hospital) user = db.get('SELECT * FROM users WHERE hospital_id = ? AND username = ?', hospital.id, b.username);
  const fail = (msg = 'Invalid username or password') => {
    if (user) {
      const max = Number(hospital ? settings.get(hospital.id, 'security.max_failed_logins') : 5) || 5;
      const n = user.failed_logins + 1;
      db.run('UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ?', n, n >= max ? fmt(new Date(Date.now() + 15 * 60e3)) : null, user.id);
      req.auditUser = b.username;
      audit(req, 'auth.login_failed', { hid: hospital ? hospital.id : null, entity: 'user', id: user.id });
    }
    throw new HttpError(401, msg);
  };
  if (!user) { if (!hospital) throw bad('Select your hospital to sign in'); fail(); }
  if (user.locked_until && user.locked_until > now()) throw new HttpError(423, 'Account temporarily locked after repeated failed attempts. Try again in 15 minutes.');
  if (!verifyPassword(b.password, user.password_hash)) fail();
  if (!user.is_active) throw new HttpError(403, 'Your account is disabled. Contact your administrator.');
  if (hospital && !hospital.is_active && !user.is_super_admin) throw new HttpError(403, 'This hospital is currently deactivated.');
  db.run('UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = ? WHERE id = ?', now(), user.id);
  const hid = user.is_super_admin ? (hospital ? hospital.id : null) : user.hospital_id;
  const token = auth.createSession({ userId: user.id, hospitalId: hid, ip: req.ip, ua: req.headers['user-agent'] });
  req.ctx = { user, hid };
  audit(req, 'auth.login', { entity: 'user', id: user.id, hid });
  res.json({ token });
});

r.post('/auth/logout', auth.authenticate, (req, res) => {
  auth.revoke(auth.bearer(req));
  audit(req, 'auth.logout', { entity: 'user', id: req.ctx.user.id });
  res.json({ ok: true });
});

// Session bootstrap for the SPA: user, hospital, roles, effective permissions, enabled modules.
r.get('/auth/me', auth.authenticate, (req, res) => {
  const { ctx } = req;
  const hospital = ctx.hid ? db.get('SELECT id, code, name, legal_name, city, state, pincode, address, phone, email, website, gstin, registration_no, logo, brand_color, plan FROM hospitals WHERE id = ?', ctx.hid) : null;
  const doctor = ctx.doctorId ? db.get('SELECT d.*, dp.name department FROM doctors d LEFT JOIN departments dp ON dp.id = d.department_id WHERE d.id = ?', ctx.doctorId) : null;
  res.json({
    user: ctx.user, hospital, doctor,
    roles: ctx.roles.map((x) => ({ key: x.key, name: x.name, dashboard: x.dashboard })),
    dashboard: (ctx.roles[0] && ctx.roles[0].dashboard) || (ctx.isSuper ? 'admin' : 'admin'),
    permissions: [...ctx.perms], modules: [...ctx.enabled],
    all_modules: MODULES,
    session_timeout_min: ctx.hid ? Number(settings.get(ctx.hid, 'security.session_timeout_min')) : 30,
  });
});

r.post('/auth/change-password', auth.authenticate, (req, res) => {
  const b = validate(req.body, { current_password: 'required', new_password: 'required|min:8|max:200' });
  const u = db.get('SELECT * FROM users WHERE id = ?', req.ctx.user.id);
  if (!verifyPassword(b.current_password, u.password_hash)) throw bad('Current password is incorrect');
  if (b.new_password === b.current_password) throw bad('New password must be different');
  if (!/[A-Za-z]/.test(b.new_password) || !/\d/.test(b.new_password)) throw bad('Use at least one letter and one number');
  db.run('UPDATE users SET password_hash = ?, must_change_password = 0, uses_demo_password = 0, updated_at = ? WHERE id = ?', hashPassword(b.new_password), now(), u.id);
  // Invalidate other sessions.
  db.run('UPDATE sessions SET revoked = 1 WHERE user_id = ? AND token_hash != ?', u.id, require('../lib/crypto').sha256(auth.bearer(req)));
  audit(req, 'auth.password_changed', { entity: 'user', id: u.id });
  res.json({ ok: true });
});

// Super admin: enter / leave a hospital's administration.
r.post('/auth/switch-hospital', auth.authenticate, auth.superAdmin, (req, res) => {
  const hid = req.body.hospital_id ? Number(req.body.hospital_id) : null;
  if (hid && !db.get('SELECT id FROM hospitals WHERE id = ?', hid)) throw bad('Unknown hospital');
  db.run('UPDATE sessions SET hospital_id = ? WHERE id = ?', hid, req.ctx.session.id);
  audit(req, hid ? 'platform.enter_hospital' : 'platform.leave_hospital', { hid, entity: 'hospital', id: hid });
  res.json({ ok: true });
});

module.exports = r;
