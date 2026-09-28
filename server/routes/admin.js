'use strict';
// Hospital administration: profile, settings, numbering, departments, doctors, users,
// roles & permission matrix, masters (diagnosis, templates, lab tests, wards/beds),
// audit log and backup status.
const express = require('express');
const fs = require('node:fs');
const db = require('../db');
const auth = require('../lib/auth');
const settings = require('../lib/settings');
const seqlib = require('../lib/sequence');
const automation = require('../lib/automation');
const hospitals = require('../services/hospitals');
const { hashPassword } = require('../lib/crypto');
const { audit } = require('../lib/audit');
const { validate, id } = require('../lib/validate');
const { MODULES, ACTIONS } = require('../lib/modules');
const { now, notFound, conflict, bad, forbidden } = require('../lib/util');

const r = express.Router();
const A = auth.authenticate;
const S = (a = 'view') => [A, auth.can('settings', a)];

// ───────── Hospital profile & settings
r.get('/settings', ...S(), (req, res) => {
  const h = db.get('SELECT * FROM hospitals WHERE id = ?', req.ctx.hid);
  const peek = {};
  for (const k of ['patient', 'ipd', 'invoice', 'receipt', 'visit', 'appointment', 'rx', 'lab', 'radiology', 'pharmacy_order', 'employee']) peek[k] = seqlib.peek(req.ctx.hid, k);
  res.json({ hospital: h, settings: settings.getAll(req.ctx.hid), sequences: peek, modules: MODULES.map((m) => ({ ...m, enabled: req.ctx.enabled.has(m.key) })) });
});

r.put('/settings/profile', ...S('edit'), (req, res) => {
  const b = validate(req.body, { name: 'required|max:120', legal_name: 'max:160', address: 'max:300', city: 'max:60', state: 'max:60', pincode: 'max:10', phone: 'max:20', email: 'email|max:120', website: 'max:120', gstin: 'max:20', registration_no: 'max:40', logo: 'max:400000', brand_color: { max: 9, pattern: '^#[0-9a-fA-F]{6}$' } });
  db.updateRow('hospitals', req.ctx.hid, { ...b, updated_at: now() });
  audit(req, 'settings.profile_updated', { entity: 'hospital', id: req.ctx.hid });
  res.json({ ok: true });
});

r.put('/settings', ...S('edit'), (req, res) => {
  const body = req.body || {};
  const changed = [];
  db.tx(() => {
    for (const [k, v] of Object.entries(body)) {
      if (!(k in settings.DEFAULTS)) throw bad(`Unknown setting ${k}`);
      if (/\.pad$/.test(k) && !(Number(v) >= 1 && Number(v) <= 10)) throw bad('Padding must be between 1 and 10');
      if (/\.prefix$/.test(k) && String(v).length > 12) throw bad('Prefix too long');
      if (k === 'security.session_timeout_min' && !(Number(v) >= 5 && Number(v) <= 720)) throw bad('Session timeout must be 5–720 minutes');
      settings.set(req.ctx.hid, k, v); changed.push(k);
    }
  });
  audit(req, 'settings.updated', { entity: 'settings', details: changed });
  res.json({ ok: true });
});

// ───────── Departments
r.get('/departments', A, auth.hospital, (req, res) => {
  res.json(db.all(`SELECT d.*, (SELECT COUNT(*) FROM doctors x WHERE x.department_id = d.id AND x.is_active = 1) doctors, (SELECT COUNT(*) FROM employees e WHERE e.department_id = d.id) employees FROM departments d WHERE d.hospital_id = ? ORDER BY d.name`, req.ctx.hid));
});
const DEPT = { name: 'required|max:80', code: 'max:12', kind: { enum: ['clinical', 'support', 'admin'], default: 'clinical' }, is_active: { type: 'bool', default: 1 } };
r.post('/departments', ...S('add'), (req, res) => {
  const b = validate(req.body, DEPT);
  if (db.get('SELECT id FROM departments WHERE hospital_id = ? AND name = ?', req.ctx.hid, b.name)) throw conflict('Department already exists');
  const did = db.insertRow('departments', { ...b, hospital_id: req.ctx.hid, created_at: now() });
  audit(req, 'department.created', { entity: 'department', id: did, ref: b.name });
  res.status(201).json({ id: did });
});
r.put('/departments/:id', ...S('edit'), (req, res) => {
  const b = validate(req.body, DEPT, { partial: true });
  if (!db.updateRow('departments', id(req.params.id), b, 'AND hospital_id = ?', req.ctx.hid)) throw notFound('Department');
  audit(req, 'department.updated', { entity: 'department', id: Number(req.params.id) });
  res.json({ ok: true });
});

