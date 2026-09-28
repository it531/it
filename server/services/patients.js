'use strict';
const db = require('../db');
const seq = require('../lib/sequence');
const { encrypt, blindIndex, hashPassword } = require('../lib/crypto');
const { now, ageFrom, notFound } = require('../lib/util');

const FIELDS = ['first_name', 'last_name', 'dob', 'gender', 'mobile', 'alt_mobile', 'email', 'address', 'city', 'state', 'pincode', 'blood_group',
  'emergency_name', 'emergency_relation', 'emergency_phone', 'occupation', 'marital_status', 'guardian_name', 'guardian_relation', 'guardian_phone',
  'allergies', 'chronic_conditions', 'photo', 'insurance_provider', 'insurance_policy_no', 'insurance_valid_till'];

// Automation: registration always generates the next UHID server-side (#000001, #000002 …).
function create(hid, data, userId, createdAt) {
  const { seq: n, value: uhid } = seq.formatted(hid, 'patient');
  const row = { hospital_id: hid, uhid, uhid_seq: n, created_by: userId, created_at: createdAt || now() };
  for (const f of FIELDS) if (data[f] !== undefined) row[f] = data[f];
  row.full_name = [data.first_name, data.last_name].filter(Boolean).join(' ');
  const id = db.insertRow('patients', row);
  if (data.id_type && data.id_number) addIdentifier(hid, id, data.id_type, data.id_number);
  return { id, uhid };
}

function update(hid, id, data) {
  const p = db.get('SELECT * FROM patients WHERE id = ? AND hospital_id = ?', id, hid);
  if (!p) throw notFound('Patient');
  const row = { updated_at: now() };
  for (const f of FIELDS) if (data[f] !== undefined) row[f] = data[f];
  if (data.first_name !== undefined || data.last_name !== undefined) row.full_name = [data.first_name ?? p.first_name, data.last_name ?? p.last_name].filter(Boolean).join(' ');
  db.updateRow('patients', id, row, 'AND hospital_id = ?', hid);
  if (data.id_type && data.id_number) addIdentifier(hid, id, data.id_type, data.id_number);
}

function addIdentifier(hid, patientId, type, value) {
  const clean = String(value).replace(/\s+/g, '');
  const bi = blindIndex(`${type}:${clean}`);
  const existing = db.get('SELECT id FROM patient_identifiers WHERE patient_id = ? AND blind_index = ?', patientId, bi);
  if (existing) return;
  db.insertRow('patient_identifiers', { hospital_id: hid, patient_id: patientId, id_type: type, value_enc: encrypt(clean), last4: clean.slice(-4), blind_index: bi, created_at: now() });
}

function findByIdentifier(hid, value) {
  const clean = String(value).replace(/\s+/g, '');
  const types = ['aadhaar', 'pan', 'passport', 'voter', 'driving', 'abha', 'other'];
  const idx = types.map((t) => blindIndex(`${t}:${clean}`));
  return db.all(`SELECT DISTINCT patient_id FROM patient_identifiers WHERE hospital_id = ? AND blind_index IN (${idx.map(() => '?').join(',')})`, hid, ...idx).map((r) => r.patient_id);
}

function decorate(p) {
  if (!p) return p;
  p.age = ageFrom(p.dob);
  return p;
}

function enablePortal(hid, patientId, password) {
  const exists = db.get('SELECT id FROM patient_accounts WHERE patient_id = ?', patientId);
  if (exists) db.run('UPDATE patient_accounts SET password_hash = ?, is_active = 1 WHERE id = ?', hashPassword(password), exists.id);
  else db.insertRow('patient_accounts', { hospital_id: hid, patient_id: patientId, password_hash: hashPassword(password), created_at: now() });
}

module.exports = { create, update, addIdentifier, findByIdentifier, decorate, enablePortal, FIELDS };
