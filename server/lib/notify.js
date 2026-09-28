'use strict';
// Notification engine. In-app notifications are stored immediately; outbound channel
// messages (SMS / WhatsApp / Email / Push) are queued in notification_deliveries and
// drained by the dispatcher in channels.js, where real providers plug in.
const db = require('../db');
const settings = require('./settings');
const { now } = require('./util');

/**
 * notify({ hid, patientId | userId | module, category, severity, title, body, link, dedupe, channels })
 * Returns the notification id, or null when deduplicated.
 */
function notify(n) {
  const t = now();
  if (n.dedupe) {
    const exists = db.get('SELECT id FROM notifications WHERE hospital_id IS ? AND dedupe_key = ?', n.hid ?? null, n.dedupe);
    if (exists) return null;
  }
  const id = db.insertRow('notifications', {
    hospital_id: n.hid ?? null, user_id: n.userId ?? null, audience_module: n.module ?? null, patient_id: n.patientId ?? null,
    category: n.category || 'system', severity: n.severity || 'info', title: n.title, body: n.body ?? null,
    link: n.link ?? null, dedupe_key: n.dedupe ?? null, created_at: t,
  });
  // Patients also receive the message on their configured external channels.
  if (n.patientId && n.hid) {
    const p = db.get('SELECT mobile, email FROM patients WHERE id = ? AND hospital_id = ?', n.patientId, n.hid);
    if (p) {
      const msg = n.body ? `${n.title}. ${n.body}` : n.title;
      const channels = n.channels || ['sms', 'whatsapp', 'push', 'email'];
      for (const ch of channels) {
        if (settings.get(n.hid, `notify.channels.${ch}`) !== '1') continue;
        const recipient = ch === 'email' ? p.email : ch === 'push' ? `patient:${n.patientId}` : p.mobile;
        if (!recipient) continue;
        db.insertRow('notification_deliveries', { hospital_id: n.hid, notification_id: id, channel: ch, recipient, message: msg, created_at: t });
      }
    }
  }
  return id;
}

// Staff inbox: direct notifications + module-audience notifications the user can view.
function forUser(ctx, { limit = 30, unreadOnly = false } = {}) {
  const mods = [...ctx.perms].filter((p) => p.endsWith(':view')).map((p) => p.split(':')[0]);
  const modSql = mods.length ? `OR n.audience_module IN (${mods.map(() => '?').join(',')})` : '';
  const rows = db.all(`
    SELECT n.*, CASE WHEN n.user_id IS NOT NULL THEN n.read_at ELSE r.read_at END AS read_at
    FROM notifications n
    LEFT JOIN notification_reads r ON r.notification_id = n.id AND r.user_id = ?
    WHERE n.hospital_id IS ? AND n.patient_id IS NULL AND (n.user_id = ? ${modSql})
    ${unreadOnly ? 'AND (CASE WHEN n.user_id IS NOT NULL THEN n.read_at ELSE r.read_at END) IS NULL' : ''}
    ORDER BY n.id DESC LIMIT ?`, ctx.user.id, ctx.hid ?? null, ctx.user.id, ...mods, limit);
  const unread = db.get(`
    SELECT COUNT(*) c FROM notifications n
    LEFT JOIN notification_reads r ON r.notification_id = n.id AND r.user_id = ?
    WHERE n.hospital_id IS ? AND n.patient_id IS NULL AND (n.user_id = ? ${modSql})
      AND (CASE WHEN n.user_id IS NOT NULL THEN n.read_at ELSE r.read_at END) IS NULL`, ctx.user.id, ctx.hid ?? null, ctx.user.id, ...mods).c;
  return { items: rows, unread };
}

function markRead(ctx, ids) {
  const t = now();
  for (const id of ids) {
    const n = db.get('SELECT id, user_id FROM notifications WHERE id = ? AND hospital_id IS ?', id, ctx.hid ?? null);
    if (!n) continue;
    if (n.user_id === ctx.user.id) db.run('UPDATE notifications SET read_at = ? WHERE id = ?', t, id);
    else db.run('INSERT OR IGNORE INTO notification_reads (notification_id, user_id, read_at) VALUES (?,?,?)', id, ctx.user.id, t);
  }
}

module.exports = { notify, forUser, markRead };
