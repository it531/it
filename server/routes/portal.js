'use strict';
// Patient mobile portal. Patients can only ever see their own records.
const express = require('express');
const db = require('../db');
const auth = require('../lib/auth');
const opd = require('../services/opd');
const { verifyPassword, hashPassword } = require('../lib/crypto');
const { validate, id } = require('../lib/validate');
const { now, today, ageFrom, HttpError, bad, notFound } = require('../lib/util');
const { bookAppointment, slots } = require('./opd');

const r = express.Router();
const P = auth.authenticatePatient;

r.post('/portal/login', (req, res) => {
  auth.throttle(req.ip);
  const b = validate(req.body, { hospital_code: 'required|max:40', login: 'required|max:40', password: 'required|max:200' });
  const h = db.get('SELECT * FROM hospitals WHERE code = ? AND is_active = 1', b.hospital_code);
  if (!h) throw bad('Unknown hospital');
  const login = b.login.trim();
  const digits = login.replace(/\D/g, '');
  // UHID (#000001 / 000001 / 1) or registered mobile.
  const candidates = db.all(`SELECT p.id, a.id account_id, a.password_hash FROM patients p JOIN patient_accounts a ON a.patient_id = p.id AND a.is_active = 1
    WHERE p.hospital_id = ? AND (p.uhid = ? OR p.uhid_seq = ? OR p.mobile = ?)`, h.id, login, Number(digits) || -1, digits);
  const match = candidates.find((c) => verifyPassword(b.password, c.password_hash));
  if (!match) throw new HttpError(401, 'Invalid UHID / mobile or password');
  if (!auth.enabledModules(h.id).has('portal')) throw new HttpError(403, 'Patient portal is not enabled for this hospital');
  db.run('UPDATE patient_accounts SET last_login_at = ? WHERE id = ?', now(), match.account_id);
  res.json({ token: auth.createSession({ kind: 'patient', patientAccountId: match.account_id, hospitalId: h.id, ip: req.ip, ua: req.headers['user-agent'] }) });
});
r.post('/portal/logout', P, (req, res) => { auth.revoke(auth.bearer(req)); res.json({ ok: true }); });

r.post('/portal/change-password', P, (req, res) => {
  const b = validate(req.body, { current_password: 'required', new_password: 'required|min:6|max:200' });
  const a = db.get('SELECT * FROM patient_accounts WHERE id = ?', req.portal.accountId);
  if (!verifyPassword(b.current_password, a.password_hash)) throw bad('Current password is incorrect');
  db.run('UPDATE patient_accounts SET password_hash = ? WHERE id = ?', hashPassword(b.new_password), a.id);
  res.json({ ok: true });
});