// ───────── Doctors
r.get('/doctors', A, auth.hospital, (req, res) => {
  res.json(db.all(`SELECT d.*, dp.name department, u.username,
      (SELECT COUNT(*) FROM opd_visits v WHERE v.doctor_id = d.id AND v.visit_date = date('now','localtime') AND v.status = 'waiting') waiting,
      (SELECT COUNT(*) FROM opd_visits v WHERE v.doctor_id = d.id AND v.visit_date = date('now','localtime')) today
    FROM doctors d LEFT JOIN departments dp ON dp.id = d.department_id LEFT JOIN users u ON u.id = d.user_id WHERE d.hospital_id = ? ORDER BY d.is_active DESC, d.name`, req.ctx.hid));
});
const DOC = { name: 'required|max:100', department_id: 'int', specialization: 'max:100', qualification: 'max:120', registration_no: 'max:40', phone: 'mobile', email: 'email', room: 'max:40', consultation_fee: 'number|min:0', followup_fee: 'number|min:0', token_prefix: { required: true, max: 3, pattern: '^[A-Z]{1,3}$', label: 'token prefix' }, avg_consult_minutes: 'int|min:1|max:120', user_id: 'int', is_active: { type: 'bool', default: 1 } };
function checkDoctorRefs(hid, b) {
  if (b.department_id && !db.get('SELECT id FROM departments WHERE id = ? AND hospital_id = ?', b.department_id, hid)) throw bad('Invalid department');
  if (b.user_id && !db.get('SELECT id FROM users WHERE id = ? AND hospital_id = ?', b.user_id, hid)) throw bad('Invalid user');
}
r.post('/doctors', ...S('add'), (req, res) => {
  const b = validate({ ...req.body, token_prefix: String(req.body.token_prefix || '').toUpperCase() }, DOC);
  checkDoctorRefs(req.ctx.hid, b);
  const did = db.insertRow('doctors', { ...b, hospital_id: req.ctx.hid, created_at: now() });
  audit(req, 'doctor.created', { entity: 'doctor', id: did, ref: b.name });
  res.status(201).json({ id: did });
});
r.put('/doctors/:id', ...S('edit'), (req, res) => {
  const b = validate({ ...req.body, token_prefix: req.body.token_prefix ? String(req.body.token_prefix).toUpperCase() : undefined }, DOC, { partial: true });
  checkDoctorRefs(req.ctx.hid, b);
  if (!db.updateRow('doctors', id(req.params.id), b, 'AND hospital_id = ?', req.ctx.hid)) throw notFound('Doctor');
  audit(req, 'doctor.updated', { entity: 'doctor', id: Number(req.params.id) });
  res.json({ ok: true });
});

