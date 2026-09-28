'use strict';
// IPD (admissions, beds, rounds, MAR, charges, discharge), nursing, laboratory, radiology.
const express = require('express');
const db = require('../db');
const auth = require('../lib/auth');
const clinical = require('../services/clinical');
const { audit } = require('../lib/audit');
const { validate, id } = require('../lib/validate');
const { now, today, ageFrom, notFound, bad, conflict } = require('../lib/util');

const r = express.Router();
const A = auth.authenticate;

// ───────── Beds & wards
r.get('/ipd/beds', A, auth.canAny(['ipd', 'view'], ['nursing', 'view']), (req, res) => {
  const wards = db.all('SELECT * FROM wards WHERE hospital_id = ? ORDER BY CASE ward_type WHEN \'icu\' THEN 0 WHEN \'emergency\' THEN 1 ELSE 2 END, name', req.ctx.hid);
  for (const w of wards) {
    w.beds = db.all(`SELECT b.*, a.ipd_no, a.admitted_at, a.expected_discharge, a.id admission_id, p.full_name patient_name, p.uhid, p.gender, p.dob, d.name doctor_name
      FROM beds b LEFT JOIN ipd_admissions a ON a.id = b.current_admission_id LEFT JOIN patients p ON p.id = a.patient_id LEFT JOIN doctors d ON d.id = a.doctor_id
      WHERE b.ward_id = ? ORDER BY b.bed_no`, w.id).map((b) => ({ ...b, age: ageFrom(b.dob) }));
  }
  const s = db.get(`SELECT COUNT(*) total, SUM(status='occupied') occupied, SUM(status='available') available, SUM(status='reserved') reserved, SUM(status='cleaning') cleaning, SUM(status='maintenance') maintenance FROM beds WHERE hospital_id = ?`, req.ctx.hid);
  const icu = db.get("SELECT COUNT(*) total, SUM(b.status='occupied') occupied FROM beds b JOIN wards w ON w.id = b.ward_id WHERE b.hospital_id = ? AND w.ward_type IN ('icu','nicu')", req.ctx.hid);
  res.json({ wards, stats: { ...s, icu_total: icu.total, icu_occupied: icu.occupied } });
});
r.post('/ipd/beds/:id/status', A, auth.canAny(['ipd', 'edit'], ['nursing', 'edit']), (req, res) => {
  const b = validate(req.body, { status: { required: true, enum: ['available', 'reserved', 'cleaning', 'maintenance'] } });
  const bed = db.get('SELECT * FROM beds WHERE id = ? AND hospital_id = ?', id(req.params.id), req.ctx.hid);
  if (!bed) throw notFound('Bed');
  if (bed.status === 'occupied') throw conflict('Bed is occupied — discharge or transfer the patient first');
  db.run('UPDATE beds SET status = ?, updated_at = ? WHERE id = ?', b.status, now(), bed.id);
  audit(req, 'ipd.bed_status', { entity: 'bed', id: bed.id, ref: bed.bed_no, details: { from: bed.status, to: b.status } });
  res.json({ ok: true });
});

