'use strict';
const db = require('../db');
const { hashPassword } = require('../lib/crypto');
const { MODULES, ROLE_TEMPLATES, expandPerms } = require('../lib/modules');
const { now, conflict } = require('../lib/util');

function ensurePermissions() {
  const { MODULE_KEYS, ACTIONS } = require('../lib/modules');
  for (const m of MODULE_KEYS) for (const a of ACTIONS) db.run('INSERT OR IGNORE INTO permissions (module, action) VALUES (?,?)', m, a);
}
const permId = (m, a) => db.get('SELECT id FROM permissions WHERE module = ? AND action = ?', m, a).id;

function setRolePermissions(roleId, pairs) {
  db.run('DELETE FROM role_permissions WHERE role_id = ?', roleId);
  for (const [m, a] of pairs) db.run('INSERT OR IGNORE INTO role_permissions (role_id, permission_id) VALUES (?,?)', roleId, permId(m, a));
}

/**
 * Provision a new tenant: hospital row, main branch, module switches, default roles
 * with permission templates, and the first hospital-admin user.
 */
function provision({ code, name, city, state, address, phone, email, plan = 'standard', modules, admin }) {
  ensurePermissions();
  if (db.get('SELECT id FROM hospitals WHERE code = ?', code)) throw conflict(`Hospital code ${code} already exists`);
  const t = now();
  const hid = db.insertRow('hospitals', { code, name, legal_name: name, city, state, address, phone, email, plan, subscription_status: 'active', subscription_expires_on: `${Number(t.slice(0, 4)) + 1}${t.slice(4, 10)}`, created_at: t, last_activity_at: t });
  db.insertRow('branches', { hospital_id: hid, name: `${name} — Main`, address, phone, is_main: 1, created_at: t });
  for (const m of MODULES) {
    const on = m.core || !modules || modules.includes(m.key);
    db.run('INSERT INTO hospital_modules (hospital_id, module, enabled, updated_at) VALUES (?,?,?,?)', hid, m.key, on ? 1 : 0, t);
  }
  const roleIds = {};
  for (const r of ROLE_TEMPLATES) {
    const rid = db.insertRow('roles', { hospital_id: hid, key: r.key, name: r.name, description: r.description, is_system: 1, dashboard: r.dashboard, created_at: t });
    setRolePermissions(rid, expandPerms(r.perms));
    roleIds[r.key] = rid;
  }
  let adminId = null;
  if (admin) {
    adminId = db.insertRow('users', { hospital_id: hid, username: admin.username, full_name: admin.full_name || `${name} Administrator`, email: admin.email, password_hash: hashPassword(admin.password), must_change_password: admin.must_change ? 1 : 0, uses_demo_password: admin.demo ? 1 : 0, created_at: t });
    db.run('INSERT INTO user_roles (user_id, role_id) VALUES (?,?)', adminId, roleIds.hospital_admin);
  }
  return { id: hid, roleIds, adminId };
}

function createUser(hid, { username, full_name, email, phone, password, role_keys = [], role_ids = [], demo = false, must_change = false }) {
  if (db.get('SELECT id FROM users WHERE IFNULL(hospital_id,0) = ? AND username = ?', hid || 0, username)) throw conflict(`Username ${username} already exists in this hospital`);
  const id = db.insertRow('users', { hospital_id: hid, username, full_name, email, phone, password_hash: hashPassword(password), uses_demo_password: demo ? 1 : 0, must_change_password: must_change ? 1 : 0, created_at: now() });
  const ids = [...role_ids];
  for (const k of role_keys) { const r = db.get('SELECT id FROM roles WHERE hospital_id = ? AND key = ?', hid, k); if (r) ids.push(r.id); }
  for (const rid of ids) {
    if (!db.get('SELECT id FROM roles WHERE id = ? AND hospital_id = ?', rid, hid)) continue;  // never cross-tenant
    db.run('INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?,?)', id, rid);
  }
  return id;
}

module.exports = { provision, createUser, ensurePermissions, setRolePermissions, permId };
