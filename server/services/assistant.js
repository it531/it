'use strict';
// "Deep Assist" — AI-assisted features that stay inside guard-rails:
//  • natural-language MIS queries → mapped onto the audited report catalogue (no free SQL)
//  • patient history summarisation from structured records
//  • clinical-note formatting and patient-message drafting
// It never diagnoses or prescribes; outputs are drafts for a clinician/admin to review.
// The parser is deterministic so it works offline; an LLM can be slotted in behind
// interpret() later without changing the contract.
const db = require('../db');
const reports = require('./reports');
const { range, today, addDays, ageFrom } = require('../lib/util');

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const pad = (n) => String(n).padStart(2, '0');

function parsePeriod(q) {
  const s = q.toLowerCase();
  let m;
  if ((m = s.match(/last (\d{1,3}) days?/))) { const n = Number(m[1]); return { from: addDays(today(), -(n - 1)), to: today(), label: `last ${n} days` }; }
  if (/\btoday\b/.test(s)) return { ...range('today'), label: 'today' };
  if (/\byesterday\b/.test(s)) return { ...range('yesterday'), label: 'yesterday' };
  if (/this week|current week/.test(s)) return { ...range('week'), label: 'this week' };
  if (/last month|previous month/.test(s)) return { ...range('last_month'), label: 'last month' };
  if (/this quarter|quarter/.test(s)) return { ...range('quarter'), label: 'this quarter' };
  if (/this year|year to date|ytd/.test(s)) return { ...range('year'), label: 'this year' };
  for (let i = 0; i < 12; i++) {
    const name = MONTHS[i];
    const re = new RegExp(`\\b(${name}|${name.slice(0, 3)})\\b(?:\\s+(\\d{4}))?`);
    if ((m = s.match(re))) {
      const t = today(); let y = m[2] ? Number(m[2]) : Number(t.slice(0, 4));
      if (!m[2] && i + 1 > Number(t.slice(5, 7))) y -= 1;       // "August" in March means last August
      const last = new Date(y, i + 1, 0).getDate();
      return { from: `${y}-${pad(i + 1)}-01`, to: `${y}-${pad(i + 1)}-${pad(last)}`, label: `${name[0].toUpperCase() + name.slice(1)} ${y}` };
    }
  }
  if (/this month|month/.test(s)) return { ...range('month'), label: 'this month' };
  return { ...range('last30'), label: 'the last 30 days' };
}

const INTENTS = [
  { re: /(below|under|less than).*(minimum|min|reorder)|low[- ]?stock|out of stock|reorder/, report: 'pharmacy_low_stock', periodless: true },
  { re: /expir/, report: 'pharmacy_expiry', periodless: true },
  { re: /top (medicine|drug)|most (dispensed|used|sold) medicine|medicine consumption/, report: 'pharmacy_top' },
  { re: /pharmacy (sales|revenue)|medicine sales/, report: 'pharmacy_sales' },
  { re: /prescription/, report: 'pharmacy_rx_volume' },
  { re: /outstanding|dues|pending payment|unpaid/, report: 'outstanding' },
  { re: /refund/, report: 'refunds' },
  { re: /revenue.*(department|dept)|department.*revenue/, report: 'revenue_department' },
  { re: /revenue.*doctor|doctor.*revenue/, report: 'revenue_doctor' },
  { re: /(payment mode|upi|cash|card).*(collection|revenue)?|collections by mode/, report: 'revenue_payment_mode' },
  { re: /revenue.*(service|type|opd.*ipd)|(opd|ipd|lab).*revenue/, report: 'revenue_by_type' },
  { re: /monthly revenue|revenue by month|billed/, report: 'revenue_monthly' },
  { re: /revenue|collection|income|earning/, report: 'revenue_daily' },
  { re: /occupan|beds?\b/, report: 'ipd_occupancy', periodless: true },
  { re: /admission|discharge|ipd|length of stay/, report: 'ipd_admissions' },
  { re: /wait(ing)? time|token/, report: 'opd_waiting' },
  { re: /opd.*doctor|doctor.*(opd|patients|performance)|patients per doctor/, report: 'opd_doctor' },
  { re: /opd.*department|department.*(opd|patients)/, report: 'opd_department' },
  { re: /appointment|no[- ]show|cancel/, report: 'appointments' },
  { re: /returning|repeat patients|new vs/, report: 'patients_returning' },
  { re: /demograph|age|gender/, report: 'patients_demographics' },
  { re: /new patients|registration|registered/, report: 'patients_new' },
  { re: /opd|outpatient|consultation|patients/, report: 'opd_daily' },
  { re: /attendance|absent|present|late/, report: 'hr_attendance' },
  { re: /leave/, report: 'hr_leave' },
  { re: /salary|payroll/, report: 'hr_salary' },
  { re: /employee|staff/, report: 'hr_employees' },
];

