'use strict';
const db = require('../db');
const settings = require('../lib/settings');
const { notify } = require('../lib/notify');
const { now, today, addDays, bad } = require('../lib/util');

function medicineStock(medicineId) {
  return db.get("SELECT COALESCE(SUM(qty),0) s FROM medicine_batches WHERE medicine_id = ? AND expiry_date >= date('now','localtime')", medicineId).s;
}

// FEFO allocation (first-expiry-first-out) of non-expired batches. Throws when stock is short.
function allocate(hid, medicineId, qty) {
  const batches = db.all("SELECT * FROM medicine_batches WHERE hospital_id = ? AND medicine_id = ? AND qty > 0 AND expiry_date >= date('now','localtime') ORDER BY expiry_date, id", hid, medicineId);
  const out = []; let need = qty;
  for (const b of batches) {
    if (need <= 0) break;
    const take = Math.min(b.qty, need);
    out.push({ batch: b, qty: take }); need -= take;
  }
  if (need > 0) {
    const m = db.get('SELECT name, strength FROM medicines WHERE id = ?', medicineId);
    throw bad(`Insufficient stock for ${m.name} ${m.strength || ''}: short by ${need}`);
  }
  return out;
}

// Decrease stock for a medicine, recording movements. Must run inside a transaction.
function consumeMedicine(hid, medicineId, qty, { movement = 'dispense', refType, refId, userId, at } = {}) {
  const alloc = allocate(hid, medicineId, qty);
  for (const a of alloc) {
    db.run('UPDATE medicine_batches SET qty = qty - ? WHERE id = ?', a.qty, a.batch.id);
    db.insertRow('stock_movements', { hospital_id: hid, item_type: 'medicine', medicine_id: medicineId, batch_id: a.batch.id, qty: -a.qty, movement, ref_type: refType, ref_id: refId, user_id: userId, created_at: at || now() });
  }
  return alloc;
}

function addBatch(hid, { medicine_id, batch_no, expiry_date, qty, purchase_price, mrp, supplier_id }, { movement = 'grn', refType, refId, userId, at } = {}) {
  const existing = db.get('SELECT id FROM medicine_batches WHERE medicine_id = ? AND batch_no = ?', medicine_id, batch_no);
  let batchId;
  if (existing) { db.run('UPDATE medicine_batches SET qty = qty + ? WHERE id = ?', qty, existing.id); batchId = existing.id; }
  else batchId = db.insertRow('medicine_batches', { hospital_id: hid, medicine_id, batch_no, expiry_date, qty, purchase_price, mrp, supplier_id, received_at: at || now() });
  db.insertRow('stock_movements', { hospital_id: hid, item_type: 'medicine', medicine_id, batch_id: batchId, qty, movement, ref_type: refType, ref_id: refId, user_id: userId, created_at: at || now() });
  return batchId;
}

// Automation: low-stock and expiry alerts. Deduplicated per medicine per day/batch.
function checkAlerts(hid, medicineIds) {
  const where = medicineIds && medicineIds.length ? `AND m.id IN (${medicineIds.map(() => '?').join(',')})` : '';
  const low = db.all(`SELECT m.id, m.name, m.strength, m.min_stock,
      (SELECT COALESCE(SUM(qty),0) FROM medicine_batches b WHERE b.medicine_id = m.id AND b.expiry_date >= date('now','localtime')) stock
    FROM medicines m WHERE m.hospital_id = ? AND m.is_active = 1 ${where}`, hid, ...(medicineIds || []))
    .filter((m) => m.stock < m.min_stock);
  for (const m of low) {
    notify({ hid, module: 'pharmacy', category: 'inventory', severity: m.stock === 0 ? 'critical' : 'warning',
      title: `${m.name} ${m.strength || ''} stock below minimum level`.replace(/\s+/g, ' '), body: `Current stock ${m.stock}, minimum ${m.min_stock}. Raise a purchase order.`,
      link: '/inventory?tab=alerts', dedupe: `lowstock:${m.id}:${today()}` });
  }
  if (!medicineIds) {
    const days = Number(settings.get(hid, 'notify.expiry_alert_days') || 30);
    const exp = db.all(`SELECT b.id, b.batch_no, b.expiry_date, b.qty, m.name, m.strength FROM medicine_batches b JOIN medicines m ON m.id = b.medicine_id
      WHERE b.hospital_id = ? AND b.qty > 0 AND b.expiry_date <= ? ORDER BY b.expiry_date`, hid, addDays(today(), days));
    for (const b of exp) {
      const expired = b.expiry_date < today();
      notify({ hid, module: 'pharmacy', category: 'inventory', severity: expired ? 'critical' : 'warning',
        title: expired ? `${b.name} batch ${b.batch_no} has expired` : `${b.name} will expire in ${Math.max(0, Math.round((new Date(b.expiry_date) - new Date(today())) / 864e5))} days`,
        body: `Batch ${b.batch_no} · ${b.qty} units · expiry ${b.expiry_date}`, link: '/inventory?tab=expiry', dedupe: `expiry:${b.id}:${expired ? 'x' : 'soon'}` });
    }
    const items = db.all('SELECT id, name, stock, min_stock FROM inventory_items WHERE hospital_id = ? AND is_active = 1 AND stock < min_stock', hid);
    for (const i of items) {
      notify({ hid, module: 'inventory', category: 'inventory', severity: 'warning', title: `${i.name} stock below minimum level`, body: `Current stock ${i.stock}, minimum ${i.min_stock}.`, link: '/inventory?tab=items', dedupe: `lowitem:${i.id}:${today()}` });
    }
  }
  return low.length;
}

module.exports = { medicineStock, allocate, consumeMedicine, addBatch, checkAlerts };