// One call returns the live portal state (polled for token/pharmacy updates).
r.get('/portal/me', P, (req, res) => {
  const { hid, patientId: pid } = req.portal; const t = today();
  const p = db.get('SELECT id, uhid, full_name, first_name, gender, dob, mobile, email, blood_group, address, city, allergies, photo FROM patients WHERE id = ?', pid);
  p.age = ageFrom(p.dob);
  const hospital = db.get('SELECT name, code, city, phone, address, logo FROM hospitals WHERE id = ?', hid);
  // Live OPD token(s) today with position in queue.
  const visits = db.all(`SELECT v.id, v.status, v.doctor_id, v.registered_at, tk.token, d.name doctor_name, d.room, dp.name department FROM opd_visits v JOIN opd_tokens tk ON tk.visit_id = v.id JOIN doctors d ON d.id = v.doctor_id LEFT JOIN departments dp ON dp.id = v.department_id
    WHERE v.patient_id = ? AND v.visit_date = ? ORDER BY v.id DESC`, pid, t).map((v) => {
    const q = opd.queue(hid, v.doctor_id, t);
    const pos = q.waiting.findIndex((w) => w.id === v.id);
    return { ...v, now_serving: q.serving ? q.serving.token : null, ahead: pos >= 0 ? pos : 0, est_wait_min: pos >= 0 ? pos * q.est_per_patient : 0 };
  });
  const pharmacy = db.all(`SELECT o.id, o.order_no, o.status, o.created_at, o.ready_at, o.dispensed_at, tk.token,
      (SELECT t2.token FROM pharmacy_orders o2 JOIN pharmacy_tokens t2 ON t2.order_id = o2.id WHERE o2.hospital_id = o.hospital_id AND o2.status = 'processing' ORDER BY o2.called_at DESC LIMIT 1) now_serving,
      (SELECT COUNT(*) FROM pharmacy_orders o3 JOIN pharmacy_tokens t3 ON t3.order_id = o3.id WHERE o3.hospital_id = o.hospital_id AND o3.status = 'waiting' AND t3.token_date = tk.token_date AND t3.token_seq < tk.token_seq) ahead
    FROM pharmacy_orders o JOIN pharmacy_tokens tk ON tk.order_id = o.id WHERE o.patient_id = ? ORDER BY o.id DESC LIMIT 10`, pid);
  const appointments = db.all(`SELECT a.id, a.appt_no, a.scheduled_at, a.status, a.reason, d.name doctor_name, dp.name department FROM appointments a JOIN doctors d ON d.id = a.doctor_id LEFT JOIN departments dp ON dp.id = a.department_id WHERE a.patient_id = ? ORDER BY a.scheduled_at DESC LIMIT 20`, pid);
  const prescriptions = db.all(`SELECT r.id, r.rx_no, r.finalized_at, d.name doctor_name, v.advice, v.follow_up_date FROM prescriptions r JOIN doctors d ON d.id = r.doctor_id LEFT JOIN opd_visits v ON v.id = r.visit_id WHERE r.patient_id = ? AND r.status = 'finalized' ORDER BY r.finalized_at DESC LIMIT 20`, pid)
    .map((x) => ({ ...x, items: db.all('SELECT m.name, m.strength, m.dosage_form, pi.dose, pi.frequency, pi.duration_days, pi.route, pi.instructions FROM prescription_items pi JOIN medicines m ON m.id = pi.medicine_id WHERE pi.prescription_id = ?', x.id), diagnoses: db.all("SELECT dc.name FROM visit_diagnoses vd JOIN diagnosis_codes dc ON dc.id = vd.diagnosis_id JOIN prescriptions r2 ON r2.visit_id = vd.visit_id WHERE r2.id = ?", x.id).map((d) => d.name) }));
  // Only verified reports are released to patients.
  const labs = db.all(`SELECT lo.id, lo.order_no, lo.status, lo.created_at, lo.verified_at, lt.name test FROM lab_orders lo JOIN lab_tests lt ON lt.id = lo.test_id WHERE lo.patient_id = ? AND lo.status != 'cancelled' ORDER BY lo.created_at DESC LIMIT 30`, pid)
    .map((l) => ({ ...l, results: l.status === 'verified' ? db.all('SELECT parameter, value, unit, ref_range, flag FROM lab_results WHERE lab_order_id = ?', l.id) : [] }));
  const radiology = db.all(`SELECT ro.id, ro.order_no, ro.modality, ro.study, ro.status, ro.created_at, CASE WHEN ro.status = 'verified' THEN rr.findings END findings, CASE WHEN ro.status = 'verified' THEN rr.impression END impression FROM radiology_orders ro LEFT JOIN radiology_reports rr ON rr.order_id = ro.id WHERE ro.patient_id = ? ORDER BY ro.created_at DESC LIMIT 20`, pid);
  const bills = db.all('SELECT id, invoice_no, bill_type, total, paid, balance, status, created_at FROM invoices WHERE patient_id = ? AND status != \'cancelled\' ORDER BY id DESC LIMIT 30', pid);
  const ipd = db.all(`SELECT a.id, a.ipd_no, a.status, a.admitted_at, a.discharged_at, a.final_diagnosis, a.discharge_summary, a.discharge_advice, a.follow_up_date, d.name doctor_name, w.name ward, b.bed_no FROM ipd_admissions a JOIN doctors d ON d.id = a.doctor_id LEFT JOIN beds b ON b.id = a.bed_id LEFT JOIN wards w ON w.id = b.ward_id WHERE a.patient_id = ? ORDER BY a.admitted_at DESC`, pid);
  const followups = db.all("SELECT v.follow_up_date, d.name doctor_name, d.id doctor_id FROM opd_visits v JOIN doctors d ON d.id = v.doctor_id WHERE v.patient_id = ? AND v.follow_up_date >= ? ORDER BY v.follow_up_date", pid, t);
  const notifications = db.all('SELECT id, category, severity, title, body, link, read_at, created_at FROM notifications WHERE patient_id = ? ORDER BY id DESC LIMIT 40', pid);
  res.json({ patient: p, hospital, visits, pharmacy, appointments, prescriptions, labs, radiology, bills, ipd, followups, notifications, unread: notifications.filter((n) => !n.read_at).length, server_time: now() });
});

