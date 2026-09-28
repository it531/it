'use strict';
const express = require('express');
const db = require('../db');
const auth = require('../lib/auth');
const seq = require('../lib/sequence');
const hr = require('../services/hr');
const { encrypt, decrypt } = require('../lib/crypto');
const { audit } = require('../lib/audit');
const { validate, id } = require('../lib/validate');
const { now, today, diffDays, notFound, bad, conflict } = require('../lib/util');

const r = express.Router();
const H = (a = 'view') => [auth.authenticate, auth.can('hr', a)];
const PR = (a = 'view') => [auth.authenticate, auth.can('payroll', a)];

r.get('/hr/dashboard', ...H(), (req, res) => {
  const hid = req.ctx.hid; const t = today();
  const total = db.get("SELECT COUNT(*) c FROM employees WHERE hospital_id = ? AND status != 'exited'", hid).c;
  const att = db.get(`SELECT SUM(status='present') present, SUM(status='late') late, SUM(status='half_day') half_day, SUM(status='leave') on_leave, SUM(status='absent') absent FROM attendance WHERE hospital_id = ? AND date = ?`, hid, t);
  const marked = (att.present || 0) + (att.late || 0) + (att.half_day || 0) + (att.on_leave || 0) + (att.absent || 0);
  const pendingLeave = db.get("SELECT COUNT(*) c FROM leaves WHERE hospital_id = ? AND status = 'pending'", hid).c;
  const byDept = db.all("SELECT COALESCE(dp.name,'—') department, COUNT(*) employees FROM employees e LEFT JOIN departments dp ON dp.id = e.department_id WHERE e.hospital_id = ? AND e.status != 'exited' GROUP BY e.department_id ORDER BY employees DESC", hid);
  const trend = db.all("SELECT date day, SUM(status IN ('present','late','half_day')) present, SUM(status='absent') absent, SUM(status='leave') on_leave FROM attendance WHERE hospital_id = ? AND date >= date(?, '-13 day') GROUP BY date ORDER BY date", hid, t);
  const payroll = db.get('SELECT month, COALESCE(SUM(net_pay),0) net, COUNT(*) n FROM payroll WHERE hospital_id = ? GROUP BY month ORDER BY month DESC LIMIT 1', hid);
  res.json({ total, present: (att.present || 0) + (att.late || 0) + (att.half_day || 0), late: att.late || 0, on_leave: att.on_leave || 0, absent: (att.absent || 0) + Math.max(total - marked, 0), unmarked: Math.max(total - marked, 0), pending_leave: pendingLeave, by_department: byDept, trend, payroll });
});

