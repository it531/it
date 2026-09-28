'use strict';
// Outbound channel dispatcher. Providers are adapters with a send(delivery) → { ref }
// contract. Out of the box every channel uses the "log" adapter (writes to the server
// log and marks the delivery sent) so the pipeline is observable end-to-end.
// To go live, register real adapters, e.g.:
//   channels.register('sms', require('./providers/msg91'))
//   channels.register('whatsapp', require('./providers/gupshup'))
//   channels.register('email', require('./providers/smtp'))
//   channels.register('push', require('./providers/fcm'))
const db = require('../db');
const { now } = require('./util');

const logAdapter = {
  name: 'log',
  async send(d) {
    if (process.env.LOG_NOTIFICATIONS !== 'false' && process.env.NODE_ENV !== 'test') {
      console.log(`[notify:${d.channel}] → ${d.recipient}: ${d.message}`);
    }
    return { ref: `log-${d.id}` };
  },
};
const adapters = { sms: logAdapter, whatsapp: logAdapter, email: logAdapter, push: logAdapter };

function register(channel, adapter) { adapters[channel] = adapter; }

let running = false;
async function drain(limit = 100) {
  if (running) return 0;
  running = true;
  let n = 0;
  try {
    const rows = db.all("SELECT * FROM notification_deliveries WHERE status = 'queued' AND attempts < 5 ORDER BY id LIMIT ?", limit);
    for (const d of rows) {
      const a = adapters[d.channel];
      if (!a) { db.run("UPDATE notification_deliveries SET status='skipped', error='no adapter' WHERE id = ?", d.id); continue; }
      try {
        const r = await a.send(d);
        db.run("UPDATE notification_deliveries SET status='sent', provider=?, provider_ref=?, sent_at=?, attempts=attempts+1 WHERE id=?", a.name, r && r.ref, now(), d.id);
        n++;
      } catch (e) {
        db.run("UPDATE notification_deliveries SET attempts=attempts+1, error=?, status=CASE WHEN attempts+1>=5 THEN 'failed' ELSE 'queued' END WHERE id=?", String(e.message).slice(0, 300), d.id);
      }
    }
  } finally { running = false; }
  return n;
}

module.exports = { register, drain, adapters };
