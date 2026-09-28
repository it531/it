'use strict';
// Demo data generator — DEVELOPMENT ONLY. Creates the platform owner (admin / 123),
// four hospitals and ~3 months of realistic, fully-linked activity that flows through
// the same services the API uses (UHIDs, tokens, invoices, stock movements …).
process.env.TZ = process.env.TZ || 'Asia/Kolkata';
const fs = require('node:fs');
const db = require('./db');
const seq = require('./lib/sequence');
const hospitals = require('./services/hospitals');
const patients = require('./services/patients');
const opd = require('./services/opd');
const pharmacy = require('./services/pharmacy');
const billing = require('./services/billing');
const inventory = require('./services/inventory');
const clinical = require('./services/clinical');
const hr = require('./services/hr');
const rxsvc = require('./services/prescriptions');
const { hashPassword } = require('./lib/crypto');
const { now, today, addDays, fmt, addMinutes } = require('./lib/util');
const D = require('./seed-data');

const DEMO_PASSWORD = '123';

// Deterministic PRNG so every developer gets the same demo world.
let s = 20260928;
const rnd = () => { s |= 0; s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const ri = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const chance = (p) => rnd() < p;
const hhmm = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}:00`;

let pwHash;
const demoHash = () => (pwHash = pwHash || hashPassword(DEMO_PASSWORD));

function user(hid, username, full_name, roleKeys) {
  const uid = db.insertRow('users', { hospital_id: hid, username, full_name, email: `${username.replace(/[^a-z0-9]/gi, '')}@deephospital.in`, password_hash: demoHash(), uses_demo_password: 1, created_at: now() });
  for (const k of roleKeys) db.run('INSERT INTO user_roles (user_id, role_id) SELECT ?, id FROM roles WHERE hospital_id = ? AND key = ?', uid, hid, k);
  return uid;
}

function masters(hid, { doctors = D.DOCTORS, full = true } = {}) {
  const t = now();
  const dept = {};
  for (const [name, code, kind] of D.DEPARTMENTS) dept[name] = db.insertRow('departments', { hospital_id: hid, name, code, kind, created_at: t });
  const docs = [];
  for (const [name, dname, spec, qual, fee, ffee, prefix, room, username] of doctors) {
    const uid = user(hid, username, name, ['doctor']);
    const id = db.insertRow('doctors', { hospital_id: hid, user_id: uid, department_id: dept[dname], name, specialization: spec, qualification: qual, registration_no: `GMC-${ri(10000, 99999)}`, phone: `98${ri(10000000, 99999999)}`, room, consultation_fee: fee, followup_fee: ffee, token_prefix: prefix, avg_consult_minutes: ri(8, 14), created_at: t });
    docs.push({ id, name, dept: dname, department_id: dept[dname], fee, ffee, prefix, user_id: uid });
  }
  const dx = {};
  for (const [code, name, specialty, common, syn] of D.DIAGNOSES) dx[name] = db.insertRow('diagnosis_codes', { hospital_id: hid, code, name, specialty, is_common: common, synonyms: syn, created_at: t });
  const sup = D.SUPPLIERS.map(([name, contact_person, phone, email, address, gstin]) => db.insertRow('suppliers', { hospital_id: hid, name, contact_person, phone, email, address, gstin, created_at: t }));
  const meds = {};
  D.MEDICINES.forEach(([name, generic_name, brand, strength, dosage_form, manufacturer, category, pp, sp, min, route, gst, hsn], i) => {
    const id = db.insertRow('medicines', { hospital_id: hid, name, generic_name, brand, strength, dosage_form, manufacturer, category, hsn, gst_rate: gst, purchase_price: pp, selling_price: sp, min_stock: full ? min : Math.ceil(min / 3), supplier_id: sup[i % 2], storage: /Insulin|Enoxaparin/.test(name) ? '2–8°C (refrigerate)' : 'Below 25°C', default_route: route, created_at: t });
    meds[name] = { id, name, strength, sp, pp, min: full ? min : Math.ceil(min / 3), supplier: sup[i % 2] };
  });
  // Approved clinical templates (suggestions only).
  const admin = db.get("SELECT u.id FROM users u JOIN user_roles ur ON ur.user_id = u.id JOIN roles r ON r.id = ur.role_id WHERE u.hospital_id = ? AND r.key = 'hospital_admin'", hid);
  for (const [dxName, tname, advice, items] of D.TEMPLATES) {
    const tid = db.insertRow('prescription_templates', { hospital_id: hid, name: tname, diagnosis_id: dx[dxName], advice, is_approved: 1, approved_by: admin && admin.id, created_at: t });
    for (const [m, dose, frequency, duration_days, route, instructions] of items) db.insertRow('prescription_template_items', { template_id: tid, medicine_id: meds[m].id, dose, frequency, duration_days, route, instructions });
  }
  const labs = {};
  for (const [code, name, category, sample_type, price, tat, params] of D.LAB_TESTS) labs[code] = { id: db.insertRow('lab_tests', { hospital_id: hid, code, name, category, sample_type, price, tat_hours: tat, parameters: JSON.stringify(params), created_at: t }), params };
  const beds = [];
  for (const [name, ward_type, floor, rate, n, prefix] of D.WARDS) {
    const wid = db.insertRow('wards', { hospital_id: hid, name, ward_type, floor, daily_rate: rate, created_at: t });
    for (let i = 1; i <= (full ? n : Math.ceil(n / 2)); i++) beds.push({ id: db.insertRow('beds', { hospital_id: hid, ward_id: wid, bed_no: `${prefix}-${String(i).padStart(2, '0')}`, room: ward_type === 'private' ? `Room ${400 + i}` : null, status: 'available', updated_at: t }), ward_type });
  }
  for (const [code, name, category, unit, stock, min, cost] of D.INVENTORY_ITEMS) {
    const iid = db.insertRow('inventory_items', { hospital_id: hid, code, name, category, unit, stock, min_stock: min, unit_cost: cost, location: category === 'equipment' ? 'Biomedical Store' : 'Main Store', supplier_id: category === 'equipment' ? sup[3] : sup[2], created_at: t });
    db.insertRow('stock_movements', { hospital_id: hid, item_type: 'item', item_id: iid, qty: stock, movement: 'opening', created_at: t });
  }
  return { dept, docs, dx, meds, labs, beds, sup };
}

// Opening stock: 2–3 batches per medicine; a few near-expiry and one expired batch for alerts.
function openingStock(hid, M, start) {
  let i = 0;
  for (const m of Object.values(M.meds)) {
    const n = ri(2, 3);
    for (let b = 0; b < n; b++) {
      const exp = addDays(today(), ri(240, 820));
      inventory.addBatch(hid, { medicine_id: m.id, batch_no: `${m.name.slice(0, 3).toUpperCase()}${ri(1000, 9999)}${String.fromCharCode(65 + b)}`, expiry_date: exp, qty: Math.max(40, Math.round(m.min * ri(4, 7) / n)), purchase_price: m.pp, mrp: m.sp, supplier_id: m.supplier }, { movement: 'opening', at: `${start} 08:00:00` });
    }
    if (i % 9 === 3) inventory.addBatch(hid, { medicine_id: m.id, batch_no: `NX${ri(10000, 99999)}`, expiry_date: addDays(today(), ri(8, 26)), qty: ri(20, 60), purchase_price: m.pp, mrp: m.sp, supplier_id: m.supplier }, { movement: 'grn', at: `${start} 08:00:00` });
    if (i === 12) inventory.addBatch(hid, { medicine_id: m.id, batch_no: `EXP${ri(1000, 9999)}`, expiry_date: addDays(today(), -6), qty: 24, purchase_price: m.pp, mrp: m.sp, supplier_id: m.supplier }, { movement: 'grn', at: `${start} 08:00:00` });
    i++;
  }
}

// Reorder via a received purchase order when stock drops below the reorder point.
function replenish(hid, m, at, force) {
  const stock = inventory.medicineStock(m.id);
  if (!force && (m.noReorder || stock >= m.min)) return;
  const qty = force ? Math.max(force, m.min) : m.min * 4;
  const po = seq.formatted(hid, 'po').value; const grn = seq.formatted(hid, 'grn').value;
  const poId = db.insertRow('purchase_orders', { hospital_id: hid, po_no: po, supplier_id: m.supplier, status: 'received', total: Math.round(qty * m.pp * 100) / 100, grn_no: grn, received_at: at, created_at: addMinutes(at, -60 * 24 * 2) });
  const batch = `${m.name.slice(0, 3).toUpperCase()}${ri(10000, 99999)}`; const exp = addDays(at.slice(0, 10), ri(300, 900));
  db.insertRow('purchase_order_items', { po_id: poId, item_type: 'medicine', medicine_id: m.id, quantity: qty, unit_cost: m.pp, batch_no: batch, expiry_date: exp, mrp: m.sp });
  inventory.addBatch(hid, { medicine_id: m.id, batch_no: batch, expiry_date: exp, qty, purchase_price: m.pp, mrp: m.sp, supplier_id: m.supplier }, { movement: 'grn', refType: 'purchase_order', refId: poId, at });
}

const METHODS = [['cash', 0.4], ['upi', 0.8], ['card', 0.95], ['bank_transfer', 1]];
function method() { const r = rnd(); return METHODS.find(([, p]) => r < p)[0]; }
function pay(hid, invoiceId, at, full = true) {
  const inv = db.get('SELECT balance FROM invoices WHERE id = ?', invoiceId);
  if (!inv || inv.balance <= 0) return;
  const m = method();
  const amount = full ? inv.balance : Math.round(inv.balance * (0.3 + rnd() * 0.4));
  billing.recordPayment(hid, invoiceId, { amount, method: m, reference: m === 'cash' ? null : `${m.toUpperCase().slice(0, 3)}${ri(100000000, 999999999)}`, created_at: at });
}

function vitals(age) {
  const bp = age > 45 ? ri(118, 162) : ri(104, 134);
  const w = age < 12 ? ri(10, 38) : ri(48, 92); const h = age < 12 ? ri(80, 145) : ri(150, 182);
  return { bp_sys: bp, bp_dia: Math.round(bp * 0.62 + ri(-4, 6)), pulse: ri(66, 102), temp: Math.round((97.6 + rnd() * (chance(0.3) ? 4 : 1.2)) * 10) / 10, spo2: ri(95, 100), weight: w, height: h, rr: ri(14, 20), bmi: Math.round((w / ((h / 100) ** 2)) * 10) / 10 };
}

function labValue(p) {
  if (p.ref_text) return p.ref_text.replace(/^< /, '') === p.ref_text ? p.ref_text : '1:40';
  const lo = p.ref_low ?? 0; const hi = p.ref_high ?? lo * 2;
  let v = lo + rnd() * (hi - lo);
  if (chance(0.22)) v = chance(0.5) ? hi * (1.05 + rnd() * 0.5) : lo * (0.6 + rnd() * 0.35);
  return String(Math.round(v * (hi > 50 ? 1 : 10)) / (hi > 50 ? 1 : 10));
}

/**
 * Simulate `days` of hospital activity for one tenant.
 */
function simulate(hid, M, { days, perDay: [lo, hi], labs = true, ipd = true, radiology = true, staff }) {
  const tday = today();
  const start = addDays(tday, -days);
  openingStock(hid, M, start);
  Object.values(M.meds).forEach((m, i) => { if (i % 11 === 5) m.noReorder = true; });

  // Patients: seed a base population, first three with fixed names.
  const pts = [];
  const mkPatient = (at, fixed) => {
    const gender = fixed ? fixed[2] : chance(0.5) ? 'Male' : 'Female';
    const first = fixed ? fixed[0] : pick(D.FIRST[gender]); const last = fixed ? fixed[1] : pick(D.LAST);
    const age = fixed ? fixed[3] : chance(0.15) ? ri(1, 12) : ri(18, 78);
    const dob = `${Number(tday.slice(0, 4)) - age}-${String(ri(1, 12)).padStart(2, '0')}-${String(ri(1, 28)).padStart(2, '0')}`;
    const [area, city, pin] = pick(D.AREAS);
    const mobile = `${pick(['98', '97', '99', '94', '90', '82', '70'])}${ri(10000000, 99999999)}`;
    const data = { first_name: first, last_name: last, gender, dob, mobile, email: chance(0.5) ? `${first.toLowerCase()}.${last.toLowerCase()}${ri(1, 99)}@gmail.com` : null, address: `${ri(1, 120)}, ${pick(['Shivalik', 'Sundaram', 'Aaryan', 'Sahjanand', 'Shukan', 'Gokul', 'Parshwanath'])} ${pick(['Society', 'Residency', 'Apartments', 'Park'])}, ${area}`, city, state: 'Gujarat', pincode: pin,
      blood_group: pick(['A+', 'B+', 'O+', 'AB+', 'B+', 'O+', 'A-', 'O-']), marital_status: age < 22 ? 'Single' : pick(['Married', 'Married', 'Single']), occupation: age < 18 ? 'Student' : pick(D.OCCUPATIONS),
      emergency_name: `${pick(D.FIRST[gender === 'Male' ? 'Female' : 'Male'])} ${last}`, emergency_relation: age < 18 ? 'Parent' : pick(['Spouse', 'Sibling', 'Parent', 'Son', 'Daughter']), emergency_phone: `98${ri(10000000, 99999999)}`,
      guardian_name: age < 18 ? `${pick(D.FIRST.Male)} ${last}` : null, guardian_relation: age < 18 ? 'Father' : null,
      allergies: chance(0.12) ? pick(['Penicillin', 'Sulfa drugs', 'NSAIDs', 'Dust', 'Peanuts']) : null, chronic_conditions: age > 45 && chance(0.35) ? pick(['Hypertension', 'Type 2 diabetes', 'Hypothyroidism', 'Hypertension, Type 2 diabetes']) : null };
    if (chance(0.4)) { data.id_type = 'aadhaar'; data.id_number = `${ri(2000, 9999)}${ri(1000, 9999)}${ri(1000, 9999)}`; }
    const p = patients.create(hid, data, null, at);
    const rec = { id: p.id, uhid: p.uhid, age, gender, visits: 0 };
    pts.push(rec);
    return rec;
  };
  const fixed = [['Rahul', 'Shah', 'Male', 42], ['Priya', 'Patel', 'Female', 34], ['Amit', 'Desai', 'Male', 58]];
  for (const f of fixed) mkPatient(`${start} 09:1${pts.length}:00`, f);
  const baseCount = Math.round((lo + hi) * 1.2);
  for (let i = 0; i < baseCount; i++) mkPatient(`${start} ${hhmm(ri(540, 1140))}`);
  // Demo portal accounts for the first three patients.
  for (const p of pts.slice(0, 3)) patients.enablePortal(hid, p.id, DEMO_PASSWORD);

  const dxIds = (names) => names.map((n) => M.dx[n]).filter(Boolean);
  const tmplByDx = {}; for (const [dxName, , advice, items] of D.TEMPLATES) tmplByDx[dxName] = { advice, items };
  const receptionId = staff.reception;
  const admissions = [];
  const pendingToday = [];
  let livePh = 0;

  for (let d = days; d >= 0; d--) {
    const date = addDays(tday, -d);
    const isToday = d === 0;
    const dow = new Date(`${date}T00:00:00`).getDay();
    let n = isToday ? hi + 10 : ri(lo, hi); if (dow === 0 && !isToday) n = Math.round(n * 0.35); if (dow === 6 && !isToday) n = Math.round(n * 0.8);
    const growth = 0.75 + 0.25 * ((days - d) / days); n = Math.max(1, Math.round(n * growth));
    const nowMin = new Date().getHours() * 60 + new Date().getMinutes();
    const times = Array.from({ length: n }, () => (chance(0.68) ? ri(540, 780) : ri(960, 1170))).sort((a, b) => a - b);
    const todayTimes = isToday ? times.map((_, i) => Math.max(5, nowMin - (n - i) * 6)) : times;

    for (let k = 0; k < n; k++) {
      const at = `${date} ${hhmm(todayTimes[k])}`;
      const patient = chance(0.3) || pts.length < 10 ? mkPatient(addMinutes(at, -5)) : pick(pts.filter((p) => p.visits < 12));
      const suited = M.docs.filter((x) => (patient.age < 13 ? x.dept === 'Pediatrics' : x.dept !== 'Pediatrics') && (patient.gender === 'Male' ? x.dept !== 'Gynecology' : true));
      const doc = pick(suited.length ? suited : M.docs);
      const deptC = D.COMPLAINTS[doc.dept] || D.COMPLAINTS['General Medicine'];
      const emergency = chance(0.03);
      const vtype = emergency ? 'emergency' : patient.visits > 0 && chance(0.4) ? 'followup' : 'new';
      // Some visits come from appointments.
      let apptId = null;
      if (chance(0.35)) {
        const no = seq.formatted(hid, 'appointment').value;
        apptId = db.insertRow('appointments', { hospital_id: hid, appt_no: no, patient_id: patient.id, doctor_id: doc.id, department_id: doc.department_id, scheduled_at: at.slice(0, 16) + ':00', duration_min: 15, status: 'confirmed', source: chance(0.3) ? 'portal' : 'reception', reason: pick(deptC), reminder_sent: 1, created_by: receptionId, created_at: addMinutes(at, -60 * ri(4, 72)) });
      }
      let visit;
      try { visit = opd.registerVisit(hid, { patient_id: patient.id, doctor_id: doc.id, appointment_id: apptId, visit_type: vtype, chief_complaint: pick(deptC) }, receptionId, at); }
      catch { continue; }
      patient.visits++;
      // Today: last few per doctor stay in the queue.
      if (isToday && k >= n - Math.ceil(n * 0.55)) {
        pendingToday.push({ visit, doc });
        if (apptId) db.run("UPDATE appointments SET status = 'waiting' WHERE id = ?", apptId);
        // OPD fee collected at registration.
        if (visit.invoice_id && chance(0.85)) pay(hid, visit.invoice_id, addMinutes(at, 1));
        continue;
      }
      if (chance(0.02)) { opd.setStatus(hid, visit.id, 'no_show'); continue; }
      const called = addMinutes(at, ri(6, 38)); const done = addMinutes(called, ri(6, 16));
      const dxNames = [pick(D.DX_BY_DEPT[doc.dept] || D.DX_BY_DEPT['General Medicine'])];
      if (chance(0.2)) dxNames.push(pick(D.DX_BY_DEPT[doc.dept] || D.DX_BY_DEPT['General Medicine']));
      const uniq = [...new Set(dxNames)];
      const tmpl = tmplByDx[uniq[0]];
      const fu = chance(0.35) ? addDays(date, pick([5, 7, 10, 14, 30])) : null;
      db.run(`UPDATE opd_visits SET status = 'completed', called_at = ?, completed_at = ?, vitals = ?, clinical_notes = ?, advice = ?, follow_up_date = ?, followup_reminder_sent = ? WHERE id = ?`,
        called, done, JSON.stringify(vitals(patient.age)), `Patient c/o ${pick(deptC).toLowerCase()}. General condition fair. Chest clear, abdomen soft.`, tmpl ? tmpl.advice : 'Plenty of fluids, rest. Review if symptoms persist.', fu, fu && fu < tday ? 1 : 0, visit.id);
      db.run("UPDATE appointments SET status = 'completed' WHERE visit_id = ?", visit.id);
      for (const dx of dxIds(uniq)) db.insertRow('visit_diagnoses', { hospital_id: hid, visit_id: visit.id, diagnosis_id: dx, doctor_id: doc.id, created_at: done });
      // Prescription
      let items = tmpl ? tmpl.items.map(([m, dose, frequency, duration_days, route, instructions]) => ({ m: M.meds[m], dose, frequency, duration_days, route, instructions }))
        : Array.from({ length: ri(1, 3) }, () => { const m = pick(Object.values(M.meds).filter((x) => !/Injection|IV|Insulin|Enoxaparin|Saline|Ringer/.test(x.name))); return { m, dose: '1 tab', frequency: pick(['OD', 'BD', 'TDS']), duration_days: pick([3, 5, 7]), route: 'Oral', instructions: 'After food' }; });
      if (chance(0.08)) items = [];
      const rxNo = seq.formatted(hid, 'rx').value;
      const rxId = db.insertRow('prescriptions', { hospital_id: hid, rx_no: rxNo, visit_id: visit.id, patient_id: patient.id, doctor_id: doc.id, status: 'finalized', finalized_at: done, finalized_by: doc.user_id, created_at: called, updated_at: done });
      const seen = new Set();
      items.filter((it) => !seen.has(it.m.id) && seen.add(it.m.id)).forEach((it, i) => db.insertRow('prescription_items', { prescription_id: rxId, medicine_id: it.m.id, dose: it.dose, frequency: it.frequency, duration_days: it.duration_days, route: it.route, instructions: it.instructions, quantity: rxsvc.suggestQuantity(it), confirmed: 1, sort_order: i }));
      // OPD invoice payment
      if (visit.invoice_id) pay(hid, visit.invoice_id, addMinutes(at, 2), !chance(0.04));
      // Pharmacy
      if (items.length && !chance(0.07)) {
        const rItems = db.all('SELECT * FROM prescription_items WHERE prescription_id = ?', rxId);
        const order = pharmacy.newOrder(hid, { prescription_id: rxId, patient_id: patient.id, doctor_id: doc.id, source: 'opd', items: rItems }, null, addMinutes(done, 1));
        if (isToday && k >= n - Math.ceil(n * 0.55) - 5) {
          // leave recent ones in the live pharmacy queue
          const st = ['ready', 'processing', 'waiting', 'waiting', 'waiting', 'waiting'][Math.min(livePh++, 5)];
          if (st !== 'waiting') db.run('UPDATE pharmacy_orders SET status = ?, called_at = ?, ready_at = ? WHERE id = ?', st, addMinutes(done, 4), st === 'ready' ? addMinutes(done, 9) : null, order.id);
        } else {
          const dAt = addMinutes(done, ri(5, 25));
          const lines = [];
          for (const it of db.all('SELECT oi.*, m.name, m.strength, m.gst_rate FROM pharmacy_order_items oi JOIN medicines m ON m.id = oi.medicine_id WHERE oi.order_id = ?', order.id)) {
            const mm = Object.values(M.meds).find((x) => x.id === it.medicine_id);
            replenish(hid, mm, addMinutes(dAt, -30));
            if (inventory.medicineStock(it.medicine_id) < it.quantity) replenish(hid, mm, addMinutes(dAt, -30), it.quantity + mm.min);
            inventory.consumeMedicine(hid, it.medicine_id, it.quantity, { refType: 'pharmacy_order', refId: order.id, at: dAt });
            db.run('UPDATE pharmacy_order_items SET dispensed_qty = ? WHERE id = ?', it.quantity, it.id);
            lines.push({ category: 'pharmacy', description: `${it.name} ${it.strength || ''}`.trim(), quantity: it.quantity, unit_price: it.unit_price, tax_rate: it.gst_rate });
          }
          const inv = billing.createInvoice(hid, { patient_id: patient.id, bill_type: 'pharmacy', doctor_id: doc.id, items: lines, created_at: dAt });
          db.run("UPDATE pharmacy_orders SET status = 'dispensed', called_at = ?, ready_at = ?, dispensed_at = ?, invoice_id = ? WHERE id = ?", addMinutes(done, 3), addMinutes(dAt, -2), dAt, inv, order.id);
          pay(hid, inv, dAt, !chance(0.05));
        }
      }
      // Investigations
      if (labs && chance(0.22)) {
        const codes = [pick(['CBC', 'CBC', 'FBS', 'LIPID', 'TSH', 'URINE', 'CRP', 'HBA1C', 'KFT', 'LFT', 'NS1', 'VITD'])];
        if (chance(0.3)) codes.push(pick(['CBC', 'CRP', 'ELEC', 'PPBS']));
        const orders = clinical.orderLab(hid, { patient_id: patient.id, visit_id: visit.id, doctor_id: doc.id, test_ids: [...new Set(codes)].map((c) => M.labs[c].id) }, doc.user_id, done);
        const inv = db.get('SELECT invoice_id FROM lab_orders WHERE id = ?', orders[0].id).invoice_id;
        if (inv) pay(hid, inv, addMinutes(done, 5));
        const fresh = isToday || d <= 1;
        for (const o of orders) {
          const code = Object.keys(M.labs).find((c) => M.labs[c].id === db.get('SELECT test_id FROM lab_orders WHERE id = ?', o.id).test_id);
          const stages = fresh ? pick([['sample_collected'], ['sample_collected', 'processing'], ['sample_collected', 'processing', 'completed'], []]) : ['sample_collected', 'processing', 'completed', 'verified'];
          let tAt = addMinutes(done, 15);
          for (const st of stages) {
            tAt = addMinutes(tAt, ri(20, 120));
            clinical.labStatus(hid, o.id, st, { userId: staff.lab, results: st === 'completed' ? M.labs[code].params.map((p) => ({ parameter: p.name, value: labValue(p) })) : undefined }, tAt);
            if (st === 'verified') db.run('UPDATE lab_orders SET verified_by = ? WHERE id = ?', staff.labVerifier, o.id);
          }
        }
      }
      if (radiology && chance(0.06)) {
        const [mod, study] = pick([['X-Ray', 'Chest PA view'], ['X-Ray', 'Lumbosacral spine AP/Lat'], ['X-Ray', 'Right knee AP/Lat'], ['Ultrasound', 'USG Abdomen & Pelvis'], ['CT', 'CT Brain (plain)'], ['MRI', 'MRI Lumbar spine'], ['Ultrasound', 'Obstetric USG']]);
        const o = clinical.orderRadiology(hid, { patient_id: patient.id, visit_id: visit.id, doctor_id: doc.id, modality: mod, study, clinical_info: pick(deptC) }, doc.user_id, done);
        const inv = db.get('SELECT invoice_id FROM radiology_orders WHERE id = ?', o.id).invoice_id; if (inv) pay(hid, inv, addMinutes(done, 6));
        const stages = isToday ? pick([['scheduled'], ['scanned'], ['scanned', 'reported']]) : ['scanned', 'reported', 'verified'];
        let tAt = addMinutes(done, 30);
        for (const st of stages) {
          tAt = addMinutes(tAt, ri(30, 180));
          clinical.radiologyStatus(hid, o.id, st, { userId: staff.radiology, findings: 'Study reviewed in standard projections. No acute bony injury. Soft tissues unremarkable. Visualised structures within normal limits for age.', impression: pick(['No significant abnormality detected.', 'Mild degenerative changes.', 'Findings suggestive of mild inflammatory changes; clinical correlation advised.']) }, tAt);
        }
      }
      // Admissions
      if (ipd && (emergency || chance(0.11)) && patient.age > 12) {
        const free = M.beds.filter((b) => db.get('SELECT status FROM beds WHERE id = ?', b.id).status === 'available' && (emergency ? ['icu', 'emergency', 'general'].includes(b.ward_type) : b.ward_type !== 'nicu'));
        if (free.length) {
          const bed = pick(free);
          const admAt = addMinutes(done, ri(20, 90));
          try {
            const a = clinical.admit(hid, { patient_id: patient.id, doctor_id: doc.id, bed_id: bed.id, admission_type: emergency ? 'emergency' : 'planned', reason: pick(['Acute gastroenteritis with dehydration', 'Dengue fever with thrombocytopenia', 'Uncontrolled diabetes', 'Chest pain for evaluation', 'Lower respiratory tract infection', 'Post-operative care — knee arthroscopy', 'Pyelonephritis', 'Hypertensive urgency']), expected_discharge: addDays(date, ri(2, 6)), nurse_user_id: staff.nurse, visit_id: visit.id }, receptionId, admAt);
            db.insertRow('visit_diagnoses', { hospital_id: hid, admission_id: a.id, diagnosis_id: M.dx[uniq[0]], doctor_id: doc.id, created_at: admAt });
            admissions.push({ ...a, admAt, los: ri(2, 8), doc, patient, bed });
          } catch { /* patient already admitted */ }
        }
      }
    }
    // Daily IPD activity & discharges.
    for (const a of admissions.filter((x) => !x.done)) {
      const day = Math.round((new Date(`${date}T00:00:00`) - new Date(`${a.admAt.slice(0, 10)}T00:00:00`)) / 864e5);
      if (day < 0) continue;
      if (day >= 0) {
        for (const h of [8, 14, 20]) {
          const t = `${date} ${String(h).padStart(2, '0')}:${String(ri(0, 50)).padStart(2, '0')}:00`;
          if (t < a.admAt || (isToday && t > now())) continue;
          db.insertRow('nursing_records', { hospital_id: hid, admission_id: a.id, bp_sys: ri(108, 150), bp_dia: ri(68, 94), pulse: ri(68, 104), temp: Math.round((97.8 + rnd() * 2.2) * 10) / 10, spo2: ri(94, 99), rr: ri(14, 22), blood_sugar: chance(0.4) ? ri(95, 240) : null, pain_score: ri(0, 5), intake_ml: ri(400, 900), output_ml: ri(300, 800), note: pick(['Patient comfortable', 'Tolerating oral feeds', 'IV fluids running', 'Afebrile, resting', null]), user_id: staff.nurse, recorded_at: t });
        }
        if (!isToday || new Date().getHours() >= 11) db.insertRow('ipd_notes', { hospital_id: hid, admission_id: a.id, note_type: 'round', body: pick(['Patient seen on morning round. Vitals stable. Continue same treatment.', 'Improving clinically. Plan: switch IV to oral medicines.', 'Afebrile for 24 h. Oral intake adequate. Mobilise.', 'Reviewed reports. Continue IV antibiotics, monitor platelets.']), user_id: a.doc.user_id, created_at: `${date} 10:${String(ri(10, 55)).padStart(2, '0')}:00` });
        if (day === 0) {
          const meds = [M.meds['Pantoprazole Injection'], M.meds['Normal Saline'], pick([M.meds['Ceftriaxone Injection'], M.meds['Ondansetron Injection']])];
          for (const m of meds) db.insertRow('ipd_medications', { hospital_id: hid, admission_id: a.id, medicine_id: m.id, dose: m.name.includes('Saline') ? '500 ml' : '1 vial', route: 'IV', frequency: m.name.includes('Saline') ? 'BD' : 'OD', times: m.name.includes('Saline') ? '09:00,21:00' : '09:00', start_date: date, status: 'active', ordered_by: a.doc.user_id, created_at: a.admAt });
          db.insertRow('ipd_charges', { hospital_id: hid, admission_id: a.id, category: 'consultation', description: `Admission consultation — ${a.doc.name}`, quantity: 1, unit_price: a.doc.fee, created_at: a.admAt });
          db.insertRow('ipd_charges', { hospital_id: hid, admission_id: a.id, category: 'consumable', description: 'IV set, cannula & consumables', quantity: 1, unit_price: ri(600, 1800), created_at: a.admAt });
        }
        if (!isToday) db.insertRow('ipd_charges', { hospital_id: hid, admission_id: a.id, category: 'nursing', description: 'Nursing charges (per day)', quantity: 1, unit_price: 500, created_at: `${date} 23:00:00` });
      }
      if (day >= a.los && !isToday) {
        const out = clinical.discharge(hid, a.id, { discharge_type: 'normal', final_diagnosis: db.get('SELECT reason FROM ipd_admissions WHERE id = ?', a.id).reason, discharge_summary: 'Patient admitted with the above complaints. Managed conservatively with IV fluids, antibiotics and supportive care. Responded well to treatment. Vitals stable at discharge; tolerating oral diet.', discharge_advice: 'Continue oral medicines as prescribed. Adequate hydration. Review in OPD after 7 days or earlier if fever, vomiting or breathlessness.', follow_up_date: addDays(date, 7) }, receptionId, `${date} ${hhmm(ri(660, 840))}`);
        db.run("UPDATE beds SET status = 'available' WHERE id = ? AND status = 'cleaning'", a.bed.id);
        pay(hid, out.invoice_id, `${date} ${hhmm(ri(850, 900))}`, !chance(0.15));
        a.done = true;
      }
    }
  }
  // Today's live queues: one patient per doctor in consultation, rest waiting.
  const byDoc = {};
  for (const p of pendingToday) (byDoc[p.doc.id] = byDoc[p.doc.id] || []).push(p);
  for (const list of Object.values(byDoc)) {
    const first = list[0];
    db.run("UPDATE opd_visits SET status = 'in_consultation', called_at = ? WHERE id = ?", addMinutes(db.get('SELECT registered_at FROM opd_visits WHERE id = ?', first.visit.id).registered_at, ri(8, 20)), first.visit.id);
    db.run("UPDATE appointments SET status = 'in_consultation' WHERE visit_id = ?", first.visit.id);
  }
  // Bed states for realism.
  const avail = db.all("SELECT id FROM beds WHERE hospital_id = ? AND status = 'available'", hid);
  for (let i = 0; i < Math.min(3, avail.length); i++) db.run('UPDATE beds SET status = ? WHERE id = ?', ['cleaning', 'reserved', 'maintenance'][i], avail[i * 5 % avail.length].id);
  // Upcoming appointments (today later + next 7 days).
  for (let d = 0; d <= 7; d++) {
    const date = addDays(tday, d);
    for (let i = 0; i < (d === 0 ? 6 : ri(5, 10)); i++) {
      const doc = pick(M.docs); const p = pick(pts);
      const t = d === 0 ? Math.min(1170, new Date().getHours() * 60 + 30 + i * 20) : pick([570, 600, 630, 660, 690, 720, 990, 1020, 1050, 1080]);
      const at = `${date} ${hhmm(t - (t % 10))}`;
      if (at <= now() || db.get("SELECT id FROM appointments WHERE hospital_id = ? AND doctor_id = ? AND scheduled_at = ?", hid, doc.id, at)) continue;
      const no = seq.formatted(hid, 'appointment').value;
      db.insertRow('appointments', { hospital_id: hid, appt_no: no, patient_id: p.id, doctor_id: doc.id, department_id: doc.department_id, scheduled_at: at, duration_min: 15, status: chance(0.7) ? 'confirmed' : 'booked', source: pick(['reception', 'portal', 'doctor']), reason: pick(D.COMPLAINTS[doc.dept] || D.COMPLAINTS['General Medicine']), created_by: receptionId, created_at: addMinutes(now(), -ri(60, 3000)) });
    }
  }
  // Rahul Shah (#000001) gets an appointment tomorrow for the demo portal.
  const drA = M.docs[0];
  const tmr = `${addDays(tday, 1)} 10:30:00`;
  if (!db.get('SELECT id FROM appointments WHERE hospital_id = ? AND doctor_id = ? AND scheduled_at = ?', hid, drA.id, tmr)) db.insertRow('appointments', { hospital_id: hid, appt_no: seq.formatted(hid, 'appointment').value, patient_id: pts[0].id, doctor_id: drA.id, department_id: drA.department_id, scheduled_at: tmr, status: 'confirmed', source: 'portal', reason: 'Follow-up for BP', created_at: now() });
  // Open purchase order.
  const lowMed = Object.values(M.meds).find((m) => m.noReorder);
  if (lowMed) {
    const po = seq.formatted(hid, 'po').value;
    const poId = db.insertRow('purchase_orders', { hospital_id: hid, po_no: po, supplier_id: lowMed.supplier, status: 'ordered', total: lowMed.min * 4 * lowMed.pp, notes: 'Urgent — below reorder level', created_by: staff.pharmacist, created_at: addMinutes(now(), -120) });
    db.insertRow('purchase_order_items', { po_id: poId, item_type: 'medicine', medicine_id: lowMed.id, quantity: lowMed.min * 4, unit_cost: lowMed.pp });
  }
  return pts;
}

function staffAndHr(hid, M, { full = true }) {
  const u = {};
  u.reception = user(hid, 'reception01', 'Kajal Soni', ['reception']);
  if (full) {
    user(hid, 'reception02', 'Hiren Panchal', ['reception']);
    u.nurse = user(hid, 'nurse01', 'Sr. Mary Thomas', ['nurse']);
    user(hid, 'nurse02', 'Sr. Jyoti Rathod', ['nurse']);
    u.pharmacist = user(hid, 'pharmacist01', 'Chetan Prajapati', ['pharmacist']);
    user(hid, 'billing01', 'Nirali Kapadia', ['billing']);
    u.lab = user(hid, 'lab01', 'Mitesh Raval', ['lab_tech']);
    u.labVerifier = user(hid, 'pathologist01', 'Dr. Swati Amin', ['lab_tech']);
    u.radiology = user(hid, 'radiology01', 'Dr. Pranav Iyer', ['radiology_tech']);
    user(hid, 'hr01', 'Rina Chauhan', ['hr']);
    user(hid, 'accounts01', 'Kamlesh Agarwal', ['accounts']);
    user(hid, 'management01', 'Mr. Devang Sheth', ['management']);
  } else {
    u.pharmacist = user(hid, 'pharmacist01', 'Pharmacist', ['pharmacist']);
    u.nurse = user(hid, 'nurse01', 'Staff Nurse', ['nurse']);
  }
  return u;
}

function employees(hid, M, days) {
  const roles = [['Staff Nurse', 'Nursing', 8], ['Pharmacist', 'Pharmacy', 3], ['Lab Technician', 'Laboratory', 3], ['Radiographer', 'Radiology', 2], ['Receptionist', 'Administration', 3], ['Billing Executive', 'Accounts', 2], ['Accountant', 'Accounts', 1], ['HR Executive', 'Human Resources', 1], ['Housekeeping Staff', 'Housekeeping', 5], ['Ward Boy', 'Nursing', 3], ['Resident Medical Officer', 'General Medicine', 2], ['Medical Superintendent', 'Administration', 1]];
  const pay = { 'Staff Nurse': 24000, Pharmacist: 26000, 'Lab Technician': 22000, Radiographer: 24000, Receptionist: 18000, 'Billing Executive': 20000, Accountant: 32000, 'HR Executive': 30000, 'Housekeeping Staff': 12500, 'Ward Boy': 13000, 'Resident Medical Officer': 65000, 'Medical Superintendent': 120000 };
  const shifts = ['Morning (07:00-15:00)', 'General (09:00-17:00)', 'Evening (15:00-23:00)', 'Night (23:00-07:00)'];
  const list = [];
  for (const [des, dept, n] of roles) {
    for (let i = 0; i < n; i++) {
      const g = des === 'Staff Nurse' ? (chance(0.85) ? 'Female' : 'Male') : chance(0.5) ? 'Male' : 'Female';
      const name = `${pick(D.FIRST[g])} ${pick(D.LAST)}`;
      const code = seq.formatted(hid, 'employee').value;
      const acct = String(ri(10000000, 99999999)) + String(ri(1000, 9999));
      const eid = db.insertRow('employees', { hospital_id: hid, emp_code: code, full_name: name, department_id: M.dept[dept], designation: des, employment_type: 'full_time', joining_date: addDays(today(), -ri(90, 2400)), phone: `9${ri(100000000, 999999999)}`, email: `${name.split(' ')[0].toLowerCase()}.${code.toLowerCase()}@deephospital.in`, address: `${pick(D.AREAS)[0]}, Ahmedabad`, emergency_contact: `${pick(D.FIRST.Male)} · 98${ri(10000000, 99999999)}`, shift: ['Staff Nurse', 'Ward Boy', 'Resident Medical Officer'].includes(des) ? pick(shifts) : 'General (09:00-17:00)', bank_name: pick(['HDFC Bank', 'State Bank of India', 'ICICI Bank', 'Bank of Baroda', 'Axis Bank']), bank_account_enc: require('./lib/crypto').encrypt(acct), bank_account_last4: acct.slice(-4), ifsc: `${pick(['HDFC', 'SBIN', 'ICIC', 'BARB', 'UTIB'])}0${ri(100000, 999999)}`, status: 'active', created_at: now() });
      const gross = pay[des] * (0.9 + rnd() * 0.25);
      const basic = Math.round(gross * 0.5); const hra = Math.round(gross * 0.2); const allow = Math.round(gross * 0.3);
      db.insertRow('salary_structures', { hospital_id: hid, employee_id: eid, basic, hra, allowances: allow, bonus: 0, overtime_rate: Math.round(basic / 208), pf_percent: 12, esi_percent: 0.75, professional_tax: 200, other_deductions: 0, updated_at: now() });
      list.push({ id: eid, shift: db.get('SELECT shift FROM employees WHERE id = ?', eid).shift });
    }
  }
  // Attendance
  const nowMin = new Date().getHours() * 60 + new Date().getMinutes();
  for (let d = days; d >= 0; d--) {
    const date = addDays(today(), -d);
    const sunday = new Date(`${date}T00:00:00`).getDay() === 0;
    for (const e of list) {
      const start = Number((e.shift.match(/(\d{2}):/) || [0, '09'])[1]) * 60;
      if (d === 0 && nowMin < start + 20) continue;
      if (sunday && e.shift.startsWith('General')) continue;
      const r = rnd();
      let status = r < 0.84 ? 'present' : r < 0.91 ? 'late' : r < 0.93 ? 'half_day' : r < 0.96 ? 'absent' : 'leave';
      if (d === 0 && status === 'absent') status = 'present';
      const ci = status === 'late' ? start + ri(15, 50) : start - ri(0, 12);
      const co = d === 0 ? null : status === 'half_day' ? ci + ri(200, 260) : start + 480 + ri(0, 90);
      db.insertRow('attendance', { hospital_id: hid, employee_id: e.id, date, check_in: ['present', 'late', 'half_day'].includes(status) ? hhmm(((ci % 1440) + 1440) % 1440).slice(0, 5) : null, check_out: co && ['present', 'late', 'half_day'].includes(status) ? hhmm(co % 1440).slice(0, 5) : null, status, overtime_hours: co && co - ci > 540 ? Math.round((co - ci - 480) / 6) / 10 : 0, shift: e.shift });
    }
  }
  // Leaves
  for (let i = 0; i < 7; i++) {
    const e = pick(list); const from = addDays(today(), ri(-20, 12)); const len = ri(0, 2);
    const st = from > today() ? pick(['pending', 'pending', 'approved']) : 'approved';
    db.insertRow('leaves', { hospital_id: hid, employee_id: e.id, leave_type: pick(['casual', 'sick', 'earned']), from_date: from, to_date: addDays(from, len), days: len + 1, reason: pick(['Family function', 'Fever', 'Personal work', 'Travelling to native place', 'Medical appointment']), status: st, created_at: addMinutes(now(), -ri(600, 20000)) });
  }
  // Payroll for the last two complete months.
  const m1 = new Date(); m1.setDate(1); m1.setMonth(m1.getMonth() - 1);
  const m2 = new Date(m1); m2.setMonth(m2.getMonth() - 1);
  const ym = (d) => fmt(d).slice(0, 7);
  hr.runPayroll(hid, ym(m2), `${ym(m1)}-01 10:00:00`);
  db.run("UPDATE payroll SET status = 'paid' WHERE hospital_id = ? AND month = ?", hid, ym(m2));
  hr.runPayroll(hid, ym(m1), `${today().slice(0, 7)}-01 10:00:00`);
  return list;
}

function seed() {
  db.open();
  hospitals.ensurePermissions();
  const t0 = Date.now();
  db.tx(() => {
    db.insertRow('users', { hospital_id: null, username: 'admin', full_name: 'Platform Administrator', email: 'owner@deephospital.in', password_hash: demoHash(), is_super_admin: 1, uses_demo_password: 1, created_at: now() });

    // ── Hospital 001: flagship, every module.
    const h1 = hospitals.provision({ code: 'DH-AMD', name: 'Deep Hospital Ahmedabad', city: 'Ahmedabad', state: 'Gujarat', address: 'Near Shivalik Circle, 132 Ft Ring Road, Satellite, Ahmedabad 380015', phone: '079-4800-1000', email: 'care.amd@deephospital.in', plan: 'enterprise' });
    db.updateRow('hospitals', h1.id, { legal_name: 'Deep Healthcare Pvt. Ltd.', gstin: '24AAGCD4821M1ZX', registration_no: 'GJ/AMC/HOSP/2019/0421', website: 'www.deephospital.in', pincode: '380015' });
    user(h1.id, 'hadmin', 'Dr. Aditi Vora (Medical Director)', ['hospital_admin']);
    const M1 = masters(h1.id);
    const staff1 = staffAndHr(h1.id, M1, { full: true });
    simulate(h1.id, M1, { days: 95, perDay: [22, 36], staff: staff1 });
    employees(h1.id, M1, 45);

    // ── Hospital 002: no laboratory module (module isolation demo).
    const mods2 = require('./lib/modules').MODULES.map((m) => m.key).filter((k) => k !== 'laboratory');
    const h2 = hospitals.provision({ code: 'DH-SRT', name: 'Deep Hospital Surat', city: 'Surat', state: 'Gujarat', address: 'Ghod Dod Road, Athwa, Surat 395007', phone: '0261-470-2000', email: 'care.srt@deephospital.in', modules: mods2 });
    user(h2.id, 'hadmin', 'Dr. Paresh Naik (Administrator)', ['hospital_admin']);
    const M2 = masters(h2.id, { doctors: [['Dr. Kiran Shah', 'General Medicine', 'Internal Medicine', 'MBBS, MD', 500, 250, 'A', 'Room 1', 'dr.shah'], ['Dr. Rutvik Modi', 'Orthopedics', 'Sports Medicine', 'MBBS, MS (Ortho)', 700, 350, 'B', 'Room 2', 'dr.modi'], ['Dr. Sneha Kapadia', 'Pediatrics', 'Pediatrics', 'MBBS, DCH', 600, 300, 'C', 'Room 3', 'dr.kapadia'], ['Dr. Farhan Mansuri', 'Cardiology', 'Cardiology', 'MBBS, MD, DM', 900, 450, 'D', 'Room 4', 'dr.mansuri']], full: false });
    const staff2 = staffAndHr(h2.id, M2, { full: false });
    simulate(h2.id, M2, { days: 30, perDay: [8, 14], labs: false, radiology: false, staff: { ...staff2, lab: null } });

    // ── Hospital 003: OPD + pharmacy clinic.
    const h3 = hospitals.provision({ code: 'XYZ-VAD', name: 'XYZ Multispeciality Hospital', city: 'Vadodara', state: 'Gujarat', address: 'Alkapuri, Vadodara 390007', phone: '0265-233-4455', email: 'info@xyzhospital.in', plan: 'starter', modules: ['reception', 'appointments', 'opd', 'doctor', 'pharmacy', 'inventory', 'billing', 'reports', 'portal'] });
    user(h3.id, 'hadmin', 'XYZ Administrator', ['hospital_admin']);
    const M3 = masters(h3.id, { doctors: [['Dr. Alpesh Rana', 'General Medicine', 'Family Medicine', 'MBBS', 400, 200, 'A', 'Cabin 1', 'dr.rana'], ['Dr. Bhumi Dave', 'Dermatology', 'Cosmetology', 'MBBS, DDVL', 600, 300, 'B', 'Cabin 2', 'dr.dave']], full: false });
    const staff3 = staffAndHr(h3.id, M3, { full: false });
    simulate(h3.id, M3, { days: 14, perDay: [5, 9], labs: false, ipd: false, radiology: false, staff: staff3 });

    // ── Hospital 004: onboarded but inactive (subscription lapsed).
    const h4 = hospitals.provision({ code: 'ABC-RJT', name: 'ABC Hospital', city: 'Rajkot', state: 'Gujarat', address: 'Kalawad Road, Rajkot 360005', phone: '0281-245-6789', email: 'admin@abchospital.in', plan: 'starter', modules: ['reception', 'opd', 'doctor', 'pharmacy', 'billing', 'appointments'] });
    user(h4.id, 'hadmin', 'ABC Administrator', ['hospital_admin']);
    db.updateRow('hospitals', h4.id, { is_active: 0, subscription_status: 'past_due' });

    db.insertRow('audit_logs', { hospital_id: null, username: 'system', action: 'system.demo_seeded', details: JSON.stringify({ hospitals: 4 }), created_at: now() });
  });
  // Generate today's automated alerts (low stock, expiry, reminders).
  require('./lib/automation').runAll();
  console.log(`[seed] Demo data ready in ${((Date.now() - t0) / 1000).toFixed(1)}s. Sign in with admin / ${DEMO_PASSWORD} (change it in Settings → Security).`);
}

if (require.main === module) {
  if (process.argv.includes('--reset')) {
    for (const f of [db.DB_FILE, `${db.DB_FILE}-wal`, `${db.DB_FILE}-shm`]) { try { fs.unlinkSync(f); } catch {} }
  }
  db.open();
  if (db.get('SELECT id FROM users WHERE is_super_admin = 1')) { console.log('[seed] Database already initialised. Use --reset to recreate.'); process.exit(0); }
  seed();
}

module.exports = { seed, DEMO_PASSWORD };
