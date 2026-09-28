'use strict';
// Super Admin (software owner) SaaS console.
const express = require('express');
const fs = require('node:fs');
const db = require('../db');
const auth = require('../lib/auth');
const hospitals = require('../services/hospitals');
const { audit } = require('../lib/audit');
const { validate, id } = require('../lib/validate');
const { MODULES } = require('../lib/modules');
const { now, today, notFound } = require('../lib/util');

const r = express.Router();
r.use('/platform', auth.authenticate, auth.superAdmin);

r.get('/platform/stats', (req, res) => {
  const t = today();
  const stats = db.get(`SELECT
    (SELECT COUNT(*) FROM hospitals) hospitals,
    (SELECT COUNT(*) FROM hospitals WHERE is_active = 1) active_hospitals,
    (SELECT COUNT(*) FROM users WHERE hospital_id IS NOT NULL) users,
    (SELECT COUNT(*) FROM patients) patients,
    (SELECT COUNT(*) FROM opd_visits WHERE visit_date = ?) opd_today,
    (SELECT COUNT(*) FROM ipd_admissions WHERE status = 'admitted') ipd_now,
    (SELECT COALESCE(SUM(CASE WHEN kind='payment' THEN amount ELSE -amount END),0) FROM payments WHERE substr(created_at,1,7) = ?) revenue_month`, t, t.slice(0, 7));
  const growth = db.all("SELECT substr(created_at,1,7) month, COUNT(*) patients FROM patients WHERE created_at >= date('now','localtime','-11 months','start of month') GROUP BY month ORDER BY month");
  const opd = db.all("SELECT v.visit_date day, h.code, COUNT(*) visits FROM opd_visits v JOIN hospitals h ON h.id = v.hospital_id WHERE v.visit_date >= date('now','localtime','-13 day') GROUP BY day, h.code ORDER BY day");
  let dbSize = 0; try { dbSize = fs.statSync(db.DB_FILE).size; } catch {}
  const lastBackup = db.get('SELECT * FROM backups ORDER BY id DESC LIMIT 1');
  res.json({ stats, growth, opd, db_size: dbSize, last_backup: lastBackup });
});

r.get('/platform/hospitals', (req, res) => {
  const rows = db.all(`SELECT h.*,
      (SELECT COUNT(*) FROM users u WHERE u.hospital_id = h.id) users,
      (SELECT COUNT(*) FROM patients p WHERE p.hospital_id = h.id) patients,
      (SELECT COUNT(*) FROM doctors d WHERE d.hospital_id = h.id AND d.is_active = 1) doctors,
      (SELECT COUNT(*) FROM opd_visits v WHERE v.hospital_id = h.id AND v.visit_date = date('now','localtime')) opd_today,
      (SELECT group_concat(module) FROM hospital_modules m WHERE m.hospital_id = h.id AND m.enabled = 1) modules
    FROM hospitals h ORDER BY h.id`);
  for (const h of rows) { h.modules = (h.modules || '').split(',').filter(Boolean); delete h.logo; }
  res.json(rows);
});

const HOSP = { code: { required: true, max: 20, pattern: '^[A-Z0-9-]+$', label: 'hospital code' }, name: 'required|max:120', legal_name: 'max:160', city: 'max:60', state: 'max:60', address: 'max:300', pincode: 'max:10', phone: 'max:20', email: 'email|max:120', website: 'max:120', gstin: 'max:20', registration_no: 'max:40', plan: { enum: ['starter', 'standard', 'enterprise'] }, subscription_status: { enum: ['trial', 'active', 'past_due', 'cancelled'] }, subscription_expires_on: 'date', max_users: 'int|min:1', brand_color: { max: 9, pattern: '^#[0-9a-fA-F]{6}$' }, logo: 'max:400000' };

