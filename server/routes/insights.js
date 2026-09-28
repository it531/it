'use strict';
// Dashboard (personalised), analytics, MIS reports & exports, global search,
// notification centre, and Deep Assist.
const express = require('express');
const db = require('../db');
const auth = require('../lib/auth');
const reports = require('../services/reports');
const assistant = require('../services/assistant');
const opd = require('../services/opd');
const { forUser, markRead } = require('../lib/notify');
const { audit } = require('../lib/audit');
const { validate, id } = require('../lib/validate');
const { today, addDays, range, round2, ageFrom, notFound, forbidden, bad, now } = require('../lib/util');

const r = express.Router();
const A = auth.authenticate;

// Dashboard blocks are included only when the user can view the underlying module,
// so the same endpoint powers every personalised dashboard.
r.get('/dashboard', A, auth.hospital, (req, res) => {
  const { ctx } = req; const hid = ctx.hid; const t = today();
  const out = { date: t, blocks: [] };
  const can = (m) => ctx.can(m, 'view');
  const one = (sql, ...p) => db.get(sql, ...p);

  if (can('patients') || can('opd') || can('mis')) {
    out.today = one(`SELECT
      (SELECT COUNT(DISTINCT patient_id) FROM opd_visits WHERE hospital_id = ? AND visit_date = ?) + (SELECT COUNT(*) FROM ipd_admissions WHERE hospital_id = ? AND substr(admitted_at,1,10) = ?) total_patients,
      (SELECT COUNT(*) FROM patients WHERE hospital_id = ? AND substr(created_at,1,10) = ?) new_patients,
      (SELECT COUNT(*) FROM opd_visits WHERE hospital_id = ? AND visit_date = ? AND status != 'cancelled') opd_patients,
      (SELECT COUNT(*) FROM ipd_admissions WHERE hospital_id = ? AND status = 'admitted') ipd_patients,
      (SELECT COUNT(*) FROM appointments WHERE hospital_id = ? AND substr(scheduled_at,1,10) = ? AND status != 'cancelled') appointments,
      (SELECT COUNT(*) FROM opd_visits WHERE hospital_id = ? AND visit_date = ? AND visit_type = 'emergency') emergency,
      (SELECT COUNT(*) FROM pharmacy_orders WHERE hospital_id = ? AND status IN ('waiting','processing','ready')) pending_prescriptions,
      (SELECT COUNT(*) FROM pharmacy_orders WHERE hospital_id = ? AND substr(created_at,1,10) = ?) pharmacy_orders`, hid, t, hid, t, hid, t, hid, t, hid, hid, t, hid, t, hid, hid, t);
    out.yesterday = one(`SELECT (SELECT COUNT(*) FROM opd_visits WHERE hospital_id = ? AND visit_date = ?) opd_patients, (SELECT COUNT(*) FROM patients WHERE hospital_id = ? AND substr(created_at,1,10) = ?) new_patients`, hid, addDays(t, -1), hid, addDays(t, -1));
  }
  if (can('billing') || can('mis') || can('accounts')) {
    out.finance = one(`SELECT
      (SELECT COALESCE(SUM(CASE WHEN kind='payment' THEN amount ELSE -amount END),0) FROM payments WHERE hospital_id = ? AND substr(created_at,1,10) = ?) revenue_today,
      (SELECT COALESCE(SUM(CASE WHEN kind='payment' THEN amount ELSE -amount END),0) FROM payments WHERE hospital_id = ? AND substr(created_at,1,10) = ?) revenue_yesterday,
      (SELECT COALESCE(SUM(CASE WHEN kind='payment' THEN amount ELSE -amount END),0) FROM payments WHERE hospital_id = ? AND substr(created_at,1,7) = ?) revenue_month,
      (SELECT COALESCE(SUM(balance),0) FROM invoices WHERE hospital_id = ? AND status IN ('unpaid','partial')) outstanding`, hid, t, hid, addDays(t, -1), hid, t.slice(0, 7), hid);
    out.revenue_trend = db.all(`SELECT substr(created_at,1,10) day, ROUND(SUM(CASE WHEN kind='payment' THEN amount ELSE -amount END),2) value FROM payments WHERE hospital_id = ? AND created_at >= ? GROUP BY day ORDER BY day`, hid, addDays(t, -13));
    out.revenue_mix = db.all(`SELECT bill_type service, ROUND(SUM(total),2) value FROM invoices WHERE hospital_id = ? AND substr(created_at,1,7) = ? AND status != 'cancelled' GROUP BY bill_type ORDER BY value DESC`, hid, t.slice(0, 7));
  }
  if (can('opd') || can('doctor')) {
    out.opd_trend = db.all(`SELECT visit_date day, COUNT(*) value FROM opd_visits WHERE hospital_id = ? AND visit_date >= ? AND status != 'cancelled' GROUP BY day ORDER BY day`, hid, addDays(t, -13));
    out.live_opd = db.all('SELECT d.id, d.name, d.room, dp.name department FROM doctors d LEFT JOIN departments dp ON dp.id = d.department_id WHERE d.hospital_id = ? AND d.is_active = 1 ORDER BY dp.name, d.name', hid)
      .map((d) => { const q = opd.queue(hid, d.id, t); return { ...d, current: q.serving ? q.serving.token : null, next: q.waiting[0] ? q.waiting[0].token : null, waiting: q.waiting.length, completed: q.completed.length, avg_wait_min: q.avg_wait_min }; })
      .filter((d) => d.waiting || d.current || d.completed);
    out.department_load = db.all(`SELECT COALESCE(dp.name,'—') department, COUNT(*) value FROM opd_visits v LEFT JOIN departments dp ON dp.id = v.department_id WHERE v.hospital_id = ? AND v.visit_date >= ? GROUP BY v.department_id ORDER BY value DESC`, hid, addDays(t, -29));
  }
  if (ctx.doctorId) {
    const q = opd.queue(hid, ctx.doctorId, t);
    out.doctor = { queue: { serving: q.serving, waiting: q.waiting, completed: q.completed.length, avg_wait_min: q.avg_wait_min },
      appointments: db.all(`SELECT a.id, a.appt_no, a.scheduled_at, a.status, a.reason, p.full_name patient_name, p.uhid FROM appointments a JOIN patients p ON p.id = a.patient_id WHERE a.hospital_id = ? AND a.doctor_id = ? AND substr(a.scheduled_at,1,10) = ? ORDER BY a.scheduled_at`, hid, ctx.doctorId, t),
      recent_prescriptions: db.all(`SELECT r.id, r.rx_no, r.finalized_at, p.full_name patient_name, p.uhid, (SELECT COUNT(*) FROM prescription_items WHERE prescription_id = r.id) items FROM prescriptions r JOIN patients p ON p.id = r.patient_id WHERE r.hospital_id = ? AND r.doctor_id = ? AND r.status = 'finalized' ORDER BY r.finalized_at DESC LIMIT 6`, hid, ctx.doctorId),
      follow_ups: db.all(`SELECT v.id, v.follow_up_date, p.id patient_id, p.full_name patient_name, p.uhid, p.mobile FROM opd_visits v JOIN patients p ON p.id = v.patient_id WHERE v.hospital_id = ? AND v.doctor_id = ? AND v.follow_up_date BETWEEN ? AND ? ORDER BY v.follow_up_date LIMIT 10`, hid, ctx.doctorId, t, addDays(t, 7)),
      ipd: db.all(`SELECT a.id, a.ipd_no, p.full_name patient_name, w.name ward, b.bed_no, a.admitted_at FROM ipd_admissions a JOIN patients p ON p.id = a.patient_id LEFT JOIN beds b ON b.id = a.bed_id LEFT JOIN wards w ON w.id = b.ward_id WHERE a.hospital_id = ? AND a.doctor_id = ? AND a.status = 'admitted'`, hid, ctx.doctorId),
      stats: one(`SELECT COUNT(*) today, SUM(status='completed') completed FROM opd_visits WHERE hospital_id = ? AND doctor_id = ? AND visit_date = ?`, hid, ctx.doctorId, t) };
  }
  if (can('pharmacy')) {
    out.pharmacy = one(`SELECT
      (SELECT COUNT(*) FROM pharmacy_orders WHERE hospital_id = ? AND status IN ('waiting','processing')) pending,
      (SELECT COUNT(*) FROM pharmacy_orders WHERE hospital_id = ? AND status = 'ready') ready,
      (SELECT COUNT(*) FROM pharmacy_orders WHERE hospital_id = ? AND status = 'dispensed' AND substr(dispensed_at,1,10) = ?) dispensed,
      (SELECT COUNT(*) FROM pharmacy_orders o JOIN pharmacy_tokens tk ON tk.order_id = o.id WHERE o.hospital_id = ? AND o.status = 'waiting') waiting_tokens,
      (SELECT COUNT(*) FROM medicine_batches WHERE hospital_id = ? AND qty > 0 AND expiry_date < date('now','localtime')) expired,
      (SELECT COALESCE(SUM(total),0) FROM invoices WHERE hospital_id = ? AND bill_type = 'pharmacy' AND substr(created_at,1,10) = ? AND status != 'cancelled') sales_today`, hid, hid, hid, t, hid, hid, hid, t);
    out.pharmacy.low_stock = db.all(`SELECT m.id, m.name, m.strength, m.min_stock, (SELECT COALESCE(SUM(qty),0) FROM medicine_batches b WHERE b.medicine_id = m.id AND b.expiry_date >= date('now','localtime')) stock FROM medicines m WHERE m.hospital_id = ? AND m.is_active = 1`, hid).filter((m) => m.stock < m.min_stock).slice(0, 8);
    out.pharmacy.expiring = db.all(`SELECT b.batch_no, b.expiry_date, b.qty, m.name, m.strength FROM medicine_batches b JOIN medicines m ON m.id = b.medicine_id WHERE b.hospital_id = ? AND b.qty > 0 AND b.expiry_date <= date('now','localtime','+30 day') ORDER BY b.expiry_date LIMIT 6`, hid);
    const q = require('../services/pharmacy').queue(hid);
    out.pharmacy.serving = q.serving && q.serving.token; out.pharmacy.next = q.waiting.slice(0, 3).map((x) => x.token);
  }
  if (can('ipd') || can('nursing')) {
    out.ipd = one(`SELECT
      (SELECT COUNT(*) FROM beds WHERE hospital_id = ? AND status = 'occupied') occupied,
      (SELECT COUNT(*) FROM beds WHERE hospital_id = ? AND status = 'available') available,
      (SELECT COUNT(*) FROM beds WHERE hospital_id = ?) total,
      (SELECT COUNT(*) FROM beds b JOIN wards w ON w.id = b.ward_id WHERE b.hospital_id = ? AND w.ward_type IN ('icu','nicu') AND b.status = 'occupied') icu_occupied,
      (SELECT COUNT(*) FROM beds b JOIN wards w ON w.id = b.ward_id WHERE b.hospital_id = ? AND w.ward_type IN ('icu','nicu')) icu_total,
      (SELECT COUNT(*) FROM ipd_admissions WHERE hospital_id = ? AND substr(admitted_at,1,10) = ?) admissions_today,
      (SELECT COUNT(*) FROM ipd_admissions WHERE hospital_id = ? AND substr(discharged_at,1,10) = ?) discharges_today`, hid, hid, hid, hid, hid, hid, t, hid, t);
  }
  if (can('laboratory')) out.lab = one(`SELECT SUM(status='ordered') ordered, SUM(status IN ('sample_collected','processing')) in_process, SUM(status='completed') awaiting_verification, SUM(status='verified' AND substr(verified_at,1,10) = ?) verified_today FROM lab_orders WHERE hospital_id = ?`, t, hid);
  if (can('radiology')) out.radiology = one(`SELECT SUM(status IN ('ordered','scheduled')) pending, SUM(status='scanned') to_report, SUM(status='reported') to_verify FROM radiology_orders WHERE hospital_id = ?`, hid);
  if (can('appointments') || can('reception')) {
    out.appointments = db.all(`SELECT a.id, a.appt_no, a.scheduled_at, a.status, p.id patient_id, p.full_name patient_name, p.uhid, p.mobile, d.name doctor_name FROM appointments a JOIN patients p ON p.id = a.patient_id JOIN doctors d ON d.id = a.doctor_id WHERE a.hospital_id = ? AND substr(a.scheduled_at,1,10) = ? ORDER BY a.scheduled_at LIMIT 12`, hid, t);
    out.recent_patients = db.all('SELECT id, uhid, full_name, gender, dob, mobile, created_at FROM patients WHERE hospital_id = ? ORDER BY id DESC LIMIT 6', hid).map((p) => ({ ...p, age: ageFrom(p.dob) }));
  }
  if (can('hr')) {
    const hr = one(`SELECT (SELECT COUNT(*) FROM employees WHERE hospital_id = ? AND status != 'exited') total,
      (SELECT COUNT(*) FROM attendance WHERE hospital_id = ? AND date = ? AND status IN ('present','late','half_day')) present,
      (SELECT COUNT(*) FROM attendance WHERE hospital_id = ? AND date = ? AND status = 'late') late,
      (SELECT COUNT(*) FROM attendance WHERE hospital_id = ? AND date = ? AND status = 'leave') on_leave,
      (SELECT COUNT(*) FROM leaves WHERE hospital_id = ? AND status = 'pending') pending_leave`, hid, hid, t, hid, t, hid, t, hid);
    out.hr = { ...hr, absent: Math.max(hr.total - hr.present - hr.on_leave, 0) };
  }
  res.json(out);
});

