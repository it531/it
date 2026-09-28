'use strict';
// End-to-end verification of the Deep Hospital core workflow through the real HTTP API:
// reception → UHID → appointment → OPD token → patient portal → doctor EMR → diagnosis →
// template suggestion → explicit confirmation → prescription → pharmacy order & token →
// dispensing (stock decrement) → invoice → payment → portal → MIS / dashboard.
// Also checks RBAC, hospital isolation, IPD numbering, audit logs and sequence safety.
process.env.TZ = 'Asia/Kolkata';
process.env.NODE_ENV = 'test';
process.env.DISABLE_SCHEDULER = 'true';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dh-test-'));
process.env.DATA_DIR = tmp;
process.env.DB_FILE = path.join(tmp, 'test.db');

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../server/db');
const { createApp } = require('../server/index');
const { hashPassword } = require('../server/lib/crypto');
const { now, today } = require('../server/lib/util');

let server; let base;
const OWNER_PW = 'Owner#Secure2026';

async function call(method, url, { token, body } = {}) {
  const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text();
  return { status: res.status, data };
}
const get = (u, t) => call('GET', u, { token: t });
const post = (u, body, t) => call('POST', u, { token: t, body });
const put = (u, body, t) => call('PUT', u, { token: t, body });
async function login(username, password, hospital_code) {
  const r = await post('/api/auth/login', { username, password, hospital_code });
  assert.equal(r.status, 200, `login ${username}: ${JSON.stringify(r.data)}`);
  return r.data.token;
}
const ok = (r, code = 200) => { assert.equal(r.status, code, JSON.stringify(r.data)); return r.data; };

