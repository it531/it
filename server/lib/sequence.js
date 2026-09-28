'use strict';
// Server-side, gap-tolerant, never-duplicating number generation.
// UPDATE … RETURNING runs inside SQLite's single-writer lock, so two concurrent
// requests can never receive the same value. Uniqueness is also enforced by
// UNIQUE constraints on every numbered column.
const db = require('../db');
const settings = require('./settings');
const { today } = require('./util');

function next(hid, key) {
  db.run('INSERT INTO sequences (hospital_id, key, value) VALUES (?, ?, 0) ON CONFLICT(hospital_id, key) DO NOTHING', hid, key);
  return db.get('UPDATE sequences SET value = value + 1 WHERE hospital_id = ? AND key = ? RETURNING value', hid, key).value;
}
function peek(hid, key) {
  const r = db.get('SELECT value FROM sequences WHERE hospital_id = ? AND key = ?', hid, key);
  return r ? r.value : 0;
}

function formatted(hid, kind) {
  const prefix = settings.get(hid, `numbering.${kind}.prefix`) ?? '';
  const pad = Number(settings.get(hid, `numbering.${kind}.pad`) || 6);
  const seq = next(hid, kind);
  return { seq, value: `${prefix}${String(seq).padStart(pad, '0')}` };
}

// OPD token: per doctor, per day (or continuous), prefix is the doctor's letter: A001, A002 …
function opdToken(hid, doctor, date = today()) {
  const pad = Number(settings.get(hid, 'numbering.opd_token.pad') || 3);
  const daily = settings.get(hid, 'numbering.opd_token.reset') !== 'never';
  const seq = next(hid, daily ? `opd_token:${doctor.id}:${date}` : `opd_token:${doctor.id}`);
  return { seq, token: `${doctor.token_prefix}${String(seq).padStart(pad, '0')}` };
}

// Pharmacy token: hospital-wide, P-001 …
function pharmacyToken(hid, date = today()) {
  const prefix = settings.get(hid, 'numbering.pharmacy_token.prefix');
  const pad = Number(settings.get(hid, 'numbering.pharmacy_token.pad') || 3);
  const daily = settings.get(hid, 'numbering.pharmacy_token.reset') !== 'never';
  const seq = next(hid, daily ? `pharmacy_token:${date}` : 'pharmacy_token');
  return { seq, token: `${prefix}${String(seq).padStart(pad, '0')}` };
}

module.exports = { next, peek, formatted, opdToken, pharmacyToken };