// ───────── Analytics
r.get('/analytics', A, auth.can('mis'), (req, res) => {
  const hid = req.ctx.hid;
  const f = range(req.query.preset || 'last90', req.query.from, req.query.to);
  const P = [hid, f.from, `${f.to} 23:59:59`];
  const monthly = (sql) => db.all(sql, ...P);
  const patientGrowth = monthly(`SELECT substr(created_at,1,7) month, COUNT(*) value FROM patients WHERE hospital_id = ? AND created_at BETWEEN ? AND ? GROUP BY month ORDER BY month`);
  let cum = db.get('SELECT COUNT(*) c FROM patients WHERE hospital_id = ? AND created_at < ?', hid, f.from).c;
  for (const g of patientGrowth) { cum += g.value; g.cumulative = cum; }
  const revenue = db.all(`SELECT substr(created_at,1,10) day, ROUND(SUM(CASE WHEN kind='payment' THEN amount ELSE -amount END),2) value FROM payments WHERE hospital_id = ? AND created_at BETWEEN ? AND ? GROUP BY day ORDER BY day`, ...P);
  const revenueByService = db.all(`SELECT substr(created_at,1,7) month, bill_type, ROUND(SUM(total),2) value FROM invoices WHERE hospital_id = ? AND created_at BETWEEN ? AND ? AND status != 'cancelled' GROUP BY month, bill_type ORDER BY month`, ...P);
  const opdTrend = db.all(`SELECT visit_date day, COUNT(*) value, SUM(is_new_patient) new_patients FROM opd_visits WHERE hospital_id = ? AND visit_date BETWEEN ? AND ? AND status != 'cancelled' GROUP BY day ORDER BY day`, hid, f.from, f.to);
  // Occupancy per day = admissions overlapping the day / total beds.
  const beds = db.get('SELECT COUNT(*) c FROM beds WHERE hospital_id = ?', hid).c || 1;
  const occupancy = [];
  for (let d = f.from; d <= f.to; d = addDays(d, 1)) {
    const n = db.get("SELECT COUNT(*) c FROM ipd_admissions WHERE hospital_id = ? AND substr(admitted_at,1,10) <= ? AND (discharged_at IS NULL OR substr(discharged_at,1,10) >= ?) AND status != 'cancelled'", hid, d, d).c;
    occupancy.push({ day: d, value: round2(Math.min(100, (100 * n) / beds)) });
  }
  const pharmacySales = db.all(`SELECT substr(created_at,1,10) day, ROUND(SUM(total),2) value FROM invoices WHERE hospital_id = ? AND bill_type = 'pharmacy' AND created_at BETWEEN ? AND ? AND status != 'cancelled' GROUP BY day ORDER BY day`, ...P);
  const doctors = db.all(`SELECT d.name doctor, dp.name department, COUNT(v.id) visits,
      ROUND(AVG(CASE WHEN v.called_at IS NOT NULL THEN (julianday(v.called_at)-julianday(v.registered_at))*1440 END),1) avg_wait,
      ROUND(AVG(CASE WHEN v.completed_at IS NOT NULL AND v.called_at IS NOT NULL THEN (julianday(v.completed_at)-julianday(v.called_at))*1440 END),1) avg_consult,
      (SELECT ROUND(COALESCE(SUM(i.total),0),2) FROM invoices i WHERE i.doctor_id = d.id AND i.created_at BETWEEN ? AND ? AND i.status != 'cancelled') revenue,
      ROUND(100.0 * SUM(CASE WHEN v.visit_type = 'followup' THEN 1 ELSE 0 END) / MAX(COUNT(v.id),1),1) followup_pct
    FROM doctors d LEFT JOIN departments dp ON dp.id = d.department_id LEFT JOIN opd_visits v ON v.doctor_id = d.id AND v.visit_date BETWEEN ? AND ? AND v.status != 'cancelled'
    WHERE d.hospital_id = ? GROUP BY d.id ORDER BY visits DESC`, f.from, `${f.to} 23:59:59`, f.from, f.to, hid);
  const departments = db.all(`SELECT COALESCE(dp.name,'—') department, COUNT(v.id) opd, (SELECT COUNT(*) FROM ipd_admissions a WHERE a.department_id = dp.id AND a.admitted_at BETWEEN ? AND ?) ipd,
      (SELECT COUNT(*) FROM doctors x WHERE x.department_id = dp.id AND x.is_active = 1) doctors
    FROM departments dp LEFT JOIN opd_visits v ON v.department_id = dp.id AND v.visit_date BETWEEN ? AND ? WHERE dp.hospital_id = ? AND dp.kind = 'clinical' GROUP BY dp.id ORDER BY opd DESC`, f.from, `${f.to} 23:59:59`, f.from, f.to, hid);
  // Heatmap: OPD registrations by weekday × hour.
  const heat = db.all(`SELECT CAST(strftime('%w', registered_at) AS INTEGER) dow, CAST(strftime('%H', registered_at) AS INTEGER) hour, COUNT(*) value FROM opd_visits WHERE hospital_id = ? AND visit_date BETWEEN ? AND ? GROUP BY dow, hour`, hid, f.from, f.to);
  // Patient journey funnel.
  const funnel = [
    ['Registered visits', `SELECT COUNT(*) c FROM opd_visits WHERE hospital_id = ? AND visit_date BETWEEN ? AND ?`],
    ['Consulted', `SELECT COUNT(*) c FROM opd_visits WHERE hospital_id = ? AND visit_date BETWEEN ? AND ? AND status = 'completed'`],
    ['Prescribed', `SELECT COUNT(*) c FROM prescriptions r JOIN opd_visits v ON v.id = r.visit_id WHERE r.hospital_id = ? AND v.visit_date BETWEEN ? AND ? AND r.status = 'finalized' AND EXISTS (SELECT 1 FROM prescription_items WHERE prescription_id = r.id)`],
    ['Dispensed', `SELECT COUNT(*) c FROM pharmacy_orders o JOIN prescriptions r ON r.id = o.prescription_id JOIN opd_visits v ON v.id = r.visit_id WHERE o.hospital_id = ? AND v.visit_date BETWEEN ? AND ? AND o.status = 'dispensed'`],
    ['Paid in full', `SELECT COUNT(*) c FROM invoices i JOIN pharmacy_orders o ON o.invoice_id = i.id JOIN prescriptions r ON r.id = o.prescription_id JOIN opd_visits v ON v.id = r.visit_id WHERE i.hospital_id = ? AND v.visit_date BETWEEN ? AND ? AND i.status = 'paid'`],
  ].map(([stage, sql]) => ({ stage, value: db.get(sql, hid, f.from, f.to).c }));
  const kpi = db.get(`SELECT
      (SELECT COUNT(*) FROM patients WHERE hospital_id = ? AND created_at BETWEEN ? AND ?) new_patients,
      (SELECT COUNT(*) FROM opd_visits WHERE hospital_id = ? AND visit_date BETWEEN ? AND ? AND status != 'cancelled') opd,
      (SELECT COUNT(*) FROM ipd_admissions WHERE hospital_id = ? AND admitted_at BETWEEN ? AND ?) admissions,
      (SELECT COALESCE(SUM(CASE WHEN kind='payment' THEN amount ELSE -amount END),0) FROM payments WHERE hospital_id = ? AND created_at BETWEEN ? AND ?) revenue,
      (SELECT ROUND(AVG(julianday(discharged_at) - julianday(admitted_at)),1) FROM ipd_admissions WHERE hospital_id = ? AND discharged_at BETWEEN ? AND ?) alos`, ...P, hid, f.from, f.to, ...P, ...P, ...P);
  res.json({ range: f, kpi, patient_growth: patientGrowth, revenue, revenue_by_service: revenueByService, opd_trend: opdTrend, occupancy, pharmacy_sales: pharmacySales, doctors, departments, heatmap: heat, funnel });
});