// ───────── Admissions
r.get('/ipd/admissions', A, auth.canAny(['ipd', 'view'], ['nursing', 'view']), (req, res) => {
  const status = req.query.status || 'admitted';
  const rows = db.all(`SELECT a.*, p.full_name patient_name, p.uhid, p.gender, p.dob, d.name doctor_name, dp.name department, w.name ward, b.bed_no,
      CAST(julianday(COALESCE(a.discharged_at, datetime('now','localtime'))) - julianday(a.admitted_at) AS INTEGER) + 1 day_no,
      (SELECT MAX(recorded_at) FROM nursing_records n WHERE n.admission_id = a.id) last_vitals
    FROM ipd_admissions a JOIN patients p ON p.id = a.patient_id JOIN doctors d ON d.id = a.doctor_id LEFT JOIN departments dp ON dp.id = a.department_id LEFT JOIN beds b ON b.id = a.bed_id LEFT JOIN wards w ON w.id = b.ward_id
    WHERE a.hospital_id = ? AND (? = 'all' OR a.status = ?) ORDER BY a.admitted_at DESC LIMIT 300`, req.ctx.hid, status, status);
  res.json(rows.map((x) => ({ ...x, age: ageFrom(x.dob) })));
});
r.post('/ipd/admission', A, auth.can('ipd', 'add'), (req, res) => {
  const b = validate(req.body, { patient_id: 'required|int', doctor_id: 'required|int', bed_id: 'required|int', department_id: 'int', admission_type: { enum: ['planned', 'emergency', 'transfer'], default: 'planned' }, reason: 'required|max:300', expected_discharge: 'date', nurse_user_id: 'int', visit_id: 'int', diagnosis_ids: 'array' });
  if (b.nurse_user_id && !db.get('SELECT id FROM users WHERE id = ? AND hospital_id = ?', b.nurse_user_id, req.ctx.hid)) throw bad('Invalid nurse');
  const out = db.tx(() => {
    const x = clinical.admit(req.ctx.hid, b, req.ctx.user.id);
    for (const did of b.diagnosis_ids || []) if (db.get('SELECT id FROM diagnosis_codes WHERE id = ? AND hospital_id = ?', Number(did), req.ctx.hid)) db.insertRow('visit_diagnoses', { hospital_id: req.ctx.hid, admission_id: x.id, diagnosis_id: Number(did), doctor_id: b.doctor_id, created_at: now() });
    return x;
  });
  audit(req, 'ipd.admitted', { entity: 'ipd_admission', id: out.id, ref: out.ipd_no, details: { bed_id: b.bed_id } });
  res.status(201).json(out);
});
function admission(req, aid) {
  const a = db.get(`SELECT a.*, p.full_name patient_name, p.uhid, p.gender, p.dob, p.mobile, p.blood_group, p.allergies, p.address, p.city, p.emergency_name, p.emergency_phone,
      d.name doctor_name, d.qualification, dp.name department, w.name ward, w.ward_type, w.daily_rate, b.bed_no, u.full_name nurse_name
    FROM ipd_admissions a JOIN patients p ON p.id = a.patient_id JOIN doctors d ON d.id = a.doctor_id LEFT JOIN departments dp ON dp.id = a.department_id LEFT JOIN beds b ON b.id = a.bed_id LEFT JOIN wards w ON w.id = b.ward_id LEFT JOIN users u ON u.id = a.nurse_user_id
    WHERE a.id = ? AND a.hospital_id = ?`, aid, req.ctx.hid);
  if (!a) throw notFound('Admission');
  a.age = ageFrom(a.dob);
  return a;
}
r.get('/ipd/admissions/:id', A, auth.canAny(['ipd', 'view'], ['nursing', 'view']), (req, res) => {
  const a = admission(req, id(req.params.id));
  a.notes = db.all('SELECT n.*, u.full_name user_name, k.full_name ack_name FROM ipd_notes n LEFT JOIN users u ON u.id = n.user_id LEFT JOIN users k ON k.id = n.acknowledged_by WHERE n.admission_id = ? ORDER BY n.created_at DESC', a.id);
  a.vitals = db.all('SELECT n.*, u.full_name user_name FROM nursing_records n LEFT JOIN users u ON u.id = n.user_id WHERE n.admission_id = ? ORDER BY n.recorded_at DESC LIMIT 100', a.id);
  a.medications = db.all("SELECT im.*, m.name, m.strength, u.full_name ordered_by_name FROM ipd_medications im JOIN medicines m ON m.id = im.medicine_id LEFT JOIN users u ON u.id = im.ordered_by WHERE im.admission_id = ? ORDER BY im.status, im.id DESC", a.id)
    .map((m) => ({ ...m, administrations: db.all('SELECT ma.*, u.full_name user_name FROM medication_administrations ma LEFT JOIN users u ON u.id = ma.user_id WHERE ma.medication_id = ? ORDER BY ma.scheduled_for DESC LIMIT 20', m.id) }));
  a.charges = db.all('SELECT * FROM ipd_charges WHERE admission_id = ? ORDER BY created_at', a.id);
  a.labs = db.all('SELECT lo.*, lt.name test FROM lab_orders lo JOIN lab_tests lt ON lt.id = lo.test_id WHERE lo.admission_id = ? ORDER BY lo.created_at DESC', a.id);
  a.radiology = db.all('SELECT * FROM radiology_orders WHERE admission_id = ? ORDER BY created_at DESC', a.id);
  a.diagnoses = db.all('SELECT dc.name, dc.code FROM visit_diagnoses vd JOIN diagnosis_codes dc ON dc.id = vd.diagnosis_id WHERE vd.admission_id = ?', a.id);
  const roomDays = Math.max(1, Math.ceil((Date.now() - new Date(a.admitted_at.replace(' ', 'T'))) / 864e5));
  a.running_bill = Math.round(a.charges.filter((c) => c.category !== 'room').reduce((s, c) => s + c.quantity * c.unit_price, 0) + roomDays * (a.daily_rate || 0));
  if (a.invoice_id) a.invoice = db.get('SELECT id, invoice_no, total, paid, balance, status FROM invoices WHERE id = ?', a.invoice_id);
  res.json(a);
});
r.post('/ipd/admissions/:id/notes', A, auth.canAny(['ipd', 'edit'], ['nursing', 'add']), (req, res) => {
  const a = admission(req, id(req.params.id));
  const b = validate(req.body, { note_type: { required: true, enum: ['round', 'progress', 'instruction', 'procedure', 'nursing', 'handover'] }, body: 'required|max:4000' });
  if (['round', 'instruction', 'procedure'].includes(b.note_type) && !req.ctx.can('ipd', 'edit')) throw bad('Only clinicians can add doctor notes');
  const nid = db.insertRow('ipd_notes', { hospital_id: req.ctx.hid, admission_id: a.id, ...b, user_id: req.ctx.user.id, created_at: now() });
  if (b.note_type === 'instruction') require('../lib/notify').notify({ hid: req.ctx.hid, module: 'nursing', category: 'ipd', severity: 'warning', title: `Doctor instruction · ${a.ward || ''} ${a.bed_no || ''}`.trim(), body: `${a.patient_name}: ${b.body.slice(0, 120)}`, link: `/ipd/${a.id}` });
  audit(req, 'ipd.note_added', { entity: 'ipd_admission', id: a.id, ref: a.ipd_no, details: { type: b.note_type } });
  res.status(201).json({ id: nid });
});
r.post('/ipd/notes/:id/acknowledge', A, auth.can('nursing', 'edit'), (req, res) => {
  const n = db.run('UPDATE ipd_notes SET acknowledged_by = ?, acknowledged_at = ? WHERE id = ? AND hospital_id = ? AND acknowledged_at IS NULL', req.ctx.user.id, now(), id(req.params.id), req.ctx.hid).changes;
  if (!n) throw notFound('Instruction');
  res.json({ ok: true });
});
r.post('/ipd/admissions/:id/vitals', A, auth.canAny(['nursing', 'add'], ['ipd', 'edit']), (req, res) => {
  const a = admission(req, id(req.params.id));
  if (a.status !== 'admitted') throw conflict('Patient is discharged');
  const b = validate(req.body, { bp_sys: 'int|min:40|max:280', bp_dia: 'int|min:20|max:180', pulse: 'int|min:20|max:250', temp: 'number|min:90|max:110', spo2: 'int|min:40|max:100', rr: 'int|min:4|max:70', blood_sugar: 'int|min:20|max:800', pain_score: 'int|min:0|max:10', intake_ml: 'int|min:0|max:10000', output_ml: 'int|min:0|max:10000', note: 'max:500' });
  if (Object.values(b).every((v) => v === null)) throw bad('Enter at least one reading');
  const vid = db.insertRow('nursing_records', { hospital_id: req.ctx.hid, admission_id: a.id, ...b, user_id: req.ctx.user.id, recorded_at: now() });
  const crit = (b.spo2 && b.spo2 < 90) || (b.bp_sys && (b.bp_sys > 180 || b.bp_sys < 90)) || (b.pulse && (b.pulse > 130 || b.pulse < 45)) || (b.temp && b.temp >= 103);
  if (crit) {
    const doc = db.get('SELECT user_id FROM doctors WHERE id = ?', a.doctor_id);
    const msg = { hid: req.ctx.hid, category: 'ipd', severity: 'critical', title: `Critical vitals · ${a.patient_name} (${a.bed_no || a.ipd_no})`, body: [b.bp_sys && `BP ${b.bp_sys}/${b.bp_dia}`, b.pulse && `HR ${b.pulse}`, b.spo2 && `SpO₂ ${b.spo2}%`, b.temp && `T ${b.temp}°F`].filter(Boolean).join(' · '), link: `/ipd/${a.id}` };
    const { notify } = require('../lib/notify');
    if (doc && doc.user_id) notify({ ...msg, userId: doc.user_id });
    notify({ ...msg, module: 'nursing' });
  }
  audit(req, 'nursing.vitals', { entity: 'ipd_admission', id: a.id, ref: a.ipd_no });
  res.status(201).json({ id: vid, critical: !!crit });
});
r.post('/ipd/admissions/:id/medications', A, auth.can('ipd', 'edit'), (req, res) => {
  const a = admission(req, id(req.params.id));
  const b = validate(req.body, { medicine_id: 'required|int', dose: 'required|max:40', route: 'required|max:30', frequency: 'required|max:20', times: 'max:60', start_date: 'date', end_date: 'date' });
  if (!db.get('SELECT id FROM medicines WHERE id = ? AND hospital_id = ?', b.medicine_id, req.ctx.hid)) throw bad('Invalid medicine');
  const defaults = { OD: '09:00', BD: '09:00,21:00', TDS: '08:00,14:00,20:00', QID: '06:00,12:00,18:00,24:00', HS: '22:00', STAT: '' };
  const mid = db.insertRow('ipd_medications', { hospital_id: req.ctx.hid, admission_id: a.id, ...b, times: b.times || defaults[b.frequency.toUpperCase()] || '09:00', start_date: b.start_date || today(), ordered_by: req.ctx.user.id, created_at: now() });
  audit(req, 'ipd.medication_ordered', { entity: 'ipd_admission', id: a.id, ref: a.ipd_no, details: b });
  res.status(201).json({ id: mid });
});
r.post('/ipd/medications/:id/stop', A, auth.can('ipd', 'edit'), (req, res) => {
  const n = db.run("UPDATE ipd_medications SET status = 'stopped', end_date = ? WHERE id = ? AND hospital_id = ?", today(), id(req.params.id), req.ctx.hid).changes;
  if (!n) throw notFound('Medication');
  audit(req, 'ipd.medication_stopped', { entity: 'ipd_medication', id: Number(req.params.id) });
  res.json({ ok: true });
});
r.post('/ipd/medications/:id/administer', A, auth.canAny(['nursing', 'add'], ['ipd', 'edit']), (req, res) => {
  const m = db.get("SELECT im.*, a.status adm_status FROM ipd_medications im JOIN ipd_admissions a ON a.id = im.admission_id WHERE im.id = ? AND im.hospital_id = ?", id(req.params.id), req.ctx.hid);
  if (!m) throw notFound('Medication');
  if (m.status !== 'active' || m.adm_status !== 'admitted') throw conflict('Medication order is not active');
  const b = validate(req.body, { scheduled_for: 'required|datetime', status: { enum: ['given', 'held', 'refused'], default: 'given' }, note: 'max:200' });
  try {
    db.insertRow('medication_administrations', { hospital_id: req.ctx.hid, medication_id: m.id, ...b, user_id: req.ctx.user.id, created_at: now() });
  } catch (e) { if (/UNIQUE/.test(e.message)) throw conflict('This dose is already recorded'); throw e; }
  audit(req, 'nursing.medication_administered', { entity: 'ipd_medication', id: m.id, details: b });
  res.status(201).json({ ok: true });
});
r.post('/ipd/admissions/:id/charges', A, auth.canAny(['ipd', 'edit'], ['billing', 'add']), (req, res) => {
  const a = admission(req, id(req.params.id));
  if (a.status !== 'admitted') throw conflict('Patient is discharged');
  const b = validate(req.body, { category: { required: true, enum: ['procedure', 'consultation', 'consumable', 'nursing', 'other'] }, description: 'required|max:200', quantity: 'number|min:0.01', unit_price: 'required|number|min:0' });
  const cid = db.insertRow('ipd_charges', { hospital_id: req.ctx.hid, admission_id: a.id, ...b, quantity: b.quantity || 1, created_at: now(), user_id: req.ctx.user.id });
  audit(req, 'ipd.charge_added', { entity: 'ipd_admission', id: a.id, ref: a.ipd_no, details: b });
  res.status(201).json({ id: cid });
});
r.post('/ipd/admissions/:id/transfer', A, auth.can('ipd', 'edit'), (req, res) => {
  const b = validate(req.body, { bed_id: 'required|int' });
  const aid = id(req.params.id);
  db.tx(() => clinical.transferBed(req.ctx.hid, aid, b.bed_id));
  audit(req, 'ipd.bed_transfer', { entity: 'ipd_admission', id: aid, details: b });
  res.json({ ok: true });
});
r.post('/ipd/admissions/:id/lab-orders', A, auth.canAny(['ipd', 'edit'], ['laboratory', 'add']), (req, res) => {
  const a = admission(req, id(req.params.id));
  const b = validate(req.body, { test_ids: 'required|array', priority: { enum: ['routine', 'urgent', 'stat'], default: 'routine' } });
  const out = db.tx(() => clinical.orderLab(req.ctx.hid, { patient_id: a.patient_id, admission_id: a.id, doctor_id: a.doctor_id, test_ids: b.test_ids.map(Number), priority: b.priority }, req.ctx.user.id));
  audit(req, 'lab.ordered', { entity: 'lab_order', ref: out.map((o) => o.order_no).join(',') });
  res.status(201).json(out);
});
r.post('/ipd/admissions/:id/discharge', A, auth.can('ipd', 'edit'), (req, res) => {
  const aid = id(req.params.id);
  const b = validate(req.body, { discharge_type: { enum: ['normal', 'lama', 'referred', 'death'], default: 'normal' }, final_diagnosis: 'required|max:500', discharge_summary: 'required|max:8000', discharge_advice: 'max:4000', follow_up_date: 'date', discount: 'number|min:0' });
  if (b.discount && !req.ctx.can('billing', 'approve') && !req.ctx.can('ipd', 'approve')) throw bad('Discounts need billing approval permission');
  const out = db.tx(() => clinical.discharge(req.ctx.hid, aid, b, req.ctx.user.id));
  const a = db.get('SELECT ipd_no FROM ipd_admissions WHERE id = ?', aid);
  audit(req, 'ipd.discharged', { entity: 'ipd_admission', id: aid, ref: a.ipd_no, details: { invoice_id: out.invoice_id, type: b.discharge_type } });
  res.json(out);
});

