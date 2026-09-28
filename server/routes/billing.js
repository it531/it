'use strict';
const express = require('express');
const db = require('../db');
const auth = require('../lib/auth');
const billing = require('../services/billing');
const { audit } = require('../lib/audit');
const { validate, id } = require('../lib/validate');
const { today, notFound, bad, conflict } = require('../lib/util');

const r = express.Router();
const B = (a = 'view') => [auth.authenticate, auth.can('billing', a)];

r.get('/billing/summary', ...B(), (req, res) => {
  const hid = req.ctx.hid; const t = today();
  const s = db.get(`SELECT
      (SELECT COALESCE(SUM(CASE WHEN kind='payment' THEN amount ELSE -amount END),0) FROM payments WHERE hospital_id = ? AND substr(created_at,1,10) = ?) collected_today,
      (SELECT COALESCE(SUM(total),0) FROM invoices WHERE hospital_id = ? AND substr(created_at,1,10) = ? AND status != 'cancelled') billed_today,
      (SELECT COALESCE(SUM(balance),0) FROM invoices WHERE hospital_id = ? AND status IN ('unpaid','partial')) outstanding,
      (SELECT COUNT(*) FROM invoices WHERE hospital_id = ? AND status IN ('unpaid','partial')) open_invoices,
      (SELECT COALESCE(SUM(amount),0) FROM payments WHERE hospital_id = ? AND kind='refund' AND substr(created_at,1,7) = ?) refunds_month`, hid, t, hid, t, hid, hid, hid, t.slice(0, 7));
  const modes = db.all("SELECT method, ROUND(SUM(amount),2) amount FROM payments WHERE hospital_id = ? AND kind='payment' AND substr(created_at,1,10) = ? GROUP BY method", hid, t);
  res.json({ ...s, modes });
});

r.get('/billing/invoices', ...B(), (req, res) => {
  const q = req.query; const where = ['i.hospital_id = ?']; const p = [req.ctx.hid];
  if (q.status === 'outstanding') where.push("i.status IN ('unpaid','partial')");
  else if (q.status) { where.push('i.status = ?'); p.push(q.status); }
  if (q.bill_type) { where.push('i.bill_type = ?'); p.push(q.bill_type); }
  if (q.patient_id) { where.push('i.patient_id = ?'); p.push(Number(q.patient_id)); }
  if (q.from) { where.push('i.created_at >= ?'); p.push(q.from); }
  if (q.to) { where.push('i.created_at <= ?'); p.push(`${q.to} 23:59:59`); }
  if (q.q) { where.push('(i.invoice_no LIKE ? OR p.full_name LIKE ? OR p.uhid LIKE ? OR p.mobile LIKE ? OR i.customer_name LIKE ?)'); p.push(...Array(5).fill(`%${q.q}%`)); }
  res.json(db.all(`SELECT i.*, COALESCE(p.full_name, i.customer_name) patient_name, p.uhid, p.mobile, d.name doctor_name FROM invoices i LEFT JOIN patients p ON p.id = i.patient_id LEFT JOIN doctors d ON d.id = i.doctor_id
    WHERE ${where.join(' AND ')} ORDER BY i.id DESC LIMIT ${Math.min(Number(q.limit) || 200, 1000)}`, ...p));
});
r.get('/billing/invoices/:id', auth.authenticate, auth.canAny(['billing', 'view'], ['pharmacy', 'view']), (req, res) => res.json(billing.invoiceDetail(req.ctx.hid, id(req.params.id))));

// Manual invoice: procedures, packages, misc services.
r.post('/billing/invoices', ...B('add'), (req, res) => {
  const b = validate(req.body, { patient_id: 'required|int', bill_type: { required: true, enum: ['opd', 'procedure', 'package', 'laboratory', 'radiology', 'other'] }, doctor_id: 'int', items: 'required|array', discount: 'number|min:0', notes: 'max:300' });
  if (!db.get('SELECT id FROM patients WHERE id = ? AND hospital_id = ?', b.patient_id, req.ctx.hid)) throw notFound('Patient');
  if (b.doctor_id && !db.get('SELECT id FROM doctors WHERE id = ? AND hospital_id = ?', b.doctor_id, req.ctx.hid)) throw bad('Invalid doctor');
  if (b.discount && !req.ctx.can('billing', 'approve')) throw bad('Discounts require billing approval permission');
  const items = b.items.map((i) => validate(i, { category: 'max:30', description: 'required|max:200', quantity: 'number|min:0.01', unit_price: 'required|number|min:0' }));
  const dept = b.doctor_id ? db.get('SELECT department_id FROM doctors WHERE id = ?', b.doctor_id).department_id : null;
  const iid = db.tx(() => billing.createInvoice(req.ctx.hid, { ...b, department_id: dept, items: items.map((i) => ({ ...i, category: i.category || b.bill_type })), userId: req.ctx.user.id }));
  const inv = db.get('SELECT invoice_no, total FROM invoices WHERE id = ?', iid);
  audit(req, 'billing.invoice_created', { entity: 'invoice', id: iid, ref: inv.invoice_no, details: { total: inv.total } });
  res.status(201).json({ id: iid, invoice_no: inv.invoice_no });
});