// ───────── Users
r.get('/users', ...S(), (req, res) => {
  const users = db.all('SELECT id, username, full_name, email, phone, is_active, uses_demo_password, last_login_at, created_at FROM users WHERE hospital_id = ? ORDER BY full_name', req.ctx.hid);
  for (const u of users) {
    u.roles = db.all('SELECT r.id, r.key, r.name FROM roles r JOIN user_roles ur ON ur.role_id = r.id WHERE ur.user_id = ?', u.id);
    u.overrides = db.all('SELECT module, allow, actions FROM user_module_access WHERE user_id = ?', u.id);
    u.effective_modules = [...new Set([...auth.permissionsFor({ ...u, is_super_admin: 0 }, req.ctx.hid).perms].filter((p) => p.endsWith(':view')).map((p) => p.split(':')[0]))];
  }
  res.json(users);
});
const USER = { username: { required: true, max: 60, pattern: '^[A-Za-z0-9._-]+$' }, full_name: 'required|max:120', email: 'email', phone: 'mobile', password: 'min:8|max:200', role_ids: 'array', is_active: { type: 'bool', default: 1 } };
function checkRoles(hid, ids = []) { for (const rid of ids) if (!db.get('SELECT id FROM roles WHERE id = ? AND hospital_id = ?', rid, hid)) throw bad('Invalid role'); }
function guardAdminRole(req, ids = []) {
  // Only hospital admins (or super admins) can grant the hospital-admin role.
  const adminRole = db.get("SELECT id FROM roles WHERE hospital_id = ? AND key = 'hospital_admin'", req.ctx.hid);
  if (adminRole && ids.map(Number).includes(adminRole.id) && !req.ctx.isSuper && !req.ctx.roles.some((x) => x.key === 'hospital_admin')) throw forbidden('Only a hospital admin can grant the Hospital Admin role');
}
r.post('/users', ...S('add'), (req, res) => {
  const b = validate(req.body, { ...USER, password: 'required|min:8|max:200' });
  checkRoles(req.ctx.hid, b.role_ids); guardAdminRole(req, b.role_ids);
  const uid = db.tx(() => hospitals.createUser(req.ctx.hid, { ...b, role_ids: (b.role_ids || []).map(Number), must_change: true }));
  audit(req, 'user.created', { entity: 'user', id: uid, ref: b.username, details: { roles: b.role_ids } });
  res.status(201).json({ id: uid });
});
r.put('/users/:id', ...S('edit'), (req, res) => {
  const uid = id(req.params.id);
  const u = db.get('SELECT * FROM users WHERE id = ? AND hospital_id = ?', uid, req.ctx.hid);
  if (!u) throw notFound('User');
  const b = validate(req.body, { full_name: 'max:120', email: 'email', phone: 'mobile', is_active: 'bool', role_ids: 'array', password: 'min:8|max:200' }, { partial: true });
  if (uid === req.ctx.user.id && b.is_active === 0) throw bad('You cannot deactivate your own account');
  db.tx(() => {
    const patch = { full_name: b.full_name ?? undefined, email: b.email, phone: b.phone, is_active: b.is_active, updated_at: now() };
    if (b.password) Object.assign(patch, { password_hash: hashPassword(b.password), must_change_password: 1, uses_demo_password: 0 });
    db.updateRow('users', uid, patch);
    if (b.role_ids) {
      checkRoles(req.ctx.hid, b.role_ids); guardAdminRole(req, b.role_ids);
      db.run('DELETE FROM user_roles WHERE user_id = ?', uid);
      for (const rid of b.role_ids) db.run('INSERT INTO user_roles (user_id, role_id) VALUES (?,?)', uid, Number(rid));
    }
    if (b.is_active === 0 || b.password) db.run('UPDATE sessions SET revoked = 1 WHERE user_id = ?', uid);
  });
  audit(req, b.role_ids ? 'user.permissions_changed' : 'user.updated', { entity: 'user', id: uid, ref: u.username, details: { roles: b.role_ids, active: b.is_active, password_reset: !!b.password } });
  res.json({ ok: true });
});
// Per-user module access matrix: { module: 'allow' | 'deny' | 'inherit' }
r.put('/users/:id/modules', ...S('edit'), (req, res) => {
  const uid = id(req.params.id);
  const u = db.get('SELECT username FROM users WHERE id = ? AND hospital_id = ?', uid, req.ctx.hid);
  if (!u) throw notFound('User');
  db.tx(() => {
    for (const [m, v] of Object.entries(req.body || {})) {
      if (!MODULES.find((x) => x.key === m)) throw bad(`Unknown module ${m}`);
      db.run('DELETE FROM user_module_access WHERE user_id = ? AND module = ?', uid, m);
      if (v === 'allow') db.run('INSERT INTO user_module_access (user_id, module, allow, actions) VALUES (?,?,1,?)', uid, m, 'view');
      else if (v === 'deny') db.run('INSERT INTO user_module_access (user_id, module, allow) VALUES (?,?,0)', uid, m);
    }
  });
  audit(req, 'user.permissions_changed', { entity: 'user', id: uid, ref: u.username, details: req.body });
  res.json({ ok: true });
});

