'use strict';
// MIS report catalogue. Every report is computed live from the database with the
// same filter contract: { from, to, department_id, doctor_id, patient_type, payment_mode, status }.
const db = require('../db');
const { round2, today, addDays } = require('../lib/util');

const C = (key, label, type = 'text') => ({ key, label, type });

function where(f, { date, dept, doctor, status }) {
  const parts = [`${date} BETWEEN ? AND ?`]; const params = [f.from, `${f.to} 23:59:59`];
  if (dept && f.department_id) { parts.push(`${dept} = ?`); params.push(Number(f.department_id)); }
  if (doctor && f.doctor_id) { parts.push(`${doctor} = ?`); params.push(Number(f.doctor_id)); }
  if (status && f.status) { parts.push(`${status} = ?`); params.push(f.status); }
  return { sql: parts.join(' AND '), params };
}
const ptype = (f, col = 'v.is_new_patient') => (f.patient_type === 'new' ? ` AND ${col} = 1` : f.patient_type === 'returning' ? ` AND ${col} = 0` : '');
const sum = (rows, k) => round2(rows.reduce((s, r) => s + (Number(r[k]) || 0), 0));

// Continuous day axis so charts have no gaps.
function days(f) { const out = []; for (let d = f.from; d <= f.to && out.length < 400; d = addDays(d, 1)) out.push(d); return out; }
function fillDays(f, rows, key = 'day', fields = ['value']) {
  const m = new Map(rows.map((r) => [r[key], r]));
  return days(f).map((d) => { const r = m.get(d) || {}; const o = { [key]: d }; for (const x of fields) o[x] = r[x] || 0; return o; });
}

