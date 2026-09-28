'use strict';
const db = require('../db');
const seq = require('../lib/sequence');
const billing = require('./billing');
const { notify } = require('../lib/notify');
const { now, today, bad, notFound, conflict } = require('../lib/util');

/**
 * Register an OPD visit. Automations: token generation (per doctor, per day),
 * placement in the doctor's queue, consultation invoice, appointment status sync,
 * and patient notification ("Your OPD token is A008").
 */
function registerVisit(hid, { patient_id, doctor_id, appointment_id, visit_type = 'new', chief_complaint, charge_fee = true }, userId, at) {
  const patient = db.get('SELECT * FROM patients WHERE id = ? AND hospital_id = ?', patient_id, hid);
  if (!patient) throw notFound('Patient');
  const doctor = db.get('SELECT * FROM doctors WHERE id = ? AND hospital_id = ? AND is_active = 1', doctor_id, hid);
  if (!doctor) throw notFound('Doctor');
  const t = at || now(); const date = t.slice(0, 10);
  const dup = db.get("SELECT v.id, tk.token FROM opd_visits v JOIN opd_tokens tk ON tk.visit_id = v.id WHERE v.hospital_id = ? AND v.patient_id = ? AND v.doctor_id = ? AND v.visit_date = ? AND v.status IN ('waiting','in_consultation')", hid, patient_id, doctor_id, date);
  if (dup) throw conflict(`Patient is already in Dr. ${doctor.name.replace(/^Dr\.?\s*/, '')}'s queue with token ${dup.token}`);
  const prior = db.get('SELECT COUNT(*) c FROM opd_visits WHERE hospital_id = ? AND patient_id = ? AND status != ?', hid, patient_id, 'cancelled').c;
  if (appointment_id) {
    const a = db.get('SELECT * FROM appointments WHERE id = ? AND hospital_id = ?', appointment_id, hid);
    if (!a) throw notFound('Appointment');
    if (a.patient_id !== patient_id) throw bad('Appointment belongs to a different patient');
    if (a.visit_id) throw conflict('Appointment already checked in');
  }
  const { value: visitNo } = seq.formatted(hid, 'visit');
  const visitId = db.insertRow('opd_visits', {
    hospital_id: hid, visit_no: visitNo, patient_id, doctor_id, department_id: doctor.department_id, appointment_id,
    visit_type, is_new_patient: prior === 0 ? 1 : 0, priority: visit_type === 'emergency' ? 10 : 0, status: 'waiting',
    visit_date: date, registered_at: t, chief_complaint, created_by: userId,
  });
  const tok = seq.opdToken(hid, doctor, date);
  db.insertRow('opd_tokens', { hospital_id: hid, visit_id: visitId, doctor_id, token_date: date, token_seq: tok.seq, token: tok.token });
  if (appointment_id) db.run("UPDATE appointments SET status = 'waiting', visit_id = ? WHERE id = ?", visitId, appointment_id);

  let invoiceId = null;
  const fee = visit_type === 'followup' && doctor.followup_fee ? doctor.followup_fee : doctor.consultation_fee;
  if (charge_fee && fee > 0) {
    invoiceId = billing.createInvoice(hid, { patient_id, bill_type: 'opd', visit_id: visitId, doctor_id, department_id: doctor.department_id, created_at: t, userId,
      items: [{ category: 'consultation', description: `${visit_type === 'followup' ? 'Follow-up' : visit_type === 'emergency' ? 'Emergency' : 'OPD'} consultation — ${doctor.name}`, quantity: 1, unit_price: fee, ref_type: 'opd_visit', ref_id: visitId }] });
  }
  if (!at) {
    const ahead = db.get("SELECT COUNT(*) c FROM opd_visits WHERE hospital_id = ? AND doctor_id = ? AND visit_date = ? AND status = 'waiting' AND id < ?", hid, doctor_id, date, visitId).c;
    notify({ hid, patientId: patient_id, category: 'opd', severity: 'info', title: `Your OPD token is ${tok.token}`, body: `${doctor.name}${doctor.room ? ', ' + doctor.room : ''}. ${ahead} patient(s) ahead of you.`, link: '/portal' });
    if (doctor.user_id) notify({ hid, userId: doctor.user_id, category: 'opd', title: `${patient.full_name} added to your queue`, body: `Token ${tok.token} · ${patient.uhid}${visit_type === 'emergency' ? ' · EMERGENCY' : ''}`, severity: visit_type === 'emergency' ? 'critical' : 'info', link: `/opd/consult/${visitId}` });
  }
  return { id: visitId, visit_no: visitNo, token: tok.token, invoice_id: invoiceId };
}