function interpret(q) {
  const s = String(q || '').toLowerCase();
  const intent = INTENTS.find((i) => i.re.test(s));
  if (!intent) return null;
  const period = parsePeriod(s);
  const filters = { from: period.from, to: period.to };
  const docs = s.match(/dr\.?\s+([a-z]+)/);
  return { report: intent.report, filters, period: intent.periodless ? null : period.label, doctorName: docs ? docs[1] : null };
}

function query(hid, q, allowedReport) {
  const it = interpret(q);
  if (!it) return { answer: "I couldn't map that to a report yet. Try: \"OPD patients for August\", \"Which medicines are below minimum stock?\", \"Revenue by department this month\" or \"Bed occupancy\".", suggestions: SUGGESTIONS };
  if (it.doctorName) {
    const d = db.get("SELECT id, name FROM doctors WHERE hospital_id = ? AND lower(name) LIKE ?", hid, `%${it.doctorName}%`);
    if (d) it.filters.doctor_id = d.id;
  }
  if (allowedReport && !allowedReport(it.report)) return { answer: 'You do not have access to the report needed to answer that question.' };
  const res = reports.run(hid, it.report, it.filters);
  const head = (res.summary || []).map((s) => `${s.label}: **${s.type === 'money' ? '₹' + Number(s.value).toLocaleString('en-IN') : Number.isFinite(Number(s.value)) ? Number(s.value).toLocaleString('en-IN') : s.value}**`).join(' · ');
  return { answer: `${res.title}${it.period ? ` for ${it.period}` : ''}. ${head}`, report: res, interpreted: it };
}

const SUGGESTIONS = ['Show me OPD patients for August', 'Which medicines are below minimum stock?', 'Revenue by department this month', 'Doctor-wise OPD last month', 'Outstanding payments', 'Bed occupancy', 'Medicines expiring soon', 'Attendance this week'];

// Structured patient-history summary for the consultation screen.
function patientSummary(hid, patientId) {
  const p = db.get('SELECT * FROM patients WHERE id = ? AND hospital_id = ?', patientId, hid);
  if (!p) return null;
  const visits = db.all(`SELECT v.id, v.visit_date, v.chief_complaint, d.name doctor FROM opd_visits v JOIN doctors d ON d.id = v.doctor_id WHERE v.patient_id = ? AND v.status = 'completed' ORDER BY v.visit_date DESC`, patientId);
  const dx = db.all(`SELECT dc.name, dc.code, COUNT(*) n, MAX(vd.created_at) last FROM visit_diagnoses vd JOIN diagnosis_codes dc ON dc.id = vd.diagnosis_id WHERE vd.hospital_id = ? AND (vd.visit_id IN (SELECT id FROM opd_visits WHERE patient_id = ?) OR vd.admission_id IN (SELECT id FROM ipd_admissions WHERE patient_id = ?)) GROUP BY dc.id ORDER BY n DESC, last DESC LIMIT 6`, hid, patientId, patientId);
  const lastRx = db.get("SELECT id, finalized_at FROM prescriptions WHERE patient_id = ? AND status = 'finalized' ORDER BY finalized_at DESC LIMIT 1", patientId);
  const meds = lastRx ? db.all('SELECT m.name, m.strength, pi.dose, pi.frequency, pi.duration_days FROM prescription_items pi JOIN medicines m ON m.id = pi.medicine_id WHERE pi.prescription_id = ?', lastRx.id) : [];
  const abnormal = db.all(`SELECT lr.parameter, lr.value, lr.unit, lr.flag, lt.name test, substr(lo.completed_at,1,10) date FROM lab_results lr JOIN lab_orders lo ON lo.id = lr.lab_order_id JOIN lab_tests lt ON lt.id = lo.test_id WHERE lo.patient_id = ? AND lo.status IN ('completed','verified') AND lr.flag IN ('H','L','C') ORDER BY lo.completed_at DESC LIMIT 6`, patientId);
  const adm = db.all('SELECT ipd_no, admitted_at, discharged_at, final_diagnosis, reason FROM ipd_admissions WHERE patient_id = ? ORDER BY admitted_at DESC LIMIT 3', patientId);
  const lastVitals = db.get("SELECT vitals, visit_date FROM opd_visits WHERE patient_id = ? AND vitals IS NOT NULL AND status = 'completed' ORDER BY visit_date DESC LIMIT 1", patientId);

  const lines = [];
  const age = ageFrom(p.dob);
  lines.push(`${p.full_name}, ${age != null ? age + ' y' : 'age unknown'} ${p.gender ? p.gender.toLowerCase() : ''}${p.blood_group ? ', ' + p.blood_group : ''}. ${visits.length ? `${visits.length} completed OPD visit${visits.length > 1 ? 's' : ''}; last on ${visits[0].visit_date} with ${visits[0].doctor}${visits[0].chief_complaint ? ` for "${visits[0].chief_complaint}"` : ''}.` : 'No previous OPD visits.'}`);
  if (p.allergies) lines.push(`⚠ Allergies: ${p.allergies}.`);
  if (p.chronic_conditions) lines.push(`Known conditions: ${p.chronic_conditions}.`);
  if (dx.length) lines.push(`Recurring diagnoses: ${dx.map((d) => `${d.name}${d.n > 1 ? ` ×${d.n}` : ''}`).join(', ')}.`);
  if (meds.length) lines.push(`Last prescription (${lastRx.finalized_at.slice(0, 10)}): ${meds.map((m) => `${m.name} ${m.strength || ''} ${m.frequency || ''}`.replace(/\s+/g, ' ').trim()).join('; ')}.`);
  if (abnormal.length) lines.push(`Recent abnormal results: ${abnormal.map((a) => `${a.parameter} ${a.value}${a.unit ? ' ' + a.unit : ''} (${a.flag === 'C' ? 'critical' : a.flag === 'H' ? 'high' : 'low'}, ${a.date})`).join('; ')}.`);
  if (adm.length) lines.push(`Admissions: ${adm.map((a) => `${a.ipd_no} on ${a.admitted_at.slice(0, 10)}${a.final_diagnosis ? ' — ' + a.final_diagnosis : a.reason ? ' — ' + a.reason : ''}`).join('; ')}.`);
  if (lastVitals) {
    const v = JSON.parse(lastVitals.vitals);
    const bits = [v.bp_sys && `BP ${v.bp_sys}/${v.bp_dia}`, v.pulse && `pulse ${v.pulse}`, v.spo2 && `SpO₂ ${v.spo2}%`, v.weight && `wt ${v.weight} kg`].filter(Boolean);
    if (bits.length) lines.push(`Last vitals (${lastVitals.visit_date}): ${bits.join(', ')}.`);
  }
  return { summary: lines, generated_at: new Date().toISOString(), disclaimer: 'Auto-generated from structured records for clinician review. Not a diagnosis.' };
}