const REPORTS = {
  // ───────── Patients
  patients_new: { group: 'Patients', title: 'New patient registrations', run(hid, f) {
    const w = where(f, { date: 'p.created_at' });
    const rows = db.all(`SELECT p.uhid, p.full_name, p.gender, p.dob, p.mobile, p.city, substr(p.created_at,1,10) registered_on FROM patients p WHERE p.hospital_id = ? AND ${w.sql} ORDER BY p.created_at DESC`, hid, ...w.params);
    const daily = fillDays(f, db.all(`SELECT substr(created_at,1,10) day, COUNT(*) value FROM patients p WHERE hospital_id = ? AND ${w.sql} GROUP BY day`, hid, ...w.params));
    return { columns: [C('uhid', 'UHID'), C('full_name', 'Patient'), C('gender', 'Gender'), C('dob', 'DOB', 'date'), C('mobile', 'Mobile'), C('city', 'City'), C('registered_on', 'Registered', 'date')], rows,
      summary: [{ label: 'New patients', value: rows.length }], chart: { type: 'area', x: 'day', series: [{ key: 'value', label: 'Registrations' }], data: daily } };
  } },
  patients_returning: { group: 'Patients', title: 'New vs returning patients', run(hid, f) {
    const w = where(f, { date: 'v.visit_date', dept: 'v.department_id', doctor: 'v.doctor_id' });
    const rows = db.all(`SELECT v.visit_date day, SUM(v.is_new_patient) new_patients, SUM(1 - v.is_new_patient) returning_patients, COUNT(*) total FROM opd_visits v WHERE v.hospital_id = ? AND v.status != 'cancelled' AND ${w.sql} GROUP BY day ORDER BY day`, hid, ...w.params);
    const data = fillDays(f, rows, 'day', ['new_patients', 'returning_patients', 'total']);
    return { columns: [C('day', 'Date', 'date'), C('new_patients', 'New', 'int'), C('returning_patients', 'Returning', 'int'), C('total', 'Total', 'int')], rows: data,
      summary: [{ label: 'New', value: sum(rows, 'new_patients') }, { label: 'Returning', value: sum(rows, 'returning_patients') }],
      chart: { type: 'bar', stacked: true, x: 'day', series: [{ key: 'new_patients', label: 'New' }, { key: 'returning_patients', label: 'Returning' }], data } };
  } },
  patients_demographics: { group: 'Patients', title: 'Patient demographics (age & gender)', run(hid, f) {
    const w = where(f, { date: 'p.created_at' });
    const rows = db.all(`SELECT CASE
        WHEN p.dob IS NULL THEN 'Unknown'
        WHEN (julianday('now') - julianday(p.dob))/365.25 < 13 THEN '0–12'
        WHEN (julianday('now') - julianday(p.dob))/365.25 < 19 THEN '13–18'
        WHEN (julianday('now') - julianday(p.dob))/365.25 < 36 THEN '19–35'
        WHEN (julianday('now') - julianday(p.dob))/365.25 < 51 THEN '36–50'
        WHEN (julianday('now') - julianday(p.dob))/365.25 < 66 THEN '51–65'
        ELSE '65+' END age_group,
        SUM(p.gender='Male') male, SUM(p.gender='Female') female, SUM(p.gender NOT IN ('Male','Female')) other, COUNT(*) total
      FROM patients p WHERE p.hospital_id = ? AND ${w.sql} GROUP BY age_group ORDER BY age_group`, hid, ...w.params);
    return { columns: [C('age_group', 'Age group'), C('male', 'Male', 'int'), C('female', 'Female', 'int'), C('other', 'Other', 'int'), C('total', 'Total', 'int')], rows,
      summary: [{ label: 'Patients', value: sum(rows, 'total') }, { label: 'Male', value: sum(rows, 'male') }, { label: 'Female', value: sum(rows, 'female') }],
      chart: { type: 'bar', stacked: true, x: 'age_group', series: [{ key: 'male', label: 'Male' }, { key: 'female', label: 'Female' }, { key: 'other', label: 'Other' }], data: rows } };
  } },
  // ───────── OPD
  opd_daily: { group: 'OPD', title: 'Daily OPD', run(hid, f) {
    const w = where(f, { date: 'v.visit_date', dept: 'v.department_id', doctor: 'v.doctor_id', status: 'v.status' });
    const rows = db.all(`SELECT v.visit_date day, COUNT(*) visits, SUM(v.status='completed') completed, SUM(v.status='cancelled' OR v.status='no_show') cancelled, SUM(v.visit_type='emergency') emergency FROM opd_visits v WHERE v.hospital_id = ? AND ${w.sql}${ptype(f)} GROUP BY day ORDER BY day`, hid, ...w.params);
    const data = fillDays(f, rows, 'day', ['visits', 'completed', 'cancelled', 'emergency']);
    return { columns: [C('day', 'Date', 'date'), C('visits', 'Visits', 'int'), C('completed', 'Completed', 'int'), C('cancelled', 'Cancelled / no-show', 'int'), C('emergency', 'Emergency', 'int')], rows: data,
      summary: [{ label: 'OPD visits', value: sum(rows, 'visits') }, { label: 'Completed', value: sum(rows, 'completed') }, { label: 'Avg / day', value: round2(sum(rows, 'visits') / Math.max(data.length, 1)) }],
      chart: { type: 'line', x: 'day', series: [{ key: 'visits', label: 'Visits' }, { key: 'completed', label: 'Completed' }], data } };
  } },
  opd_monthly: { group: 'OPD', title: 'Monthly OPD', run(hid, f) {
    const w = where(f, { date: 'v.visit_date', dept: 'v.department_id', doctor: 'v.doctor_id', status: 'v.status' });
    const rows = db.all(`SELECT substr(v.visit_date,1,7) month, COUNT(*) visits, SUM(v.is_new_patient) new_patients, SUM(v.status='completed') completed FROM opd_visits v WHERE v.hospital_id = ? AND ${w.sql}${ptype(f)} GROUP BY month ORDER BY month`, hid, ...w.params);
    return { columns: [C('month', 'Month'), C('visits', 'Visits', 'int'), C('new_patients', 'New patients', 'int'), C('completed', 'Completed', 'int')], rows,
      summary: [{ label: 'Visits', value: sum(rows, 'visits') }], chart: { type: 'bar', x: 'month', series: [{ key: 'visits', label: 'Visits' }], data: rows } };
  } },
  opd_doctor: { group: 'OPD', title: 'Doctor-wise OPD', run(hid, f) {
    const w = where(f, { date: 'v.visit_date', dept: 'v.department_id', doctor: 'v.doctor_id', status: 'v.status' });
    const rows = db.all(`SELECT d.name doctor, dp.name department, COUNT(*) visits, SUM(v.is_new_patient) new_patients, SUM(v.status='completed') completed,
        ROUND(AVG(CASE WHEN v.called_at IS NOT NULL THEN (julianday(v.called_at)-julianday(v.registered_at))*1440 END),1) avg_wait_min,
        ROUND(AVG(CASE WHEN v.completed_at IS NOT NULL AND v.called_at IS NOT NULL THEN (julianday(v.completed_at)-julianday(v.called_at))*1440 END),1) avg_consult_min
      FROM opd_visits v JOIN doctors d ON d.id = v.doctor_id LEFT JOIN departments dp ON dp.id = v.department_id
      WHERE v.hospital_id = ? AND ${w.sql}${ptype(f)} GROUP BY v.doctor_id ORDER BY visits DESC`, hid, ...w.params);
    return { columns: [C('doctor', 'Doctor'), C('department', 'Department'), C('visits', 'Visits', 'int'), C('new_patients', 'New', 'int'), C('completed', 'Completed', 'int'), C('avg_wait_min', 'Avg wait (min)', 'number'), C('avg_consult_min', 'Avg consult (min)', 'number')], rows,
      summary: [{ label: 'Doctors', value: rows.length }, { label: 'Visits', value: sum(rows, 'visits') }], chart: { type: 'hbar', x: 'doctor', series: [{ key: 'visits', label: 'Visits' }], data: rows } };
  } },
  opd_department: { group: 'OPD', title: 'Department-wise OPD', run(hid, f) {
    const w = where(f, { date: 'v.visit_date', dept: 'v.department_id', doctor: 'v.doctor_id', status: 'v.status' });
    const rows = db.all(`SELECT COALESCE(dp.name,'—') department, COUNT(*) visits, SUM(v.is_new_patient) new_patients, COUNT(DISTINCT v.doctor_id) doctors FROM opd_visits v LEFT JOIN departments dp ON dp.id = v.department_id WHERE v.hospital_id = ? AND ${w.sql}${ptype(f)} GROUP BY v.department_id ORDER BY visits DESC`, hid, ...w.params);
    return { columns: [C('department', 'Department'), C('visits', 'Visits', 'int'), C('new_patients', 'New', 'int'), C('doctors', 'Doctors', 'int')], rows,
      summary: [{ label: 'Visits', value: sum(rows, 'visits') }], chart: { type: 'donut', x: 'department', series: [{ key: 'visits', label: 'Visits' }], data: rows } };
  } },
  opd_waiting: { group: 'OPD', title: 'Token statistics & waiting time', run(hid, f) {
    const w = where(f, { date: 'v.visit_date', dept: 'v.department_id', doctor: 'v.doctor_id' });
    const rows = db.all(`SELECT v.visit_date day, COUNT(*) tokens, ROUND(AVG(CASE WHEN v.called_at IS NOT NULL THEN (julianday(v.called_at)-julianday(v.registered_at))*1440 END),1) avg_wait_min,
        ROUND(MAX(CASE WHEN v.called_at IS NOT NULL THEN (julianday(v.called_at)-julianday(v.registered_at))*1440 END),1) max_wait_min
      FROM opd_visits v WHERE v.hospital_id = ? AND ${w.sql} GROUP BY day ORDER BY day`, hid, ...w.params);
    const data = fillDays(f, rows, 'day', ['tokens', 'avg_wait_min', 'max_wait_min']);
    const valid = rows.filter((r) => r.avg_wait_min != null);
    return { columns: [C('day', 'Date', 'date'), C('tokens', 'Tokens issued', 'int'), C('avg_wait_min', 'Avg wait (min)', 'number'), C('max_wait_min', 'Max wait (min)', 'number')], rows: data,
      summary: [{ label: 'Tokens', value: sum(rows, 'tokens') }, { label: 'Avg wait (min)', value: valid.length ? round2(sum(valid, 'avg_wait_min') / valid.length) : 0 }],
      chart: { type: 'line', x: 'day', series: [{ key: 'avg_wait_min', label: 'Avg wait (min)' }], data } };
  } },
  appointments: { group: 'OPD', title: 'Appointments by status', run(hid, f) {
    const w = where(f, { date: 'a.scheduled_at', dept: 'a.department_id', doctor: 'a.doctor_id', status: 'a.status' });
    const rows = db.all(`SELECT a.appt_no, substr(a.scheduled_at,1,16) scheduled_at, p.full_name patient, p.uhid, d.name doctor, a.status, a.source FROM appointments a JOIN patients p ON p.id = a.patient_id JOIN doctors d ON d.id = a.doctor_id WHERE a.hospital_id = ? AND ${w.sql} ORDER BY a.scheduled_at DESC`, hid, ...w.params);
    const by = {}; for (const r of rows) by[r.status] = (by[r.status] || 0) + 1;
    const data = Object.entries(by).map(([status, count]) => ({ status, count }));
    return { columns: [C('appt_no', 'Appt #'), C('scheduled_at', 'Scheduled', 'datetime'), C('patient', 'Patient'), C('uhid', 'UHID'), C('doctor', 'Doctor'), C('status', 'Status', 'status'), C('source', 'Source')], rows,
      summary: [{ label: 'Appointments', value: rows.length }, { label: 'Cancelled', value: by.cancelled || 0 }, { label: 'No-show', value: by.no_show || 0 }],
      chart: { type: 'donut', x: 'status', series: [{ key: 'count', label: 'Appointments' }], data } };
  } },
  // ───────── IPD
  ipd_admissions: { group: 'IPD', title: 'Admissions & discharges', run(hid, f) {
    const w = where(f, { date: 'a.admitted_at', dept: 'a.department_id', doctor: 'a.doctor_id', status: 'a.status' });
    const rows = db.all(`SELECT a.ipd_no, p.uhid, p.full_name patient, d.name doctor, dp.name department, substr(a.admitted_at,1,16) admitted_at, substr(a.discharged_at,1,16) discharged_at, a.status,
        ROUND(julianday(COALESCE(a.discharged_at, datetime('now','localtime'))) - julianday(a.admitted_at),1) los_days
      FROM ipd_admissions a JOIN patients p ON p.id = a.patient_id JOIN doctors d ON d.id = a.doctor_id LEFT JOIN departments dp ON dp.id = a.department_id
      WHERE a.hospital_id = ? AND ${w.sql} ORDER BY a.admitted_at DESC`, hid, ...w.params);
    const adm = db.all(`SELECT substr(admitted_at,1,10) day, COUNT(*) admissions FROM ipd_admissions a WHERE hospital_id = ? AND ${w.sql} GROUP BY day`, hid, ...w.params);
    const w2 = where(f, { date: 'a.discharged_at', dept: 'a.department_id', doctor: 'a.doctor_id' });
    const dis = db.all(`SELECT substr(discharged_at,1,10) day, COUNT(*) discharges FROM ipd_admissions a WHERE hospital_id = ? AND ${w2.sql} GROUP BY day`, hid, ...w2.params);
    const dm = new Map(dis.map((r) => [r.day, r.discharges]));
    const data = fillDays(f, adm, 'day', ['admissions']).map((r) => ({ ...r, discharges: dm.get(r.day) || 0 }));
    const discharged = rows.filter((r) => r.status === 'discharged');
    return { columns: [C('ipd_no', 'IPD #'), C('uhid', 'UHID'), C('patient', 'Patient'), C('doctor', 'Doctor'), C('department', 'Department'), C('admitted_at', 'Admitted', 'datetime'), C('discharged_at', 'Discharged', 'datetime'), C('los_days', 'LOS (days)', 'number'), C('status', 'Status', 'status')], rows,
      summary: [{ label: 'Admissions', value: rows.length }, { label: 'Discharges', value: sum(dis, 'discharges') }, { label: 'Avg LOS (days)', value: discharged.length ? round2(sum(discharged, 'los_days') / discharged.length) : 0 }],
      chart: { type: 'bar', x: 'day', series: [{ key: 'admissions', label: 'Admissions' }, { key: 'discharges', label: 'Discharges' }], data } };
  } },
  ipd_occupancy: { group: 'IPD', title: 'Bed occupancy by ward', run(hid) {
    const rows = db.all(`SELECT w.name ward, w.ward_type, COUNT(b.id) beds, SUM(b.status='occupied') occupied, SUM(b.status='available') available, SUM(b.status IN ('cleaning','maintenance','reserved')) unavailable,
        ROUND(100.0 * SUM(b.status='occupied') / MAX(COUNT(b.id),1), 1) occupancy_pct
      FROM wards w LEFT JOIN beds b ON b.ward_id = w.id WHERE w.hospital_id = ? GROUP BY w.id ORDER BY w.name`, hid);
    const beds = sum(rows, 'beds'); const occ = sum(rows, 'occupied');
    return { columns: [C('ward', 'Ward'), C('ward_type', 'Type'), C('beds', 'Beds', 'int'), C('occupied', 'Occupied', 'int'), C('available', 'Available', 'int'), C('unavailable', 'Cleaning / maint.', 'int'), C('occupancy_pct', 'Occupancy %', 'pct')], rows,
      summary: [{ label: 'Total beds', value: beds }, { label: 'Occupied', value: occ }, { label: 'Occupancy', value: `${beds ? round2(100 * occ / beds) : 0}%` }],
      chart: { type: 'hbar', x: 'ward', series: [{ key: 'occupancy_pct', label: 'Occupancy %' }], data: rows } };
  } },
  // ───────── Pharmacy
  pharmacy_sales: { group: 'Pharmacy', title: 'Pharmacy sales', run(hid, f) {
    const w = where(f, { date: 'i.created_at', doctor: 'i.doctor_id' });
    const rows = db.all(`SELECT substr(i.created_at,1,10) day, COUNT(*) bills, ROUND(SUM(i.total),2) sales, ROUND(SUM(i.tax),2) gst FROM invoices i WHERE i.hospital_id = ? AND i.bill_type='pharmacy' AND i.status != 'cancelled' AND ${w.sql} GROUP BY day ORDER BY day`, hid, ...w.params);
    const data = fillDays(f, rows, 'day', ['bills', 'sales', 'gst']);
    return { columns: [C('day', 'Date', 'date'), C('bills', 'Bills', 'int'), C('sales', 'Sales', 'money'), C('gst', 'GST included', 'money')], rows: data,
      summary: [{ label: 'Sales', value: sum(rows, 'sales'), type: 'money' }, { label: 'Bills', value: sum(rows, 'bills') }],
      chart: { type: 'area', x: 'day', series: [{ key: 'sales', label: 'Sales (₹)' }], data, money: true } };
  } },
  pharmacy_top: { group: 'Pharmacy', title: 'Top medicines & consumption', run(hid, f) {
    const w = where(f, { date: 'o.dispensed_at', doctor: 'o.doctor_id' });
    const rows = db.all(`SELECT m.name || ' ' || COALESCE(m.strength,'') medicine, m.category, SUM(oi.dispensed_qty) qty, ROUND(SUM(oi.dispensed_qty*oi.unit_price),2) value, COUNT(DISTINCT o.id) orders
      FROM pharmacy_order_items oi JOIN pharmacy_orders o ON o.id = oi.order_id JOIN medicines m ON m.id = oi.medicine_id
      WHERE o.hospital_id = ? AND o.status='dispensed' AND ${w.sql} GROUP BY m.id ORDER BY qty DESC LIMIT 50`, hid, ...w.params);
    return { columns: [C('medicine', 'Medicine'), C('category', 'Category'), C('qty', 'Units dispensed', 'int'), C('orders', 'Orders', 'int'), C('value', 'Value', 'money')], rows,
      summary: [{ label: 'Units', value: sum(rows, 'qty') }, { label: 'Value', value: sum(rows, 'value'), type: 'money' }],
      chart: { type: 'hbar', x: 'medicine', series: [{ key: 'qty', label: 'Units' }], data: rows.slice(0, 12) } };
  } },
  pharmacy_rx_volume: { group: 'Pharmacy', title: 'Prescription volume', run(hid, f) {
    const w = where(f, { date: 'r.finalized_at', doctor: 'r.doctor_id' });
    const rows = db.all(`SELECT substr(r.finalized_at,1,10) day, COUNT(*) prescriptions, (SELECT COUNT(*) FROM prescription_items pi JOIN prescriptions r2 ON r2.id = pi.prescription_id WHERE r2.hospital_id = r.hospital_id AND substr(r2.finalized_at,1,10) = substr(r.finalized_at,1,10)) items
      FROM prescriptions r WHERE r.hospital_id = ? AND r.status='finalized' AND ${w.sql} GROUP BY day ORDER BY day`, hid, ...w.params);
    const data = fillDays(f, rows, 'day', ['prescriptions', 'items']);
    return { columns: [C('day', 'Date', 'date'), C('prescriptions', 'Prescriptions', 'int'), C('items', 'Line items', 'int')], rows: data,
      summary: [{ label: 'Prescriptions', value: sum(rows, 'prescriptions') }], chart: { type: 'bar', x: 'day', series: [{ key: 'prescriptions', label: 'Prescriptions' }], data } };
  } },
  pharmacy_low_stock: { group: 'Pharmacy', title: 'Low stock medicines', run(hid) {
    const rows = db.all(`SELECT m.name, m.strength, m.category, m.min_stock, (SELECT COALESCE(SUM(qty),0) FROM medicine_batches b WHERE b.medicine_id = m.id AND b.expiry_date >= date('now','localtime')) stock, s.name supplier
      FROM medicines m LEFT JOIN suppliers s ON s.id = m.supplier_id WHERE m.hospital_id = ? AND m.is_active = 1`, hid).filter((r) => r.stock < r.min_stock).map((r) => ({ ...r, shortfall: r.min_stock - r.stock }));
    return { columns: [C('name', 'Medicine'), C('strength', 'Strength'), C('category', 'Category'), C('stock', 'Stock', 'int'), C('min_stock', 'Minimum', 'int'), C('shortfall', 'Shortfall', 'int'), C('supplier', 'Supplier')], rows,
      summary: [{ label: 'Below minimum', value: rows.length }], chart: { type: 'hbar', x: 'name', series: [{ key: 'shortfall', label: 'Shortfall' }], data: rows.slice(0, 12) } };
  } },
  pharmacy_expiry: { group: 'Pharmacy', title: 'Expired & near-expiry batches', run(hid) {
    const rows = db.all(`SELECT m.name, m.strength, b.batch_no, b.expiry_date, b.qty, ROUND(b.qty * COALESCE(b.purchase_price, m.purchase_price),2) value, CAST(julianday(b.expiry_date) - julianday(date('now','localtime')) AS INTEGER) days_left
      FROM medicine_batches b JOIN medicines m ON m.id = b.medicine_id WHERE b.hospital_id = ? AND b.qty > 0 AND b.expiry_date <= date('now','localtime','+90 day') ORDER BY b.expiry_date`, hid);
    return { columns: [C('name', 'Medicine'), C('strength', 'Strength'), C('batch_no', 'Batch'), C('expiry_date', 'Expiry', 'date'), C('days_left', 'Days left', 'int'), C('qty', 'Qty', 'int'), C('value', 'Stock value', 'money')], rows,
      summary: [{ label: 'Expired', value: rows.filter((r) => r.days_left < 0).length }, { label: '≤ 30 days', value: rows.filter((r) => r.days_left >= 0 && r.days_left <= 30).length }, { label: 'Value at risk', value: sum(rows, 'value'), type: 'money' }] };
  } },
  purchase: { group: 'Pharmacy', title: 'Purchase & supplier report', run(hid, f) {
    const w = where(f, { date: 'po.created_at', status: 'po.status' });
    const rows = db.all(`SELECT po.po_no, po.grn_no, s.name supplier, substr(po.created_at,1,10) ordered_on, substr(po.received_at,1,10) received_on, po.status, po.total FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id WHERE po.hospital_id = ? AND ${w.sql} ORDER BY po.created_at DESC`, hid, ...w.params);
    const bySup = {}; for (const r of rows) bySup[r.supplier] = round2((bySup[r.supplier] || 0) + r.total);
    return { columns: [C('po_no', 'PO #'), C('grn_no', 'GRN #'), C('supplier', 'Supplier'), C('ordered_on', 'Ordered', 'date'), C('received_on', 'Received', 'date'), C('status', 'Status', 'status'), C('total', 'Value', 'money')], rows,
      summary: [{ label: 'Purchase orders', value: rows.length }, { label: 'Value', value: sum(rows, 'total'), type: 'money' }],
      chart: { type: 'hbar', x: 'supplier', series: [{ key: 'value', label: 'Purchase value' }], data: Object.entries(bySup).map(([supplier, value]) => ({ supplier, value })), money: true } };
  } },
  // ───────── Revenue
  revenue_daily: { group: 'Revenue', title: 'Daily revenue (collections)', run(hid, f) {
    const w = where(f, { date: 'py.created_at' });
    const pm = f.payment_mode ? ' AND py.method = ?' : '';
    const params = f.payment_mode ? [...w.params, f.payment_mode] : w.params;
    const rows = db.all(`SELECT substr(py.created_at,1,10) day, ROUND(SUM(CASE WHEN py.kind='payment' THEN py.amount ELSE 0 END),2) collected, ROUND(SUM(CASE WHEN py.kind='refund' THEN py.amount ELSE 0 END),2) refunds,
        ROUND(SUM(CASE WHEN py.kind='payment' THEN py.amount ELSE -py.amount END),2) net
      FROM payments py JOIN invoices i ON i.id = py.invoice_id WHERE py.hospital_id = ? AND ${w.sql}${pm}${f.department_id ? ' AND i.department_id = ' + Number(f.department_id) : ''}${f.doctor_id ? ' AND i.doctor_id = ' + Number(f.doctor_id) : ''} GROUP BY day ORDER BY day`, hid, ...params);
    const data = fillDays(f, rows, 'day', ['collected', 'refunds', 'net']);
    return { columns: [C('day', 'Date', 'date'), C('collected', 'Collected', 'money'), C('refunds', 'Refunds', 'money'), C('net', 'Net', 'money')], rows: data,
      summary: [{ label: 'Collected', value: sum(rows, 'collected'), type: 'money' }, { label: 'Refunds', value: sum(rows, 'refunds'), type: 'money' }, { label: 'Net', value: sum(rows, 'net'), type: 'money' }],
      chart: { type: 'area', x: 'day', series: [{ key: 'net', label: 'Net revenue (₹)' }], data, money: true } };
  } },
  revenue_monthly: { group: 'Revenue', title: 'Monthly revenue (billed vs collected)', run(hid, f) {
    const w = where(f, { date: 'i.created_at', dept: 'i.department_id', doctor: 'i.doctor_id' });
    const billed = db.all(`SELECT substr(i.created_at,1,7) month, ROUND(SUM(i.total),2) billed, ROUND(SUM(i.balance),2) outstanding FROM invoices i WHERE i.hospital_id = ? AND i.status != 'cancelled' AND ${w.sql} GROUP BY month`, hid, ...w.params);
    const w2 = where(f, { date: 'py.created_at' });
    const coll = db.all(`SELECT substr(py.created_at,1,7) month, ROUND(SUM(CASE WHEN py.kind='payment' THEN py.amount ELSE -py.amount END),2) collected FROM payments py WHERE py.hospital_id = ? AND ${w2.sql} GROUP BY month`, hid, ...w2.params);
    const cm = new Map(coll.map((r) => [r.month, r.collected]));
    const rows = billed.map((r) => ({ ...r, collected: cm.get(r.month) || 0 })).sort((a, b) => a.month.localeCompare(b.month));
    return { columns: [C('month', 'Month'), C('billed', 'Billed', 'money'), C('collected', 'Collected', 'money'), C('outstanding', 'Outstanding', 'money')], rows,
      summary: [{ label: 'Billed', value: sum(rows, 'billed'), type: 'money' }, { label: 'Collected', value: sum(rows, 'collected'), type: 'money' }],
      chart: { type: 'bar', x: 'month', series: [{ key: 'billed', label: 'Billed' }, { key: 'collected', label: 'Collected' }], data: rows, money: true } };
  } },
  revenue_by_type: { group: 'Revenue', title: 'Revenue by service (OPD / IPD / Pharmacy / Lab / Radiology)', run(hid, f) {
    const w = where(f, { date: 'i.created_at', dept: 'i.department_id', doctor: 'i.doctor_id' });
    const rows = db.all(`SELECT i.bill_type service, COUNT(*) invoices, ROUND(SUM(i.total),2) billed, ROUND(SUM(i.paid - i.refunded),2) collected, ROUND(SUM(i.balance),2) outstanding FROM invoices i WHERE i.hospital_id = ? AND i.status != 'cancelled' AND ${w.sql} GROUP BY i.bill_type ORDER BY billed DESC`, hid, ...w.params);
    return { columns: [C('service', 'Service'), C('invoices', 'Invoices', 'int'), C('billed', 'Billed', 'money'), C('collected', 'Collected', 'money'), C('outstanding', 'Outstanding', 'money')], rows,
      summary: [{ label: 'Billed', value: sum(rows, 'billed'), type: 'money' }, { label: 'Collected', value: sum(rows, 'collected'), type: 'money' }],
      chart: { type: 'donut', x: 'service', series: [{ key: 'billed', label: 'Billed' }], data: rows, money: true } };
  } },
  revenue_doctor: { group: 'Revenue', title: 'Doctor-wise revenue', run(hid, f) {
    const w = where(f, { date: 'i.created_at', dept: 'i.department_id', doctor: 'i.doctor_id' });
    const rows = db.all(`SELECT d.name doctor, COUNT(*) invoices, ROUND(SUM(CASE WHEN i.bill_type='opd' THEN i.total ELSE 0 END),2) consultation, ROUND(SUM(i.total),2) total FROM invoices i JOIN doctors d ON d.id = i.doctor_id WHERE i.hospital_id = ? AND i.status != 'cancelled' AND ${w.sql} GROUP BY d.id ORDER BY total DESC`, hid, ...w.params);
    return { columns: [C('doctor', 'Doctor'), C('invoices', 'Invoices', 'int'), C('consultation', 'Consultation', 'money'), C('total', 'Total attributed', 'money')], rows,
      summary: [{ label: 'Total', value: sum(rows, 'total'), type: 'money' }], chart: { type: 'hbar', x: 'doctor', series: [{ key: 'total', label: 'Revenue' }], data: rows, money: true } };
  } },
  revenue_department: { group: 'Revenue', title: 'Department-wise revenue', run(hid, f) {
    const w = where(f, { date: 'i.created_at', dept: 'i.department_id', doctor: 'i.doctor_id' });
    const rows = db.all(`SELECT COALESCE(dp.name, 'Unassigned') department, COUNT(*) invoices, ROUND(SUM(i.total),2) total FROM invoices i LEFT JOIN doctors d ON d.id = i.doctor_id LEFT JOIN departments dp ON dp.id = COALESCE(i.department_id, d.department_id) WHERE i.hospital_id = ? AND i.status != 'cancelled' AND ${w.sql} GROUP BY dp.id ORDER BY total DESC`, hid, ...w.params);
    return { columns: [C('department', 'Department'), C('invoices', 'Invoices', 'int'), C('total', 'Revenue', 'money')], rows,
      summary: [{ label: 'Total', value: sum(rows, 'total'), type: 'money' }], chart: { type: 'donut', x: 'department', series: [{ key: 'total', label: 'Revenue' }], data: rows, money: true } };
  } },
  revenue_payment_mode: { group: 'Revenue', title: 'Collections by payment mode', run(hid, f) {
    const w = where(f, { date: 'py.created_at' });
    const rows = db.all(`SELECT py.method payment_mode, COUNT(*) transactions, ROUND(SUM(py.amount),2) amount FROM payments py WHERE py.hospital_id = ? AND py.kind='payment' AND ${w.sql} GROUP BY py.method ORDER BY amount DESC`, hid, ...w.params);
    return { columns: [C('payment_mode', 'Mode'), C('transactions', 'Transactions', 'int'), C('amount', 'Amount', 'money')], rows,
      summary: [{ label: 'Collected', value: sum(rows, 'amount'), type: 'money' }], chart: { type: 'donut', x: 'payment_mode', series: [{ key: 'amount', label: 'Amount' }], data: rows, money: true } };
  } },
  outstanding: { group: 'Revenue', title: 'Outstanding amounts', run(hid, f) {
    const w = where(f, { date: 'i.created_at', dept: 'i.department_id', doctor: 'i.doctor_id' });
    const rows = db.all(`SELECT i.invoice_no, substr(i.created_at,1,10) date, COALESCE(p.full_name, i.customer_name) patient, p.uhid, p.mobile, i.bill_type, i.total, i.paid, i.balance, CAST(julianday('now','localtime') - julianday(i.created_at) AS INTEGER) age_days
      FROM invoices i LEFT JOIN patients p ON p.id = i.patient_id WHERE i.hospital_id = ? AND i.balance > 0 AND i.status NOT IN ('cancelled','draft') AND ${w.sql} ORDER BY i.balance DESC`, hid, ...w.params);
    const buckets = [['0–7 days', 0, 7], ['8–30 days', 8, 30], ['31–60 days', 31, 60], ['60+ days', 61, 1e9]].map(([bucket, a, b]) => ({ bucket, amount: sum(rows.filter((r) => r.age_days >= a && r.age_days <= b), 'balance') }));
    return { columns: [C('invoice_no', 'Invoice'), C('date', 'Date', 'date'), C('patient', 'Patient'), C('uhid', 'UHID'), C('mobile', 'Mobile'), C('bill_type', 'Type'), C('total', 'Total', 'money'), C('paid', 'Paid', 'money'), C('balance', 'Outstanding', 'money'), C('age_days', 'Age (days)', 'int')], rows,
      summary: [{ label: 'Outstanding', value: sum(rows, 'balance'), type: 'money' }, { label: 'Invoices', value: rows.length }],
      chart: { type: 'bar', x: 'bucket', series: [{ key: 'amount', label: 'Outstanding' }], data: buckets, money: true } };
  } },
  refunds: { group: 'Revenue', title: 'Refunds', run(hid, f) {
    const w = where(f, { date: 'py.created_at' });
    const rows = db.all(`SELECT py.receipt_no, substr(py.created_at,1,16) date, i.invoice_no, COALESCE(p.full_name, i.customer_name) patient, py.amount, py.method, py.note reason, u.full_name by_user FROM payments py JOIN invoices i ON i.id = py.invoice_id LEFT JOIN patients p ON p.id = py.patient_id LEFT JOIN users u ON u.id = py.user_id WHERE py.hospital_id = ? AND py.kind='refund' AND ${w.sql} ORDER BY py.created_at DESC`, hid, ...w.params);
    return { columns: [C('receipt_no', 'Refund #'), C('date', 'Date', 'datetime'), C('invoice_no', 'Invoice'), C('patient', 'Patient'), C('amount', 'Amount', 'money'), C('method', 'Mode'), C('reason', 'Reason'), C('by_user', 'By')], rows,
      summary: [{ label: 'Refunds', value: rows.length }, { label: 'Amount', value: sum(rows, 'amount'), type: 'money' }] };
  } },
  // ───────── HR
  hr_employees: { group: 'HR', title: 'Department-wise employees', run(hid) {
    const rows = db.all(`SELECT COALESCE(dp.name,'—') department, COUNT(*) employees, SUM(e.status='active') active, SUM(e.employment_type='full_time') full_time FROM employees e LEFT JOIN departments dp ON dp.id = e.department_id WHERE e.hospital_id = ? AND e.status != 'exited' GROUP BY e.department_id ORDER BY employees DESC`, hid);
    return { columns: [C('department', 'Department'), C('employees', 'Employees', 'int'), C('active', 'Active', 'int'), C('full_time', 'Full-time', 'int')], rows,
      summary: [{ label: 'Employees', value: sum(rows, 'employees') }], chart: { type: 'hbar', x: 'department', series: [{ key: 'employees', label: 'Employees' }], data: rows } };
  } },
  hr_attendance: { group: 'HR', title: 'Attendance summary', run(hid, f) {
    const w = where(f, { date: 'a.date', dept: 'e.department_id' });
    const rows = db.all(`SELECT e.emp_code, e.full_name, dp.name department, SUM(a.status='present') present, SUM(a.status='late') late, SUM(a.status='half_day') half_day, SUM(a.status='absent') absent, SUM(a.status='leave') leave, ROUND(SUM(a.overtime_hours),1) overtime_hours
      FROM attendance a JOIN employees e ON e.id = a.employee_id LEFT JOIN departments dp ON dp.id = e.department_id WHERE a.hospital_id = ? AND ${w.sql} GROUP BY e.id ORDER BY e.full_name`, hid, ...w.params);
    const daily = db.all(`SELECT a.date day, SUM(a.status IN ('present','late')) present, SUM(a.status='absent') absent, SUM(a.status='leave') on_leave FROM attendance a JOIN employees e ON e.id = a.employee_id WHERE a.hospital_id = ? AND ${w.sql} GROUP BY a.date ORDER BY a.date`, hid, ...w.params);
    return { columns: [C('emp_code', 'Emp #'), C('full_name', 'Employee'), C('department', 'Department'), C('present', 'Present', 'int'), C('late', 'Late', 'int'), C('half_day', 'Half day', 'int'), C('absent', 'Absent', 'int'), C('leave', 'Leave', 'int'), C('overtime_hours', 'OT hrs', 'number')], rows,
      summary: [{ label: 'Present days', value: sum(rows, 'present') + sum(rows, 'late') }, { label: 'Absent days', value: sum(rows, 'absent') }, { label: 'Leave days', value: sum(rows, 'leave') }],
      chart: { type: 'bar', stacked: true, x: 'day', series: [{ key: 'present', label: 'Present' }, { key: 'on_leave', label: 'Leave' }, { key: 'absent', label: 'Absent' }], data: daily } };
  } },
  hr_leave: { group: 'HR', title: 'Leave register', run(hid, f) {
    const w = where(f, { date: 'l.from_date', status: 'l.status' });
    const rows = db.all(`SELECT e.emp_code, e.full_name, l.leave_type, l.from_date, l.to_date, l.days, l.status, l.reason FROM leaves l JOIN employees e ON e.id = l.employee_id WHERE l.hospital_id = ? AND ${w.sql} ORDER BY l.from_date DESC`, hid, ...w.params);
    const by = {}; for (const r of rows) by[r.leave_type] = (by[r.leave_type] || 0) + r.days;
    return { columns: [C('emp_code', 'Emp #'), C('full_name', 'Employee'), C('leave_type', 'Type'), C('from_date', 'From', 'date'), C('to_date', 'To', 'date'), C('days', 'Days', 'number'), C('status', 'Status', 'status'), C('reason', 'Reason')], rows,
      summary: [{ label: 'Requests', value: rows.length }, { label: 'Days', value: sum(rows, 'days') }], chart: { type: 'donut', x: 'leave_type', series: [{ key: 'days', label: 'Days' }], data: Object.entries(by).map(([leave_type, days]) => ({ leave_type, days })) } };
  } },
  hr_salary: { group: 'HR', title: 'Payroll register', run(hid, f) {
    const month = (f.to || today()).slice(0, 7);
    const rows = db.all(`SELECT e.emp_code, e.full_name, dp.name department, p.month, p.paid_days, p.gross, p.total_deductions, p.net_pay, p.status FROM payroll p JOIN employees e ON e.id = p.employee_id LEFT JOIN departments dp ON dp.id = e.department_id WHERE p.hospital_id = ? AND p.month BETWEEN ? AND ? ORDER BY p.month DESC, e.full_name`, hid, f.from.slice(0, 7), month);
    return { columns: [C('emp_code', 'Emp #'), C('full_name', 'Employee'), C('department', 'Department'), C('month', 'Month'), C('paid_days', 'Paid days', 'number'), C('gross', 'Gross', 'money'), C('total_deductions', 'Deductions', 'money'), C('net_pay', 'Net pay', 'money'), C('status', 'Status', 'status')], rows,
      summary: [{ label: 'Gross', value: sum(rows, 'gross'), type: 'money' }, { label: 'Net pay', value: sum(rows, 'net_pay'), type: 'money' }] };
  } },
};

function catalogue() { return Object.entries(REPORTS).map(([key, r]) => ({ key, group: r.group, title: r.title })); }
function run(hid, key, filters) {
  const r = REPORTS[key];
  if (!r) return null;
  const out = r.run(hid, filters);
  return { key, title: r.title, group: r.group, filters, ...out };
}

module.exports = { REPORTS, catalogue, run };
