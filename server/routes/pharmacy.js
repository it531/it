'use strict';
// Pharmacy queue & dispensing, medicine master, inventory (batches, items, suppliers,
// purchase orders / GRN, issues & adjustments, alerts).
const express = require('express');
const db = require('../db');
const auth = require('../lib/auth');
const seq = require('../lib/sequence');
const pharmacy = require('../services/pharmacy');
const inventory = require('../services/inventory');
const { audit } = require('../lib/audit');
const { validate, id } = require('../lib/validate');
const { now, today, notFound, bad, conflict, round2 } = require('../lib/util');

const r = express.Router();
const A = auth.authenticate;
const PH = (a = 'view') => [A, auth.can('pharmacy', a)];
const INV = (a = 'view') => [A, auth.can('inventory', a)];

// ───────── Pharmacy queue
r.get('/pharmacy/queue', ...PH(), (req, res) => {
  const q = pharmacy.queue(req.ctx.hid);
  const stats = db.get(`SELECT COUNT(*) total, SUM(o.status='dispensed') dispensed, SUM(o.status IN ('waiting','processing','ready')) pending
    FROM pharmacy_orders o JOIN pharmacy_tokens t ON t.order_id = o.id WHERE o.hospital_id = ? AND t.token_date = ?`, req.ctx.hid, today());
  const sales = db.get("SELECT COALESCE(SUM(total),0) s FROM invoices WHERE hospital_id = ? AND bill_type = 'pharmacy' AND substr(created_at,1,10) = ? AND status != 'cancelled'", req.ctx.hid, today()).s;
  res.json({ ...q, stats: { ...stats, sales } });
});
r.get('/pharmacy/orders', ...PH(), (req, res) => {
  const where = ['o.hospital_id = ?']; const p = [req.ctx.hid];
  if (req.query.status) { where.push('o.status = ?'); p.push(req.query.status); }
  if (req.query.date) { where.push('substr(o.created_at,1,10) = ?'); p.push(req.query.date); }
  res.json(db.all(`SELECT o.*, t.token, COALESCE(p.full_name, o.customer_name) patient_name, p.uhid, d.name doctor_name, (SELECT COUNT(*) FROM pharmacy_order_items WHERE order_id = o.id) item_count, i.total invoice_total
    FROM pharmacy_orders o LEFT JOIN pharmacy_tokens t ON t.order_id = o.id LEFT JOIN patients p ON p.id = o.patient_id LEFT JOIN doctors d ON d.id = o.doctor_id LEFT JOIN invoices i ON i.id = o.invoice_id
    WHERE ${where.join(' AND ')} ORDER BY o.id DESC LIMIT 200`, ...p));
});
r.get('/pharmacy/orders/:id', ...PH(), (req, res) => res.json(pharmacy.detail(req.ctx.hid, id(req.params.id))));
r.post('/pharmacy/call-next', ...PH('edit'), (req, res) => {
  const next = db.tx(() => pharmacy.callNext(req.ctx.hid));
  audit(req, 'pharmacy.token_called', { entity: 'pharmacy_order', id: next.id, ref: next.token });
  res.json(next);
});
r.post('/pharmacy/orders/:id/status', ...PH('edit'), (req, res) => {
  const b = validate(req.body, { status: { required: true, enum: ['waiting', 'processing', 'ready', 'dispensed', 'cancelled'] }, quantities: 'object' });
  const oid = id(req.params.id);
  const out = db.tx(() => pharmacy.setStatus(req.ctx.hid, oid, b.status, { userId: req.ctx.user.id, quantities: b.quantities }));
  audit(req, `pharmacy.${b.status}`, { entity: 'pharmacy_order', id: oid, ref: out.order_no, details: b.status === 'dispensed' ? { items: out.items.map((i) => `${i.name} x${i.dispensed_qty}`), invoice_id: out.invoice_id } : undefined });
  res.json(out);
});
// Counter sale / manual order (walk-in customer or patient without e-prescription).
r.post('/pharmacy/order', ...PH('add'), (req, res) => {
  const b = validate(req.body, { patient_id: 'int', customer_name: 'max:100', items: 'required|array' });
  if (!b.patient_id && !b.customer_name) throw bad('Select a patient or enter customer name');
  if (b.patient_id && !db.get('SELECT id FROM patients WHERE id = ? AND hospital_id = ?', b.patient_id, req.ctx.hid)) throw notFound('Patient');
  const items = b.items.map((i) => ({ medicine_id: Number(i.medicine_id), quantity: Math.round(Number(i.quantity)) })).filter((i) => i.quantity > 0);
  if (!items.length) throw bad('Add at least one medicine');
  const out = db.tx(() => pharmacy.newOrder(req.ctx.hid, { patient_id: b.patient_id, customer_name: b.customer_name, source: 'counter', items }, req.ctx.user.id));
  audit(req, 'pharmacy.order_created', { entity: 'pharmacy_order', id: out.id, ref: out.order_no });
  res.status(201).json(out);
});

