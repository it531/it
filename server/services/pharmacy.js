'use strict';
const db = require('../db');
const seq = require('../lib/sequence');
const billing = require('./billing');
const inventory = require('./inventory');
const { notify } = require('../lib/notify');
const { now, today, bad, notFound, conflict } = require('../lib/util');

const TRANSITIONS = {
  waiting: ['processing', 'ready', 'cancelled'],
  processing: ['ready', 'dispensed', 'cancelled', 'waiting'],
  ready: ['dispensed', 'cancelled', 'processing'],
  dispensed: [],
  cancelled: [],
};

function newOrder(hid, { prescription_id, patient_id, doctor_id, customer_name, source, items }, userId, at) {
  const t = at || now();
  const orderNo = seq.formatted(hid, 'pharmacy_order').value;
  const id = db.insertRow('pharmacy_orders', { hospital_id: hid, order_no: orderNo, prescription_id, patient_id, doctor_id, customer_name, source, status: 'waiting', created_at: t });
  for (const it of items) {
    const m = db.get('SELECT selling_price FROM medicines WHERE id = ? AND hospital_id = ?', it.medicine_id, hid);
    if (!m) throw bad('Unknown medicine');
    db.insertRow('pharmacy_order_items', { order_id: id, medicine_id: it.medicine_id, quantity: it.quantity, unit_price: m.selling_price, dose: it.dose, frequency: it.frequency, duration_days: it.duration_days, instructions: it.instructions });
  }
  const tok = seq.pharmacyToken(hid, t.slice(0, 10));
  db.insertRow('pharmacy_tokens', { hospital_id: hid, order_id: id, token_date: t.slice(0, 10), token_seq: tok.seq, token: tok.token });
  return { id, order_no: orderNo, token: tok.token };
}

// Automation: finalized prescription → pharmacy order + pharmacy token + alerts.
function createFromPrescription(hid, rxId, userId) {
  const rx = db.get('SELECT * FROM prescriptions WHERE id = ? AND hospital_id = ?', rxId, hid);
  const items = db.all('SELECT * FROM prescription_items WHERE prescription_id = ?', rxId);
  const order = newOrder(hid, { prescription_id: rxId, patient_id: rx.patient_id, doctor_id: rx.doctor_id, source: rx.admission_id ? 'ipd' : 'opd', items }, userId);
  const p = db.get('SELECT full_name, uhid FROM patients WHERE id = ?', rx.patient_id);
  notify({ hid, module: 'pharmacy', category: 'pharmacy', title: `New prescription · ${order.token}`, body: `${p.full_name} (${p.uhid}) · ${items.length} item(s)`, link: '/pharmacy' });
  notify({ hid, patientId: rx.patient_id, category: 'pharmacy', title: `Your pharmacy token is ${order.token}`, body: 'Your prescription has been sent to the pharmacy. We will notify you when medicines are ready.', link: '/portal' });
  return order;
}

function detail(hid, id) {
  const o = db.get(`SELECT o.*, t.token, p.full_name patient_name, p.uhid, p.mobile, p.dob, p.gender, d.name doctor_name, pr.rx_no
    FROM pharmacy_orders o LEFT JOIN pharmacy_tokens t ON t.order_id = o.id LEFT JOIN patients p ON p.id = o.patient_id
    LEFT JOIN doctors d ON d.id = o.doctor_id LEFT JOIN prescriptions pr ON pr.id = o.prescription_id
    WHERE o.id = ? AND o.hospital_id = ?`, id, hid);
  if (!o) throw notFound('Pharmacy order');
  o.items = db.all(`SELECT oi.*, m.name, m.strength, m.dosage_form, m.gst_rate,
      (SELECT COALESCE(SUM(qty),0) FROM medicine_batches b WHERE b.medicine_id = m.id AND b.expiry_date >= date('now','localtime')) stock
    FROM pharmacy_order_items oi JOIN medicines m ON m.id = oi.medicine_id WHERE oi.order_id = ?`, id);
  return o;
}