// ───────── Roles & permission matrix
r.get('/roles', ...S(), (req, res) => {
  const roles = db.all('SELECT r.*, (SELECT COUNT(*) FROM user_roles ur WHERE ur.role_id = r.id) users FROM roles r WHERE r.hospital_id = ? ORDER BY r.is_system DESC, r.name', req.ctx.hid);
  for (const role of roles) role.permissions = db.all('SELECT p.module, p.action FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id WHERE rp.role_id = ?', role.id).map((p) => `${p.module}:${p.action}`);
  res.json({ roles, modules: MODULES, actions: ACTIONS });
});
function validPerms(list) {
  const out = [];
  for (const p of list || []) {
    const [m, a] = String(p).split(':');
    if (!MODULES.find((x) => x.key === m) || !ACTIONS.includes(a)) throw bad(`Invalid permission ${p}`);
    out.push([m, a]);
  }
  return out;
}
r.post('/roles', ...S('add'), (req, res) => {
  const b = validate(req.body, { name: 'required|max:60', description: 'max:200', dashboard: { enum: ['admin', 'reception', 'doctor', 'nurse', 'pharmacist', 'billing', 'lab', 'radiology', 'hr', 'management'], default: 'admin' }, permissions: 'array' });
  const key = `custom_${b.name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}_${Date.now().toString(36)}`;
  const rid = db.tx(() => {
    const x = db.insertRow('roles', { hospital_id: req.ctx.hid, key, name: b.name, description: b.description, dashboard: b.dashboard, created_at: now() });
    hospitals.setRolePermissions(x, validPerms(b.permissions));
    return x;
  });
  audit(req, 'role.created', { entity: 'role', id: rid, ref: b.name });
  res.status(201).json({ id: rid });
});
r.put('/roles/:id', ...S('edit'), (req, res) => {
  const rid = id(req.params.id);
  const role = db.get('SELECT * FROM roles WHERE id = ? AND hospital_id = ?', rid, req.ctx.hid);
  if (!role) throw notFound('Role');
  if (role.key === 'hospital_admin' && !req.ctx.isSuper) throw forbidden('The Hospital Admin role always has full access');
  const b = validate(req.body, { name: 'max:60', description: 'max:200', dashboard: 'max:20', permissions: 'array' }, { partial: true });
  db.tx(() => {
    db.updateRow('roles', rid, { name: b.name || undefined, description: b.description, dashboard: b.dashboard || undefined });
    if (b.permissions) hospitals.setRolePermissions(rid, validPerms(b.permissions));
  });
  audit(req, 'role.permissions_changed', { entity: 'role', id: rid, ref: role.name, details: { count: b.permissions && b.permissions.length } });
  res.json({ ok: true });
});
r.delete('/roles/:id', ...S('delete'), (req, res) => {
  const role = db.get('SELECT * FROM roles WHERE id = ? AND hospital_id = ?', id(req.params.id), req.ctx.hid);
  if (!role) throw notFound('Role');
  if (role.is_system) throw bad('System roles cannot be deleted');
  if (db.get('SELECT COUNT(*) c FROM user_roles WHERE role_id = ?', role.id).c) throw conflict('Role is assigned to users');
  db.run('DELETE FROM roles WHERE id = ?', role.id);
  audit(req, 'role.deleted', { entity: 'role', id: role.id, ref: role.name });
  res.json({ ok: true });
});

// ───────── Diagnosis master
r.get('/masters/diagnoses', A, auth.canAny(['settings', 'view'], ['doctor', 'view']), (req, res) => {
  const q = `%${req.query.q || ''}%`;
  res.json(db.all(`SELECT d.*, (SELECT COUNT(*) FROM visit_diagnoses v WHERE v.diagnosis_id = d.id) uses FROM diagnosis_codes d WHERE d.hospital_id = ? AND (d.name LIKE ? OR d.code LIKE ?) ORDER BY d.is_active DESC, d.name LIMIT 500`, req.ctx.hid, q, q));
});
const DX = { code: 'max:12', name: 'required|max:160', specialty: 'max:60', synonyms: 'max:300', is_common: 'bool', is_active: { type: 'bool', default: 1 } };
r.post('/masters/diagnoses', ...S('add'), (req, res) => {
  const b = validate(req.body, DX);
  if (db.get('SELECT id FROM diagnosis_codes WHERE hospital_id = ? AND name = ?', req.ctx.hid, b.name)) throw conflict('Diagnosis already exists');
  const did = db.insertRow('diagnosis_codes', { ...b, hospital_id: req.ctx.hid, created_at: now() });
  audit(req, 'master.diagnosis_created', { entity: 'diagnosis', id: did, ref: b.name });
  res.status(201).json({ id: did });
});
r.put('/masters/diagnoses/:id', ...S('edit'), (req, res) => {
  const b = validate(req.body, DX, { partial: true });
  if (!db.updateRow('diagnosis_codes', id(req.params.id), b, 'AND hospital_id = ?', req.ctx.hid)) throw notFound('Diagnosis');
  res.json({ ok: true });
});