// ───────── Medicine master
const MED_COLS = `m.*, s.name supplier_name,
  (SELECT COALESCE(SUM(qty),0) FROM medicine_batches b WHERE b.medicine_id = m.id AND b.expiry_date >= date('now','localtime')) stock,
  (SELECT MIN(expiry_date) FROM medicine_batches b WHERE b.medicine_id = m.id AND b.qty > 0) next_expiry`;
r.get('/medicines', A, auth.canAny(['pharmacy', 'view'], ['inventory', 'view'], ['doctor', 'view'], ['settings', 'view'], ['ipd', 'view']), (req, res) => {
  const q = String(req.query.q || '').trim(); const doc = req.ctx.doctorId;
  const where = ['m.hospital_id = ?']; const p = [req.ctx.hid];
  if (q) { where.push('(m.name LIKE ? OR m.generic_name LIKE ? OR m.brand LIKE ? OR m.category LIKE ?)'); p.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`); }
  if (!req.query.all) where.push('m.is_active = 1');
  if (req.query.category) { where.push('m.category = ?'); p.push(req.query.category); }
  // Frequently used medicines (by this doctor, else hospital-wide) rank first.
  const rows = db.all(`SELECT ${MED_COLS},
      (SELECT COUNT(*) FROM prescription_items pi JOIN prescriptions r ON r.id = pi.prescription_id WHERE pi.medicine_id = m.id ${doc ? 'AND r.doctor_id = ' + Number(doc) : ''}) uses,
      ${doc ? `EXISTS(SELECT 1 FROM doctor_favourite_medicines f WHERE f.medicine_id = m.id AND f.doctor_id = ${Number(doc)})` : '0'} favourite
    FROM medicines m LEFT JOIN suppliers s ON s.id = m.supplier_id WHERE ${where.join(' AND ')}
    ORDER BY ${q ? '(m.name LIKE ?) DESC,' : ''} favourite DESC, uses DESC, m.name LIMIT ${q ? 30 : Math.min(Number(req.query.limit) || 500, 1000)}`, ...p, ...(q ? [`${q}%`] : []));
  res.json(rows);
});
r.get('/medicines/:id', A, auth.canAny(['pharmacy', 'view'], ['inventory', 'view']), (req, res) => {
  const m = db.get(`SELECT ${MED_COLS} FROM medicines m LEFT JOIN suppliers s ON s.id = m.supplier_id WHERE m.id = ? AND m.hospital_id = ?`, id(req.params.id), req.ctx.hid);
  if (!m) throw notFound('Medicine');
  m.batches = db.all('SELECT b.*, s.name supplier FROM medicine_batches b LEFT JOIN suppliers s ON s.id = b.supplier_id WHERE b.medicine_id = ? ORDER BY b.expiry_date', m.id);
  m.movements = db.all('SELECT sm.*, u.full_name user_name, b.batch_no FROM stock_movements sm LEFT JOIN users u ON u.id = sm.user_id LEFT JOIN medicine_batches b ON b.id = sm.batch_id WHERE sm.medicine_id = ? ORDER BY sm.id DESC LIMIT 50', m.id);
  res.json(m);
});
const MED = { name: 'required|max:120', generic_name: 'max:160', brand: 'max:80', strength: 'max:40', dosage_form: 'max:40', manufacturer: 'max:120', category: 'max:60', hsn: 'max:12', gst_rate: 'number|min:0|max:28', purchase_price: 'number|min:0', selling_price: 'number|min:0', min_stock: 'int|min:0', supplier_id: 'int', storage: 'max:80', default_route: 'max:30', is_active: { type: 'bool', default: 1 } };
r.post('/medicines', A, auth.canAny(['inventory', 'add'], ['settings', 'add'], ['pharmacy', 'add']), (req, res) => {
  const b = validate(req.body, { ...MED, batch_no: 'max:40', expiry_date: 'date', opening_qty: 'int|min:0' });
  const { batch_no, expiry_date, opening_qty } = b; delete b.batch_no; delete b.expiry_date; delete b.opening_qty;
  if (db.get("SELECT id FROM medicines WHERE hospital_id = ? AND name = ? AND IFNULL(strength,'') = IFNULL(?,'')", req.ctx.hid, b.name, b.strength)) throw conflict('Medicine with this name and strength already exists');
  const mid = db.tx(() => {
    const x = db.insertRow('medicines', { ...b, hospital_id: req.ctx.hid, created_at: now() });
    if (opening_qty > 0) {
      if (!batch_no || !expiry_date) throw bad('Batch number and expiry are required for opening stock');
      inventory.addBatch(req.ctx.hid, { medicine_id: x, batch_no, expiry_date, qty: opening_qty, purchase_price: b.purchase_price, mrp: b.selling_price, supplier_id: b.supplier_id }, { movement: 'opening', userId: req.ctx.user.id });
    }
    return x;
  });
  audit(req, 'medicine.created', { entity: 'medicine', id: mid, ref: b.name });
  res.status(201).json({ id: mid });
});
r.put('/medicines/:id', A, auth.canAny(['inventory', 'edit'], ['settings', 'edit'], ['pharmacy', 'edit']), (req, res) => {
  const mid = id(req.params.id);
  const b = validate(req.body, MED, { partial: true });
  const before = db.get('SELECT * FROM medicines WHERE id = ? AND hospital_id = ?', mid, req.ctx.hid);
  if (!before) throw notFound('Medicine');
  db.updateRow('medicines', mid, b);
  const changed = Object.keys(b).filter((k) => String(before[k]) !== String(b[k]));
  audit(req, 'medicine.updated', { entity: 'medicine', id: mid, ref: before.name, details: Object.fromEntries(changed.map((k) => [k, { from: before[k], to: b[k] }])) });
  res.json({ ok: true });
});
r.post('/medicines/:id/favourite', A, auth.can('doctor', 'edit'), (req, res) => {
  if (!req.ctx.doctorId) throw bad('Only doctors can keep favourites');
  const mid = id(req.params.id);
  if (!db.get('SELECT id FROM medicines WHERE id = ? AND hospital_id = ?', mid, req.ctx.hid)) throw notFound('Medicine');
  const ex = db.get('SELECT 1 x FROM doctor_favourite_medicines WHERE doctor_id = ? AND medicine_id = ?', req.ctx.doctorId, mid);
  if (ex) db.run('DELETE FROM doctor_favourite_medicines WHERE doctor_id = ? AND medicine_id = ?', req.ctx.doctorId, mid);
  else db.run('INSERT INTO doctor_favourite_medicines (doctor_id, medicine_id) VALUES (?,?)', req.ctx.doctorId, mid);
  res.json({ favourite: !ex });
});

// ───────── Inventory overview & alerts
r.get('/inventory/overview', ...INV(), (req, res) => {
  const hid = req.ctx.hid;
  const meds = db.all(`SELECT m.id, m.name, m.strength, m.min_stock, m.purchase_price, (SELECT COALESCE(SUM(qty),0) FROM medicine_batches b WHERE b.medicine_id = m.id AND b.expiry_date >= date('now','localtime')) stock FROM medicines m WHERE m.hospital_id = ? AND m.is_active = 1`, hid);
  const low = meds.filter((m) => m.stock < m.min_stock);
  const expiring = db.all("SELECT b.*, m.name, m.strength, CAST(julianday(b.expiry_date) - julianday(date('now','localtime')) AS INTEGER) days_left FROM medicine_batches b JOIN medicines m ON m.id = b.medicine_id WHERE b.hospital_id = ? AND b.qty > 0 AND b.expiry_date <= date('now','localtime','+60 day') ORDER BY b.expiry_date", hid);
  const value = db.get("SELECT COALESCE(SUM(b.qty * COALESCE(b.purchase_price, m.purchase_price)),0) v FROM medicine_batches b JOIN medicines m ON m.id = b.medicine_id WHERE b.hospital_id = ? AND b.expiry_date >= date('now','localtime')", hid).v
    + db.get('SELECT COALESCE(SUM(stock * unit_cost),0) v FROM inventory_items WHERE hospital_id = ?', hid).v;
  const itemsLow = db.all('SELECT * FROM inventory_items WHERE hospital_id = ? AND is_active = 1 AND stock < min_stock', hid);
  res.json({ stats: { medicines: meds.length, low_stock: low.length + itemsLow.length, expiring: expiring.filter((b) => b.days_left >= 0).length, expired: expiring.filter((b) => b.days_left < 0).length, stock_value: round2(value), items: db.get('SELECT COUNT(*) c FROM inventory_items WHERE hospital_id = ?', hid).c, open_pos: db.get("SELECT COUNT(*) c FROM purchase_orders WHERE hospital_id = ? AND status = 'ordered'", hid).c }, low_stock: low, items_low: itemsLow, expiring });
});
r.get('/inventory/movements', ...INV(), (req, res) => {
  res.json(db.all(`SELECT sm.*, COALESCE(m.name || ' ' || COALESCE(m.strength,''), i.name) item_name, b.batch_no, u.full_name user_name, dp.name department
    FROM stock_movements sm LEFT JOIN medicines m ON m.id = sm.medicine_id LEFT JOIN inventory_items i ON i.id = sm.item_id LEFT JOIN medicine_batches b ON b.id = sm.batch_id LEFT JOIN users u ON u.id = sm.user_id LEFT JOIN departments dp ON dp.id = sm.to_department_id
    WHERE sm.hospital_id = ? ORDER BY sm.id DESC LIMIT 200`, req.ctx.hid));
});

// General inventory items (equipment, consumables, surgical, general)
r.get('/inventory/items', ...INV(), (req, res) => {
  const where = ['i.hospital_id = ?']; const p = [req.ctx.hid];
  if (req.query.category) { where.push('i.category = ?'); p.push(req.query.category); }
  if (req.query.q) { where.push('(i.name LIKE ? OR i.code LIKE ?)'); p.push(`%${req.query.q}%`, `%${req.query.q}%`); }
  res.json(db.all(`SELECT i.*, s.name supplier_name FROM inventory_items i LEFT JOIN suppliers s ON s.id = i.supplier_id WHERE ${where.join(' AND ')} ORDER BY i.category, i.name`, ...p));
});
const ITEM = { code: 'max:20', name: 'required|max:120', category: { required: true, enum: ['equipment', 'consumable', 'surgical', 'general'] }, unit: 'max:12', stock: 'int|min:0', min_stock: 'int|min:0', unit_cost: 'number|min:0', location: 'max:60', supplier_id: 'int', expiry_date: 'date', is_active: { type: 'bool', default: 1 } };
r.post('/inventory/items', ...INV('add'), (req, res) => {
  const b = validate(req.body, ITEM);
  const iid = db.tx(() => {
    const x = db.insertRow('inventory_items', { ...b, stock: 0, hospital_id: req.ctx.hid, created_at: now() });
    if (b.stock > 0) { db.run('UPDATE inventory_items SET stock = ? WHERE id = ?', b.stock, x); db.insertRow('stock_movements', { hospital_id: req.ctx.hid, item_type: 'item', item_id: x, qty: b.stock, movement: 'opening', user_id: req.ctx.user.id, created_at: now() }); }
    return x;
  });
  audit(req, 'inventory.item_created', { entity: 'inventory_item', id: iid, ref: b.name });
  res.status(201).json({ id: iid });
});
r.put('/inventory/items/:id', ...INV('edit'), (req, res) => {
  const b = validate(req.body, ITEM, { partial: true }); delete b.stock;  // stock only changes through movements
  if (!db.updateRow('inventory_items', id(req.params.id), b, 'AND hospital_id = ?', req.ctx.hid)) throw notFound('Item');
  res.json({ ok: true });
});

// Stock out / issue to department / adjustment (+/-) for items and medicine batches.
r.post('/inventory/movement', ...INV('edit'), (req, res) => {
  const b = validate(req.body, { item_type: { required: true, enum: ['medicine', 'item'] }, item_id: 'int', medicine_id: 'int', batch_id: 'int', qty: 'required|int', movement: { required: true, enum: ['issue', 'transfer', 'adjustment', 'return'] }, to_department_id: 'int', note: 'required|max:200' });
  if (b.qty === 0) throw bad('Quantity cannot be zero');
  if (['issue', 'transfer'].includes(b.movement) && !b.to_department_id) throw bad('Select the receiving department');
  if (b.to_department_id && !db.get('SELECT id FROM departments WHERE id = ? AND hospital_id = ?', b.to_department_id, req.ctx.hid)) throw bad('Invalid department');
  const delta = ['issue', 'transfer'].includes(b.movement) ? -Math.abs(b.qty) : b.movement === 'return' ? Math.abs(b.qty) : b.qty;
  db.tx(() => {
    if (b.item_type === 'item') {
      const it = db.get('SELECT * FROM inventory_items WHERE id = ? AND hospital_id = ?', b.item_id, req.ctx.hid);
      if (!it) throw notFound('Item');
      if (it.stock + delta < 0) throw bad(`Only ${it.stock} ${it.unit || ''} in stock`);
      db.run('UPDATE inventory_items SET stock = stock + ? WHERE id = ?', delta, it.id);
      db.insertRow('stock_movements', { hospital_id: req.ctx.hid, item_type: 'item', item_id: it.id, qty: delta, movement: b.movement, to_department_id: b.to_department_id, note: b.note, user_id: req.ctx.user.id, created_at: now() });
    } else {
      const bt = db.get('SELECT b.*, m.name FROM medicine_batches b JOIN medicines m ON m.id = b.medicine_id WHERE b.id = ? AND b.hospital_id = ?', b.batch_id, req.ctx.hid);
      if (!bt) throw notFound('Batch');
      if (bt.qty + delta < 0) throw bad(`Only ${bt.qty} units in batch ${bt.batch_no}`);
      db.run('UPDATE medicine_batches SET qty = qty + ? WHERE id = ?', delta, bt.id);
      db.insertRow('stock_movements', { hospital_id: req.ctx.hid, item_type: 'medicine', medicine_id: bt.medicine_id, batch_id: bt.id, qty: delta, movement: b.movement, to_department_id: b.to_department_id, note: b.note, user_id: req.ctx.user.id, created_at: now() });
    }
    inventory.checkAlerts(req.ctx.hid);
  });
  audit(req, `inventory.${b.movement}`, { entity: b.item_type, id: b.item_id || b.batch_id, details: { qty: delta, note: b.note } });
  res.json({ ok: true });
});

// ───────── Suppliers
r.get('/suppliers', ...INV(), (req, res) => res.json(db.all(`SELECT s.*, (SELECT COUNT(*) FROM purchase_orders p WHERE p.supplier_id = s.id) pos, (SELECT COALESCE(SUM(total),0) FROM purchase_orders p WHERE p.supplier_id = s.id AND p.status = 'received') purchased FROM suppliers s WHERE s.hospital_id = ? ORDER BY s.name`, req.ctx.hid)));
const SUP = { name: 'required|max:120', contact_person: 'max:80', phone: 'mobile', email: 'email', address: 'max:300', gstin: { max: 15, pattern: '^[0-9A-Z]{15}$' }, is_active: { type: 'bool', default: 1 } };
r.post('/suppliers', ...INV('add'), (req, res) => { const b = validate(req.body, SUP); const sid = db.insertRow('suppliers', { ...b, hospital_id: req.ctx.hid, created_at: now() }); audit(req, 'supplier.created', { entity: 'supplier', id: sid, ref: b.name }); res.status(201).json({ id: sid }); });
r.put('/suppliers/:id', ...INV('edit'), (req, res) => { const b = validate(req.body, SUP, { partial: true }); if (!db.updateRow('suppliers', id(req.params.id), b, 'AND hospital_id = ?', req.ctx.hid)) throw notFound('Supplier'); res.json({ ok: true }); });

// ───────── Purchase orders & GRN
r.get('/purchase-orders', ...INV(), (req, res) => {
  const rows = db.all('SELECT po.*, s.name supplier_name, u.full_name created_by_name, (SELECT COUNT(*) FROM purchase_order_items WHERE po_id = po.id) items FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id LEFT JOIN users u ON u.id = po.created_by WHERE po.hospital_id = ? ORDER BY po.id DESC LIMIT 200', req.ctx.hid);
  res.json(rows);
});
r.get('/purchase-orders/:id', ...INV(), (req, res) => {
  const po = db.get('SELECT po.*, s.name supplier_name, s.gstin supplier_gstin, s.address supplier_address FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id WHERE po.id = ? AND po.hospital_id = ?', id(req.params.id), req.ctx.hid);
  if (!po) throw notFound('Purchase order');
  po.items = db.all("SELECT pi.*, COALESCE(m.name || ' ' || COALESCE(m.strength,''), i.name) item_name FROM purchase_order_items pi LEFT JOIN medicines m ON m.id = pi.medicine_id LEFT JOIN inventory_items i ON i.id = pi.item_id WHERE pi.po_id = ?", po.id);
  res.json(po);
});
r.post('/purchase-orders', ...INV('add'), (req, res) => {
  const b = validate(req.body, { supplier_id: 'required|int', items: 'required|array', notes: 'max:300' });
  if (!db.get('SELECT id FROM suppliers WHERE id = ? AND hospital_id = ?', b.supplier_id, req.ctx.hid)) throw bad('Invalid supplier');
  const out = db.tx(() => {
    const no = seq.formatted(req.ctx.hid, 'po').value;
    const pid = db.insertRow('purchase_orders', { hospital_id: req.ctx.hid, po_no: no, supplier_id: b.supplier_id, status: 'ordered', notes: b.notes, created_by: req.ctx.user.id, created_at: now() });
    let total = 0;
    for (const it of b.items) {
      const type = it.item_type === 'item' ? 'item' : 'medicine';
      const q = Math.round(Number(it.quantity)); const c = Number(it.unit_cost) || 0;
      if (!(q > 0)) throw bad('Quantity must be positive');
      if (type === 'medicine' && !db.get('SELECT id FROM medicines WHERE id = ? AND hospital_id = ?', Number(it.medicine_id), req.ctx.hid)) throw bad('Invalid medicine');
      if (type === 'item' && !db.get('SELECT id FROM inventory_items WHERE id = ? AND hospital_id = ?', Number(it.item_id), req.ctx.hid)) throw bad('Invalid item');
      db.insertRow('purchase_order_items', { po_id: pid, item_type: type, medicine_id: type === 'medicine' ? Number(it.medicine_id) : null, item_id: type === 'item' ? Number(it.item_id) : null, quantity: q, unit_cost: c });
      total += q * c;
    }
    db.run('UPDATE purchase_orders SET total = ? WHERE id = ?', round2(total), pid);
    return { id: pid, po_no: no };
  });
  audit(req, 'purchase.order_created', { entity: 'purchase_order', id: out.id, ref: out.po_no });
  res.status(201).json(out);
});
// GRN: receive goods → batches (with batch no. & expiry) / item stock increase.
r.post('/purchase-orders/:id/receive', ...INV('edit'), (req, res) => {
  const pid = id(req.params.id);
  const po = db.get('SELECT * FROM purchase_orders WHERE id = ? AND hospital_id = ?', pid, req.ctx.hid);
  if (!po) throw notFound('Purchase order');
  if (po.status !== 'ordered') throw conflict(`Purchase order is ${po.status}`);
  const lines = (req.body && req.body.lines) || {};
  const out = db.tx(() => {
    const grn = seq.formatted(req.ctx.hid, 'grn').value;
    for (const it of db.all('SELECT * FROM purchase_order_items WHERE po_id = ?', pid)) {
      const l = lines[it.id] || {};
      if (it.item_type === 'medicine') {
        const batch = String(l.batch_no || '').trim(); const exp = l.expiry_date;
        if (!batch || !/^\d{4}-\d{2}-\d{2}$/.test(exp || '')) throw bad('Batch number and expiry date are required for every medicine');
        if (exp <= today()) throw bad(`Batch ${batch} is already expired`);
        const med = db.get('SELECT selling_price FROM medicines WHERE id = ?', it.medicine_id);
        db.run('UPDATE purchase_order_items SET batch_no = ?, expiry_date = ?, mrp = ? WHERE id = ?', batch, exp, Number(l.mrp) || med.selling_price, it.id);
        inventory.addBatch(req.ctx.hid, { medicine_id: it.medicine_id, batch_no: batch, expiry_date: exp, qty: it.quantity, purchase_price: it.unit_cost, mrp: Number(l.mrp) || med.selling_price, supplier_id: po.supplier_id }, { movement: 'grn', refType: 'purchase_order', refId: pid, userId: req.ctx.user.id });
      } else {
        db.run('UPDATE inventory_items SET stock = stock + ?, unit_cost = ? WHERE id = ?', it.quantity, it.unit_cost, it.item_id);
        db.insertRow('stock_movements', { hospital_id: req.ctx.hid, item_type: 'item', item_id: it.item_id, qty: it.quantity, movement: 'grn', ref_type: 'purchase_order', ref_id: pid, user_id: req.ctx.user.id, created_at: now() });
      }
    }
    db.run("UPDATE purchase_orders SET status = 'received', grn_no = ?, received_at = ?, received_by = ? WHERE id = ?", grn, now(), req.ctx.user.id, pid);
    return { grn_no: grn };
  });
  audit(req, 'purchase.grn', { entity: 'purchase_order', id: pid, ref: out.grn_no });
  res.json(out);
});
r.post('/purchase-orders/:id/cancel', ...INV('edit'), (req, res) => {
  const pid = id(req.params.id);
  const n = db.run("UPDATE purchase_orders SET status = 'cancelled' WHERE id = ? AND hospital_id = ? AND status = 'ordered'", pid, req.ctx.hid).changes;
  if (!n) throw conflict('Only open purchase orders can be cancelled');
  audit(req, 'purchase.cancelled', { entity: 'purchase_order', id: pid });
  res.json({ ok: true });
});

module.exports = r;
