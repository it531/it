'use strict';
const db = require('../db');
const { now } = require('./util');

/** audit(req, 'patient.create', { entity: 'patient', id, ref: '#000234', details }) */
function audit(req, action, { entity, id, ref, details, hid } = {}) {
  const ctx = req && req.ctx;
  db.insertRow('audit_logs', {
    hospital_id: hid !== undefined ? hid : (ctx ? ctx.hid : null),
    user_id: ctx ? ctx.user.id : null,
    username: ctx ? ctx.user.username : (req && req.auditUser) || 'system',
    action, entity, entity_id: id, ref,
    details: details ? JSON.stringify(details) : null,
    ip: req && req.ip,
    created_at: now(),
  });
  if (ctx && ctx.hid) db.run('UPDATE hospitals SET last_activity_at = ? WHERE id = ?', now(), ctx.hid);
}

module.exports = { audit };