r.post('/portal/notifications/read', P, (req, res) => {
  db.run('UPDATE notifications SET read_at = ? WHERE patient_id = ? AND read_at IS NULL', now(), req.portal.patientId);
  res.json({ ok: true });
});
r.get('/portal/doctors', P, (req, res) => {
  res.json(db.all('SELECT d.id, d.name, d.specialization, d.qualification, d.consultation_fee, dp.name department FROM doctors d LEFT JOIN departments dp ON dp.id = d.department_id WHERE d.hospital_id = ? AND d.is_active = 1 ORDER BY dp.name, d.name', req.portal.hid));
});
r.get('/portal/slots', P, (req, res) => res.json(slots(req.portal.hid, id(req.query.doctor_id), req.query.date || today())));
r.post('/portal/appointments', P, (req, res) => {
  if (!auth.enabledModules(req.portal.hid).has('appointments')) throw bad('Online appointments are not available');
  const b = validate(req.body, { doctor_id: 'required|int', scheduled_at: 'required|datetime', reason: 'max:200' });
  const out = db.tx(() => bookAppointment(req.portal.hid, { ...b, patient_id: req.portal.patientId }, null, 'portal'));
  db.insertRow('audit_logs', { hospital_id: req.portal.hid, username: `patient:${req.portal.patientId}`, action: 'appointment.created', entity: 'appointment', entity_id: out.id, ref: out.appt_no, ip: req.ip, created_at: now() });
  res.status(201).json(out);
});
r.post('/portal/appointments/:id/cancel', P, (req, res) => {
  const a = db.get("SELECT * FROM appointments WHERE id = ? AND patient_id = ? AND status IN ('booked','confirmed')", id(req.params.id), req.portal.patientId);
  if (!a) throw notFound('Appointment');
  db.run("UPDATE appointments SET status = 'cancelled' WHERE id = ?", a.id);
  res.json({ ok: true });
});
// Printable documents (own records only).
r.get('/portal/prescriptions/:id', P, (req, res) => {
  const x = db.get(`SELECT r.*, p.full_name patient_name, p.uhid, p.gender, p.dob, p.mobile, p.allergies, d.name doctor_name, d.qualification, d.registration_no, dp.name department, v.chief_complaint, v.vitals, v.advice, v.follow_up_date
    FROM prescriptions r JOIN patients p ON p.id = r.patient_id JOIN doctors d ON d.id = r.doctor_id LEFT JOIN departments dp ON dp.id = d.department_id LEFT JOIN opd_visits v ON v.id = r.visit_id
    WHERE r.id = ? AND r.patient_id = ? AND r.status = 'finalized'`, id(req.params.id), req.portal.patientId);
  if (!x) throw notFound('Prescription');
  x.items = require('../services/prescriptions').items(x.id);
  x.vitals = x.vitals ? JSON.parse(x.vitals) : null; x.age = ageFrom(x.dob);
  x.diagnoses = x.visit_id ? db.all('SELECT dc.name, dc.code FROM visit_diagnoses vd JOIN diagnosis_codes dc ON dc.id = vd.diagnosis_id WHERE vd.visit_id = ?', x.visit_id) : [];
  res.json(x);
});
r.get('/portal/invoices/:id', P, (req, res) => {
  const inv = db.get('SELECT id FROM invoices WHERE id = ? AND patient_id = ?', id(req.params.id), req.portal.patientId);
  if (!inv) throw notFound('Invoice');
  res.json(require('../services/billing').invoiceDetail(req.portal.hid, inv.id));
});

module.exports = r;