// ───────── Reports
const GROUP_MODULES = { Patients: ['patients', 'mis', 'reports'], OPD: ['opd', 'mis', 'reports'], IPD: ['ipd', 'mis', 'reports'], Pharmacy: ['pharmacy', 'inventory', 'mis'], Revenue: ['billing', 'accounts', 'mis'], HR: ['hr', 'payroll'] };
function canReport(ctx, key) {
  const def = reports.REPORTS[key];
  if (!def) return false;
  const hasReports = ctx.can('reports', 'view') || ctx.can('mis', 'view');
  return (GROUP_MODULES[def.group] || []).some((m) => ctx.can(m, 'view')) && (hasReports || ctx.can(GROUP_MODULES[def.group][0], 'report') || ctx.can(GROUP_MODULES[def.group][0], 'view'));
}
function filtersFrom(q) {
  const rg = range(q.preset, q.from, q.to);
  const int = (v) => (/^\d{1,9}$/.test(String(v || '')) ? Number(v) : null);
  return { from: rg.from, to: rg.to, preset: q.preset || null, department_id: int(q.department_id), doctor_id: int(q.doctor_id),
    patient_type: ['new', 'returning'].includes(q.patient_type) ? q.patient_type : null,
    payment_mode: ['cash', 'upi', 'card', 'bank_transfer', 'other'].includes(q.payment_mode) ? q.payment_mode : null,
    status: /^[a-z_]{1,30}$/.test(String(q.status || '')) ? q.status : null };
}
r.get('/reports', A, auth.hospital, (req, res) => {
  res.json({ catalogue: reports.catalogue().filter((c) => canReport(req.ctx, c.key)), saved: db.all('SELECT * FROM saved_reports WHERE hospital_id = ? AND (user_id = ? OR ?) ORDER BY name', req.ctx.hid, req.ctx.user.id, req.ctx.can('reports', 'edit') ? 1 : 0) });
});
r.get('/reports/:key', A, auth.hospital, (req, res) => {
  if (!reports.REPORTS[req.params.key]) throw notFound('Report');
  if (!canReport(req.ctx, req.params.key)) throw forbidden('You do not have access to this report');
  const f = filtersFrom(req.query);
  const out = reports.run(req.ctx.hid, req.params.key, f);
  const fmt = req.query.format;
  if (fmt === 'csv' || fmt === 'xls') {
    if (!req.ctx.can('reports', 'export') && !req.ctx.can('mis', 'export') && !req.ctx.can('billing', 'export')) throw forbidden('Export permission required');
    audit(req, 'report.exported', { entity: 'report', ref: req.params.key, details: { format: fmt, ...f } });
    const name = `${req.params.key}_${f.from}_${f.to}`;
    if (fmt === 'csv') {
      const esc = (v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
      const csv = [out.columns.map((c) => esc(c.label)).join(','), ...out.rows.map((row) => out.columns.map((c) => esc(row[c.key])).join(','))].join('\r\n');
      res.setHeader('Content-Type', 'text/csv; charset=utf-8'); res.setHeader('Content-Disposition', `attachment; filename="${name}.csv"`);
      return res.send('﻿' + csv);
    }
    // SpreadsheetML 2003 (.xls) — opens natively in Excel / LibreOffice with typed cells.
    const x = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const cell = (c, v) => (['int', 'number', 'money', 'pct'].includes(c.type) && v !== null && v !== '' && Number.isFinite(Number(v)) ? `<Cell ss:StyleID="${c.type === 'money' ? 'm' : 'n'}"><Data ss:Type="Number">${Number(v)}</Data></Cell>` : `<Cell><Data ss:Type="String">${x(v)}</Data></Cell>`);
    const xml = `<?xml version="1.0"?><?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
<Styles><Style ss:ID="h"><Font ss:Bold="1" ss:Color="#FFFFFF"/><Interior ss:Color="#0B2545" ss:Pattern="Solid"/></Style><Style ss:ID="t"><Font ss:Bold="1" ss:Size="14"/></Style><Style ss:ID="m"><NumberFormat ss:Format="#,##0.00"/></Style><Style ss:ID="n"><NumberFormat ss:Format="General"/></Style></Styles>
<Worksheet ss:Name="${x(out.title.slice(0, 30))}"><Table>
<Row><Cell ss:StyleID="t"><Data ss:Type="String">${x(out.title)}</Data></Cell></Row>
<Row><Cell><Data ss:Type="String">Period: ${f.from} to ${f.to}</Data></Cell></Row><Row/>
<Row>${out.columns.map((c) => `<Cell ss:StyleID="h"><Data ss:Type="String">${x(c.label)}</Data></Cell>`).join('')}</Row>
${out.rows.map((row) => `<Row>${out.columns.map((c) => cell(c, row[c.key])).join('')}</Row>`).join('\n')}
</Table></Worksheet></Workbook>`;
    res.setHeader('Content-Type', 'application/vnd.ms-excel'); res.setHeader('Content-Disposition', `attachment; filename="${name}.xls"`);
    return res.send(xml);
  }
  res.json(out);
});
r.post('/reports/saved', A, auth.hospital, (req, res) => {
  const b = validate(req.body, { name: 'required|max:80', report_type: 'required|max:40', filters: 'object', schedule: { enum: ['none', 'daily', 'weekly', 'monthly'], default: 'none' } });
  if (!canReport(req.ctx, b.report_type)) throw forbidden();
  const sid = db.insertRow('saved_reports', { hospital_id: req.ctx.hid, name: b.name, report_type: b.report_type, filters: JSON.stringify(b.filters || {}), schedule: b.schedule, user_id: req.ctx.user.id, created_at: now() });
  audit(req, 'report.saved', { entity: 'saved_report', id: sid, ref: b.name, details: { schedule: b.schedule } });
  res.status(201).json({ id: sid });
});
r.delete('/reports/saved/:id', A, auth.hospital, (req, res) => {
  const n = db.run('DELETE FROM saved_reports WHERE id = ? AND hospital_id = ? AND (user_id = ? OR ?)', id(req.params.id), req.ctx.hid, req.ctx.user.id, req.ctx.can('reports', 'delete') ? 1 : 0).changes;
  if (!n) throw notFound('Saved report');
  res.json({ ok: true });
});

// ───────── Global search (permission-aware)
r.get('/search', A, auth.hospital, (req, res) => {
  const { ctx } = req; const hid = ctx.hid;
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json([]);
  const like = `%${q}%`; const out = [];
  const push = (type, rows, map) => rows.forEach((r) => out.push({ type, ...map(r) }));
  if (ctx.can('patients', 'view') || ctx.can('opd', 'view') || ctx.can('reception', 'view')) {
    const { search } = require('./patients');
    push('patient', search(hid, { q, limit: 6 }).rows, (p) => ({ id: p.id, title: p.full_name, subtitle: `${p.uhid} · ${p.gender || ''}${p.age != null ? ', ' + p.age + 'y' : ''} · ${p.mobile}`, link: `/patients/${p.id}` }));
  }
  push('doctor', db.all("SELECT d.id, d.name, d.specialization, dp.name department FROM doctors d LEFT JOIN departments dp ON dp.id = d.department_id WHERE d.hospital_id = ? AND (d.name LIKE ? OR d.specialization LIKE ?) LIMIT 4", hid, like, like), (d) => ({ id: d.id, title: d.name, subtitle: `${d.department || ''} · ${d.specialization || ''}`, link: `/opd?doctor=${d.id}` }));
  if (ctx.can('ipd', 'view')) push('ipd', db.all('SELECT a.id, a.ipd_no, a.status, p.full_name FROM ipd_admissions a JOIN patients p ON p.id = a.patient_id WHERE a.hospital_id = ? AND a.ipd_no LIKE ? LIMIT 4', hid, like), (a) => ({ id: a.id, title: a.ipd_no, subtitle: `${a.full_name} · ${a.status}`, link: `/ipd/${a.id}` }));
  if (ctx.can('appointments', 'view')) push('appointment', db.all('SELECT a.id, a.appt_no, a.scheduled_at, p.full_name FROM appointments a JOIN patients p ON p.id = a.patient_id WHERE a.hospital_id = ? AND a.appt_no LIKE ? LIMIT 4', hid, like), (a) => ({ id: a.id, title: a.appt_no, subtitle: `${a.full_name} · ${a.scheduled_at.slice(0, 16)}`, link: `/appointments?date=${a.scheduled_at.slice(0, 10)}` }));
  if (ctx.can('doctor', 'view') || ctx.can('pharmacy', 'view')) push('prescription', db.all('SELECT r.id, r.rx_no, p.full_name FROM prescriptions r JOIN patients p ON p.id = r.patient_id WHERE r.hospital_id = ? AND r.rx_no LIKE ? LIMIT 4', hid, like), (x) => ({ id: x.id, title: x.rx_no, subtitle: x.full_name, link: `/print/prescription/${x.id}` }));
  if (ctx.can('pharmacy', 'view') || ctx.can('inventory', 'view') || ctx.can('doctor', 'view')) push('medicine', db.all('SELECT m.id, m.name, m.strength, m.generic_name FROM medicines m WHERE m.hospital_id = ? AND (m.name LIKE ? OR m.generic_name LIKE ?) LIMIT 5', hid, like, like), (m) => ({ id: m.id, title: `${m.name} ${m.strength || ''}`.trim(), subtitle: m.generic_name || '', link: `/inventory/medicine/${m.id}` }));
  if (ctx.can('billing', 'view')) push('invoice', db.all('SELECT i.id, i.invoice_no, i.total, i.status, COALESCE(p.full_name, i.customer_name) name FROM invoices i LEFT JOIN patients p ON p.id = i.patient_id WHERE i.hospital_id = ? AND i.invoice_no LIKE ? LIMIT 4', hid, like), (i) => ({ id: i.id, title: i.invoice_no, subtitle: `${i.name || ''} · ₹${i.total.toLocaleString('en-IN')} · ${i.status}`, link: `/billing/${i.id}` }));
  if (ctx.can('hr', 'view')) push('employee', db.all('SELECT e.id, e.emp_code, e.full_name, e.designation FROM employees e WHERE e.hospital_id = ? AND (e.full_name LIKE ? OR e.emp_code LIKE ?) LIMIT 4', hid, like, like), (e) => ({ id: e.id, title: e.full_name, subtitle: `${e.emp_code} · ${e.designation || ''}`, link: `/hr/employee/${e.id}` }));
  res.json(out);
});

// ───────── Notification centre
r.get('/notifications', A, (req, res) => res.json(forUser(req.ctx, { limit: Math.min(Number(req.query.limit) || 30, 100) })));
r.post('/notifications/read', A, (req, res) => {
  const ids = req.body.all ? forUser(req.ctx, { limit: 500, unreadOnly: true }).items.map((n) => n.id) : (req.body.ids || []).map(Number);
  markRead(req.ctx, ids);
  res.json({ ok: true });
});

// ───────── Deep Assist
r.post('/assistant/query', A, auth.hospital, (req, res) => {
  const b = validate(req.body, { q: 'required|max:300' });
  const out = assistant.query(req.ctx.hid, b.q, (key) => canReport(req.ctx, key));
  audit(req, 'assistant.query', { details: { q: b.q, report: out.interpreted && out.interpreted.report } });
  res.json({ ...out, suggestions: assistant.SUGGESTIONS });
});
r.get('/assistant/suggestions', A, (req, res) => res.json(assistant.SUGGESTIONS));
r.post('/assistant/format-note', A, auth.can('doctor', 'edit'), (req, res) => res.json({ text: assistant.formatNote(String((req.body && req.body.text) || '').slice(0, 8000)) }));
r.post('/assistant/draft-message', A, auth.hospital, (req, res) => {
  const b = validate(req.body, { kind: { required: true, enum: ['appointment_reminder', 'report_ready', 'payment_due', 'follow_up', 'discharge'] }, patient_id: 'int', doctor: 'max:80', when: 'max:60', amount: 'max:20' });
  const h = db.get('SELECT name FROM hospitals WHERE id = ?', req.ctx.hid);
  const p = b.patient_id ? db.get('SELECT full_name FROM patients WHERE id = ? AND hospital_id = ?', b.patient_id, req.ctx.hid) : null;
  res.json({ text: assistant.draftMessage(b.kind, { name: p ? p.full_name : 'Patient', hospital: h.name, doctor: b.doctor || 'your doctor', when: b.when || 'the scheduled date', amount: b.amount || '—' }) });
});

module.exports = r;
