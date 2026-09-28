'use strict';
// Appointments, OPD registration & token queue, doctor consultation (EMR),
// smart diagnosis search, prescription templates, and prescriptions.
const express = require('express');
const db = require('../db');
const auth = require('../lib/auth');
const seq = require('../lib/sequence');
const opd = require('../services/opd');
const rx = require('../services/prescriptions');
const clinical = require('../services/clinical');
const assistant = require('../services/assistant');
const { notify } = require('../lib/notify');
const { audit } = require('../lib/audit');
const { validate, id } = require('../lib/validate');
const { now, today, notFound, bad, conflict, forbidden } = require('../lib/util');

const r = express.Router();
const A = auth.authenticate;

// ───────── Appointments
const APPT_STATUSES = ['booked', 'confirmed', 'arrived', 'waiting', 'in_consultation', 'completed', 'cancelled', 'no_show'];
r.get('/appointments', A, auth.can('appointments'), (req, res) => {
  const from = req.query.from || today(); const to = req.query.to || from;
  const where = ['a.hospital_id = ?', 'substr(a.scheduled_at,1,10) BETWEEN ? AND ?']; const p = [req.ctx.hid, from, to];
  if (req.query.doctor_id) { where.push('a.doctor_id = ?'); p.push(Number(req.query.doctor_id)); }
  if (req.query.status) { where.push('a.status = ?'); p.push(req.query.status); }
  if (req.query.mine && req.ctx.doctorId) { where.push('a.doctor_id = ?'); p.push(req.ctx.doctorId); }
  res.json(db.all(`SELECT a.*, p.full_name patient_name, p.uhid, p.mobile, p.gender, p.dob, d.name doctor_name, dp.name department, tk.token
    FROM appointments a JOIN patients p ON p.id = a.patient_id JOIN doctors d ON d.id = a.doctor_id LEFT JOIN departments dp ON dp.id = a.department_id LEFT JOIN opd_tokens tk ON tk.visit_id = a.visit_id
    WHERE ${where.join(' AND ')} ORDER BY a.scheduled_at`, ...p));
});

