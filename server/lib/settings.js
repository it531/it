'use strict';
const db = require('../db');

const DEFAULTS = {
  // Numbering (hospital admin can change prefixes/padding; sequences never reset except daily tokens)
  'numbering.patient.prefix': '#', 'numbering.patient.pad': '6',
  'numbering.ipd.prefix': 'IPD-', 'numbering.ipd.pad': '6',
  'numbering.pharmacy_token.prefix': 'P-', 'numbering.pharmacy_token.pad': '3', 'numbering.pharmacy_token.reset': 'daily',
  'numbering.opd_token.pad': '3', 'numbering.opd_token.reset': 'daily',
  'numbering.visit.prefix': 'OPD-', 'numbering.visit.pad': '6',
  'numbering.appointment.prefix': 'APT-', 'numbering.appointment.pad': '6',
  'numbering.invoice.prefix': 'INV-', 'numbering.invoice.pad': '6',
  'numbering.receipt.prefix': 'RCP-', 'numbering.receipt.pad': '6',
  'numbering.rx.prefix': 'RX-', 'numbering.rx.pad': '6',
  'numbering.pharmacy_order.prefix': 'PHO-', 'numbering.pharmacy_order.pad': '6',
  'numbering.lab.prefix': 'LAB-', 'numbering.lab.pad': '6',
  'numbering.radiology.prefix': 'RAD-', 'numbering.radiology.pad': '6',
  'numbering.po.prefix': 'PO-', 'numbering.po.pad': '5',
  'numbering.grn.prefix': 'GRN-', 'numbering.grn.pad': '5',
  'numbering.employee.prefix': 'EMP-', 'numbering.employee.pad': '4',
  // Security
  'security.session_timeout_min': '30',
  'security.max_failed_logins': '5',
  'security.password_min_length': '8',
  // Billing
  'billing.pharmacy_gst_inclusive': '1',
  'billing.currency': 'INR',
  'billing.invoice_footer': 'Thank you for choosing us. Get well soon.',
  // Tokens
  'tokens.display_next_count': '3',
  // Notifications
  'notify.channels.sms': '1', 'notify.channels.whatsapp': '1', 'notify.channels.email': '1', 'notify.channels.push': '1',
  'notify.appointment_reminder_hours': '24',
  'notify.expiry_alert_days': '30',
  // Printing
  'print.default_paper': 'A4',   // A4 | thermal
  'print.show_logo': '1',
  // Backup
  'backup.frequency': 'daily',
  'backup.retention': '14',
};

function getAll(hid) {
  const rows = db.all('SELECT key, value FROM settings WHERE hospital_id = ?', hid);
  const out = { ...DEFAULTS };
  for (const r of rows) out[r.key] = r.value;
  return out;
}
function get(hid, key) {
  const r = db.get('SELECT value FROM settings WHERE hospital_id = ? AND key = ?', hid, key);
  return r ? r.value : DEFAULTS[key];
}
function set(hid, key, value) {
  if (!(key in DEFAULTS)) throw new Error(`Unknown setting ${key}`);
  db.run('INSERT INTO settings (hospital_id, key, value) VALUES (?,?,?) ON CONFLICT(hospital_id, key) DO UPDATE SET value = excluded.value', hid, key, String(value));
}

module.exports = { DEFAULTS, getAll, get, set };