// Formats free-text clinical notes into a SOAP-style structure (no content is invented).
function formatNote(text) {
  const src = String(text || '').trim();
  if (!src) return '';
  const sentences = src.replace(/\s+/g, ' ').split(/(?<=[.;])\s+|\n+/).map((x) => x.trim()).filter(Boolean);
  const bucket = { S: [], O: [], A: [], P: [] };
  for (const s of sentences) {
    const l = s.toLowerCase();
    if (/\b(bp|pulse|spo2|temp|afebrile|febrile|on examination|o\/e|chest|abdomen|tender|clear|rr|cvs|cns|p\/a)\b/.test(l)) bucket.O.push(s);
    else if (/\b(impression|likely|suspect|diagnos|r\/o|rule out|consistent with)\b/.test(l)) bucket.A.push(s);
    else if (/\b(advise|advice|plan|start|continue|review|follow[- ]?up|investigat|refer|stop|increase|decrease)\b/.test(l)) bucket.P.push(s);
    else bucket.S.push(s);
  }
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  return [['Subjective', bucket.S], ['Objective', bucket.O], ['Assessment', bucket.A], ['Plan', bucket.P]].filter(([, v]) => v.length).map(([k, v]) => `${k}:\n${v.map((x) => `• ${cap(x)}`).join('\n')}`).join('\n\n');
}

const TEMPLATES = {
  appointment_reminder: ({ name, doctor, when, hospital }) => `Dear ${name}, this is a reminder of your appointment with ${doctor} on ${when} at ${hospital}. Please arrive 10 minutes early and carry your previous reports. Reply to reschedule.`,
  report_ready: ({ name, hospital }) => `Dear ${name}, your test report is ready and available in the ${hospital} patient portal. Please review it with your doctor at your next visit.`,
  payment_due: ({ name, amount, hospital }) => `Dear ${name}, an amount of ₹${amount} is pending on your account at ${hospital}. You can pay at the billing counter or via UPI. Thank you.`,
  follow_up: ({ name, doctor, when, hospital }) => `Dear ${name}, ${doctor} has advised a follow-up visit on ${when}. Book your slot from the ${hospital} patient portal or call the reception.`,
  discharge: ({ name, hospital }) => `Dear ${name}, we wish you a speedy recovery. Your discharge summary and final bill are available in the ${hospital} patient portal.`,
};
function draftMessage(kind, vars) { const f = TEMPLATES[kind]; return f ? f(vars) : null; }

module.exports = { interpret, query, patientSummary, formatNote, draftMessage, SUGGESTIONS, parsePeriod };