// ───────── Employees
r.get('/hr/employees', ...H(), (req, res) => {
  const where = ['e.hospital_id = ?']; const p = [req.ctx.hid];
  if (req.query.department_id) { where.push('e.department_id = ?'); p.push(Number(req.query.department_id)); }
  if (req.query.q) { where.push('(e.full_name LIKE ? OR e.emp_code LIKE ? OR e.designation LIKE ?)'); p.push(...Array(3).fill(`%${req.query.q}%`)); }
  if (!req.query.all) where.push("e.status != 'exited'");
  res.json(db.all(`SELECT e.id, e.emp_code, e.full_name, e.designation, e.employment_type, e.joining_date, e.phone, e.email, e.shift, e.status, dp.name department, e.department_id,
      (SELECT status FROM attendance a WHERE a.employee_id = e.id AND a.date = date('now','localtime')) today_status
    FROM employees e LEFT JOIN departments dp ON dp.id = e.department_id WHERE ${where.join(' AND ')} ORDER BY e.full_name`, ...p));
});
r.get('/hr/employees/:id', ...H(), (req, res) => {
  const e = db.get('SELECT e.*, dp.name department, u.username FROM employees e LEFT JOIN departments dp ON dp.id = e.department_id LEFT JOIN users u ON u.id = e.user_id WHERE e.id = ? AND e.hospital_id = ?', id(req.params.id), req.ctx.hid);
  if (!e) throw notFound('Employee');
  const canSee = req.ctx.can('hr', 'edit');
  e.bank_account = canSee ? decrypt(e.bank_account_enc) : e.bank_account_last4 ? `XXXXXX${e.bank_account_last4}` : null;
  e.pan = canSee ? decrypt(e.pan_enc) : null;
  delete e.bank_account_enc; delete e.pan_enc;
  e.salary = db.get('SELECT * FROM salary_structures WHERE employee_id = ?', e.id);
  e.documents = db.all('SELECT id, doc_type, file_name, mime, size, created_at FROM employee_documents WHERE employee_id = ?', e.id);
  e.attendance = db.all('SELECT * FROM attendance WHERE employee_id = ? ORDER BY date DESC LIMIT 31', e.id);
  e.leaves = db.all('SELECT * FROM leaves WHERE employee_id = ? ORDER BY from_date DESC LIMIT 20', e.id);
  e.payroll = db.all('SELECT * FROM payroll WHERE employee_id = ? ORDER BY month DESC LIMIT 12', e.id);
  res.json(e);
});
const EMP = { full_name: 'required|max:120', department_id: 'int', designation: 'max:80', employment_type: { enum: ['full_time', 'part_time', 'contract', 'consultant'], default: 'full_time' }, joining_date: 'date', phone: 'mobile', email: 'email', address: 'max:300', emergency_contact: 'max:120', shift: 'max:40', bank_name: 'max:80', bank_account: { max: 20, pattern: '^\\d{6,20}$' }, ifsc: { max: 11, pattern: '^[A-Z]{4}0[A-Z0-9]{6}$' }, pan: { max: 10, pattern: '^[A-Z]{5}\\d{4}[A-Z]$' }, status: { enum: ['active', 'on_notice', 'exited'] }, user_id: 'int' };
function empRow(b) {
  const row = { ...b };
  if (b.bank_account !== undefined) { row.bank_account_enc = encrypt(b.bank_account); row.bank_account_last4 = b.bank_account ? b.bank_account.slice(-4) : null; }
  if (b.pan !== undefined) row.pan_enc = encrypt(b.pan);
  delete row.bank_account; delete row.pan;
  return row;
}
r.post('/hr/employees', ...H('add'), (req, res) => {
  const b = validate(req.body, EMP);
  if (b.department_id && !db.get('SELECT id FROM departments WHERE id = ? AND hospital_id = ?', b.department_id, req.ctx.hid)) throw bad('Invalid department');
  const out = db.tx(() => {
    const code = seq.formatted(req.ctx.hid, 'employee').value;
    const eid = db.insertRow('employees', { ...empRow(b), hospital_id: req.ctx.hid, emp_code: code, status: b.status || 'active', created_at: now() });
    if (req.body.salary) saveSalary(req.ctx.hid, eid, req.body.salary);
    return { id: eid, emp_code: code };
  });
  audit(req, 'hr.employee_created', { entity: 'employee', id: out.id, ref: out.emp_code });
  res.status(201).json(out);
});
r.put('/hr/employees/:id', ...H('edit'), (req, res) => {
  const eid = id(req.params.id);
  const b = validate(req.body, EMP, { partial: true });
  if (!db.get('SELECT id FROM employees WHERE id = ? AND hospital_id = ?', eid, req.ctx.hid)) throw notFound('Employee');
  db.tx(() => { db.updateRow('employees', eid, empRow(b)); if (req.body.salary) saveSalary(req.ctx.hid, eid, req.body.salary); });
  audit(req, 'hr.employee_updated', { entity: 'employee', id: eid, details: Object.keys(b).filter((k) => !['bank_account', 'pan'].includes(k)) });
  res.json({ ok: true });
});
function saveSalary(hid, eid, s) {
  const b = validate(s, { basic: 'required|number|min:0', hra: 'number|min:0', allowances: 'number|min:0', bonus: 'number|min:0', overtime_rate: 'number|min:0', pf_percent: 'number|min:0|max:30', esi_percent: 'number|min:0|max:10', professional_tax: 'number|min:0|max:2500', other_deductions: 'number|min:0' });
  const row = { basic: b.basic, hra: b.hra || 0, allowances: b.allowances || 0, bonus: b.bonus || 0, overtime_rate: b.overtime_rate || 0, pf_percent: b.pf_percent ?? 12, esi_percent: b.esi_percent ?? 0.75, professional_tax: b.professional_tax ?? 200, other_deductions: b.other_deductions || 0 };
  db.run(`INSERT INTO salary_structures (hospital_id, employee_id, basic, hra, allowances, bonus, overtime_rate, pf_percent, esi_percent, professional_tax, other_deductions, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(employee_id) DO UPDATE SET basic=excluded.basic, hra=excluded.hra, allowances=excluded.allowances, bonus=excluded.bonus, overtime_rate=excluded.overtime_rate, pf_percent=excluded.pf_percent, esi_percent=excluded.esi_percent, professional_tax=excluded.professional_tax, other_deductions=excluded.other_deductions, updated_at=excluded.updated_at`,
  hid, eid, row.basic, row.hra, row.allowances, row.bonus, row.overtime_rate, row.pf_percent, row.esi_percent, row.professional_tax, row.other_deductions, now());
}