r.post('/platform/hospitals', (req, res) => {
  const b = validate({ ...req.body, code: String(req.body.code || '').toUpperCase() }, HOSP);
  const a = validate(req.body.admin || {}, { username: 'required|max:60', password: 'required|min:8|max:200', full_name: 'max:120', email: 'email' });
  const modules = Array.isArray(req.body.modules) ? req.body.modules : undefined;
  const out = db.tx(() => {
    const h = hospitals.provision({ ...b, modules, admin: { ...a, must_change: true } });
    const patch = {}; for (const k of ['legal_name', 'pincode', 'website', 'gstin', 'registration_no', 'subscription_status', 'subscription_expires_on', 'max_users', 'brand_color', 'logo']) if (b[k] != null) patch[k] = b[k];
    db.updateRow('hospitals', h.id, patch);
    audit(req, 'platform.hospital_created', { hid: h.id, entity: 'hospital', id: h.id, ref: b.code });
    return h;
  });
  res.status(201).json({ id: out.id });
});

r.get('/platform/hospitals/:id', (req, res) => {
  const h = db.get('SELECT * FROM hospitals WHERE id = ?', id(req.params.id));
  if (!h) throw notFound('Hospital');
  h.modules = db.all('SELECT module, enabled FROM hospital_modules WHERE hospital_id = ?', h.id);
  h.admins = db.all("SELECT u.id, u.username, u.full_name, u.last_login_at FROM users u JOIN user_roles ur ON ur.user_id = u.id JOIN roles r ON r.id = ur.role_id WHERE u.hospital_id = ? AND r.key = 'hospital_admin'", h.id);
  h.branches = db.all('SELECT * FROM branches WHERE hospital_id = ?', h.id);
  h.counts = db.get(`SELECT (SELECT COUNT(*) FROM departments WHERE hospital_id = ?) departments, (SELECT COUNT(*) FROM doctors WHERE hospital_id = ?) doctors, (SELECT COUNT(*) FROM employees WHERE hospital_id = ?) employees, (SELECT COUNT(*) FROM medicines WHERE hospital_id = ?) medicines, (SELECT COUNT(*) FROM beds WHERE hospital_id = ?) beds`, h.id, h.id, h.id, h.id, h.id);
  res.json(h);
});

r.put('/platform/hospitals/:id', (req, res) => {
  const hid = id(req.params.id);
  if (!db.get('SELECT id FROM hospitals WHERE id = ?', hid)) throw notFound('Hospital');
  const b = validate(req.body, { ...HOSP, code: { max: 20 } }, { partial: true });
  delete b.code;  // codes are immutable once issued
  db.updateRow('hospitals', hid, { ...b, updated_at: now() });
  audit(req, 'platform.hospital_updated', { hid, entity: 'hospital', id: hid, details: Object.keys(b) });
  res.json({ ok: true });
});

r.post('/platform/hospitals/:id/status', (req, res) => {
  const hid = id(req.params.id);
  const active = req.body.is_active ? 1 : 0;
  db.run('UPDATE hospitals SET is_active = ?, updated_at = ? WHERE id = ?', active, now(), hid);
  if (!active) db.run('UPDATE sessions SET revoked = 1 WHERE hospital_id = ? AND user_id IN (SELECT id FROM users WHERE is_super_admin = 0)', hid);
  audit(req, active ? 'platform.hospital_activated' : 'platform.hospital_deactivated', { hid, entity: 'hospital', id: hid });
  res.json({ ok: true });
});

// Module switches per hospital (core modules cannot be disabled).
r.put('/platform/hospitals/:id/modules', (req, res) => {
  const hid = id(req.params.id);
  const body = req.body || {};
  db.tx(() => {
    for (const m of MODULES) {
      if (m.core || !(m.key in body)) continue;
      db.run('INSERT INTO hospital_modules (hospital_id, module, enabled, updated_at) VALUES (?,?,?,?) ON CONFLICT(hospital_id, module) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at', hid, m.key, body[m.key] ? 1 : 0, now());
    }
  });
  audit(req, 'platform.modules_updated', { hid, entity: 'hospital', id: hid, details: body });
  res.json({ ok: true });
});

r.get('/platform/audit', (req, res) => {
  res.json(db.all('SELECT a.*, h.code hospital_code FROM audit_logs a LEFT JOIN hospitals h ON h.id = a.hospital_id ORDER BY a.id DESC LIMIT 200'));
});

module.exports = r;
