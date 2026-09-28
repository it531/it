'use strict';
const db = require('../db');
const seq = require('../lib/sequence');
const { notify } = require('../lib/notify');
const { now, round2, bad, notFound, conflict } = require('../lib/util');

const METHODS = ['cash', 'upi', 'card', 'bank_transfer', 'other'];

/**
 * Create an invoice with items. items: [{ category, description, quantity, unit_price, tax_rate, ref_type, ref_id }]
 * Prices are GST-inclusive; tax holds the included GST component for reporting.
 */
function createInvoice(hid, { patient_id, customer_name, bill_type, visit_id, admission_id, doctor_id, department_id, items, discount = 0, notes, created_at, userId }) {
  if (!items || !items.length) throw bad('An invoice needs at least one item');
  const no = seq.formatted(hid, 'invoice').value;
  const t = created_at || now();
  const id = db.insertRow('invoices', { hospital_id: hid, invoice_no: no, patient_id, customer_name, bill_type, visit_id, admission_id, doctor_id, department_id, discount: round2(discount), notes, created_by: userId, created_at: t, status: 'unpaid' });
  for (const it of items) addItem(id, it);
  recompute(id);
  return id;
}

function addItem(invoiceId, it) {
  const qty = Number(it.quantity ?? 1); const price = Number(it.unit_price ?? 0);
  if (!(qty > 0) || price < 0) throw bad('Invalid invoice item quantity or price');
  db.insertRow('invoice_items', { invoice_id: invoiceId, category: it.category || 'other', description: it.description, quantity: qty, unit_price: round2(price), tax_rate: Number(it.tax_rate || 0), amount: round2(qty * price), ref_type: it.ref_type, ref_id: it.ref_id });
}

// Automation: totals, balance and status are always derived from items + payments.
function recompute(invoiceId) {
  const inv = db.get('SELECT * FROM invoices WHERE id = ?', invoiceId);
  const items = db.all('SELECT amount, tax_rate FROM invoice_items WHERE invoice_id = ?', invoiceId);
  const subtotal = round2(items.reduce((s, i) => s + i.amount, 0));
  const tax = round2(items.reduce((s, i) => s + (i.tax_rate ? i.amount - i.amount / (1 + i.tax_rate / 100) : 0), 0));
  const discount = Math.min(inv.discount || 0, subtotal);
  const total = round2(subtotal - discount);
  const p = db.get("SELECT COALESCE(SUM(CASE WHEN kind='payment' THEN amount END),0) paid, COALESCE(SUM(CASE WHEN kind='refund' THEN amount END),0) refunded FROM payments WHERE invoice_id = ?", invoiceId);
  const balance = round2(Math.max(total - p.paid, 0));
  let status = inv.status === 'cancelled' ? 'cancelled' : p.paid <= 0 ? 'unpaid' : balance > 0 ? 'partial' : 'paid';
  if (p.refunded > 0 && p.refunded >= p.paid) status = 'refunded';
  db.run('UPDATE invoices SET subtotal=?, tax=?, discount=?, total=?, paid=?, refunded=?, balance=?, status=? WHERE id=?', subtotal, tax, discount, total, round2(p.paid), round2(p.refunded), balance, status, invoiceId);
  return db.get('SELECT * FROM invoices WHERE id = ?', invoiceId);
}

function recordPayment(hid, invoiceId, { amount, method, reference, note, userId, created_at }) {
  const inv = db.get('SELECT * FROM invoices WHERE id = ? AND hospital_id = ?', invoiceId, hid);
  if (!inv) throw notFound('Invoice');
  if (inv.status === 'cancelled') throw conflict('Invoice is cancelled');
  amount = round2(amount);
  if (!(amount > 0)) throw bad('Amount must be greater than zero');
  if (!METHODS.includes(method)) throw bad('Invalid payment method');
  if (amount > inv.balance + 0.001) throw bad(`Amount exceeds outstanding balance of ₹${inv.balance}`);
  const receipt = seq.formatted(hid, 'receipt').value;
  const pid = db.insertRow('payments', { hospital_id: hid, receipt_no: receipt, invoice_id: invoiceId, patient_id: inv.patient_id, kind: 'payment', amount, method, reference, note, user_id: userId, created_at: created_at || now() });
  const updated = recompute(invoiceId);
  if (inv.patient_id && !created_at) {
    notify({ hid, patientId: inv.patient_id, category: 'billing', severity: 'success', title: `Payment of ₹${amount.toLocaleString('en-IN')} received`, body: `Receipt ${receipt} for invoice ${inv.invoice_no}. Balance ₹${updated.balance.toLocaleString('en-IN')}.`, link: '/portal/bills' });
  }
  return { id: pid, receipt_no: receipt, invoice: updated };
}

function refund(hid, invoiceId, { amount, method, reason, userId }) {
  const inv = db.get('SELECT * FROM invoices WHERE id = ? AND hospital_id = ?', invoiceId, hid);
  if (!inv) throw notFound('Invoice');
  amount = round2(amount);
  const refundable = round2(inv.paid - inv.refunded);
  if (!(amount > 0)) throw bad('Refund amount must be greater than zero');
  if (amount > refundable + 0.001) throw bad(`Refund exceeds refundable amount of ₹${refundable}`);
  if (!reason) throw bad('A reason is required for refunds');
  const receipt = seq.formatted(hid, 'receipt').value;
  const id = db.insertRow('payments', { hospital_id: hid, receipt_no: receipt, invoice_id: invoiceId, patient_id: inv.patient_id, kind: 'refund', amount, method: method || 'cash', note: reason, user_id: userId, created_at: now() });
  recompute(invoiceId);
  return { id, receipt_no: receipt };
}

function invoiceDetail(hid, id) {
  const inv = db.get(`SELECT i.*, p.full_name patient_name, p.uhid, p.mobile, p.gender, p.dob, d.name doctor_name, dp.name department_name
    FROM invoices i LEFT JOIN patients p ON p.id = i.patient_id LEFT JOIN doctors d ON d.id = i.doctor_id LEFT JOIN departments dp ON dp.id = i.department_id
    WHERE i.id = ? AND i.hospital_id = ?`, id, hid);
  if (!inv) throw notFound('Invoice');
  inv.items = db.all('SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY id', id);
  inv.payments = db.all('SELECT py.*, u.full_name user_name FROM payments py LEFT JOIN users u ON u.id = py.user_id WHERE py.invoice_id = ? ORDER BY py.id', id);
  return inv;
}

module.exports = { createInvoice, addItem, recompute, recordPayment, refund, invoiceDetail, METHODS };
