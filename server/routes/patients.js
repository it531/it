'use strict';
const express = require('express');
const db = require('../db');
const auth = require('../lib/auth');
const patients = require('../services/patients');
const assistant = require('../services/assistant');
const { audit } = require('../lib/audit');
const { validate, id } = require('../lib/validate');
const { decrypt } = require('../lib/crypto');
const { notFound, bad, conflict } = require('../lib/util');

const r = express.Router();
const P = (a = 'view') => [auth.authenticate, auth.can('patients', a)];

const SCHEMA = {
  first_name: 'required|max:60', last_name: 'max:60', dob: 'date|past', gender: { required: true, enum: ['Male', 'Female', 'Other'] },
  mobile: 'required|mobile', alt_mobile: 'mobile', email: 'email|max:120', address: 'max:300', city: 'max:60', state: 'max:60', pincode: { max: 6, pattern: '^\\d{6}$' },
  blood_group: { enum: ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-', 'Unknown'] },
  emergency_name: 'max:100', emergency_relation: 'max:40', emergency_phone: 'mobile',
  occupation: 'max:60', marital_status: { enum: ['Single', 'Married', 'Divorced', 'Widowed', 'Other'] },
  guardian_name: 'max:100', guardian_relation: 'max:40', guardian_phone: 'mobile',
  allergies: 'max:300', chronic_conditions: 'max:300', photo: 'max:600000',
  insurance_provider: 'max:80', insurance_policy_no: 'max:40', insurance_valid_till: 'date',
  id_type: { enum: ['aadhaar', 'pan', 'passport', 'voter', 'driving', 'abha', 'other'] }, id_number: 'max:30',
};

// Powerful patient search: UHID, name, mobile, DOB, ID number (blind index), doctor, visit/appointment date.
function search(hid, q = {}) {
  const where = ['p.hospital_id = ?']; const params = [hid];
  const term = String(q.q || '').trim();
  if (term) {
    const or = []; const digits = term.replace(/\D/g, '');
    or.push('p.full_name LIKE ?'); params.push(`%${term}%`);
    or.push('p.uhid LIKE ?'); params.push(`%${term.replace(/^#/, '')}%`);
    if (digits.length >= 3) { or.push('p.mobile LIKE ?'); params.push(`%${digits}%`); or.push('p.alt_mobile LIKE ?'); params.push(`%${digits}%`); }
    if (digits && digits.length <= 6) { or.push('p.uhid_seq = ?'); params.push(Number(digits)); }
    let dob = null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(term)) dob = term;
    const m = term.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/); if (m) dob = `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    if (dob) { or.push('p.dob = ?'); params.push(dob); }
    if (digits.length >= 8 || /^[A-Z]{3,5}\d{4}[A-Z]$/i.test(term)) {
      const ids = patients.findByIdentifier(hid, term);
      if (ids.length) or.push(`p.id IN (${ids.join(',')})`);
    }
    where.push(`(${or.join(' OR ')})`);
  }
  if (q.doctor_id) { where.push('p.id IN (SELECT patient_id FROM opd_visits WHERE doctor_id = ?)'); params.push(Number(q.doctor_id)); }
  if (q.visit_date) { where.push('p.id IN (SELECT patient_id FROM opd_visits WHERE visit_date = ? AND hospital_id = p.hospital_id)'); params.push(q.visit_date); }
  if (q.appointment_date) { where.push('p.id IN (SELECT patient_id FROM appointments WHERE substr(scheduled_at,1,10) = ? AND hospital_id = p.hospital_id)'); params.push(q.appointment_date); }
  if (q.gender) { where.push('p.gender = ?'); params.push(q.gender); }
  const limit = Math.min(Number(q.limit) || 50, 200); const offset = Math.max(Number(q.offset) || 0, 0);
  const total = db.get(`SELECT COUNT(*) c FROM patients p WHERE ${where.join(' AND ')}`, ...params).c;
  const rows = db.all(`SELECT p.id, p.uhid, p.full_name, p.gender, p.dob, p.mobile, p.city, p.blood_group, p.photo IS NOT NULL has_photo, p.created_at,
      (SELECT MAX(visit_date) FROM opd_visits v WHERE v.patient_id = p.id) last_visit,
      (SELECT d.name FROM opd_visits v JOIN doctors d ON d.id = v.doctor_id WHERE v.patient_id = p.id ORDER BY v.id DESC LIMIT 1) last_doctor,
      (SELECT COUNT(*) FROM opd_visits v WHERE v.patient_id = p.id) visits,
      (SELECT ipd_no FROM ipd_admissions a WHERE a.patient_id = p.id AND a.status = 'admitted') ipd_no
    FROM patients p WHERE ${where.join(' AND ')} ORDER BY ${term ? 'CASE WHEN p.uhid = ? OR p.mobile = ? THEN 0 ELSE 1 END,' : ''} p.id DESC LIMIT ? OFFSET ?`,
  ...params, ...(term ? [term, term.replace(/\D/g, '')] : []), limit, offset);
  return { total, rows: rows.map(patients.decorate) };
}

r.get('/patients', auth.authenticate, auth.canAny(['patients', 'view'], ['reception', 'view'], ['opd', 'view'], ['billing', 'view'], ['pharmacy', 'view']), (req, res) => res.json(search(req.ctx.hid, req.query)));

// Duplicate check used during registration ("patient doesn't exist?").
r.get('/patients/check-duplicate', ...P(), (req, res) => {
  const { mobile, first_name, dob } = req.query;
  const rows = db.all('SELECT id, uhid, full_name, dob, mobile, gender FROM patients WHERE hospital_id = ? AND (mobile = ? OR (lower(first_name) = lower(?) AND dob = ?)) LIMIT 5', req.ctx.hid, mobile || '', first_name || '', dob || '');
  res.json(rows.map(patients.decorate));
});

r.post('/patients', ...P('add'), (req, res) => {
  const b = validate(req.body, SCHEMA);
  if ((b.id_type && !b.id_number) || (!b.id_type && b.id_number)) throw bad('Provide both ID type and ID number');
  if (b.id_type === 'aadhaar' && b.id_number && !/^\d{12}$/.test(b.id_number.replace(/\s/g, ''))) throw bad('Aadhaar number must be 12 digits');
  const out = db.tx(() => {
    const p = patients.create(req.ctx.hid, b, req.ctx.user.id);
    if (req.body.portal_password) {
      if (String(req.body.portal_password).length < 6) throw bad('Portal password must be at least 6 characters');
      patients.enablePortal(req.ctx.hid, p.id, String(req.body.portal_password));
    }
    audit(req, 'patient.created', { entity: 'patient', id: p.id, ref: p.uhid });
    return p;
  });
  res.status(201).json(out);
});

r.get('/patients/:id', auth.authenticate, auth.canAny(['patients', 'view'], ['opd', 'view'], ['doctor', 'view'], ['ipd', 'view'], ['billing', 'view'], ['pharmacy', 'view'], ['laboratory', 'view']), (req, res) => {
  const pid = id(req.params.id);
  const p = patients.decorate(db.get('SELECT p.*, u.full_name registered_by FROM patients p LEFT JOIN users u ON u.id = p.created_by WHERE p.id = ? AND p.hospital_id = ?', pid, req.ctx.hid));
  if (!p) throw notFound('Patient');
  const canSeeIds = req.ctx.can('patients', 'edit');
  p.identifiers = db.all('SELECT id, id_type, last4, value_enc FROM patient_identifiers WHERE patient_id = ?', pid).map((i) => ({ id: i.id, id_type: i.id_type, masked: `XXXX-XXXX-${i.last4}`, value: canSeeIds ? decrypt(i.value_enc) : undefined }));
  p.portal = !!db.get('SELECT id FROM patient_accounts WHERE patient_id = ? AND is_active = 1', pid);
  p.active_admission = db.get("SELECT a.id, a.ipd_no, a.admitted_at, w.name ward, b.bed_no FROM ipd_admissions a LEFT JOIN beds b ON b.id = a.bed_id LEFT JOIN wards w ON w.id = b.ward_id WHERE a.patient_id = ? AND a.status = 'admitted'", pid);
  p.balance = db.get("SELECT COALESCE(SUM(balance),0) b FROM invoices WHERE patient_id = ? AND status NOT IN ('cancelled')", pid).b;
  p.stats = db.get(`SELECT (SELECT COUNT(*) FROM opd_visits WHERE patient_id = ?) visits, (SELECT COUNT(*) FROM ipd_admissions WHERE patient_id = ?) admissions, (SELECT COUNT(*) FROM lab_orders WHERE patient_id = ?) labs, (SELECT COALESCE(SUM(total),0) FROM invoices WHERE patient_id = ? AND status != 'cancelled') billed`, pid, pid, pid, pid);
  audit(req, 'patient.viewed', { entity: 'patient', id: pid, ref: p.uhid });
  res.json(p);
});

// Unified medical timeline across every department.
r.get('/patients/:id/timeline', auth.authenticate, auth.canAny(['patients', 'view'], ['doctor', 'view'], ['ipd', 'view']), (req, res) => {
  const pid = id(req.params.id);
  const p = db.get('SELECT id, created_at, uhid FROM patients WHERE id = ? AND hospital_id = ?', pid, req.ctx.hid);
  if (!p) throw notFound('Patient');
  const ev = [];
  ev.push({ type: 'registration', at: p.created_at, title: 'Patient registered', subtitle: `UHID ${p.uhid} issued` });
  for (const a of db.all('SELECT a.*, d.name doctor FROM appointments a JOIN doctors d ON d.id = a.doctor_id WHERE a.patient_id = ?', pid)) ev.push({ type: 'appointment', at: a.created_at, title: `Appointment ${a.status.replace('_', ' ')}`, subtitle: `${a.doctor} · ${a.scheduled_at.slice(0, 16)}`, ref: a.appt_no, status: a.status });
  for (const v of db.all(`SELECT v.*, d.name doctor, dp.name department, tk.token FROM opd_visits v JOIN doctors d ON d.id = v.doctor_id LEFT JOIN departments dp ON dp.id = v.department_id LEFT JOIN opd_tokens tk ON tk.visit_id = v.id WHERE v.patient_id = ?`, pid)) {
    const dx = db.all('SELECT dc.name, dc.code FROM visit_diagnoses vd JOIN diagnosis_codes dc ON dc.id = vd.diagnosis_id WHERE vd.visit_id = ?', v.id);
    ev.push({ type: 'opd', at: v.registered_at, title: `OPD consultation · ${v.doctor}`, subtitle: `${v.department || ''} · Token ${v.token || '—'}${v.chief_complaint ? ' · ' + v.chief_complaint : ''}`, ref: v.visit_no, status: v.status, id: v.id,
      detail: { diagnoses: dx, vitals: v.vitals ? JSON.parse(v.vitals) : null, notes: v.clinical_notes, advice: v.advice, follow_up: v.follow_up_date } });
  }
  for (const rx of db.all("SELECT r.*, d.name doctor FROM prescriptions r JOIN doctors d ON d.id = r.doctor_id WHERE r.patient_id = ? AND r.status = 'finalized'", pid)) {
    const items = db.all('SELECT m.name, m.strength, pi.dose, pi.frequency, pi.duration_days, pi.route, pi.instructions FROM prescription_items pi JOIN medicines m ON m.id = pi.medicine_id WHERE pi.prescription_id = ?', rx.id);
    ev.push({ type: 'prescription', at: rx.finalized_at, title: `Prescription ${rx.rx_no}`, subtitle: `${rx.doctor} · ${items.length} medicine(s)`, ref: rx.rx_no, id: rx.id, detail: { items } });
  }
  for (const o of db.all('SELECT o.*, t.token FROM pharmacy_orders o LEFT JOIN pharmacy_tokens t ON t.order_id = o.id WHERE o.patient_id = ?', pid)) ev.push({ type: 'pharmacy', at: o.dispensed_at || o.created_at, title: `Pharmacy ${o.status}`, subtitle: `${o.order_no} · Token ${o.token}`, ref: o.order_no, status: o.status });
  for (const l of db.all('SELECT lo.*, lt.name test FROM lab_orders lo JOIN lab_tests lt ON lt.id = lo.test_id WHERE lo.patient_id = ?', pid)) {
    const results = ['completed', 'verified'].includes(l.status) ? db.all('SELECT parameter, value, unit, ref_range, flag FROM lab_results WHERE lab_order_id = ?', l.id) : [];
    ev.push({ type: 'lab', at: l.verified_at || l.completed_at || l.created_at, title: `Lab · ${l.test}`, subtitle: `${l.order_no} · ${l.status.replace('_', ' ')}`, ref: l.order_no, status: l.status, id: l.id, detail: { results } });
  }
  for (const x of db.all('SELECT ro.*, rr.findings, rr.impression FROM radiology_orders ro LEFT JOIN radiology_reports rr ON rr.order_id = ro.id WHERE ro.patient_id = ?', pid)) ev.push({ type: 'radiology', at: x.created_at, title: `${x.modality} · ${x.study}`, subtitle: `${x.order_no} · ${x.status}`, ref: x.order_no, status: x.status, id: x.id, detail: { impression: x.impression } });
  for (const a of db.all('SELECT a.*, d.name doctor FROM ipd_admissions a JOIN doctors d ON d.id = a.doctor_id WHERE a.patient_id = ?', pid)) {
    ev.push({ type: 'ipd', at: a.admitted_at, title: `Admitted · ${a.ipd_no}`, subtitle: `${a.doctor}${a.reason ? ' · ' + a.reason : ''}`, ref: a.ipd_no, id: a.id, status: a.status });
    if (a.discharged_at) ev.push({ type: 'discharge', at: a.discharged_at, title: `Discharged · ${a.ipd_no}`, subtitle: a.final_diagnosis || '', ref: a.ipd_no, id: a.id, detail: { summary: a.discharge_summary, advice: a.discharge_advice } });
  }
  for (const i of db.all('SELECT * FROM invoices WHERE patient_id = ?', pid)) ev.push({ type: 'invoice', at: i.created_at, title: `Invoice ${i.invoice_no}`, subtitle: `${i.bill_type.toUpperCase()} · ₹${i.total.toLocaleString('en-IN')} · ${i.status}`, ref: i.invoice_no, id: i.id, status: i.status });
  for (const py of db.all('SELECT * FROM payments WHERE patient_id = ?', pid)) ev.push({ type: py.kind === 'refund' ? 'refund' : 'payment', at: py.created_at, title: `${py.kind === 'refund' ? 'Refund' : 'Payment'} ₹${py.amount.toLocaleString('en-IN')}`, subtitle: `${py.receipt_no} · ${py.method.replace('_', ' ')}`, ref: py.receipt_no });
  for (const f of db.all("SELECT v.follow_up_date, d.name doctor FROM opd_visits v JOIN doctors d ON d.id = v.doctor_id WHERE v.patient_id = ? AND v.follow_up_date IS NOT NULL", pid)) ev.push({ type: 'followup', at: `${f.follow_up_date} 09:00:00`, title: 'Follow-up due', subtitle: f.doctor, future: f.follow_up_date >= new Date().toISOString().slice(0, 10) });
  ev.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  res.json(ev);
});

r.put('/patients/:id', ...P('edit'), (req, res) => {
  const pid = id(req.params.id);
  const b = validate(req.body, SCHEMA, { partial: true });
  db.tx(() => patients.update(req.ctx.hid, pid, b));
  const p = db.get('SELECT uhid FROM patients WHERE id = ?', pid);
  audit(req, 'patient.updated', { entity: 'patient', id: pid, ref: p.uhid, details: Object.keys(b).filter((k) => k !== 'photo') });
  res.json({ ok: true });
});

r.post('/patients/:id/portal', auth.authenticate, auth.canAny(['portal', 'edit'], ['patients', 'edit']), (req, res) => {
  const pid = id(req.params.id);
  const p = db.get('SELECT uhid FROM patients WHERE id = ? AND hospital_id = ?', pid, req.ctx.hid);
  if (!p) throw notFound('Patient');
  const b = validate(req.body, { password: 'required|min:6|max:100' });
  patients.enablePortal(req.ctx.hid, pid, b.password);
  audit(req, 'patient.portal_enabled', { entity: 'patient', id: pid, ref: p.uhid });
  res.json({ ok: true });
});

r.get('/patients/:id/summary', auth.authenticate, auth.canAny(['doctor', 'view'], ['patients', 'view']), (req, res) => {
  const s = assistant.patientSummary(req.ctx.hid, id(req.params.id));
  if (!s) throw notFound('Patient');
  res.json(s);
});

module.exports = r;
module.exports.search = search;