// ───────── Prescription templates (hospital-approved)
r.get('/masters/templates', A, auth.canAny(['settings', 'view'], ['doctor', 'view']), (req, res) => {
  const rows = db.all('SELECT t.*, d.name diagnosis, d.code FROM prescription_templates t LEFT JOIN diagnosis_codes d ON d.id = t.diagnosis_id WHERE t.hospital_id = ? ORDER BY t.name', req.ctx.hid);
  for (const t of rows) t.items = db.all('SELECT ti.*, m.name, m.strength FROM prescription_template_items ti JOIN medicines m ON m.id = ti.medicine_id WHERE ti.template_id = ?', t.id);
  res.json(rows);
});
function saveTemplate(req, tid) {
  const b = validate(req.body, { name: 'required|max:120', diagnosis_id: 'int', advice: 'max:500', items: 'array', is_approved: 'bool' });
  if (b.diagnosis_id && !db.get('SELECT id FROM diagnosis_codes WHERE id = ? AND hospital_id = ?', b.diagnosis_id, req.ctx.hid)) throw bad('Invalid diagnosis');
  // Approval is a separate permission: settings:approve.
  const approve = b.is_approved && req.ctx.can('settings', 'approve');
  return db.tx(() => {
    if (!tid) tid = db.insertRow('prescription_templates', { hospital_id: req.ctx.hid, name: b.name, diagnosis_id: b.diagnosis_id, advice: b.advice, is_approved: approve ? 1 : 0, approved_by: approve ? req.ctx.user.id : null, created_at: now() });
    else db.updateRow('prescription_templates', tid, { name: b.name, diagnosis_id: b.diagnosis_id, advice: b.advice, is_approved: approve ? 1 : 0, approved_by: approve ? req.ctx.user.id : null });
    db.run('DELETE FROM prescription_template_items WHERE template_id = ?', tid);
    for (const it of b.items || []) {
      if (!db.get('SELECT id FROM medicines WHERE id = ? AND hospital_id = ?', Number(it.medicine_id), req.ctx.hid)) throw bad('Invalid medicine in template');
      db.insertRow('prescription_template_items', { template_id: tid, medicine_id: Number(it.medicine_id), dose: it.dose, frequency: it.frequency, duration_days: Number(it.duration_days) || null, route: it.route, instructions: it.instructions });
    }
    return tid;
  });
}
r.post('/masters/templates', ...S('add'), (req, res) => { const tid = saveTemplate(req); audit(req, 'master.template_saved', { entity: 'template', id: tid }); res.status(201).json({ id: tid }); });
r.put('/masters/templates/:id', ...S('edit'), (req, res) => {
  const tid = id(req.params.id);
  if (!db.get('SELECT id FROM prescription_templates WHERE id = ? AND hospital_id = ?', tid, req.ctx.hid)) throw notFound('Template');
  saveTemplate(req, tid); audit(req, 'master.template_saved', { entity: 'template', id: tid }); res.json({ ok: true });
});

// ───────── Lab test master
r.get('/masters/lab-tests', A, auth.hospital, (req, res) => res.json(db.all('SELECT * FROM lab_tests WHERE hospital_id = ? ORDER BY category, name', req.ctx.hid).map((t) => ({ ...t, parameters: JSON.parse(t.parameters || '[]') }))));
r.post('/masters/lab-tests', A, auth.canAny(['settings', 'add'], ['laboratory', 'add']), (req, res) => {
  const b = validate(req.body, { code: 'max:20', name: 'required|max:120', category: 'max:60', sample_type: 'max:40', price: 'number|min:0', tat_hours: 'int|min:1', parameters: 'array' });
  const tid = db.insertRow('lab_tests', { ...b, parameters: JSON.stringify(b.parameters || []), hospital_id: req.ctx.hid, created_at: now() });
  audit(req, 'master.lab_test_created', { entity: 'lab_test', id: tid, ref: b.name });
  res.status(201).json({ id: tid });
});
r.put('/masters/lab-tests/:id', A, auth.canAny(['settings', 'edit'], ['laboratory', 'edit']), (req, res) => {
  const b = validate(req.body, { code: 'max:20', name: 'max:120', category: 'max:60', sample_type: 'max:40', price: 'number|min:0', tat_hours: 'int|min:1', parameters: 'array', is_active: 'bool' }, { partial: true });
  if (b.parameters) b.parameters = JSON.stringify(b.parameters);
  if (!db.updateRow('lab_tests', id(req.params.id), b, 'AND hospital_id = ?', req.ctx.hid)) throw notFound('Lab test');
  res.json({ ok: true });
});

