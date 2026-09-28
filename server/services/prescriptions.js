'use strict';
const db = require('../db');
const seq = require('../lib/sequence');
const pharmacy = require('./pharmacy');
const opd = require('./opd');
const { notify } = require('../lib/notify');
const { now, bad, notFound, conflict } = require('../lib/util');

// Doses per day for common Indian prescription shorthand.
const FREQ = { OD: 1, QD: 1, HS: 1, BD: 2, BID: 2, TDS: 3, TID: 3, QID: 4, Q6H: 4, Q8H: 3, Q12H: 2, STAT: 1, SOS: 0, WEEKLY: 1 / 7 };
function dosesPerDay(freq) {
  if (!freq) return 1;
  const f = String(freq).toUpperCase().replace(/\s+/g, '');
  if (/^\d(-\d){2,3}$/.test(f)) return f.split('-').reduce((s, x) => s + Number(x), 0);   // 1-0-1
  return FREQ[f] ?? 1;
}
function suggestQuantity({ frequency, duration_days }) {
  const q = Math.ceil(dosesPerDay(frequency) * (Number(duration_days) || 1));
  return Math.max(q, 1);
}

function forVisit(hid, visitId) {
  const rx = db.get("SELECT * FROM prescriptions WHERE hospital_id = ? AND visit_id = ? AND status != 'cancelled' ORDER BY id DESC", hid, visitId);
  if (rx) rx.items = items(rx.id);
  return rx;
}
function items(rxId) {
  return db.all(`SELECT pi.*, m.name, m.strength, m.dosage_form, m.generic_name,
      (SELECT COALESCE(SUM(qty),0) FROM medicine_batches b WHERE b.medicine_id = m.id AND b.expiry_date >= date('now','localtime')) stock
    FROM prescription_items pi JOIN medicines m ON m.id = pi.medicine_id WHERE pi.prescription_id = ? ORDER BY pi.sort_order, pi.id`, rxId);
}

/** Save (autosave) a draft prescription for a visit. items: [{medicine_id, dose, frequency, duration_days, route, instructions, quantity, confirmed}] */
function saveDraft(hid, visitId, { items: list = [], notes, template_id }, userId) {
  const visit = db.get('SELECT * FROM opd_visits WHERE id = ? AND hospital_id = ?', visitId, hid);
  if (!visit) throw notFound('Visit');
  let rx = db.get("SELECT * FROM prescriptions WHERE hospital_id = ? AND visit_id = ? AND status != 'cancelled' ORDER BY id DESC", hid, visitId);
  if (rx && rx.status === 'finalized') throw conflict('Prescription is already finalized');
  const t = now();
  if (!rx) {
    const id = db.insertRow('prescriptions', { hospital_id: hid, visit_id: visitId, patient_id: visit.patient_id, doctor_id: visit.doctor_id, status: 'draft', notes, template_id, created_at: t, updated_at: t });
    rx = { id };
  } else db.run('UPDATE prescriptions SET notes = ?, template_id = COALESCE(?, template_id), updated_at = ? WHERE id = ?', notes ?? null, template_id ?? null, t, rx.id);
  db.run('DELETE FROM prescription_items WHERE prescription_id = ?', rx.id);
  list.forEach((it, i) => {
    const m = db.get('SELECT id FROM medicines WHERE id = ? AND hospital_id = ?', Number(it.medicine_id), hid);
    if (!m) throw bad('Unknown medicine in prescription');
    const qty = Number(it.quantity) > 0 ? Math.round(Number(it.quantity)) : suggestQuantity(it);
    db.insertRow('prescription_items', { prescription_id: rx.id, medicine_id: m.id, dose: s(it.dose), frequency: s(it.frequency), duration_days: Number(it.duration_days) || null, route: s(it.route), instructions: s(it.instructions), quantity: qty, confirmed: it.confirmed ? 1 : 0, sort_order: i });
  });
  return rx.id;
}
const s = (v) => (v === undefined || v === null ? null : String(v).slice(0, 300));

/**
 * Finalize: every line must have been explicitly reviewed by the doctor (confirmed=1),
 * with dose, frequency, duration and route. Automations: Rx number, pharmacy order,
 * pharmacy token, patient notification, visit completion, follow-up reminder scheduling.
 */
function finalize(hid, visitId, ctx, { sendToPharmacy = true } = {}) {
  const rx = forVisit(hid, visitId);
  if (!rx) throw bad('Nothing to finalize — add at least one medicine or save a draft');
  if (rx.status === 'finalized') throw conflict('Prescription already finalized');
  const visit = db.get('SELECT * FROM opd_visits WHERE id = ?', visitId);
  if (ctx.doctorId && ctx.doctorId !== visit.doctor_id && !ctx.can('doctor', 'approve')) throw bad('Only the treating doctor can finalize this prescription');
  for (const it of rx.items) {
    if (!it.confirmed) throw bad(`Please review and confirm ${it.name} before finalizing`);
    if (!it.dose || !it.frequency || !it.route || !(it.duration_days > 0)) throw bad(`${it.name}: dose, frequency, duration and route are required`);
  }
  const t = now();
  const rxNo = seq.formatted(hid, 'rx').value;
  db.run("UPDATE prescriptions SET status = 'finalized', rx_no = ?, finalized_at = ?, finalized_by = ?, updated_at = ? WHERE id = ?", rxNo, t, ctx.user.id, t, rx.id);
  let order = null;
  if (rx.items.length && sendToPharmacy) order = pharmacy.createFromPrescription(hid, rx.id, ctx.user.id);
  opd.setStatus(hid, visitId, 'completed');
  notify({ hid, patientId: visit.patient_id, category: 'opd', severity: 'success', title: 'Your prescription is ready', body: order ? `Sent to pharmacy. Your pharmacy token is ${order.token}.` : `Prescription ${rxNo} is available in your portal.`, link: '/portal/prescriptions' });
  return { rx_no: rxNo, prescription_id: rx.id, pharmacy_order: order };
}

module.exports = { forVisit, items, saveDraft, finalize, suggestQuantity, dosesPerDay };