r.post('/billing/invoices/:id/payments', ...B('add'), (req, res) => {
  const iid = id(req.params.id);
  const b = validate(req.body, { amount: 'required|number|min:0.01', method: { required: true, enum: billing.METHODS }, reference: 'max:60', note: 'max:200' });
  if (['upi', 'card', 'bank_transfer'].includes(b.method) && !b.reference) throw bad('Transaction reference is required for UPI / card / bank transfer');
  const out = db.tx(() => billing.recordPayment(req.ctx.hid, iid, { ...b, userId: req.ctx.user.id }));
  audit(req, 'billing.payment', { entity: 'invoice', id: iid, ref: out.receipt_no, details: { amount: b.amount, method: b.method, invoice: out.invoice.invoice_no } });
  res.status(201).json(out);
});
r.post('/billing/invoices/:id/refund', ...B('approve'), (req, res) => {
  const iid = id(req.params.id);
  const b = validate(req.body, { amount: 'required|number|min:0.01', method: { enum: billing.METHODS, default: 'cash' }, reason: 'required|max:200' });
  const out = db.tx(() => billing.refund(req.ctx.hid, iid, { ...b, userId: req.ctx.user.id }));
  audit(req, 'billing.refund', { entity: 'invoice', id: iid, ref: out.receipt_no, details: b });
  res.status(201).json(out);
});
r.post('/billing/invoices/:id/discount', ...B('approve'), (req, res) => {
  const iid = id(req.params.id);
  const b = validate(req.body, { discount: 'required|number|min:0', reason: 'required|max:200' });
  const inv = db.get('SELECT * FROM invoices WHERE id = ? AND hospital_id = ?', iid, req.ctx.hid);
  if (!inv) throw notFound('Invoice');
  if (b.discount > inv.subtotal) throw bad('Discount cannot exceed invoice amount');
  if (inv.subtotal - b.discount < inv.paid) throw conflict('Discount would make the invoice less than the amount already paid — issue a refund instead');
  db.tx(() => { db.run('UPDATE invoices SET discount = ?, notes = ? WHERE id = ?', b.discount, `Discount: ${b.reason}`, iid); billing.recompute(iid); });
  audit(req, 'billing.discount', { entity: 'invoice', id: iid, ref: inv.invoice_no, details: b });
  res.json({ ok: true });
});
r.post('/billing/invoices/:id/cancel', ...B('approve'), (req, res) => {
  const iid = id(req.params.id);
  const inv = db.get('SELECT * FROM invoices WHERE id = ? AND hospital_id = ?', iid, req.ctx.hid);
  if (!inv) throw notFound('Invoice');
  if (inv.paid - inv.refunded > 0) throw conflict('Refund collected payments before cancelling');
  db.run("UPDATE invoices SET status = 'cancelled', balance = 0 WHERE id = ?", iid);
  audit(req, 'billing.invoice_cancelled', { entity: 'invoice', id: iid, ref: inv.invoice_no, details: { reason: req.body && req.body.reason } });
  res.json({ ok: true });
});
// Insurance claim tracking on an invoice.
r.post('/billing/invoices/:id/insurance', auth.authenticate, auth.canAny(['insurance', 'edit'], ['billing', 'approve']), (req, res) => {
  const iid = id(req.params.id);
  const b = validate(req.body, { insurance_claim_amount: 'required|number|min:0', insurance_claim_status: { required: true, enum: ['none', 'submitted', 'approved', 'rejected', 'settled'] } });
  if (!db.updateRow('invoices', iid, b, 'AND hospital_id = ?', req.ctx.hid)) throw notFound('Invoice');
  audit(req, 'insurance.claim_updated', { entity: 'invoice', id: iid, details: b });
  res.json({ ok: true });
});
r.get('/insurance/claims', auth.authenticate, auth.canAny(['insurance', 'view'], ['billing', 'view']), (req, res) => {
  res.json(db.all(`SELECT i.id, i.invoice_no, i.bill_type, i.total, i.balance, i.insurance_claim_amount, i.insurance_claim_status, i.created_at, p.full_name patient_name, p.uhid, p.insurance_provider, p.insurance_policy_no
    FROM invoices i JOIN patients p ON p.id = i.patient_id WHERE i.hospital_id = ? AND (i.insurance_claim_status IS NOT NULL AND i.insurance_claim_status != 'none' OR (p.insurance_provider IS NOT NULL AND i.bill_type = 'ipd')) ORDER BY i.id DESC LIMIT 200`, req.ctx.hid));
});

r.get('/billing/payments', ...B(), (req, res) => {
  const date = req.query.date;
  res.json(db.all(`SELECT py.*, i.invoice_no, COALESCE(p.full_name, i.customer_name) patient_name, p.uhid, u.full_name user_name FROM payments py JOIN invoices i ON i.id = py.invoice_id LEFT JOIN patients p ON p.id = py.patient_id LEFT JOIN users u ON u.id = py.user_id
    WHERE py.hospital_id = ? ${date ? 'AND substr(py.created_at,1,10) = ?' : ''} ORDER BY py.id DESC LIMIT 300`, req.ctx.hid, ...(date ? [date] : [])));
});
r.get('/billing/payments/:id', auth.authenticate, auth.canAny(['billing', 'view'], ['pharmacy', 'view']), (req, res) => {
  const p = db.get(`SELECT py.*, i.invoice_no, i.total, i.balance, i.bill_type, COALESCE(pt.full_name, i.customer_name) patient_name, pt.uhid, pt.mobile, u.full_name user_name FROM payments py JOIN invoices i ON i.id = py.invoice_id LEFT JOIN patients pt ON pt.id = py.patient_id LEFT JOIN users u ON u.id = py.user_id WHERE py.id = ? AND py.hospital_id = ?`, id(req.params.id), req.ctx.hid);
  if (!p) throw notFound('Receipt');
  res.json(p);
});

module.exports = r;
