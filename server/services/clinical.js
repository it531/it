'use strict';
// IPD, laboratory and radiology workflows.
const db = require('../db');
const seq = require('../lib/sequence');
const billing = require('./billing');
const { notify } = require('../lib/notify');
const { now, today, diffDays, bad, notFound, conflict } = require('../lib/util');

// ───────────── IPD ─────────────
// Automation: IPD number (separate from UHID), bed → occupied, notifications.
function admit(hid, d, userId, at) {
  const patient = db.get('SELECT * FROM patients WHERE id = ? AND hospital_id = ?', d.patient_id, hid);
  if (!patient) throw notFound('Patient');
  const doctor = db.get('SELECT * FROM doctors WHERE id = ? AND hospital_id = ?', d.doctor_id, hid);
  if (!doctor) throw notFound('Doctor');
  const already = db.get("SELECT ipd_no FROM ipd_admissions WHERE hospital_id = ? AND patient_id = ? AND status = 'admitted'", hid, d.patient_id);
  if (already) throw conflict(`Patient is already admitted (${already.ipd_no})`);
  const bed = db.get('SELECT b.*, w.name ward_name FROM beds b JOIN wards w ON w.id = b.ward_id WHERE b.id = ? AND b.hospital_id = ?', d.bed_id, hid);
  if (!bed) throw notFound('Bed');
  if (!['available', 'reserved'].includes(bed.status)) throw conflict(`Bed ${bed.bed_no} is ${bed.status}`);
  const t = at || now();
  const { value: ipdNo } = seq.formatted(hid, 'ipd');
  const id = db.insertRow('ipd_admissions', { hospital_id: hid, ipd_no: ipdNo, patient_id: d.patient_id, doctor_id: d.doctor_id, department_id: d.department_id || doctor.department_id, bed_id: bed.id, nurse_user_id: d.nurse_user_id, visit_id: d.visit_id, admission_type: d.admission_type || 'planned', reason: d.reason, admitted_at: t, expected_discharge: d.expected_discharge, created_by: userId });
  db.run("UPDATE beds SET status = 'occupied', current_admission_id = ?, updated_at = ? WHERE id = ?", id, t, bed.id);
  if (!at) {
    notify({ hid, module: 'nursing', category: 'ipd', severity: d.admission_type === 'emergency' ? 'critical' : 'info', title: `New admission · ${bed.ward_name} ${bed.bed_no}`, body: `${patient.full_name} (${ipdNo}) under ${doctor.name}`, link: `/ipd/${id}` });
    notify({ hid, patientId: d.patient_id, category: 'ipd', title: `Admitted · ${ipdNo}`, body: `${bed.ward_name}, bed ${bed.bed_no}. Attending doctor: ${doctor.name}.`, link: '/portal/ipd' });
  }
  return { id, ipd_no: ipdNo };
}

function transferBed(hid, admissionId, bedId) {
  const a = db.get("SELECT * FROM ipd_admissions WHERE id = ? AND hospital_id = ? AND status = 'admitted'", admissionId, hid);
  if (!a) throw notFound('Active admission');
  const bed = db.get('SELECT * FROM beds WHERE id = ? AND hospital_id = ?', bedId, hid);
  if (!bed || bed.status !== 'available') throw conflict('Target bed is not available');
  const t = now();
  // Room charges up to the transfer are captured on the old ward.
  captureRoomCharges(hid, a, t);
  db.run("UPDATE beds SET status = 'cleaning', current_admission_id = NULL, updated_at = ? WHERE id = ?", t, a.bed_id);
  db.run("UPDATE beds SET status = 'occupied', current_admission_id = ?, updated_at = ? WHERE id = ?", a.id, t, bedId);
  db.run('UPDATE ipd_admissions SET bed_id = ? WHERE id = ?', bedId, a.id);
}