// ───────── Nursing dashboard
r.get('/nursing/dashboard', A, auth.can('nursing'), (req, res) => {
  const hid = req.ctx.hid; const t = now();
  const patients = db.all(`SELECT a.id, a.ipd_no, a.nurse_user_id, a.admitted_at, p.full_name patient_name, p.uhid, p.gender, p.dob, p.allergies, w.name ward, b.bed_no, d.name doctor_name,
      (SELECT MAX(recorded_at) FROM nursing_records n WHERE n.admission_id = a.id) last_vitals_at,
      (SELECT json_object('bp_sys',bp_sys,'bp_dia',bp_dia,'pulse',pulse,'temp',temp,'spo2',spo2) FROM nursing_records n WHERE n.admission_id = a.id ORDER BY recorded_at DESC LIMIT 1) last_vitals
    FROM ipd_admissions a JOIN patients p ON p.id = a.patient_id LEFT JOIN beds b ON b.id = a.bed_id LEFT JOIN wards w ON w.id = b.ward_id JOIN doctors d ON d.id = a.doctor_id
    WHERE a.hospital_id = ? AND a.status = 'admitted' ${req.query.mine ? 'AND a.nurse_user_id = ' + Number(req.ctx.user.id) : ''} ORDER BY w.name, b.bed_no`, hid)
    .map((p) => ({ ...p, age: ageFrom(p.dob), last_vitals: p.last_vitals ? JSON.parse(p.last_vitals) : null, vitals_due: !p.last_vitals_at || (Date.now() - new Date(p.last_vitals_at.replace(' ', 'T'))) > 4 * 3600e3 }));
  // Medication due: active orders with a scheduled time in the window [now-2h, now+2h] not yet recorded.
  const meds = db.all(`SELECT im.*, m.name, m.strength, a.ipd_no, p.full_name patient_name, w.name ward, b.bed_no FROM ipd_medications im JOIN medicines m ON m.id = im.medicine_id JOIN ipd_admissions a ON a.id = im.admission_id JOIN patients p ON p.id = a.patient_id LEFT JOIN beds b ON b.id = a.bed_id LEFT JOIN wards w ON w.id = b.ward_id
    WHERE im.hospital_id = ? AND im.status = 'active' AND a.status = 'admitted'`, hid);
  const due = [];
  const nowMs = Date.now();
  for (const m of meds) {
    for (const time of String(m.times || '').split(',').filter(Boolean)) {
      const hhmm = time === '24:00' ? '23:59' : time;
      const slot = `${today()} ${hhmm}:00`;
      const ms = new Date(slot.replace(' ', 'T')).getTime();
      if (ms < nowMs - 2 * 3600e3 || ms > nowMs + 2 * 3600e3) continue;
      const done = db.get('SELECT status FROM medication_administrations WHERE medication_id = ? AND scheduled_for = ?', m.id, slot);
      due.push({ medication_id: m.id, name: `${m.name} ${m.strength || ''}`.trim(), dose: m.dose, route: m.route, scheduled_for: slot, overdue: ms < nowMs - 30 * 60e3 && !done, done: done ? done.status : null, patient_name: m.patient_name, ipd_no: m.ipd_no, bed: `${m.ward || ''} ${m.bed_no || ''}`.trim(), admission_id: m.admission_id });
    }
  }
  due.sort((a, b) => a.scheduled_for.localeCompare(b.scheduled_for));
  const instructions = db.all(`SELECT n.*, a.ipd_no, p.full_name patient_name, b.bed_no, u.full_name user_name FROM ipd_notes n JOIN ipd_admissions a ON a.id = n.admission_id JOIN patients p ON p.id = a.patient_id LEFT JOIN beds b ON b.id = a.bed_id LEFT JOIN users u ON u.id = n.user_id
    WHERE n.hospital_id = ? AND n.note_type = 'instruction' AND n.acknowledged_at IS NULL AND a.status = 'admitted' ORDER BY n.created_at DESC`, hid);
  const handovers = db.all(`SELECT n.*, a.ipd_no, p.full_name patient_name, u.full_name user_name FROM ipd_notes n JOIN ipd_admissions a ON a.id = n.admission_id JOIN patients p ON p.id = a.patient_id LEFT JOIN users u ON u.id = n.user_id WHERE n.hospital_id = ? AND n.note_type IN ('handover','nursing') AND n.created_at >= datetime(?, '-24 hours') ORDER BY n.created_at DESC LIMIT 30`, hid, t);
  res.json({ patients, medications_due: due, instructions, handovers, stats: { patients: patients.length, vitals_due: patients.filter((p) => p.vitals_due).length, meds_due: due.filter((d) => !d.done).length, overdue: due.filter((d) => d.overdue).length, instructions: instructions.length } });
});

