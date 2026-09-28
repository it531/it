'use strict';
const db = require('../db');
const { now, round2, bad } = require('../lib/util');

function daysInMonth(month) { const [y, m] = month.split('-').map(Number); return new Date(y, m, 0).getDate(); }

/**
 * Payroll for a month (YYYY-MM). Paid days come from attendance: absent days (not covered
 * by approved leave) are loss-of-pay, half days count 0.5 LOP. Overtime is paid at the
 * structure's hourly rate. Statutory: PF on basic, ESI on gross (if gross ≤ ₹21,000), PT.
 */
function runPayroll(hid, month, at) {
  if (!/^\d{4}-\d{2}$/.test(month)) throw bad('Month must be YYYY-MM');
  const wd = daysInMonth(month);
  const emps = db.all("SELECT e.*, s.basic, s.hra, s.allowances, s.bonus, s.overtime_rate, s.pf_percent, s.esi_percent, s.professional_tax, s.other_deductions FROM employees e JOIN salary_structures s ON s.employee_id = e.id WHERE e.hospital_id = ? AND e.status != 'exited'", hid);
  let count = 0;
  for (const e of emps) {
    const a = db.get(`SELECT
        SUM(CASE WHEN status='absent' THEN 1 ELSE 0 END) absent,
        SUM(CASE WHEN status='half_day' THEN 0.5 ELSE 0 END) half,
        COALESCE(SUM(overtime_hours),0) ot
      FROM attendance WHERE employee_id = ? AND substr(date,1,7) = ?`, e.id, month);
    const lop = (a.absent || 0) + (a.half || 0);
    const paid = Math.max(wd - lop, 0);
    const fixed = e.basic + e.hra + e.allowances;
    const lopDed = round2((fixed / wd) * lop);
    const overtime = round2((a.ot || 0) * e.overtime_rate);
    const gross = round2(fixed + e.bonus + overtime);
    const pf = round2((e.basic * (paid / wd)) * e.pf_percent / 100);
    const esi = gross <= 21000 ? round2(gross * e.esi_percent / 100) : 0;
    const pt = e.professional_tax;
    const totalDed = round2(pf + esi + pt + e.other_deductions + lopDed);
    const net = round2(gross - totalDed);
    db.run(`INSERT INTO payroll (hospital_id, employee_id, month, working_days, paid_days, lop_days, basic, hra, allowances, bonus, overtime, gross, pf, esi, professional_tax, other_deductions, lop_deduction, total_deductions, net_pay, status, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(employee_id, month) DO UPDATE SET working_days=excluded.working_days, paid_days=excluded.paid_days, lop_days=excluded.lop_days, basic=excluded.basic, hra=excluded.hra, allowances=excluded.allowances, bonus=excluded.bonus, overtime=excluded.overtime, gross=excluded.gross, pf=excluded.pf, esi=excluded.esi, professional_tax=excluded.professional_tax, other_deductions=excluded.other_deductions, lop_deduction=excluded.lop_deduction, total_deductions=excluded.total_deductions, net_pay=excluded.net_pay
      WHERE payroll.status != 'paid'`,
    hid, e.id, month, wd, paid, lop, e.basic, e.hra, e.allowances, e.bonus, overtime, gross, pf, esi, pt, e.other_deductions, lopDed, totalDed, net, 'processed', at || now());
    count++;
  }
  return count;
}

module.exports = { runPayroll, daysInMonth };