function captureRoomCharges(hid, a, until) {
  const ward = db.get('SELECT w.name, w.daily_rate, b.bed_no FROM beds b JOIN wards w ON w.id = b.ward_id WHERE b.id = ?', a.bed_id);
  const since = db.get("SELECT MAX(created_at) t FROM ipd_charges WHERE admission_id = ? AND category = 'room'", a.id).t || a.admitted_at;
  const days = Math.max(1, diffDays(since, until));
  if (ward && ward.daily_rate > 0) db.insertRow('ipd_charges', { hospital_id: hid, admission_id: a.id, category: 'room', description: `${ward.name} · bed ${ward.bed_no} (${days} day${days > 1 ? 's' : ''})`, quantity: days, unit_price: ward.daily_rate, created_at: until });
}

// Automation: discharge → room charges, IPD invoice, bed → cleaning, follow-up reminder, notification.
function discharge(hid, admissionId, d, userId, at) {
  const a = db.get("SELECT * FROM ipd_admissions WHERE id = ? AND hospital_id = ?", admissionId, hid);
  if (!a) throw notFound('Admission');
  if (a.status !== 'admitted') throw conflict('Patient is not currently admitted');
  const t = at || now();
  captureRoomCharges(hid, a, t);
  const charges = db.all('SELECT * FROM ipd_charges WHERE admission_id = ?', a.id);
  const invoiceId = billing.createInvoice(hid, { patient_id: a.patient_id, bill_type: 'ipd', admission_id: a.id, doctor_id: a.doctor_id, department_id: a.department_id, discount: d.discount || 0, created_at: t, userId,
    items: charges.map((c) => ({ category: c.category, description: c.description, quantity: c.quantity, unit_price: c.unit_price, ref_type: 'ipd_charge', ref_id: c.id })) });
  db.updateRow('ipd_admissions', a.id, { status: 'discharged', discharged_at: t, discharge_type: d.discharge_type || 'normal', final_diagnosis: d.final_diagnosis, discharge_summary: d.discharge_summary, discharge_advice: d.discharge_advice, follow_up_date: d.follow_up_date, invoice_id: invoiceId });
  db.run("UPDATE beds SET status = 'cleaning', current_admission_id = NULL, updated_at = ? WHERE id = ?", t, a.bed_id);
  db.run("UPDATE ipd_medications SET status = 'stopped', end_date = ? WHERE admission_id = ? AND status = 'active'", t.slice(0, 10), a.id);
  if (!at) {
    const inv = db.get('SELECT total FROM invoices WHERE id = ?', invoiceId);
    notify({ hid, patientId: a.patient_id, category: 'ipd', severity: 'success', title: 'Discharge summary available', body: `${a.ipd_no} discharged. Final bill ₹${inv.total.toLocaleString('en-IN')}.${d.follow_up_date ? ' Follow-up on ' + d.follow_up_date + '.' : ''}`, link: '/portal/ipd' });
    notify({ hid, module: 'ipd', category: 'ipd', title: 'Bed ready for cleaning', body: `Bed released by ${a.ipd_no}`, link: '/ipd/beds' });
  }
  return { invoice_id: invoiceId };
}

// ───────────── Laboratory ─────────────
const LAB_FLOW = { ordered: ['sample_collected', 'cancelled'], sample_collected: ['processing', 'cancelled'], processing: ['completed'], completed: ['verified', 'processing'], verified: [], cancelled: [] };