// ───────── Laboratory
r.get('/lab/orders', A, auth.can('laboratory'), (req, res) => {
  const where = ['lo.hospital_id = ?']; const p = [req.ctx.hid];
  if (req.query.status && req.query.status !== 'all') { where.push('lo.status = ?'); p.push(req.query.status); }
  if (req.query.pending) where.push("lo.status IN ('ordered','sample_collected','processing','completed')");
  if (req.query.date) { where.push('substr(lo.created_at,1,10) = ?'); p.push(req.query.date); }
  res.json(db.all(`SELECT lo.*, lt.name test, lt.category, lt.sample_type, p.full_name patient_name, p.uhid, p.gender, p.dob, d.name doctor_name, a.ipd_no
    FROM lab_orders lo JOIN lab_tests lt ON lt.id = lo.test_id JOIN patients p ON p.id = lo.patient_id LEFT JOIN doctors d ON d.id = lo.doctor_id LEFT JOIN ipd_admissions a ON a.id = lo.admission_id
    WHERE ${where.join(' AND ')} ORDER BY CASE lo.priority WHEN 'stat' THEN 0 WHEN 'urgent' THEN 1 ELSE 2 END, lo.created_at DESC LIMIT 300`, ...p).map((x) => ({ ...x, age: ageFrom(x.dob) })));
});
r.get('/lab/stats', A, auth.can('laboratory'), (req, res) => {
  res.json(db.get(`SELECT SUM(status='ordered') ordered, SUM(status='sample_collected') sample_collected, SUM(status='processing') processing, SUM(status='completed') completed, SUM(status='verified' AND substr(verified_at,1,10) = ?) verified_today, SUM(substr(created_at,1,10) = ?) today
    FROM lab_orders WHERE hospital_id = ?`, today(), today(), req.ctx.hid));
});
r.get('/lab/orders/:id', A, auth.canAny(['laboratory', 'view'], ['doctor', 'view'], ['patients', 'view']), (req, res) => {
  const o = db.get(`SELECT lo.*, lt.name test, lt.category, lt.sample_type, lt.parameters, p.full_name patient_name, p.uhid, p.gender, p.dob, p.mobile, d.name doctor_name,
      cu.full_name collected_by_name, tu.full_name technician_name, vu.full_name verified_by_name
    FROM lab_orders lo JOIN lab_tests lt ON lt.id = lo.test_id JOIN patients p ON p.id = lo.patient_id LEFT JOIN doctors d ON d.id = lo.doctor_id
    LEFT JOIN users cu ON cu.id = lo.collected_by LEFT JOIN users tu ON tu.id = lo.technician_id LEFT JOIN users vu ON vu.id = lo.verified_by
    WHERE lo.id = ? AND lo.hospital_id = ?`, id(req.params.id), req.ctx.hid);
  if (!o) throw notFound('Lab order');
  o.parameters = JSON.parse(o.parameters || '[]'); o.age = ageFrom(o.dob);
  o.results = db.all('SELECT * FROM lab_results WHERE lab_order_id = ?', o.id);
  res.json(o);
});
r.post('/lab/orders', A, auth.can('laboratory', 'add'), (req, res) => {
  const b = validate(req.body, { patient_id: 'required|int', test_ids: 'required|array', doctor_id: 'int', priority: { enum: ['routine', 'urgent', 'stat'], default: 'routine' } });
  const out = db.tx(() => clinical.orderLab(req.ctx.hid, { ...b, test_ids: b.test_ids.map(Number) }, req.ctx.user.id));
  audit(req, 'lab.ordered', { entity: 'lab_order', ref: out.map((o) => o.order_no).join(',') });
  res.status(201).json(out);
});
r.post('/lab/orders/:id/status', A, auth.can('laboratory', 'edit'), (req, res) => {
  const b = validate(req.body, { status: { required: true, enum: ['sample_collected', 'processing', 'completed', 'verified', 'cancelled'] }, results: 'array', remarks: 'max:500', sample_id: 'max:30' });
  if (b.status === 'verified' && !req.ctx.can('laboratory', 'approve')) throw bad('Verification requires approve permission');
  const oid = id(req.params.id);
  if (b.status === 'verified') {
    const o = db.get('SELECT technician_id FROM lab_orders WHERE id = ? AND hospital_id = ?', oid, req.ctx.hid);
    if (o && o.technician_id === req.ctx.user.id && !req.ctx.isSuper && !req.ctx.roles.some((x) => x.key === 'hospital_admin')) throw bad('Results must be verified by a different user than the one who entered them');
  }
  db.tx(() => clinical.labStatus(req.ctx.hid, oid, b.status, { ...b, userId: req.ctx.user.id }));
  audit(req, `lab.${b.status}`, { entity: 'lab_order', id: oid });
  res.json({ ok: true });
});