function bookAppointment(hid, b, userId, source) {
  const patient = db.get('SELECT id, full_name FROM patients WHERE id = ? AND hospital_id = ?', b.patient_id, hid);
  if (!patient) throw notFound('Patient');
  const doctor = db.get('SELECT * FROM doctors WHERE id = ? AND hospital_id = ? AND is_active = 1', b.doctor_id, hid);
  if (!doctor) throw notFound('Doctor');
  if (b.scheduled_at < now().slice(0, 16)) throw bad('Appointment time cannot be in the past');
  const clash = db.get("SELECT id FROM appointments WHERE hospital_id = ? AND doctor_id = ? AND scheduled_at = ? AND status NOT IN ('cancelled','no_show')", hid, b.doctor_id, b.scheduled_at);
  if (clash) throw conflict('This slot is already booked for the doctor. Choose another time.');
  const dupe = db.get("SELECT appt_no FROM appointments WHERE hospital_id = ? AND patient_id = ? AND doctor_id = ? AND substr(scheduled_at,1,10) = ? AND status NOT IN ('cancelled','no_show','completed')", hid, b.patient_id, b.doctor_id, b.scheduled_at.slice(0, 10));
  if (dupe) throw conflict(`Patient already has appointment ${dupe.appt_no} with this doctor on that day`);
  const no = seq.formatted(hid, 'appointment').value;
  const aid = db.insertRow('appointments', { hospital_id: hid, appt_no: no, patient_id: b.patient_id, doctor_id: b.doctor_id, department_id: doctor.department_id, scheduled_at: b.scheduled_at, duration_min: b.duration_min || doctor.avg_consult_minutes || 15, status: source === 'portal' ? 'booked' : 'confirmed', source, reason: b.reason, created_by: userId, created_at: now() });
  const when = new Date(b.scheduled_at.replace(' ', 'T')).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
  notify({ hid, patientId: b.patient_id, category: 'appointment', severity: 'success', title: `Appointment ${source === 'portal' ? 'requested' : 'confirmed'} · ${when}`, body: `${doctor.name}. Appointment no. ${no}.`, link: '/portal/appointments' });
  if (doctor.user_id) notify({ hid, userId: doctor.user_id, category: 'appointment', title: `New appointment · ${when}`, body: `${patient.full_name}${b.reason ? ' — ' + b.reason : ''}`, link: '/appointments' });
  return { id: aid, appt_no: no };
}
const APPT = { patient_id: 'required|int', doctor_id: 'required|int', scheduled_at: 'required|datetime', duration_min: 'int|min:5|max:240', reason: 'max:200' };
r.post('/appointments', A, auth.can('appointments', 'add'), (req, res) => {
  const b = validate(req.body, APPT);
  const out = db.tx(() => bookAppointment(req.ctx.hid, b, req.ctx.user.id, req.ctx.doctorId ? 'doctor' : 'reception'));
  audit(req, 'appointment.created', { entity: 'appointment', id: out.id, ref: out.appt_no });
  res.status(201).json(out);
});
r.put('/appointments/:id', A, auth.can('appointments', 'edit'), (req, res) => {
  const aid = id(req.params.id);
  const a = db.get('SELECT * FROM appointments WHERE id = ? AND hospital_id = ?', aid, req.ctx.hid);
  if (!a) throw notFound('Appointment');
  const b = validate(req.body, { status: { enum: APPT_STATUSES }, scheduled_at: 'datetime', doctor_id: 'int', reason: 'max:200' }, { partial: true });
  if (b.scheduled_at && b.scheduled_at !== a.scheduled_at) {
    const clash = db.get("SELECT id FROM appointments WHERE hospital_id = ? AND doctor_id = ? AND scheduled_at = ? AND id != ? AND status NOT IN ('cancelled','no_show')", req.ctx.hid, b.doctor_id || a.doctor_id, b.scheduled_at, aid);
    if (clash) throw conflict('Slot already booked');
    b.reminder_sent = 0;
  }
  if (b.doctor_id && !db.get('SELECT id FROM doctors WHERE id = ? AND hospital_id = ?', b.doctor_id, req.ctx.hid)) throw bad('Invalid doctor');
  db.updateRow('appointments', aid, b);
  if (b.status === 'cancelled') notify({ hid: req.ctx.hid, patientId: a.patient_id, category: 'appointment', severity: 'warning', title: 'Appointment cancelled', body: `${a.appt_no} on ${a.scheduled_at.slice(0, 16)}`, link: '/portal/appointments' });
  audit(req, 'appointment.updated', { entity: 'appointment', id: aid, ref: a.appt_no, details: b });
  res.json({ ok: true });
});
// Check-in: appointment → OPD visit + token.
r.post('/appointments/:id/check-in', A, auth.canAny(['opd', 'add'], ['reception', 'add']), (req, res) => {
  const aid = id(req.params.id);
  const a = db.get('SELECT * FROM appointments WHERE id = ? AND hospital_id = ?', aid, req.ctx.hid);
  if (!a) throw notFound('Appointment');
  if (['cancelled', 'no_show', 'completed'].includes(a.status)) throw conflict(`Appointment is ${a.status}`);
  const out = db.tx(() => opd.registerVisit(req.ctx.hid, { patient_id: a.patient_id, doctor_id: a.doctor_id, appointment_id: a.id, visit_type: req.body.visit_type || 'new', chief_complaint: a.reason }, req.ctx.user.id));
  audit(req, 'opd.visit_created', { entity: 'opd_visit', id: out.id, ref: out.token, details: { appointment: a.appt_no } });
  res.status(201).json(out);
});
r.get('/appointments/slots', A, auth.can('appointments'), (req, res) => {
  res.json(slots(req.ctx.hid, Number(req.query.doctor_id), req.query.date || today()));
});
function slots(hid, doctorId, date) {
  const d = db.get('SELECT avg_consult_minutes FROM doctors WHERE id = ? AND hospital_id = ?', doctorId, hid);
  if (!d) throw notFound('Doctor');
  const step = Math.max(d.avg_consult_minutes, 10);
  const taken = new Set(db.all("SELECT substr(scheduled_at,12,5) t FROM appointments WHERE hospital_id = ? AND doctor_id = ? AND substr(scheduled_at,1,10) = ? AND status NOT IN ('cancelled','no_show')", hid, doctorId, date).map((x) => x.t));
  const out = []; const nowT = now();
  for (const [s, e] of [[9 * 60, 13 * 60], [16 * 60, 19 * 60]]) {
    for (let m = s; m < e; m += step) {
      const t = `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
      out.push({ time: t, available: !taken.has(t) && `${date} ${t}` > nowT.slice(0, 16) });
    }
  }
  return out;
}

// ───────── OPD
r.get('/opd/dashboard', A, auth.can('opd'), (req, res) => {
  const hid = req.ctx.hid; const t = today();
  const stats = db.get(`SELECT COUNT(*) total, SUM(status='waiting') waiting, SUM(status='in_consultation') in_consultation, SUM(status='completed') completed,
      SUM(appointment_id IS NOT NULL) from_appointments, SUM(appointment_id IS NULL) walk_ins, SUM(visit_type='emergency') emergency, SUM(is_new_patient) new_patients
    FROM opd_visits WHERE hospital_id = ? AND visit_date = ?`, hid, t);
  const doctors = db.all('SELECT d.id, d.name, d.room, d.token_prefix, d.avg_consult_minutes, dp.name department FROM doctors d LEFT JOIN departments dp ON dp.id = d.department_id WHERE d.hospital_id = ? AND d.is_active = 1 ORDER BY dp.name, d.name', hid)
    .map((d) => { const q = opd.queue(hid, d.id, t); return { ...d, serving: q.serving && q.serving.token, next: q.waiting.slice(0, 3).map((w) => w.token), waiting: q.waiting.length, completed: q.completed.length, avg_wait_min: q.avg_wait_min }; });
  const appts = db.get("SELECT COUNT(*) c FROM appointments WHERE hospital_id = ? AND substr(scheduled_at,1,10) = ? AND status NOT IN ('cancelled')", hid, t).c;
  res.json({ stats: { ...stats, appointments: appts }, doctors });
});

r.get('/opd/visits', A, auth.canAny(['opd', 'view'], ['doctor', 'view']), (req, res) => {
  const date = req.query.date || today();
  const where = ['v.hospital_id = ?', 'v.visit_date = ?']; const p = [req.ctx.hid, date];
  if (req.query.doctor_id) { where.push('v.doctor_id = ?'); p.push(Number(req.query.doctor_id)); }
  if (req.query.status) { where.push('v.status = ?'); p.push(req.query.status); }
  res.json(db.all(`SELECT v.*, tk.token, p.full_name patient_name, p.uhid, p.gender, p.dob, p.mobile, d.name doctor_name, dp.name department
    FROM opd_visits v JOIN opd_tokens tk ON tk.visit_id = v.id JOIN patients p ON p.id = v.patient_id JOIN doctors d ON d.id = v.doctor_id LEFT JOIN departments dp ON dp.id = v.department_id
    WHERE ${where.join(' AND ')} ORDER BY v.registered_at DESC`, ...p));
});

// Register OPD visit (walk-in or emergency) → token automatically.
r.post('/opd/visit', A, auth.canAny(['opd', 'add'], ['reception', 'add'], ['emergency', 'add']), (req, res) => {
  const b = validate(req.body, { patient_id: 'required|int', doctor_id: 'required|int', visit_type: { enum: ['new', 'followup', 'emergency'], default: 'new' }, chief_complaint: 'max:300', appointment_id: 'int' });
  if (b.visit_type === 'emergency' && !req.ctx.enabled.has('emergency')) throw forbidden('Emergency module is not enabled');
  const out = db.tx(() => opd.registerVisit(req.ctx.hid, b, req.ctx.user.id));
  audit(req, 'opd.visit_created', { entity: 'opd_visit', id: out.id, ref: out.token, details: { patient_id: b.patient_id, doctor_id: b.doctor_id, type: b.visit_type } });
  res.status(201).json(out);
});
r.post('/opd/token', A, auth.canAny(['opd', 'add'], ['reception', 'add']), (req, res) => {
  // Alias: returns the existing token for today's visit or creates a visit.
  const b = validate(req.body, { patient_id: 'required|int', doctor_id: 'required|int' });
  const ex = db.get("SELECT v.id, tk.token FROM opd_visits v JOIN opd_tokens tk ON tk.visit_id = v.id WHERE v.hospital_id = ? AND v.patient_id = ? AND v.doctor_id = ? AND v.visit_date = ? AND v.status IN ('waiting','in_consultation')", req.ctx.hid, b.patient_id, b.doctor_id, today());
  if (ex) return res.json({ id: ex.id, token: ex.token });
  const out = db.tx(() => opd.registerVisit(req.ctx.hid, b, req.ctx.user.id));
  audit(req, 'opd.visit_created', { entity: 'opd_visit', id: out.id, ref: out.token });
  res.status(201).json(out);
});

r.get('/opd/visits/:id', A, auth.canAny(['opd', 'view'], ['doctor', 'view'], ['reception', 'view']), (req, res) => {
  const v = db.get(`SELECT v.*, tk.token, p.full_name patient_name, p.uhid, p.gender, p.dob, p.mobile, p.address, p.city, d.name doctor_name, d.room, d.qualification, dp.name department,
      (SELECT COUNT(*) FROM opd_visits w WHERE w.hospital_id = v.hospital_id AND w.doctor_id = v.doctor_id AND w.visit_date = v.visit_date AND w.status = 'waiting' AND w.id < v.id) ahead,
      i.invoice_no, i.total invoice_total, i.paid invoice_paid
    FROM opd_visits v JOIN opd_tokens tk ON tk.visit_id = v.id JOIN patients p ON p.id = v.patient_id JOIN doctors d ON d.id = v.doctor_id LEFT JOIN departments dp ON dp.id = v.department_id
    LEFT JOIN invoices i ON i.visit_id = v.id AND i.bill_type = 'opd' WHERE v.id = ? AND v.hospital_id = ?`, id(req.params.id), req.ctx.hid);
  if (!v) throw notFound('Visit');
  v.age = require('../lib/util').ageFrom(v.dob);
  res.json(v);
});

r.get('/opd/queue/:doctorId', A, auth.canAny(['opd', 'view'], ['doctor', 'view']), (req, res) => {
  const did = id(req.params.doctorId);
  const d = db.get('SELECT d.id, d.name, d.room, d.token_prefix, dp.name department FROM doctors d LEFT JOIN departments dp ON dp.id = d.department_id WHERE d.id = ? AND d.hospital_id = ?', did, req.ctx.hid);
  if (!d) throw notFound('Doctor');
  res.json({ doctor: d, ...opd.queue(req.ctx.hid, did) });
});
r.post('/opd/queue/:doctorId/call-next', A, auth.canAny(['doctor', 'edit'], ['opd', 'edit']), (req, res) => {
  const did = id(req.params.doctorId);
  if (req.ctx.doctorId && req.ctx.doctorId !== did && !req.ctx.can('opd', 'edit')) throw forbidden('You can only call patients from your own queue');
  if (!db.get('SELECT id FROM doctors WHERE id = ? AND hospital_id = ?', did, req.ctx.hid)) throw notFound('Doctor');
  const next = db.tx(() => opd.callNext(req.ctx.hid, did, req.body.visit_id ? Number(req.body.visit_id) : undefined));
  audit(req, 'opd.token_called', { entity: 'opd_visit', id: next.id, ref: next.token });
  res.json(next);
});
r.post('/opd/visits/:id/status', A, auth.canAny(['opd', 'edit'], ['doctor', 'edit']), (req, res) => {
  const b = validate(req.body, { status: { required: true, enum: ['waiting', 'in_consultation', 'completed', 'cancelled', 'no_show'] } });
  const vid = id(req.params.id);
  db.tx(() => opd.setStatus(req.ctx.hid, vid, b.status));
  audit(req, 'opd.visit_status', { entity: 'opd_visit', id: vid, details: b });
  res.json({ ok: true });
});

// ───────── Consultation (EMR)
function visitFor(req, vid) {
  const v = db.get(`SELECT v.*, tk.token, d.name doctor_name, d.user_id doctor_user_id, dp.name department FROM opd_visits v JOIN opd_tokens tk ON tk.visit_id = v.id JOIN doctors d ON d.id = v.doctor_id LEFT JOIN departments dp ON dp.id = v.department_id WHERE v.id = ? AND v.hospital_id = ?`, vid, req.ctx.hid);
  if (!v) throw notFound('Visit');
  return v;
}
r.get('/opd/visits/:id/emr', A, auth.can('doctor'), (req, res) => {
  const v = visitFor(req, id(req.params.id));
  const p = db.get('SELECT * FROM patients WHERE id = ?', v.patient_id);
  p.age = require('../lib/util').ageFrom(p.dob);
  v.vitals = v.vitals ? JSON.parse(v.vitals) : null;
  v.diagnoses = db.all('SELECT dc.id, dc.name, dc.code, vd.kind FROM visit_diagnoses vd JOIN diagnosis_codes dc ON dc.id = vd.diagnosis_id WHERE vd.visit_id = ? ORDER BY vd.id', v.id);
  const history = db.all(`SELECT v.id, v.visit_date, v.chief_complaint, v.clinical_notes, v.advice, v.vitals, d.name doctor FROM opd_visits v JOIN doctors d ON d.id = v.doctor_id WHERE v.patient_id = ? AND v.id != ? AND v.status = 'completed' ORDER BY v.visit_date DESC LIMIT 10`, v.patient_id, v.id)
    .map((h) => ({ ...h, vitals: h.vitals ? JSON.parse(h.vitals) : null, diagnoses: db.all('SELECT dc.name, dc.code FROM visit_diagnoses vd JOIN diagnosis_codes dc ON dc.id = vd.diagnosis_id WHERE vd.visit_id = ?', h.id), prescription: (() => { const x = db.get("SELECT id, rx_no FROM prescriptions WHERE visit_id = ? AND status = 'finalized'", h.id); return x ? { ...x, items: rx.items(x.id) } : null; })() }));
  const labs = db.all(`SELECT lo.id, lo.order_no, lo.status, lo.created_at, lt.name test FROM lab_orders lo JOIN lab_tests lt ON lt.id = lo.test_id WHERE lo.patient_id = ? ORDER BY lo.created_at DESC LIMIT 15`, v.patient_id)
    .map((l) => ({ ...l, results: db.all('SELECT parameter, value, unit, ref_range, flag FROM lab_results WHERE lab_order_id = ?', l.id) }));
  const radiology = db.all('SELECT ro.id, ro.order_no, ro.modality, ro.study, ro.status, ro.created_at, rr.impression FROM radiology_orders ro LEFT JOIN radiology_reports rr ON rr.order_id = ro.id WHERE ro.patient_id = ? ORDER BY ro.created_at DESC LIMIT 10', v.patient_id);
  res.json({ visit: v, patient: p, history, labs, radiology, prescription: rx.forVisit(req.ctx.hid, v.id), summary: assistant.patientSummary(req.ctx.hid, v.patient_id) });
});

// Autosave: vitals, complaint, notes, diagnoses, follow-up. Never loses data.
r.put('/opd/visits/:id/consultation', A, auth.can('doctor', 'edit'), (req, res) => {
  const v = visitFor(req, id(req.params.id));
  const b = validate(req.body, { chief_complaint: 'max:1000', history_notes: 'max:4000', clinical_notes: 'max:8000', examination: 'max:4000', advice: 'max:2000', follow_up_date: 'date', vitals: 'object', diagnosis_ids: 'array' }, { partial: true });
  if (b.vitals) {
    const vt = {};
    const lim = { bp_sys: [50, 260], bp_dia: [30, 160], pulse: [20, 250], temp: [90, 110], spo2: [50, 100], weight: [0.5, 300], height: [30, 250], rr: [5, 60] };
    for (const [k, [lo, hi]] of Object.entries(lim)) {
      const x = b.vitals[k];
      if (x === '' || x === null || x === undefined) continue;
      const n = Number(x);
      if (!Number.isFinite(n) || n < lo || n > hi) throw bad(`${k.replace('_', ' ').toUpperCase()} value ${x} looks out of range (${lo}–${hi})`);
      vt[k] = n;
    }
    if (vt.weight && vt.height) vt.bmi = Math.round((vt.weight / ((vt.height / 100) ** 2)) * 10) / 10;
    b.vitals = JSON.stringify(vt);
  }
  db.tx(() => {
    const ids = b.diagnosis_ids; delete b.diagnosis_ids;
    if (v.status === 'waiting') { b.status = 'in_consultation'; b.called_at = now(); }
    db.updateRow('opd_visits', v.id, { ...b, draft_saved_at: now() });
    if (ids) {
      db.run('DELETE FROM visit_diagnoses WHERE visit_id = ?', v.id);
      for (const did of ids) {
        if (!db.get('SELECT id FROM diagnosis_codes WHERE id = ? AND hospital_id = ?', Number(did), req.ctx.hid)) throw bad('Invalid diagnosis');
        db.insertRow('visit_diagnoses', { hospital_id: req.ctx.hid, visit_id: v.id, diagnosis_id: Number(did), doctor_id: v.doctor_id, created_at: now() });
      }
    }
  });
  res.json({ ok: true, saved_at: now() });
});

// ───────── Smart diagnosis search: frequently used, recent, favourites, then master search.
r.get('/diagnoses/search', A, auth.can('doctor'), (req, res) => {
  const hid = req.ctx.hid; const doc = req.ctx.doctorId || (req.query.doctor_id ? Number(req.query.doctor_id) : null);
  const q = String(req.query.q || '').trim();
  const cols = 'd.id, d.code, d.name, d.specialty, d.is_common';
  const favIds = doc ? new Set(db.all('SELECT diagnosis_id FROM doctor_favourite_diagnoses WHERE doctor_id = ?', doc).map((x) => x.diagnosis_id)) : new Set();
  const mark = (rows) => rows.map((x) => ({ ...x, favourite: favIds.has(x.id) }));
  const frequent = doc ? mark(db.all(`SELECT ${cols}, COUNT(*) uses FROM visit_diagnoses vd JOIN diagnosis_codes d ON d.id = vd.diagnosis_id WHERE vd.hospital_id = ? AND vd.doctor_id = ? AND d.is_active = 1 GROUP BY d.id ORDER BY uses DESC LIMIT 8`, hid, doc)) : [];
  const recent = doc ? mark(db.all(`SELECT ${cols}, MAX(vd.id) last FROM visit_diagnoses vd JOIN diagnosis_codes d ON d.id = vd.diagnosis_id WHERE vd.hospital_id = ? AND vd.doctor_id = ? GROUP BY d.id ORDER BY last DESC LIMIT 8`, hid, doc)) : [];
  const favourites = doc ? mark(db.all(`SELECT ${cols} FROM doctor_favourite_diagnoses f JOIN diagnosis_codes d ON d.id = f.diagnosis_id WHERE f.doctor_id = ? ORDER BY d.name`, doc)) : [];
  let results = [];
  if (q) {
    const like = `%${q}%`;
    // Rank: code/name prefix > substring; then personal usage, then hospital-wide usage.
    results = mark(db.all(`SELECT ${cols},
        (SELECT COUNT(*) FROM visit_diagnoses x WHERE x.diagnosis_id = d.id AND x.doctor_id IS ?) my_uses,
        (SELECT COUNT(*) FROM visit_diagnoses x WHERE x.diagnosis_id = d.id) uses
      FROM diagnosis_codes d WHERE d.hospital_id = ? AND d.is_active = 1 AND (d.name LIKE ? OR d.code LIKE ? OR d.synonyms LIKE ? OR d.specialty LIKE ?)
      ORDER BY (d.name LIKE ? OR d.code LIKE ?) DESC, my_uses DESC, uses DESC, d.is_common DESC, d.name LIMIT 25`, doc, hid, like, `${q}%`, like, like, `${q}%`, `${q}%`));
  } else {
    results = mark(db.all(`SELECT ${cols} FROM diagnosis_codes d WHERE d.hospital_id = ? AND d.is_active = 1 AND d.is_common = 1 ORDER BY d.name LIMIT 20`, hid));
  }
  res.json({ frequent, recent, favourites, results });
});
r.post('/diagnoses/:id/favourite', A, auth.can('doctor', 'edit'), (req, res) => {
  if (!req.ctx.doctorId) throw bad('Only doctors can keep favourites');
  const did = id(req.params.id);
  if (!db.get('SELECT id FROM diagnosis_codes WHERE id = ? AND hospital_id = ?', did, req.ctx.hid)) throw notFound('Diagnosis');
  const ex = db.get('SELECT 1 x FROM doctor_favourite_diagnoses WHERE doctor_id = ? AND diagnosis_id = ?', req.ctx.doctorId, did);
  if (ex) db.run('DELETE FROM doctor_favourite_diagnoses WHERE doctor_id = ? AND diagnosis_id = ?', req.ctx.doctorId, did);
  else db.run('INSERT INTO doctor_favourite_diagnoses (doctor_id, diagnosis_id) VALUES (?,?)', req.ctx.doctorId, did);
  res.json({ favourite: !ex });
});

// Template suggestions (hospital-approved only) for the selected diagnoses. Suggestions are
// returned as unconfirmed lines — the doctor must review and confirm each one.
r.get('/prescription-templates/suggest', A, auth.can('doctor'), (req, res) => {
  const ids = String(req.query.diagnosis_ids || '').split(',').map(Number).filter(Boolean);
  if (!ids.length) return res.json([]);
  const rows = db.all(`SELECT t.id, t.name, t.advice, d.name diagnosis, d.code FROM prescription_templates t JOIN diagnosis_codes d ON d.id = t.diagnosis_id WHERE t.hospital_id = ? AND t.is_approved = 1 AND t.diagnosis_id IN (${ids.map(() => '?').join(',')}) ORDER BY t.name`, req.ctx.hid, ...ids);
  for (const t of rows) t.items = db.all(`SELECT ti.medicine_id, ti.dose, ti.frequency, ti.duration_days, ti.route, ti.instructions, m.name, m.strength, m.dosage_form,
      (SELECT COALESCE(SUM(qty),0) FROM medicine_batches b WHERE b.medicine_id = m.id AND b.expiry_date >= date('now','localtime')) stock
    FROM prescription_template_items ti JOIN medicines m ON m.id = ti.medicine_id WHERE ti.template_id = ?`, t.id).map((i) => ({ ...i, quantity: rx.suggestQuantity(i), confirmed: 0 }));
  res.json(rows);
});

// ───────── Prescriptions
r.get('/prescriptions', A, auth.canAny(['doctor', 'view'], ['pharmacy', 'view']), (req, res) => {
  const where = ["r.hospital_id = ?", "r.status = 'finalized'"]; const p = [req.ctx.hid];
  if (req.query.mine && req.ctx.doctorId) { where.push('r.doctor_id = ?'); p.push(req.ctx.doctorId); }
  if (req.query.patient_id) { where.push('r.patient_id = ?'); p.push(Number(req.query.patient_id)); }
  res.json(db.all(`SELECT r.id, r.rx_no, r.finalized_at, r.visit_id, p.full_name patient_name, p.uhid, d.name doctor_name, (SELECT COUNT(*) FROM prescription_items WHERE prescription_id = r.id) items
    FROM prescriptions r JOIN patients p ON p.id = r.patient_id JOIN doctors d ON d.id = r.doctor_id WHERE ${where.join(' AND ')} ORDER BY r.finalized_at DESC LIMIT 100`, ...p));
});
r.get('/prescriptions/:id', A, auth.canAny(['doctor', 'view'], ['pharmacy', 'view'], ['patients', 'view']), (req, res) => {
  const x = db.get(`SELECT r.*, p.full_name patient_name, p.uhid, p.gender, p.dob, p.mobile, p.allergies, d.name doctor_name, d.qualification, d.registration_no, dp.name department,
      v.chief_complaint, v.vitals, v.advice, v.follow_up_date, v.clinical_notes
    FROM prescriptions r JOIN patients p ON p.id = r.patient_id JOIN doctors d ON d.id = r.doctor_id LEFT JOIN departments dp ON dp.id = d.department_id LEFT JOIN opd_visits v ON v.id = r.visit_id
    WHERE r.id = ? AND r.hospital_id = ?`, id(req.params.id), req.ctx.hid);
  if (!x) throw notFound('Prescription');
  x.items = rx.items(x.id);
  x.vitals = x.vitals ? JSON.parse(x.vitals) : null;
  x.diagnoses = x.visit_id ? db.all('SELECT dc.name, dc.code FROM visit_diagnoses vd JOIN diagnosis_codes dc ON dc.id = vd.diagnosis_id WHERE vd.visit_id = ?', x.visit_id) : [];
  x.age = require('../lib/util').ageFrom(x.dob);
  res.json(x);
});
r.put('/opd/visits/:id/prescription', A, auth.can('doctor', 'edit'), (req, res) => {
  const v = visitFor(req, id(req.params.id));
  const b = validate(req.body, { items: 'array', notes: 'max:1000', template_id: 'int' });
  const rid = db.tx(() => rx.saveDraft(req.ctx.hid, v.id, b, req.ctx.user.id));
  res.json({ id: rid, saved_at: now(), prescription: rx.forVisit(req.ctx.hid, v.id) });
});
r.post('/prescriptions', A, auth.can('doctor', 'add'), (req, res) => {
  // REST alias: { visit_id, items, notes, finalize }
  const b = validate(req.body, { visit_id: 'required|int', items: 'array', notes: 'max:1000', finalize: 'bool' });
  visitFor(req, b.visit_id);
  const out = db.tx(() => {
    rx.saveDraft(req.ctx.hid, b.visit_id, b, req.ctx.user.id);
    return b.finalize ? rx.finalize(req.ctx.hid, b.visit_id, req.ctx) : { prescription: rx.forVisit(req.ctx.hid, b.visit_id) };
  });
  if (b.finalize) audit(req, 'prescription.finalized', { entity: 'prescription', id: out.prescription_id, ref: out.rx_no });
  res.status(201).json(out);
});
r.post('/opd/visits/:id/finalize', A, auth.can('doctor', 'edit'), (req, res) => {
  const v = visitFor(req, id(req.params.id));
  const b = validate(req.body, { items: 'array', notes: 'max:1000', send_to_pharmacy: { type: 'bool', default: 1 } });
  const out = db.tx(() => {
    if (b.items) rx.saveDraft(req.ctx.hid, v.id, b, req.ctx.user.id);
    const existing = rx.forVisit(req.ctx.hid, v.id);
    if (!existing) {  // consultation without medicines
      rx.saveDraft(req.ctx.hid, v.id, { items: [] }, req.ctx.user.id);
    }
    return rx.finalize(req.ctx.hid, v.id, req.ctx, { sendToPharmacy: !!b.send_to_pharmacy });
  });
  const items = rx.items(out.prescription_id);
  audit(req, 'prescription.finalized', { entity: 'prescription', id: out.prescription_id, ref: out.rx_no, details: { visit: v.visit_no, items: items.map((i) => `${i.name} ${i.dose} ${i.frequency} x${i.duration_days}d`), pharmacy_token: out.pharmacy_order && out.pharmacy_order.token } });
  res.json(out);
});

// Investigations ordered from the consultation screen.
r.post('/opd/visits/:id/lab-orders', A, auth.canAny(['doctor', 'edit'], ['laboratory', 'add']), (req, res) => {
  const v = visitFor(req, id(req.params.id));
  const b = validate(req.body, { test_ids: 'required|array', priority: { enum: ['routine', 'urgent', 'stat'], default: 'routine' } });
  const out = db.tx(() => clinical.orderLab(req.ctx.hid, { patient_id: v.patient_id, visit_id: v.id, doctor_id: v.doctor_id, test_ids: b.test_ids.map(Number), priority: b.priority }, req.ctx.user.id));
  audit(req, 'lab.ordered', { entity: 'lab_order', ref: out.map((o) => o.order_no).join(',') });
  res.status(201).json(out);
});
r.post('/opd/visits/:id/radiology-orders', A, auth.canAny(['doctor', 'edit'], ['radiology', 'add']), (req, res) => {
  const v = visitFor(req, id(req.params.id));
  const b = validate(req.body, { modality: { required: true, enum: ['X-Ray', 'CT', 'MRI', 'Ultrasound', 'Other'] }, study: 'required|max:120', clinical_info: 'max:500' });
  const out = db.tx(() => clinical.orderRadiology(req.ctx.hid, { ...b, patient_id: v.patient_id, visit_id: v.id, doctor_id: v.doctor_id }, req.ctx.user.id));
  audit(req, 'radiology.ordered', { entity: 'radiology_order', id: out.id, ref: out.order_no });
  res.status(201).json(out);
});

module.exports = r;
module.exports.bookAppointment = bookAppointment;
module.exports.slots = slots;