// Automation: lab order → lab queue + billing (OPD invoice or IPD charges).
function orderLab(hid, { patient_id, test_ids, visit_id, admission_id, doctor_id, priority = 'routine' }, userId, at) {
  if (!db.get('SELECT id FROM patients WHERE id = ? AND hospital_id = ?', patient_id, hid)) throw notFound('Patient');
  if (!test_ids || !test_ids.length) throw bad('Select at least one test');
  const t = at || now();
  const created = []; const items = [];
  for (const tid of test_ids) {
    const test = db.get('SELECT * FROM lab_tests WHERE id = ? AND hospital_id = ? AND is_active = 1', tid, hid);
    if (!test) throw notFound('Lab test');
    const no = seq.formatted(hid, 'lab').value;
    const id = db.insertRow('lab_orders', { hospital_id: hid, order_no: no, patient_id, test_id: test.id, visit_id, admission_id, doctor_id, priority, status: 'ordered', price: test.price, created_at: t });
    created.push({ id, order_no: no, test: test.name });
    if (admission_id) db.insertRow('ipd_charges', { hospital_id: hid, admission_id, category: 'lab', description: `Lab · ${test.name}`, quantity: 1, unit_price: test.price, created_at: t, user_id: userId });
    else items.push({ category: 'laboratory', description: test.name, quantity: 1, unit_price: test.price, ref_type: 'lab_order', ref_id: id });
  }
  if (items.length) {
    const invId = billing.createInvoice(hid, { patient_id, bill_type: 'laboratory', visit_id, doctor_id, items, created_at: t, userId });
    db.run(`UPDATE lab_orders SET invoice_id = ? WHERE id IN (${created.map(() => '?').join(',')})`, invId, ...created.map((c) => c.id));
  }
  if (!at) notify({ hid, module: 'laboratory', category: 'lab', severity: priority === 'stat' ? 'critical' : 'info', title: `${created.length} new lab test(s) ordered`, body: created.map((c) => c.test).join(', '), link: '/laboratory' });
  return created;
}

function labStatus(hid, id, status, { userId, results, remarks, sample_id } = {}, at) {
  const o = db.get('SELECT lo.*, lt.parameters, lt.name test_name FROM lab_orders lo JOIN lab_tests lt ON lt.id = lo.test_id WHERE lo.id = ? AND lo.hospital_id = ?', id, hid);
  if (!o) throw notFound('Lab order');
  if (!LAB_FLOW[o.status].includes(status)) throw conflict(`Cannot move from ${o.status} to ${status}`);
  const t = at || now();
  if (status === 'sample_collected') db.run('UPDATE lab_orders SET status=?, sample_id=?, collected_at=?, collected_by=? WHERE id=?', status, sample_id || `S${o.order_no.replace(/\D/g, '')}`, t, userId, id);
  else if (status === 'processing') db.run('UPDATE lab_orders SET status=?, technician_id=? WHERE id=?', status, userId, id);
  else if (status === 'completed') {
    if (!results || !results.length) throw bad('Enter results before completing');
    const params = JSON.parse(o.parameters || '[]');
    db.run('DELETE FROM lab_results WHERE lab_order_id = ?', id);
    for (const r of results) {
      const p = params.find((x) => x.name === r.parameter) || {};
      const v = Number(r.value);
      let flag = 'N';
      if (Number.isFinite(v) && p.ref_low !== undefined && v < p.ref_low) flag = 'L';
      if (Number.isFinite(v) && p.ref_high !== undefined && v > p.ref_high) flag = 'H';
      if (p.critical_low !== undefined && v < p.critical_low) flag = 'C';
      if (p.critical_high !== undefined && v > p.critical_high) flag = 'C';
      db.insertRow('lab_results', { lab_order_id: id, parameter: String(r.parameter).slice(0, 100), value: String(r.value ?? '').slice(0, 100), unit: p.unit, ref_range: p.ref_text || (p.ref_low !== undefined ? `${p.ref_low} – ${p.ref_high}` : null), flag });
    }
    db.run('UPDATE lab_orders SET status=?, completed_at=?, remarks=?, technician_id=COALESCE(technician_id, ?) WHERE id=?', status, t, remarks ?? null, userId, id);
  } else if (status === 'verified') {
    db.run('UPDATE lab_orders SET status=?, verified_at=?, verified_by=? WHERE id=?', status, t, userId, id);
    if (!at) {
      notify({ hid, patientId: o.patient_id, category: 'lab', severity: 'success', title: 'Your lab report is available', body: `${o.test_name} (${o.order_no})`, link: '/portal/reports' });
      const doc = o.doctor_id && db.get('SELECT user_id FROM doctors WHERE id = ?', o.doctor_id);
      const critical = db.get("SELECT COUNT(*) c FROM lab_results WHERE lab_order_id = ? AND flag = 'C'", id).c;
      if (doc && doc.user_id) notify({ hid, userId: doc.user_id, category: 'lab', severity: critical ? 'critical' : 'info', title: `${critical ? 'CRITICAL · ' : ''}Lab report ready: ${o.test_name}`, body: o.order_no, link: `/patients/${o.patient_id}` });
    }
  } else db.run('UPDATE lab_orders SET status=? WHERE id=?', status, id);
}