// ───────── Radiology
r.get('/radiology/orders', A, auth.can('radiology'), (req, res) => {
  const where = ['ro.hospital_id = ?']; const p = [req.ctx.hid];
  if (req.query.status && req.query.status !== 'all') { where.push('ro.status = ?'); p.push(req.query.status); }
  if (req.query.modality) { where.push('ro.modality = ?'); p.push(req.query.modality); }
  res.json(db.all(`SELECT ro.*, p.full_name patient_name, p.uhid, p.gender, p.dob, d.name doctor_name, rr.impression, rr.findings
    FROM radiology_orders ro JOIN patients p ON p.id = ro.patient_id LEFT JOIN doctors d ON d.id = ro.doctor_id LEFT JOIN radiology_reports rr ON rr.order_id = ro.id
    WHERE ${where.join(' AND ')} ORDER BY ro.created_at DESC LIMIT 300`, ...p).map((x) => ({ ...x, age: ageFrom(x.dob) })));
});
r.get('/radiology/orders/:id', A, auth.canAny(['radiology', 'view'], ['doctor', 'view'], ['patients', 'view']), (req, res) => {
  const o = db.get(`SELECT ro.*, p.full_name patient_name, p.uhid, p.gender, p.dob, p.mobile, d.name doctor_name, rr.findings, rr.impression, rr.reported_at, rr.verified_at, ru.full_name reported_by_name, vu.full_name verified_by_name
    FROM radiology_orders ro JOIN patients p ON p.id = ro.patient_id LEFT JOIN doctors d ON d.id = ro.doctor_id LEFT JOIN radiology_reports rr ON rr.order_id = ro.id LEFT JOIN users ru ON ru.id = rr.reported_by LEFT JOIN users vu ON vu.id = rr.verified_by
    WHERE ro.id = ? AND ro.hospital_id = ?`, id(req.params.id), req.ctx.hid);
  if (!o) throw notFound('Radiology order');
  o.age = ageFrom(o.dob);
  res.json(o);
});
r.post('/radiology/orders', A, auth.can('radiology', 'add'), (req, res) => {
  const b = validate(req.body, { patient_id: 'required|int', modality: { required: true, enum: ['X-Ray', 'CT', 'MRI', 'Ultrasound', 'Other'] }, study: 'required|max:120', clinical_info: 'max:500', doctor_id: 'int', scheduled_at: 'datetime', price: 'number|min:0' });
  const out = db.tx(() => clinical.orderRadiology(req.ctx.hid, b, req.ctx.user.id));
  audit(req, 'radiology.ordered', { entity: 'radiology_order', id: out.id, ref: out.order_no });
  res.status(201).json(out);
});
r.post('/radiology/orders/:id/status', A, auth.can('radiology', 'edit'), (req, res) => {
  const b = validate(req.body, { status: { required: true, enum: ['scheduled', 'scanned', 'reported', 'verified', 'cancelled'] }, findings: 'max:8000', impression: 'max:2000', scheduled_at: 'datetime' });
  if (b.status === 'verified' && !req.ctx.can('radiology', 'approve')) throw bad('Verification requires approve permission');
  const oid = id(req.params.id);
  db.tx(() => clinical.radiologyStatus(req.ctx.hid, oid, b.status, { ...b, userId: req.ctx.user.id }));
  audit(req, `radiology.${b.status}`, { entity: 'radiology_order', id: oid });
  res.json({ ok: true });
});

module.exports = r;
