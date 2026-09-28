'use strict';
const db = require('../db');
const settings = require('./settings');
const { randomToken, sha256, verifyPassword } = require('./crypto');
const { MODULE_KEYS, MODULES } = require('./modules');
const { now, fmt, HttpError, forbidden } = require('./util');

const ABSOLUTE_HOURS = 12;

function createSession({ kind = 'staff', userId = null, patientAccountId = null, hospitalId = null, ip, ua }) {
  const token = randomToken();
  const t = now();
  const exp = fmt(new Date(Date.now() + ABSOLUTE_HOURS * 3600e3));
  db.insertRow('sessions', { token_hash: sha256(token), kind, user_id: userId, patient_account_id: patientAccountId, hospital_id: hospitalId, ip, user_agent: (ua || '').slice(0, 200), created_at: t, last_seen_at: t, expires_at: exp });
  return token;
}

function revoke(token) { db.run('UPDATE sessions SET revoked = 1 WHERE token_hash = ?', sha256(token)); }

function timeoutMin(hid) { return Number(hid ? settings.get(hid, 'security.session_timeout_min') : 30) || 30; }

// Resolve a bearer token to a live session; enforces idle timeout (automatic logout).
function resolveSession(token) {
  if (!token) return null;
  const s = db.get('SELECT * FROM sessions WHERE token_hash = ? AND revoked = 0', sha256(token));
  if (!s) return null;
  const t = now();
  if (s.expires_at < t) return null;
  const idleLimit = fmt(new Date(Date.now() - timeoutMin(s.hospital_id) * 60e3));
  if (s.last_seen_at < idleLimit) { db.run('UPDATE sessions SET revoked = 1 WHERE id = ?', s.id); return { expired: true }; }
  db.run('UPDATE sessions SET last_seen_at = ? WHERE id = ?', t, s.id);
  return s;
}

function enabledModules(hid) {
  const rows = db.all('SELECT module, enabled FROM hospital_modules WHERE hospital_id = ?', hid);
  const map = Object.fromEntries(rows.map((r) => [r.module, !!r.enabled]));
  return new Set(MODULES.filter((m) => m.core || map[m.key] !== false).map((m) => m.key));
}

// Effective permissions = (role permissions ∪ user grants − user blocks) ∩ enabled modules.
function permissionsFor(user, hid) {
  const enabled = enabledModules(hid);
  const perms = new Set();
  if (user.is_super_admin) {
    for (const m of enabled) for (const a of require('./modules').ACTIONS) perms.add(`${m}:${a}`);
    return { perms, enabled, roles: [{ key: 'super_admin', name: 'Super Admin', dashboard: 'admin' }] };
  }
  const roles = db.all('SELECT r.id, r.key, r.name, r.dashboard FROM roles r JOIN user_roles ur ON ur.role_id = r.id WHERE ur.user_id = ? AND r.hospital_id = ?', user.id, hid);
  if (roles.length) {
    const rows = db.all(`SELECT DISTINCT p.module, p.action FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id WHERE rp.role_id IN (${roles.map(() => '?').join(',')})`, ...roles.map((r) => r.id));
    for (const r of rows) perms.add(`${r.module}:${r.action}`);
  }
  for (const o of db.all('SELECT module, allow, actions FROM user_module_access WHERE user_id = ?', user.id)) {
    if (!o.allow) { for (const p of [...perms]) if (p.startsWith(`${o.module}:`)) perms.delete(p); }
    else for (const a of (o.actions || 'view').split(',')) perms.add(`${o.module}:${a.trim()}`);
  }
  for (const p of [...perms]) if (!enabled.has(p.split(':')[0])) perms.delete(p);
  return { perms, enabled, roles };
}

// ── Express middleware ─────────────────────────────────────────────
function bearer(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7) : null;
}