// ───────────── Radiology ─────────────
const RAD_FLOW = { ordered: ['scheduled', 'scanned', 'cancelled'], scheduled: ['scanned', 'cancelled'], scanned: ['reported'], reported: ['verified', 'scanned'], verified: [], cancelled: [] };
const RAD_PRICES = { 'X-Ray': 450, CT: 3500, MRI: 6500, Ultrasound: 1200, Other: 800 };

function orderRadiology(hid, { patient_id, modality, study, clinical_info, visit_id, admission_id, doctor_id, scheduled_at, price }, userId, at) {
  if (!db.get('SELECT id FROM patients WHERE id = ? AND hospital_id = ?', patient_id, hid)) throw notFound('Patient');
  const t = at || now();
  const amount = price ?? RAD_PRICES[modality] ?? 800;
  const no = seq.formatted(hid, 'radiology').value;
  const id = db.insertRow('radiology_orders', { hospital_id: hid, order_no: no, patient_id, doctor_id, visit_id, admission_id, modality, study, clinical_info, status: scheduled_at ? 'scheduled' : 'ordered', scheduled_at, price: amount, created_at: t });
  if (admission_id) db.insertRow('ipd_charges', { hospital_id: hid, admission_id, category: 'radiology', description: `${modality} · ${study}`, quantity: 1, unit_price: amount, created_at: t, user_id: userId });
  else {
    const inv = billing.createInvoice(hid, { patient_id, bill_type: 'radiology', visit_id, doctor_id, created_at: t, userId, items: [{ category: 'radiology', description: `${modality} · ${study}`, quantity: 1, unit_price: amount, ref_type: 'radiology_order', ref_id: id }] });
    db.run('UPDATE radiology_orders SET invoice_id = ? WHERE id = ?', inv, id);
  }
  if (!at) notify({ hid, module: 'radiology', category: 'radiology', title: `New ${modality} order`, body: `${study} · ${no}`, link: '/radiology' });
  return { id, order_no: no };
}

function radiologyStatus(hid, id, status, { userId, findings, impression, scheduled_at } = {}, at) {
  const o = db.get('SELECT * FROM radiology_orders WHERE id = ? AND hospital_id = ?', id, hid);
  if (!o) throw notFound('Radiology order');
  if (!RAD_FLOW[o.status].includes(status)) throw conflict(`Cannot move from ${o.status} to ${status}`);
  const t = at || now();
  if (status === 'scheduled') db.run('UPDATE radiology_orders SET status=?, scheduled_at=? WHERE id=?', status, scheduled_at || t, id);
  else if (status === 'scanned') db.run('UPDATE radiology_orders SET status=?, scanned_at=? WHERE id=?', status, t, id);
  else if (status === 'reported') {
    if (!findings || !impression) throw bad('Findings and impression are required');
    db.run('INSERT INTO radiology_reports (order_id, findings, impression, reported_by, reported_at) VALUES (?,?,?,?,?) ON CONFLICT(order_id) DO UPDATE SET findings=excluded.findings, impression=excluded.impression, reported_by=excluded.reported_by, reported_at=excluded.reported_at', id, findings, impression, userId, t);
    db.run('UPDATE radiology_orders SET status=? WHERE id=?', status, id);
  } else if (status === 'verified') {
    db.run('UPDATE radiology_reports SET verified_by=?, verified_at=? WHERE order_id=?', userId, t, id);
    db.run('UPDATE radiology_orders SET status=? WHERE id=?', status, id);
    if (!at) notify({ hid, patientId: o.patient_id, category: 'radiology', severity: 'success', title: 'Your radiology report is available', body: `${o.modality} · ${o.study}`, link: '/portal/reports' });
  } else db.run('UPDATE radiology_orders SET status=? WHERE id=?', status, id);
}

module.exports = { admit, transferBed, discharge, orderLab, labStatus, orderRadiology, radiologyStatus, LAB_FLOW, RAD_FLOW, RAD_PRICES, today };