// ───────── Wards & beds master
r.post('/masters/wards', A, auth.canAny(['settings', 'add'], ['ipd', 'add']), (req, res) => {
  const b = validate(req.body, { name: 'required|max:60', ward_type: { enum: ['general', 'semi_private', 'private', 'icu', 'nicu', 'emergency'], default: 'general' }, floor: 'max:20', daily_rate: 'number|min:0', beds: 'int|min:0|max:200', bed_prefix: 'max:6' });
  const wid = db.tx(() => {
    const w = db.insertRow('wards', { hospital_id: req.ctx.hid, name: b.name, ward_type: b.ward_type, floor: b.floor, daily_rate: b.daily_rate || 0, created_at: now() });
    for (let i = 1; i <= (b.beds || 0); i++) db.insertRow('beds', { hospital_id: req.ctx.hid, ward_id: w, bed_no: `${b.bed_prefix || b.name.slice(0, 2).toUpperCase()}-${String(i).padStart(2, '0')}`, status: 'available', updated_at: now() });
    return w;
  });
  audit(req, 'master.ward_created', { entity: 'ward', id: wid, ref: b.name });
  res.status(201).json({ id: wid });
});

// ───────── Audit log
r.get('/audit', A, auth.can('audit', 'view'), (req, res) => {
  const q = req.query; const where = ['a.hospital_id = ?']; const p = [req.ctx.hid];
  if (q.user) { where.push('a.username LIKE ?'); p.push(`%${q.user}%`); }
  if (q.action) { where.push('a.action LIKE ?'); p.push(`%${q.action}%`); }
  if (q.ref) { where.push('(a.ref LIKE ? OR a.details LIKE ?)'); p.push(`%${q.ref}%`, `%${q.ref}%`); }
  if (q.from) { where.push('a.created_at >= ?'); p.push(q.from); }
  if (q.to) { where.push('a.created_at <= ?'); p.push(`${q.to} 23:59:59`); }
  const limit = Math.min(Number(q.limit) || 200, 1000);
  res.json(db.all(`SELECT a.* FROM audit_logs a WHERE ${where.join(' AND ')} ORDER BY a.id DESC LIMIT ?`, ...p, limit));
});

// ───────── Backup status (backups are platform-wide; hospital admins see status, super admin can trigger)
r.get('/backup', ...S(), (req, res) => {
  let size = 0; try { size = fs.statSync(db.DB_FILE).size; } catch {}
  const hospitalRows = db.get(`SELECT (SELECT COUNT(*) FROM patients WHERE hospital_id = ?) + (SELECT COUNT(*) FROM opd_visits WHERE hospital_id = ?) + (SELECT COUNT(*) FROM invoices WHERE hospital_id = ?) + (SELECT COUNT(*) FROM audit_logs WHERE hospital_id = ?) n`, req.ctx.hid, req.ctx.hid, req.ctx.hid, req.ctx.hid).n;
  res.json({ database_size: size, hospital_records: hospitalRows, frequency: settings.get(req.ctx.hid, 'backup.frequency'), retention: 14, history: db.all('SELECT * FROM backups ORDER BY id DESC LIMIT 20'), can_run: req.ctx.isSuper || req.ctx.roles.some((x) => x.key === 'hospital_admin') });
});
r.post('/backup/run', ...S('edit'), (req, res) => {
  if (!req.ctx.isSuper && !req.ctx.roles.some((x) => x.key === 'hospital_admin')) throw forbidden('Only administrators can trigger a backup');
  const out = automation.backup('manual');
  audit(req, 'backup.manual', { details: out });
  res.json(out);
});

// ───────── Notification delivery log (channel queue)
r.get('/notifications/deliveries', ...S(), (req, res) => {
  res.json(db.all('SELECT * FROM notification_deliveries WHERE hospital_id = ? ORDER BY id DESC LIMIT 100', req.ctx.hid));
});

module.exports = r;