function authenticate(req, res, next) {
  const s = resolveSession(bearer(req));
  if (!s) return next(new HttpError(401, 'Please sign in to continue'));
  if (s.expired) return next(new HttpError(401, 'Your session expired due to inactivity. Please sign in again.'));
  if (s.kind !== 'staff') return next(new HttpError(401, 'Staff session required'));
  const user = db.get('SELECT id, hospital_id, username, full_name, email, phone, is_super_admin, is_active, uses_demo_password, must_change_password FROM users WHERE id = ?', s.user_id);
  if (!user || !user.is_active) return next(new HttpError(401, 'Account disabled'));
  const hid = s.hospital_id;
  if (hid) {
    const h = db.get('SELECT id, is_active FROM hospitals WHERE id = ?', hid);
    if (!h || (!h.is_active && !user.is_super_admin)) return next(new HttpError(403, 'This hospital is deactivated. Contact the platform administrator.'));
  }
  const ctx = { session: s, user, hid, isSuper: !!user.is_super_admin, perms: new Set(), enabled: new Set(), roles: [] };
  if (hid) Object.assign(ctx, permissionsFor(user, hid));
  const doc = hid ? db.get('SELECT id FROM doctors WHERE hospital_id = ? AND user_id = ?', hid, user.id) : null;
  ctx.doctorId = doc ? doc.id : null;
  ctx.can = (m, a = 'view') => ctx.perms.has(`${m}:${a}`);
  req.ctx = ctx;
  next();
}

// Hospital context required (super admin must "enter" a hospital first).
function hospital(req, res, next) {
  if (!req.ctx || !req.ctx.hid) return next(new HttpError(400, 'Select a hospital first'));
  next();
}

// Permission middleware: require(module, action[, …any of]).
function can(module, action = 'view') {
  return (req, res, next) => {
    if (!req.ctx || !req.ctx.hid) return next(new HttpError(400, 'Select a hospital first'));
    if (!req.ctx.enabled.has(module)) return next(new HttpError(403, `The ${module} module is not enabled for this hospital`));
    if (!req.ctx.can(module, action)) return next(forbidden(`You do not have ${action} permission for ${module}`));
    next();
  };
}
// Any of several module permissions (e.g. patients:view OR opd:view).
function canAny(...pairs) {
  return (req, res, next) => {
    if (!req.ctx || !req.ctx.hid) return next(new HttpError(400, 'Select a hospital first'));
    if (pairs.some(([m, a]) => req.ctx.can(m, a || 'view'))) return next();
    next(forbidden());
  };
}
function superAdmin(req, res, next) {
  if (!req.ctx || !req.ctx.isSuper) return next(forbidden('Super Admin access required'));
  next();
}

// Patient-portal sessions
function authenticatePatient(req, res, next) {
  const s = resolveSession(bearer(req));
  if (!s || s.expired || s.kind !== 'patient') return next(new HttpError(401, 'Please sign in to the patient portal'));
  const acct = db.get('SELECT * FROM patient_accounts WHERE id = ? AND is_active = 1', s.patient_account_id);
  if (!acct) return next(new HttpError(401, 'Portal account disabled'));
  const enabled = enabledModules(acct.hospital_id);
  if (!enabled.has('portal')) return next(new HttpError(403, 'The patient portal is not enabled for this hospital'));
  req.portal = { hid: acct.hospital_id, patientId: acct.patient_id, accountId: acct.id };
  next();
}

// Simple in-memory login throttling per IP (per-account lockout lives in the users table).
const attempts = new Map();
function throttle(ip) {
  const t = Date.now(); const a = (attempts.get(ip) || []).filter((x) => t - x < 60e3);
  a.push(t); attempts.set(ip, a);
  if (a.length > 20) throw new HttpError(429, 'Too many sign-in attempts. Please wait a minute.');
}

module.exports = { createSession, revoke, resolveSession, permissionsFor, enabledModules, authenticate, hospital, can, canAny, superAdmin, authenticatePatient, throttle, verifyPassword, bearer, MODULE_KEYS };