function queue(hid, date = today()) {
  const rows = db.all(`SELECT o.id, o.order_no, o.status, o.source, o.created_at, o.called_at, o.ready_at, o.dispensed_at, t.token, t.token_seq,
      COALESCE(p.full_name, o.customer_name) patient_name, p.uhid, d.name doctor_name,
      (SELECT COUNT(*) FROM pharmacy_order_items WHERE order_id = o.id) item_count
    FROM pharmacy_orders o JOIN pharmacy_tokens t ON t.order_id = o.id LEFT JOIN patients p ON p.id = o.patient_id LEFT JOIN doctors d ON d.id = o.doctor_id
    WHERE o.hospital_id = ? AND (t.token_date = ? OR o.status IN ('waiting','processing','ready')) ORDER BY t.token_date, t.token_seq`, hid, date);
  const serving = rows.filter((r) => r.status === 'processing').sort((a, b) => (b.called_at || '').localeCompare(a.called_at || ''))[0] || null;
  return { serving, waiting: rows.filter((r) => r.status === 'waiting'), processing: rows.filter((r) => r.status === 'processing'), ready: rows.filter((r) => r.status === 'ready'), dispensed: rows.filter((r) => r.status === 'dispensed'), all: rows };
}

function callNext(hid) {
  const q = queue(hid);
  const next = q.waiting[0];
  if (!next) throw conflict('No patients waiting at the pharmacy');
  setStatus(hid, next.id, 'processing');
  return next;
}

/**
 * Status machine. Dispensing is the critical automation: FEFO stock deduction,
 * stock movements, pharmacy invoice, low-stock alert check, patient notification.
 */
function setStatus(hid, id, status, { userId, quantities } = {}) {
  const o = detail(hid, id);
  if (!TRANSITIONS[o.status].includes(status)) throw conflict(`Cannot change order from ${o.status} to ${status}`);
  const t = now();
  if (status === 'processing') db.run('UPDATE pharmacy_orders SET status = ?, called_at = COALESCE(called_at, ?) WHERE id = ?', status, t, id);
  else if (status === 'ready') {
    db.run('UPDATE pharmacy_orders SET status = ?, ready_at = ? WHERE id = ?', status, t, id);
    if (o.patient_id) notify({ hid, patientId: o.patient_id, category: 'pharmacy', severity: 'success', title: `Your medicines are ready · ${o.token}`, body: 'Please collect them at the pharmacy counter.', link: '/portal' });
  } else if (status === 'cancelled') db.run('UPDATE pharmacy_orders SET status = ? WHERE id = ?', status, id);
  else if (status === 'dispensed') return dispense(hid, o, { userId, quantities });
  return detail(hid, id);
}

function dispense(hid, o, { userId, quantities = {} }) {
  const t = now();
  const lines = [];
  for (const it of o.items) {
    const q = quantities[it.id] !== undefined ? Math.max(0, Math.round(Number(quantities[it.id]))) : it.quantity;
    if (q > it.quantity) throw bad(`Cannot dispense more ${it.name} than prescribed`);
    if (q === 0) continue;
    inventory.consumeMedicine(hid, it.medicine_id, q, { movement: 'dispense', refType: 'pharmacy_order', refId: o.id, userId });
    db.run('UPDATE pharmacy_order_items SET dispensed_qty = ? WHERE id = ?', q, it.id);
    lines.push({ category: 'pharmacy', description: `${it.name} ${it.strength || ''}`.trim(), quantity: q, unit_price: it.unit_price, tax_rate: it.gst_rate, ref_type: 'medicine', ref_id: it.medicine_id });
  }
  if (!lines.length) throw bad('Nothing to dispense');
  let invoiceId = null;
  if (o.source === 'ipd' && o.prescription_id) {
    // IPD medicines are charged to the admission and billed at discharge.
    const rx = db.get('SELECT admission_id FROM prescriptions WHERE id = ?', o.prescription_id);
    for (const l of lines) db.insertRow('ipd_charges', { hospital_id: hid, admission_id: rx.admission_id, category: 'pharmacy', description: l.description, quantity: l.quantity, unit_price: l.unit_price, created_at: t, user_id: userId });
  } else {
    invoiceId = billing.createInvoice(hid, { patient_id: o.patient_id, customer_name: o.customer_name, bill_type: 'pharmacy', doctor_id: o.doctor_id, items: lines, userId });
  }
  db.run("UPDATE pharmacy_orders SET status = 'dispensed', dispensed_at = ?, dispensed_by = ?, invoice_id = ? WHERE id = ?", t, userId, invoiceId, o.id);
  inventory.checkAlerts(hid, o.items.map((i) => i.medicine_id));
  if (o.patient_id) notify({ hid, patientId: o.patient_id, category: 'pharmacy', severity: 'success', title: 'Medicines dispensed', body: `Order ${o.order_no} (${o.token}) has been dispensed.${invoiceId ? ' Your invoice is available in the portal.' : ''}`, link: '/portal' });
  return { ...detail(hid, o.id), invoice_id: invoiceId };
}

module.exports = { newOrder, createFromPrescription, detail, queue, callNext, setStatus, TRANSITIONS };
