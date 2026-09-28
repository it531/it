'use strict';
// Minimal declarative validator. Every write endpoint runs its body through a schema
// server-side — the frontend validation is only a convenience.
const { bad } = require('./util');

/**
 * schema: { field: 'string|required|max:120' | { type, required, max, min, enum, pattern, label } }
 * Returns a clean object containing only declared fields.
 */
function validate(body, schema, { partial = false } = {}) {
  body = body || {};
  const out = {}; const errors = {};
  for (const [field, raw] of Object.entries(schema)) {
    const rule = typeof raw === 'string' ? parse(raw) : raw;
    let v = body[field];
    const label = rule.label || field.replace(/_/g, ' ');
    if (typeof v === 'string') v = v.trim();
    const empty = v === undefined || v === null || v === '';
    if (empty) {
      if (rule.required && !partial) errors[field] = `${cap(label)} is required`;
      // Absent optional fields stay undefined (so DB/service defaults apply); a field sent
      // empty is cleared to null; declared defaults apply on create.
      else if (field in body) out[field] = !partial && rule.default !== undefined ? rule.default : (rule.type === 'bool' ? 0 : null);
      else if (!partial && rule.default !== undefined) out[field] = rule.default;
      continue;
    }
    switch (rule.type) {
      case 'int': case 'number': {
        const n = Number(v);
        if (!Number.isFinite(n) || (rule.type === 'int' && !Number.isInteger(n))) { errors[field] = `${cap(label)} must be a number`; continue; }
        if (rule.min !== undefined && n < rule.min) { errors[field] = `${cap(label)} must be ≥ ${rule.min}`; continue; }
        if (rule.max !== undefined && n > rule.max) { errors[field] = `${cap(label)} must be ≤ ${rule.max}`; continue; }
        v = n; break;
      }
      case 'bool': v = v === true || v === 1 || v === '1' || v === 'true' ? 1 : 0; break;
      case 'date':
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v)) || isNaN(new Date(v))) { errors[field] = `${cap(label)} must be a valid date`; continue; }
        if (rule.past && v > new Date().toISOString().slice(0, 10)) { errors[field] = `${cap(label)} cannot be in the future`; continue; }
        break;
      case 'datetime':
        if (!/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/.test(String(v))) { errors[field] = `${cap(label)} must be a valid date & time`; continue; }
        v = String(v).replace('T', ' '); if (v.length === 16) v += ':00';
        break;
      case 'array': if (!Array.isArray(v)) { errors[field] = `${cap(label)} must be a list`; continue; } break;
      case 'object': if (typeof v !== 'object' || Array.isArray(v)) { errors[field] = `${cap(label)} is invalid`; continue; } break;
      default: {
        v = String(v);
        if (rule.max && v.length > rule.max) { errors[field] = `${cap(label)} is too long (max ${rule.max})`; continue; }
        if (rule.min && v.length < rule.min) { errors[field] = `${cap(label)} must be at least ${rule.min} characters`; continue; }
        if (rule.kind === 'mobile' && !/^[6-9]\d{9}$/.test(v.replace(/[\s+-]/g, '').replace(/^91(?=\d{10}$)/, ''))) { errors[field] = `${cap(label)} must be a valid 10-digit mobile number`; continue; }
        if (rule.kind === 'mobile') v = v.replace(/[\s+-]/g, '').replace(/^91(?=\d{10}$)/, '');
        if (rule.kind === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) { errors[field] = `${cap(label)} must be a valid email`; continue; }
        if (rule.pattern && !new RegExp(rule.pattern).test(v)) { errors[field] = `${cap(label)} is invalid`; continue; }
      }
    }
    if (rule.enum && !rule.enum.includes(v)) { errors[field] = `${cap(label)} must be one of: ${rule.enum.join(', ')}`; continue; }
    out[field] = v;
  }
  if (Object.keys(errors).length) throw bad(Object.values(errors)[0], errors);
  return out;
}

function parse(str) {
  const r = { type: 'string' };
  for (const part of str.split('|')) {
    const [k, a] = part.split(':');
    if (['string', 'int', 'number', 'bool', 'date', 'datetime', 'array', 'object'].includes(k)) r.type = k;
    else if (k === 'required') r.required = true;
    else if (k === 'max') r.max = Number(a);
    else if (k === 'min') r.min = Number(a);
    else if (k === 'enum') r.enum = a.split(',');
    else if (k === 'mobile' || k === 'email') r.kind = k;
    else if (k === 'past') r.past = true;
  }
  return r;
}
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

const id = (v, label = 'id') => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw bad(`Invalid ${label}`);
  return n;
};

module.exports = { validate, id };
