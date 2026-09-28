'use strict';
// Dates are stored as local wall-clock strings (hospital timezone, default Asia/Kolkata)
// in 'YYYY-MM-DD HH:MM:SS' so SQLite date() functions group by the local day.

const pad = (n, w = 2) => String(n).padStart(w, '0');

function fmt(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
const now = () => fmt(new Date());
const today = () => now().slice(0, 10);
function addDays(dateStr, n) {
  const d = new Date(`${dateStr.slice(0, 10)}T00:00:00`);
  d.setDate(d.getDate() + n);
  return fmt(d).slice(0, 10);
}
function addMinutes(dt, n) { return fmt(new Date(new Date(dt.replace(' ', 'T')).getTime() + n * 60000)); }
function diffDays(a, b) {
  return Math.round((new Date(`${b.slice(0, 10)}T00:00:00`) - new Date(`${a.slice(0, 10)}T00:00:00`)) / 86400000);
}
function ageFrom(dob) {
  if (!dob) return null;
  const d = new Date(`${dob}T00:00:00`); const n = new Date();
  let a = n.getFullYear() - d.getFullYear();
  if (n.getMonth() < d.getMonth() || (n.getMonth() === d.getMonth() && n.getDate() < d.getDate())) a--;
  return a;
}

// Date-range presets used by reports / analytics.
function range(preset, from, to) {
  const t = today();
  const d = new Date(`${t}T00:00:00`);
  const ymd = (x) => fmt(x).slice(0, 10);
  switch (preset) {
    case 'today': return { from: t, to: t };
    case 'yesterday': { const y = addDays(t, -1); return { from: y, to: y }; }
    case 'week': { const dow = (d.getDay() + 6) % 7; return { from: addDays(t, -dow), to: t }; }
    case 'last30': return { from: addDays(t, -29), to: t };
    case 'month': return { from: `${t.slice(0, 7)}-01`, to: t };
    case 'last_month': {
      const s = new Date(d.getFullYear(), d.getMonth() - 1, 1); const e = new Date(d.getFullYear(), d.getMonth(), 0);
      return { from: ymd(s), to: ymd(e) };
    }
    case 'quarter': { const q = Math.floor(d.getMonth() / 3) * 3; return { from: ymd(new Date(d.getFullYear(), q, 1)), to: t }; }
    case 'year': return { from: `${t.slice(0, 4)}-01-01`, to: t };
    case 'last90': return { from: addDays(t, -89), to: t };
    default:
      return { from: isDate(from) ? from : addDays(t, -29), to: isDate(to) ? to : t };
  }
}
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

class HttpError extends Error {
  constructor(status, message, details) { super(message); this.status = status; this.details = details; }
}
const bad = (msg, details) => new HttpError(400, msg, details);
const notFound = (what = 'Record') => new HttpError(404, `${what} not found`);
const conflict = (msg) => new HttpError(409, msg);
const forbidden = (msg = 'You do not have permission to perform this action') => new HttpError(403, msg);

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const inr = (n) => '₹' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });

module.exports = { now, today, addDays, addMinutes, diffDays, ageFrom, range, isDate, fmt, pad, HttpError, bad, notFound, conflict, forbidden, round2, inr };