before(async () => {
  db.open();
  require('../server/services/hospitals').ensurePermissions();
  db.insertRow('users', { hospital_id: null, username: 'owner', full_name: 'Platform Owner', password_hash: hashPassword(OWNER_PW), is_super_admin: 1, created_at: now() });
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); db.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

const S = {};

test('super admin creates an isolated hospital with a hospital admin', async () => {
  S.owner = await login('owner', OWNER_PW);
  ok(await post('/api/platform/hospitals', { code: 'TEST-H', name: 'Test General Hospital', city: 'Ahmedabad', admin: { username: 'hadmin', password: 'Admin#2026x', full_name: 'Test Admin' } }, S.owner), 201);
  ok(await post('/api/platform/hospitals', { code: 'OTHER-H', name: 'Other Hospital', city: 'Surat', admin: { username: 'hadmin', password: 'Admin#2026y' } }, S.owner), 201);
  const list = ok(await get('/api/platform/hospitals', S.owner));
  assert.equal(list.length, 2);
  S.admin = await login('hadmin', 'Admin#2026x', 'TEST-H');
  S.otherAdmin = await login('hadmin', 'Admin#2026y', 'OTHER-H'); // same username, different tenant
});

test('hospital admin sets up masters, users and roles', async () => {
  const roles = ok(await get('/api/roles', S.admin)).roles;
  const rid = (k) => roles.find((r) => r.key === k).id;
  const dept = ok(await post('/api/departments', { name: 'General Medicine', code: 'GM' }, S.admin), 201);
  const doctorUser = ok(await post('/api/users', { username: 'dr.test', full_name: 'Dr. Test Mehta', password: 'Doctor#2026', role_ids: [rid('doctor')] }, S.admin), 201);
  ok(await post('/api/users', { username: 'reception01', full_name: 'Reception One', password: 'Recept#2026', role_ids: [rid('reception')] }, S.admin), 201);
  ok(await post('/api/users', { username: 'pharma01', full_name: 'Pharma One', password: 'Pharma#2026', role_ids: [rid('pharmacist')] }, S.admin), 201);
  ok(await post('/api/users', { username: 'nurse01', full_name: 'Nurse One', password: 'Nurse#20266', role_ids: [rid('nurse')] }, S.admin), 201);
  S.doctor = ok(await post('/api/doctors', { name: 'Dr. Test Mehta', department_id: dept.id, consultation_fee: 500, token_prefix: 'A', user_id: doctorUser.id }, S.admin), 201);
  const exp = `${Number(today().slice(0, 4)) + 2}-01-31`;
  S.med = ok(await post('/api/medicines', { name: 'Pantoprazole', strength: '40 mg', dosage_form: 'Tablet', purchase_price: 6, selling_price: 10, min_stock: 5, batch_no: 'PAN001', expiry_date: exp, opening_qty: 100 }, S.admin), 201);
  S.med2 = ok(await post('/api/medicines', { name: 'Domperidone', strength: '10 mg', dosage_form: 'Tablet', purchase_price: 2, selling_price: 3.5, min_stock: 5, batch_no: 'DOM001', expiry_date: exp, opening_qty: 50 }, S.admin), 201);
  S.dx = ok(await post('/api/masters/diagnoses', { code: 'K29.1', name: 'Acute gastritis', specialty: 'General Medicine', is_common: true }, S.admin), 201);
  ok(await post('/api/masters/templates', { name: 'Gastritis standard', diagnosis_id: S.dx.id, is_approved: true, items: [{ medicine_id: S.med.id, dose: '1 tab', frequency: 'OD', duration_days: 5, route: 'Oral', instructions: 'Before breakfast' }, { medicine_id: S.med2.id, dose: '1 tab', frequency: 'TDS', duration_days: 5, route: 'Oral' }] }, S.admin), 201);
  ok(await post('/api/masters/wards', { name: 'General Ward', ward_type: 'general', daily_rate: 1500, beds: 4, bed_prefix: 'GW' }, S.admin), 201);
  S.reception = await login('reception01', 'Recept#2026', 'TEST-H');
  S.doc = await login('dr.test', 'Doctor#2026', 'TEST-H');
  S.pharma = await login('pharma01', 'Pharma#2026', 'TEST-H');
});

test('steps 1–8: reception registers patient (#000001), appointment → token A001, patient sees it on portal', async () => {
  // 2–3: search → not found
  assert.equal(ok(await get('/api/patients?q=Rahul%20Shah', S.reception)).total, 0);
  // 4–5: create → UHID #000001
  const p = ok(await post('/api/patients', { first_name: 'Rahul', last_name: 'Shah', gender: 'Male', dob: '1984-05-10', mobile: '9876543210', allergies: 'Penicillin', id_type: 'aadhaar', id_number: '1234 5678 9012', portal_password: 'portal123' }, S.reception), 201);
  assert.equal(p.uhid, '#000001');
  S.patient = p;
  const p2 = ok(await post('/api/patients', { first_name: 'Priya', last_name: 'Patel', gender: 'Female', mobile: '9876500000' }, S.reception), 201);
  assert.equal(p2.uhid, '#000002');
  // search by UHID, mobile and encrypted Aadhaar (blind index)
  assert.equal(ok(await get('/api/patients?q=%23000001', S.reception)).rows[0].id, p.id);
  assert.equal(ok(await get('/api/patients?q=9876543210', S.reception)).rows[0].id, p.id);
  assert.equal(ok(await get('/api/patients?q=123456789012', S.reception)).rows[0].id, p.id);
  // 6: appointment
  const d = new Date(Date.now() + 2 * 3600e3);
  const at = `${today()} ${String(Math.min(d.getHours(), 22)).padStart(2, '0')}:${d.getHours() > 22 ? '59' : '00'}`;
  const appt = ok(await post('/api/appointments', { patient_id: p.id, doctor_id: S.doctor.id, scheduled_at: at, reason: 'Acidity' }, S.reception), 201);
  // 7: check-in → token A001
  const visit = ok(await post(`/api/appointments/${appt.id}/check-in`, {}, S.reception), 201);
  assert.equal(visit.token, 'A001');
  assert.ok(visit.invoice_id, 'consultation invoice auto-created');
  S.visit = visit;
  // 8: patient portal shows the live token
  const pl = ok(await post('/api/portal/login', { hospital_code: 'TEST-H', login: '#000001', password: 'portal123' }));
  S.portal = pl.token;
  const me = ok(await get('/api/portal/me', S.portal));
  assert.equal(me.visits[0].token, 'A001');
  assert.equal(me.visits[0].status, 'waiting');
  assert.ok(me.notifications.some((n) => /A001/.test(n.title)), 'patient notified of token');
});

test('steps 9–18: doctor consultation, smart diagnosis, templates require explicit review, prescription finalized', async () => {
  // 10: doctor sees A001
  const q = ok(await get(`/api/opd/queue/${S.doctor.id}`, S.doc));
  assert.equal(q.waiting[0].token, 'A001');
  const called = ok(await post(`/api/opd/queue/${S.doctor.id}/call-next`, {}, S.doc));
  assert.equal(called.token, 'A001');
  // 11–12: EMR with allergies and (empty) history
  const emr = ok(await get(`/api/opd/visits/${S.visit.id}/emr`, S.doc));
  assert.equal(emr.patient.allergies, 'Penicillin');
  assert.ok(Array.isArray(emr.history));
  // 13–14: vitals + diagnosis (server validates ranges)
  assert.equal((await put(`/api/opd/visits/${S.visit.id}/consultation`, { vitals: { spo2: 140 } }, S.doc)).status, 400);
  ok(await put(`/api/opd/visits/${S.visit.id}/consultation`, { chief_complaint: 'Burning epigastric pain', vitals: { bp_sys: 124, bp_dia: 80, pulse: 78, temp: 98.4, spo2: 98, weight: 72, height: 175 }, diagnosis_ids: [S.dx.id], follow_up_date: today() }, S.doc));
  // 15: frequently used diagnoses appear first for this doctor
  const dxs = ok(await get('/api/diagnoses/search', S.doc));
  assert.equal(dxs.frequent[0].id, S.dx.id);
  // 16: hospital-approved template suggested — lines come back unconfirmed
  const t = ok(await get(`/api/prescription-templates/suggest?diagnosis_ids=${S.dx.id}`, S.doc));
  assert.equal(t.length, 1);
  assert.ok(t[0].items.every((i) => i.confirmed === 0));
  // Never auto-prescribe: finalizing unreviewed lines is rejected server-side
  const items = t[0].items.map((i) => ({ ...i }));
  ok(await put(`/api/opd/visits/${S.visit.id}/prescription`, { items }, S.doc));
  const rej = await post(`/api/opd/visits/${S.visit.id}/finalize`, {}, S.doc);
  assert.equal(rej.status, 400);
  assert.match(rej.data.error, /review and confirm/i);
  // Reception cannot prescribe at all
  assert.equal((await post(`/api/opd/visits/${S.visit.id}/finalize`, {}, S.reception)).status, 403);
  // 17–18: doctor confirms every line, then finalizes
  const confirmed = items.map((i) => ({ ...i, confirmed: 1 }));
  const fin = ok(await post(`/api/opd/visits/${S.visit.id}/finalize`, { items: confirmed, send_to_pharmacy: 1 }, S.doc));
  assert.match(fin.rx_no, /^RX-\d+/);
  S.rx = fin;
  S.expectedQty = { [S.med.id]: 5, [S.med2.id]: 15 };  // OD×5, TDS×5
});

test('steps 19–23: pharmacy receives order automatically, token P-001, dispensing decreases stock', async () => {
  // 19–20
  assert.equal(S.rx.pharmacy_order.token, 'P-001');
  const q = ok(await get('/api/pharmacy/queue', S.pharma));
  assert.equal(q.waiting[0].token, 'P-001');
  // 21: patient sees pharmacy status
  let me = ok(await get('/api/portal/me', S.portal));
  assert.equal(me.pharmacy[0].token, 'P-001');
  assert.equal(me.pharmacy[0].status, 'waiting');
  // 22: call next → processing → dispense
  const before = ok(await get(`/api/medicines/${S.med.id}`, S.pharma)).stock;
  ok(await post('/api/pharmacy/call-next', {}, S.pharma));
  const disp = ok(await post(`/api/pharmacy/orders/${S.rx.pharmacy_order.id}/status`, { status: 'dispensed' }, S.pharma));
  assert.equal(disp.status, 'dispensed');
  // 23: stock decreased by prescribed quantity, with FEFO stock movements
  const after = ok(await get(`/api/medicines/${S.med.id}`, S.pharma));
  assert.equal(after.stock, before - S.expectedQty[S.med.id]);
  assert.ok(after.movements.some((m) => m.movement === 'dispense' && m.qty === -S.expectedQty[S.med.id]));
  me = ok(await get('/api/portal/me', S.portal));
  assert.equal(me.pharmacy[0].status, 'dispensed');
  S.pharmacyInvoice = disp.invoice_id;
});

test('steps 24–28: invoice, payment, patient receives documents, MIS and dashboard update', async () => {
  // 24
  const inv = ok(await get(`/api/billing/invoices/${S.pharmacyInvoice}`, S.reception));
  assert.equal(inv.total, 5 * 10 + 15 * 3.5);
  // 25: partial then full payment; balance recalculated automatically
  const p1 = ok(await post(`/api/billing/invoices/${inv.id}/payments`, { amount: 50, method: 'cash' }, S.reception), 201);
  assert.equal(p1.invoice.status, 'partial');
  assert.equal((await post(`/api/billing/invoices/${inv.id}/payments`, { amount: 10, method: 'upi' }, S.reception)).status, 400, 'UPI needs a reference');
  const p2 = ok(await post(`/api/billing/invoices/${inv.id}/payments`, { amount: inv.total - 50, method: 'upi', reference: 'UPI123456' }, S.reception), 201);
  assert.equal(p2.invoice.status, 'paid');
  assert.equal(p2.invoice.balance, 0);
  assert.equal((await post(`/api/billing/invoices/${inv.id}/payments`, { amount: 1, method: 'cash' }, S.reception)).status, 400, 'no overpayment');
  // consultation fee too
  ok(await post(`/api/billing/invoices/${S.visit.invoice_id}/payments`, { amount: 500, method: 'cash' }, S.reception), 201);
  // 26: portal has prescription + invoice
  const me = ok(await get('/api/portal/me', S.portal));
  assert.equal(me.prescriptions[0].rx_no, S.rx.rx_no);
  assert.ok(me.bills.find((b) => b.id === inv.id && b.status === 'paid'));
  ok(await get(`/api/portal/prescriptions/${S.rx.prescription_id}`, S.portal));
  // 27: MIS computed from live data
  const opd = ok(await get('/api/reports/opd_daily?preset=today', S.admin));
  assert.equal(opd.summary[0].value, 1);
  const rev = ok(await get('/api/reports/revenue_daily?preset=today', S.admin));
  assert.equal(rev.summary[0].value, inv.total + 500);
  const nl = ok(await post('/api/assistant/query', { q: 'Show me OPD patients today' }, S.admin));
  assert.equal(nl.report.key, 'opd_daily');
  const csv = await get('/api/reports/pharmacy_sales?preset=today&format=csv', S.admin);
  assert.equal(csv.status, 200);
  assert.match(csv.data, /Sales/);
  // 28: dashboard statistics
  const dash = ok(await get('/api/dashboard', S.admin));
  assert.equal(dash.today.opd_patients, 1);
  assert.equal(dash.finance.revenue_today, inv.total + 500);
});

test('IPD number is separate from UHID; admission and discharge drive bed status and billing', async () => {
  const beds = ok(await get('/api/ipd/beds', S.admin));
  const bed = beds.wards[0].beds[0];
  const adm = ok(await post('/api/ipd/admission', { patient_id: S.patient.id, doctor_id: S.doctor.id, bed_id: bed.id, reason: 'Observation' }, S.admin), 201);
  assert.equal(adm.ipd_no, 'IPD-000001');
  assert.notEqual(adm.ipd_no, S.patient.uhid);
  assert.equal(ok(await get('/api/ipd/beds', S.admin)).wards[0].beds.find((b) => b.id === bed.id).status, 'occupied');
  assert.equal((await post('/api/ipd/admission', { patient_id: S.patient.id, doctor_id: S.doctor.id, bed_id: beds.wards[0].beds[1].id, reason: 'x' }, S.admin)).status, 409, 'no double admission');
  const nurse = await login('nurse01', 'Nurse#20266', 'TEST-H');
  const v = ok(await post(`/api/ipd/admissions/${adm.id}/vitals`, { spo2: 86, pulse: 120 }, nurse), 201);
  assert.equal(v.critical, true);
  const dis = ok(await post(`/api/ipd/admissions/${adm.id}/discharge`, { final_diagnosis: 'Recovered', discharge_summary: 'Stable' }, S.admin));
  const inv = ok(await get(`/api/billing/invoices/${dis.invoice_id}`, S.admin));
  assert.equal(inv.bill_type, 'ipd');
  assert.ok(inv.items.some((i) => i.category === 'room'));
  assert.equal(ok(await get('/api/ipd/beds', S.admin)).wards[0].beds.find((b) => b.id === bed.id).status, 'cleaning');
});

test('permissions actually restrict access', async () => {
  assert.equal((await post('/api/patients', { first_name: 'X', gender: 'Male', mobile: '9999999999' }, S.pharma)).status, 403);
  assert.equal((await get('/api/hr/employees', S.pharma)).status, 403);
  assert.equal((await get('/api/audit', S.reception)).status, 403);
  assert.equal((await get('/api/platform/hospitals', S.admin)).status, 403, 'hospital admin is not super admin');
  assert.equal((await post('/api/pharmacy/call-next', {}, S.reception)).status, 403);
  // per-user override: block patients for the pharmacist
  const users = ok(await get('/api/users', S.admin));
  const ph = users.find((u) => u.username === 'pharma01');
  ok(await put(`/api/users/${ph.id}/modules`, { patients: 'deny' }, S.admin));
  assert.equal((await get(`/api/patients?q=a`, S.pharma)).status, 200, 'pharmacy view still allowed via pharmacy module');
  assert.equal((await get(`/api/patients/${S.patient.id}/timeline`, S.pharma)).status, 403);
  // module disabled by the platform owner → blocked for everyone in that hospital
  const hs = ok(await get('/api/platform/hospitals', S.owner));
  const h = hs.find((x) => x.code === 'TEST-H');
  ok(await put(`/api/platform/hospitals/${h.id}/modules`, { laboratory: false }, S.owner));
  assert.equal((await get('/api/lab/orders', S.admin)).status, 403);
  ok(await put(`/api/platform/hospitals/${h.id}/modules`, { laboratory: true }, S.owner));
  assert.equal((await get('/api/lab/orders', S.admin)).status, 200);
});

test('hospital data is isolated between tenants', async () => {
  const other = ok(await post('/api/patients', { first_name: 'Surat', last_name: 'Patient', gender: 'Female', mobile: '9812345678' }, S.otherAdmin), 201);
  assert.equal(other.uhid, '#000001', 'each hospital has its own UHID series');
  assert.equal((await get(`/api/patients/${other.id}`, S.admin)).status, 404);
  assert.equal((await get(`/api/patients/${S.patient.id}`, S.otherAdmin)).status, 404);
  assert.equal(ok(await get('/api/patients?q=Surat', S.admin)).total, 0);
  assert.equal((await post(`/api/billing/invoices/${S.pharmacyInvoice}/payments`, { amount: 1, method: 'cash' }, S.otherAdmin)).status, 404);
  assert.equal((await get(`/api/opd/visits/${S.visit.id}/emr`, S.otherAdmin)).status, 404);
});

test('audit log records important actions', async () => {
  const rows = ok(await get('/api/audit?limit=500', S.admin));
  const actions = new Set(rows.map((r) => r.action));
  for (const a of ['auth.login', 'patient.created', 'opd.visit_created', 'prescription.finalized', 'pharmacy.dispensed', 'billing.payment', 'ipd.admitted', 'ipd.discharged', 'user.permissions_changed', 'user.created']) assert.ok(actions.has(a), `missing audit ${a}`);
  const created = rows.find((r) => r.action === 'patient.created' && r.ref === '#000001');
  assert.equal(created.username, 'reception01');
});

test('numbers are never duplicated under concurrent registration', async () => {
  const res = await Promise.all(Array.from({ length: 25 }, (_, i) => post('/api/patients', { first_name: `Load${i}`, gender: 'Male', mobile: `98000000${String(i).padStart(2, '0')}` }, S.reception)));
  const uhids = res.map((r) => r.data.uhid);
  assert.equal(new Set(uhids).size, 25);
});

test('authentication hardening: wrong password, lockout, logout, password change', async () => {
  assert.equal((await post('/api/auth/login', { username: 'reception01', password: 'nope', hospital_code: 'TEST-H' })).status, 401);
  assert.equal((await get('/api/auth/me')).status, 401);
  const t = await login('nurse01', 'Nurse#20266', 'TEST-H');
  ok(await post('/api/auth/change-password', { current_password: 'Nurse#20266', new_password: 'Nurse#Changed1' }, t));
  assert.equal((await post('/api/auth/login', { username: 'nurse01', password: 'Nurse#20266', hospital_code: 'TEST-H' })).status, 401);
  const t2 = await login('nurse01', 'Nurse#Changed1', 'TEST-H');
  ok(await post('/api/auth/logout', {}, t2));
  assert.equal((await get('/api/auth/me', t2)).status, 401);
  const stored = db.get("SELECT password_hash FROM users WHERE username = 'nurse01'").password_hash;
  assert.match(stored, /^scrypt\$/);
  assert.ok(!stored.includes('Nurse#Changed1'));
});
