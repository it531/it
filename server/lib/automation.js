'use strict';
// Background automation engine. Event-driven automations (UHID, tokens, pharmacy orders,
// stock deduction, bed status, invoices …) run synchronously inside the originating
// transaction in services/*. This scheduler handles the time-based ones.
const fs = require('node:fs');
const path = require('node:path');
const db = require('../db');
const channels = require('./channels');
const inventory = require('../services/inventory');
const reports = require('../services/reports');
const settings = require('./settings');
const { notify } = require('./notify');
const { now, today, addDays, range, fmt } = require('./util');

const BACKUP_DIR = process.env.BACKUP_DIR || path.join(db.DATA_DIR, 'backups');

function appointmentReminders(hid) {
  const hours = Number(settings.get(hid, 'notify.appointment_reminder_hours') || 24);
  const until = fmt(new Date(Date.now() + hours * 3600e3));
  const rows = db.all(`SELECT a.id, a.patient_id, a.scheduled_at, d.name doctor FROM appointments a JOIN doctors d ON d.id = a.doctor_id
    WHERE a.hospital_id = ? AND a.status IN ('booked','confirmed') AND a.reminder_sent = 0 AND a.scheduled_at BETWEEN ? AND ?`, hid, now(), until);
  for (const a of rows) {
    const when = new Date(a.scheduled_at.replace(' ', 'T'));
    const day = a.scheduled_at.slice(0, 10) === today() ? 'today' : a.scheduled_at.slice(0, 10) === addDays(today(), 1) ? 'tomorrow' : a.scheduled_at.slice(0, 10);
    notify({ hid, patientId: a.patient_id, category: 'appointment', title: `Your appointment is ${day} at ${when.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })}`, body: `With ${a.doctor}. Please arrive 10 minutes early.`, link: '/portal/appointments', dedupe: `appt-rem:${a.id}` });
    db.run('UPDATE appointments SET reminder_sent = 1 WHERE id = ?', a.id);
  }
  return rows.length;
}

function followUpReminders(hid) {
  const tomorrow = addDays(today(), 1);
  const rows = db.all(`SELECT v.id, v.patient_id, v.follow_up_date, d.name doctor FROM opd_visits v JOIN doctors d ON d.id = v.doctor_id
    WHERE v.hospital_id = ? AND v.follow_up_date BETWEEN ? AND ? AND v.followup_reminder_sent = 0`, hid, today(), tomorrow);
  for (const v of rows) {
    notify({ hid, patientId: v.patient_id, category: 'appointment', title: `Follow-up due ${v.follow_up_date === today() ? 'today' : 'tomorrow'}`, body: `Your follow-up with ${v.doctor} is due on ${v.follow_up_date}. Book an appointment from the portal.`, link: '/portal/appointments', dedupe: `fu:${v.id}` });
    db.run('UPDATE opd_visits SET followup_reminder_sent = 1 WHERE id = ?', v.id);
  }
  return rows.length;
}

function paymentReminders(hid) {
  const rows = db.all(`SELECT id, patient_id, invoice_no, balance FROM invoices WHERE hospital_id = ? AND balance > 0 AND status IN ('unpaid','partial') AND patient_id IS NOT NULL AND created_at < ?`, hid, `${addDays(today(), -3)} 00:00:00`);
  for (const i of rows) notify({ hid, patientId: i.patient_id, category: 'billing', severity: 'warning', title: `Payment reminder · ₹${i.balance.toLocaleString('en-IN')} due`, body: `Invoice ${i.invoice_no} has an outstanding balance.`, link: '/portal/bills', dedupe: `payrem:${i.id}:${today().slice(0, 7)}`, channels: ['sms', 'push'] });
  return rows.length;
}

function scheduledReports(hid) {
  const due = db.all("SELECT * FROM saved_reports WHERE hospital_id = ? AND schedule IN ('daily','weekly','monthly')", hid).filter((r) => {
    if (!r.last_run_at) return true;
    const last = r.last_run_at.slice(0, 10);
    return r.schedule === 'daily' ? last < today() : r.schedule === 'weekly' ? last <= addDays(today(), -7) : last.slice(0, 7) < today().slice(0, 7);
  });
  for (const r of due) {
    const f = JSON.parse(r.filters || '{}');
    const res = reports.run(hid, r.report_type, { ...f, ...range(f.preset || 'last30', f.from, f.to) });
    if (!res) continue;
    const headline = (res.summary || []).map((s) => `${s.label}: ${s.type === 'money' ? '₹' + Number(s.value).toLocaleString('en-IN') : s.value}`).join(' · ');
    notify({ hid, userId: r.user_id, category: 'report', title: `Scheduled report ready: ${r.name}`, body: headline, link: `/reports?saved=${r.id}` });
    db.run('UPDATE saved_reports SET last_run_at = ? WHERE id = ?', now(), r.id);
  }
  return due.length;
}

// Whole-database online backup (all tenants) via VACUUM INTO, with retention.
function backup(trigger = 'scheduled') {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const name = `deep-hospital-${now().replace(/[: ]/g, '-')}.db`;
  const file = path.join(BACKUP_DIR, name);
  try {
    db.conn().exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
    const size = fs.statSync(file).size;
    db.insertRow('backups', { file_name: name, size_bytes: size, status: 'success', trigger, created_at: now() });
    const keep = 14;
    const files = fs.readdirSync(BACKUP_DIR).filter((f) => f.endsWith('.db')).sort();
    for (const f of files.slice(0, Math.max(files.length - keep, 0))) fs.unlinkSync(path.join(BACKUP_DIR, f));
    return { file_name: name, size_bytes: size };
  } catch (e) {
    db.insertRow('backups', { file_name: name, status: 'failed', trigger, error: String(e.message).slice(0, 300), created_at: now() });
    throw e;
  }
}
function backupIfDue() {
  const last = db.get("SELECT created_at FROM backups WHERE status = 'success' ORDER BY id DESC LIMIT 1");
  if (!last || last.created_at < fmt(new Date(Date.now() - 24 * 3600e3))) {
    try { backup('scheduled'); } catch (e) { console.error('[backup] failed:', e.message); }
  }
}

function runAll() {
  const hospitals = db.all('SELECT id FROM hospitals WHERE is_active = 1');
  const out = {};
  for (const { id } of hospitals) {
    try {
      db.tx(() => {
        out[id] = { alerts: inventory.checkAlerts(id), reminders: appointmentReminders(id), followups: followUpReminders(id), payments: paymentReminders(id), reports: scheduledReports(id) };
      });
    } catch (e) { console.error(`[automation] hospital ${id}:`, e.message); }
  }
  return out;
}

let timers = [];
function start() {
  if (process.env.DISABLE_SCHEDULER === 'true') return;
  setTimeout(() => { runAll(); backupIfDue(); }, 3000).unref();
  timers.push(setInterval(runAll, 5 * 60e3));
  timers.push(setInterval(() => channels.drain().catch(() => {}), 5e3));
  timers.push(setInterval(backupIfDue, 60 * 60e3));
  timers.forEach((t) => t.unref());
}
function stop() { timers.forEach(clearInterval); timers = []; }

module.exports = { start, stop, runAll, backup, appointmentReminders, followUpReminders, BACKUP_DIR };