// Documents are encrypted at rest; download requires hr:download.
r.post('/hr/employees/:id/documents', ...H('edit'), (req, res) => {
  const eid = id(req.params.id);
  if (!db.get('SELECT id FROM employees WHERE id = ? AND hospital_id = ?', eid, req.ctx.hid)) throw notFound('Employee');
  const b = validate(req.body, { doc_type: 'required|max:40', file_name: 'required|max:120', mime: 'max:80', content_base64: 'required' });
  const size = Math.floor(b.content_base64.length * 0.75);
  if (size > 5 * 1024 * 1024) throw bad('Document must be under 5 MB');
  if (b.mime && !/^(application\/pdf|image\/(png|jpeg|webp))$/.test(b.mime)) throw bad('Only PDF, PNG, JPEG or WEBP files are allowed');
  const did = db.insertRow('employee_documents', { hospital_id: req.ctx.hid, employee_id: eid, doc_type: b.doc_type, file_name: b.file_name, mime: b.mime, content_enc: encrypt(b.content_base64), size, uploaded_by: req.ctx.user.id, created_at: now() });
  audit(req, 'hr.document_uploaded', { entity: 'employee', id: eid, details: { doc_type: b.doc_type, file: b.file_name } });
  res.status(201).json({ id: did });
});
r.get('/hr/documents/:id', ...H('download'), (req, res) => {
  const d = db.get('SELECT * FROM employee_documents WHERE id = ? AND hospital_id = ?', id(req.params.id), req.ctx.hid);
  if (!d) throw notFound('Document');
  audit(req, 'hr.document_downloaded', { entity: 'employee', id: d.employee_id, details: { file: d.file_name } });
  res.setHeader('Content-Type', d.mime || 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${d.file_name.replace(/[^\w.-]/g, '_')}"`);
  res.send(Buffer.from(decrypt(d.content_enc), 'base64'));
});

// ───────── Attendance
r.get('/hr/attendance', ...H(), (req, res) => {
  const date = req.query.date || today();
  res.json(db.all(`SELECT e.id employee_id, e.emp_code, e.full_name, e.designation, e.shift default_shift, dp.name department, a.id, a.check_in, a.check_out, a.status, a.overtime_hours, a.shift, a.note
    FROM employees e LEFT JOIN departments dp ON dp.id = e.department_id LEFT JOIN attendance a ON a.employee_id = e.id AND a.date = ?
    WHERE e.hospital_id = ? AND e.status != 'exited' ORDER BY dp.name, e.full_name`, date, req.ctx.hid));
});
// Mark / check-in / check-out. Late mark auto-computed from shift start (+10 min grace).
r.post('/hr/attendance', ...H('edit'), (req, res) => {
  const b = validate(req.body, { employee_id: 'required|int', date: 'date', action: { enum: ['check_in', 'check_out', 'mark'], default: 'mark' }, status: { enum: ['present', 'absent', 'late', 'half_day', 'leave'] }, check_in: { pattern: '^\\d{2}:\\d{2}$' }, check_out: { pattern: '^\\d{2}:\\d{2}$' }, overtime_hours: 'number|min:0|max:16', note: 'max:200' });
  const e = db.get('SELECT * FROM employees WHERE id = ? AND hospital_id = ?', b.employee_id, req.ctx.hid);
  if (!e) throw notFound('Employee');
  const date = b.date || today();
  const hhmm = now().slice(11, 16);
  const ex = db.get('SELECT * FROM attendance WHERE employee_id = ? AND date = ?', e.id, date);
  const shiftStart = (String(e.shift || '').match(/(\d{2}):(\d{2})/) || [null, '09', '00']);
  const graceMin = Number(shiftStart[1]) * 60 + Number(shiftStart[2]) + 10;
  const toMin = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  let row;
  if (b.action === 'check_in') {
    if (ex && ex.check_in) throw conflict('Already checked in');
    const ci = b.check_in || hhmm;
    row = { check_in: ci, status: toMin(ci) > graceMin ? 'late' : 'present', shift: e.shift };
  } else if (b.action === 'check_out') {
    if (!ex || !ex.check_in) throw bad('Check in first');
    const co = b.check_out || hhmm;
    const worked = (toMin(co) - toMin(ex.check_in)) / 60;
    row = { check_out: co, overtime_hours: Math.max(0, Math.round((worked - 8) * 10) / 10), status: worked < 4.5 ? 'half_day' : ex.status };
  } else {
    if (!b.status) throw bad('Select a status');
    row = { status: b.status, check_in: b.check_in, check_out: b.check_out, overtime_hours: b.overtime_hours || 0, note: b.note, shift: e.shift };
  }
  if (ex) db.updateRow('attendance', ex.id, row);
  else db.insertRow('attendance', { hospital_id: req.ctx.hid, employee_id: e.id, date, status: 'present', ...row });
  audit(req, `hr.attendance_${b.action}`, { entity: 'employee', id: e.id, ref: e.emp_code, details: { date, ...row } });
  res.json({ ok: true });
});
r.post('/hr/attendance/bulk', ...H('edit'), (req, res) => {
  const b = validate(req.body, { date: 'required|date', status: { required: true, enum: ['present', 'absent'] }, employee_ids: 'required|array' });
  let n = 0;
  db.tx(() => {
    for (const eid of b.employee_ids) {
      if (!db.get('SELECT id FROM employees WHERE id = ? AND hospital_id = ?', Number(eid), req.ctx.hid)) continue;
      if (db.get('SELECT id FROM attendance WHERE employee_id = ? AND date = ?', Number(eid), b.date)) continue;
      db.insertRow('attendance', { hospital_id: req.ctx.hid, employee_id: Number(eid), date: b.date, status: b.status, check_in: b.status === 'present' ? '09:00' : null }); n++;
    }
  });
  audit(req, 'hr.attendance_bulk', { details: { date: b.date, status: b.status, count: n } });
  res.json({ marked: n });
});

// ───────── Leave
r.get('/hr/leaves', ...H(), (req, res) => {
  res.json(db.all(`SELECT l.*, e.full_name, e.emp_code, dp.name department, u.full_name approved_by_name FROM leaves l JOIN employees e ON e.id = l.employee_id LEFT JOIN departments dp ON dp.id = e.department_id LEFT JOIN users u ON u.id = l.approved_by
    WHERE l.hospital_id = ? ${req.query.status ? 'AND l.status = ?' : ''} ORDER BY CASE l.status WHEN 'pending' THEN 0 ELSE 1 END, l.from_date DESC LIMIT 200`, req.ctx.hid, ...(req.query.status ? [req.query.status] : [])));
});
r.post('/hr/leaves', ...H('add'), (req, res) => {
  const b = validate(req.body, { employee_id: 'required|int', leave_type: { required: true, enum: ['casual', 'sick', 'earned', 'unpaid'] }, from_date: 'required|date', to_date: 'required|date', half_day: 'bool', reason: 'max:300' });
  if (b.to_date < b.from_date) throw bad('End date is before start date');
  if (!db.get('SELECT id FROM employees WHERE id = ? AND hospital_id = ?', b.employee_id, req.ctx.hid)) throw notFound('Employee');
  const overlap = db.get("SELECT id FROM leaves WHERE employee_id = ? AND status != 'rejected' AND from_date <= ? AND to_date >= ?", b.employee_id, b.to_date, b.from_date);
  if (overlap) throw conflict('Overlapping leave request exists');
  const days = b.half_day ? 0.5 : diffDays(b.from_date, b.to_date) + 1;
  const lid = db.insertRow('leaves', { hospital_id: req.ctx.hid, employee_id: b.employee_id, leave_type: b.leave_type, from_date: b.from_date, to_date: b.to_date, days, reason: b.reason, created_at: now() });
  audit(req, 'hr.leave_requested', { entity: 'leave', id: lid, details: { days } });
  res.status(201).json({ id: lid });
});
// Approving leave writes 'leave' attendance for each day (excluded from LOP).
r.post('/hr/leaves/:id/decision', ...H('approve'), (req, res) => {
  const b = validate(req.body, { status: { required: true, enum: ['approved', 'rejected'] } });
  const l = db.get("SELECT * FROM leaves WHERE id = ? AND hospital_id = ? AND status = 'pending'", id(req.params.id), req.ctx.hid);
  if (!l) throw notFound('Pending leave');
  db.tx(() => {
    db.run('UPDATE leaves SET status = ?, approved_by = ? WHERE id = ?', b.status, req.ctx.user.id, l.id);
    if (b.status === 'approved' && l.leave_type !== 'unpaid') {
      for (let d = l.from_date; d <= l.to_date; d = require('../lib/util').addDays(d, 1)) {
        db.run("INSERT INTO attendance (hospital_id, employee_id, date, status, note) VALUES (?,?,?,'leave',?) ON CONFLICT(employee_id, date) DO UPDATE SET status = 'leave', note = excluded.note", req.ctx.hid, l.employee_id, d, `${l.leave_type} leave`);
      }
    }
  });
  audit(req, `hr.leave_${b.status}`, { entity: 'leave', id: l.id });
  res.json({ ok: true });
});

// ───────── Payroll
r.get('/payroll', ...PR(), (req, res) => {
  const month = req.query.month || today().slice(0, 7);
  const rows = db.all('SELECT p.*, e.emp_code, e.full_name, e.designation, dp.name department FROM payroll p JOIN employees e ON e.id = p.employee_id LEFT JOIN departments dp ON dp.id = e.department_id WHERE p.hospital_id = ? AND p.month = ? ORDER BY e.full_name', req.ctx.hid, month);
  const months = db.all('SELECT month, COUNT(*) n, SUM(net_pay) net, SUM(gross) gross FROM payroll WHERE hospital_id = ? GROUP BY month ORDER BY month DESC LIMIT 12', req.ctx.hid);
  const structures = db.all("SELECT e.id employee_id, e.emp_code, e.full_name, e.designation, s.* FROM employees e LEFT JOIN salary_structures s ON s.employee_id = e.id WHERE e.hospital_id = ? AND e.status != 'exited' ORDER BY e.full_name", req.ctx.hid);
  res.json({ month, rows, months, structures });
});
r.post('/payroll/run', ...PR('add'), (req, res) => {
  const b = validate(req.body, { month: { required: true, pattern: '^\\d{4}-\\d{2}$' } });
  if (b.month > today().slice(0, 7)) throw bad('Cannot run payroll for a future month');
  const n = db.tx(() => hr.runPayroll(req.ctx.hid, b.month));
  audit(req, 'payroll.processed', { details: { month: b.month, employees: n } });
  res.json({ processed: n });
});
r.post('/payroll/mark-paid', ...PR('approve'), (req, res) => {
  const b = validate(req.body, { month: { required: true, pattern: '^\\d{4}-\\d{2}$' } });
  const n = db.run("UPDATE payroll SET status = 'paid' WHERE hospital_id = ? AND month = ? AND status = 'processed'", req.ctx.hid, b.month).changes;
  audit(req, 'payroll.paid', { details: { month: b.month, employees: n } });
  res.json({ updated: Number(n) });
});
r.put('/payroll/structure/:employeeId', ...PR('edit'), (req, res) => {
  const eid = id(req.params.employeeId);
  if (!db.get('SELECT id FROM employees WHERE id = ? AND hospital_id = ?', eid, req.ctx.hid)) throw notFound('Employee');
  saveSalary(req.ctx.hid, eid, req.body);
  audit(req, 'payroll.structure_updated', { entity: 'employee', id: eid });
  res.json({ ok: true });
});
r.get('/payroll/:id/payslip', ...PR('print'), (req, res) => {
  const p = db.get(`SELECT p.*, e.emp_code, e.full_name, e.designation, e.joining_date, e.bank_name, e.bank_account_last4, e.ifsc, dp.name department FROM payroll p JOIN employees e ON e.id = p.employee_id LEFT JOIN departments dp ON dp.id = e.department_id WHERE p.id = ? AND p.hospital_id = ?`, id(req.params.id), req.ctx.hid);
  if (!p) throw notFound('Payslip');
  res.json(p);
});

module.exports = r;