function queue(hid, doctorId, date = today()) {
  const rows = db.all(`SELECT v.id, v.status, v.visit_type, v.priority, v.registered_at, v.called_at, v.completed_at, v.chief_complaint, tk.token, tk.token_seq,
      p.id patient_id, p.full_name, p.uhid, p.gender, p.dob, p.mobile
    FROM opd_visits v JOIN opd_tokens tk ON tk.visit_id = v.id JOIN patients p ON p.id = v.patient_id
    WHERE v.hospital_id = ? AND v.doctor_id = ? AND v.visit_date = ? ORDER BY v.priority DESC, tk.token_seq`, hid, doctorId, date);
  const serving = rows.filter((r) => r.status === 'in_consultation').sort((a, b) => (b.called_at || '').localeCompare(a.called_at || ''))[0] || null;
  const waiting = rows.filter((r) => r.status === 'waiting');
  const completed = rows.filter((r) => r.status === 'completed');
  const doc = db.get('SELECT avg_consult_minutes FROM doctors WHERE id = ?', doctorId);
  const recent = db.get("SELECT AVG((julianday(called_at) - julianday(registered_at)) * 1440) w FROM opd_visits WHERE hospital_id = ? AND doctor_id = ? AND visit_date = ? AND called_at IS NOT NULL", hid, doctorId, date);
  return { serving, waiting, completed, all: rows, avg_wait_min: recent.w ? Math.round(recent.w) : null, est_per_patient: doc ? doc.avg_consult_minutes : 10 };
}

// Doctor presses "Call next": current patient (if any) stays in consultation until completed.
function callNext(hid, doctorId, visitId) {
  const q = queue(hid, doctorId);
  const next = visitId ? q.waiting.find((w) => w.id === visitId) : q.waiting[0];
  if (!next) throw conflict('No patients waiting');
  const t = now();
  db.run("UPDATE opd_visits SET status = 'in_consultation', called_at = ? WHERE id = ?", t, next.id);
  db.run("UPDATE appointments SET status = 'in_consultation' WHERE visit_id = ?", next.id);
  notify({ hid, patientId: next.patient_id, category: 'opd', severity: 'success', title: `Token ${next.token} — please proceed to the consultation room`, body: 'The doctor is ready to see you now.', link: '/portal', channels: ['push', 'sms'] });
  // Heads-up to the patient who is next in line.
  const after = q.waiting.filter((w) => w.id !== next.id)[0];
  if (after) notify({ hid, patientId: after.patient_id, category: 'opd', title: `You are next — token ${after.token}`, body: 'Please be near the consultation room.', link: '/portal', dedupe: `next:${after.id}`, channels: ['push'] });
  return next;
}

function setStatus(hid, visitId, status) {
  const v = db.get('SELECT * FROM opd_visits WHERE id = ? AND hospital_id = ?', visitId, hid);
  if (!v) throw notFound('Visit');
  const t = now();
  const patch = { status };
  if (status === 'in_consultation' && !v.called_at) patch.called_at = t;
  if (status === 'completed') patch.completed_at = t;
  db.updateRow('opd_visits', visitId, patch);
  const apptStatus = { completed: 'completed', cancelled: 'cancelled', no_show: 'no_show', in_consultation: 'in_consultation', waiting: 'waiting' }[status];
  if (apptStatus) db.run('UPDATE appointments SET status = ? WHERE visit_id = ?', apptStatus, visitId);
  if (status === 'cancelled') db.run("UPDATE invoices SET status = 'cancelled' WHERE visit_id = ? AND bill_type = 'opd' AND paid = 0", visitId);
}

module.exports = { registerVisit, queue, callNext, setStatus };
