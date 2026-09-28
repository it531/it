// Printable documents: A4 and 80 mm thermal layouts. "Save as PDF" from the print dialog.
import { api, session } from '../core/api.js';
import { icon, LOGO } from '../core/icons.js';
import { esc, fdate, fdt, ftime, inr2, num, titleCase } from '../core/ui.js';

const toWords = (n) => {
  const a = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
  const b = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
  const w = (x) => (x < 20 ? a[x] : x < 100 ? `${b[Math.floor(x / 10)]}${x % 10 ? ' ' + a[x % 10] : ''}` : x < 1000 ? `${a[Math.floor(x / 100)]} Hundred${x % 100 ? ' ' + w(x % 100) : ''}` : x < 100000 ? `${w(Math.floor(x / 1000))} Thousand${x % 1000 ? ' ' + w(x % 1000) : ''}` : x < 10000000 ? `${w(Math.floor(x / 100000))} Lakh${x % 100000 ? ' ' + w(x % 100000) : ''}` : `${w(Math.floor(x / 10000000))} Crore${x % 10000000 ? ' ' + w(x % 10000000) : ''}`);
  const r = Math.round(Number(n || 0)); return r ? `Rupees ${w(r)} Only` : 'Rupees Zero Only';
};

export default async function print(ctx) {
  const { type, id } = ctx.params;
  const q = new URLSearchParams(location.search);
  const thermal = q.get('paper') === 'thermal';
  const app = document.getElementById('app');
  app.innerHTML = '<div class="print-toolbar"><b>Preparing document…</b></div>';
  let hosp = session.me && session.me.hospital;
  let body = ''; let title = 'Document';
  try {
    const portal = type.startsWith('portal-');
    if (portal) { const me = await api.get('/portal/me', { portal: true }); hosp = me.hospital; }
    const R = RENDER[type.replace('portal-', '')];
    if (!R) throw new Error('Unknown document type');
    const data = await R.load(id, portal, q);
    title = R.title(data);
    body = R.render(data, { thermal });
  } catch (err) {
    app.innerHTML = `<div class="print-toolbar"><b>Unable to prepare document</b></div><div class="print-page"><p>${esc(err.message)}</p></div>`;
    return;
  }
  document.title = title;
  const header = `<div class="ph"><div class="row" style="gap:12px">${hosp && hosp.logo ? `<img src="${esc(hosp.logo)}" style="height:52px">` : LOGO}<div><div class="hn">${esc(hosp ? hosp.name : 'Deep Hospital')}</div><div class="ha">${esc([hosp && hosp.address, hosp && hosp.city].filter(Boolean).join(', '))}${hosp && hosp.phone ? ` · ${esc(hosp.phone)}` : ''}${hosp && hosp.email ? ` · ${esc(hosp.email)}` : ''}</div>${hosp && hosp.gstin ? `<div class="ha">GSTIN ${esc(hosp.gstin)}${hosp.registration_no ? ` · Reg. ${esc(hosp.registration_no)}` : ''}</div>` : ''}</div></div><div style="text-align:right;font-size:11px;color:#555">Printed ${fdt(new Date())}</div></div>`;
  app.innerHTML = `<div class="print-toolbar no-print"><div class="row" style="gap:10px">${LOGO}<b>${esc(title)}</b></div><div class="row" style="gap:8px">${['invoice', 'receipt', 'opd-slip', 'portal-invoice'].includes(type) ? `<a class="btn btn-secondary btn-sm" href="?paper=${thermal ? 'a4' : 'thermal'}">${thermal ? 'A4 layout' : 'Thermal 80 mm'}</a>` : ''}<button class="btn btn-primary btn-sm" id="do-print">${icon('printer')}Print / Save PDF</button></div></div>
    <div class="print-page ${thermal ? 'thermal' : ''}">${header}${body}<div class="pfoot">This is a computer-generated document from Deep Hospital. ${esc((hosp && hosp.name) || '')}</div></div>`;
  document.getElementById('do-print').onclick = () => window.print();
  if (thermal) { const st = document.createElement('style'); st.textContent = '@media print { @page { size: 80mm auto; margin: 0; } }'; document.head.appendChild(st); }
  setTimeout(() => window.print(), 600);
}

const pinfo = (rows) => `<div class="pinfo">${rows.filter(Boolean).map(([k, v]) => `<div>${esc(k)}: <b>${esc(v ?? '—')}</b></div>`).join('')}</div>`;
const age = (x) => (x.age != null ? `${x.age} y` : '—');

const RENDER = {
  prescription: {
    load: (id, portal) => api.get(portal ? `/portal/prescriptions/${id}` : `/prescriptions/${id}`, { portal }),
    title: (x) => `Prescription ${x.rx_no}`,
    render: (x) => `<div class="pt-title">Prescription</div>${pinfo([['Patient', x.patient_name], ['UHID', x.uhid], ['Age / Sex', `${age(x)} / ${x.gender || ''}`], ['Rx No.', x.rx_no], ['Date', fdt(x.finalized_at)], ['Mobile', x.mobile]])}
      <div class="row between" style="align-items:flex-start;gap:20px"><div><b>${esc(x.doctor_name)}</b><div style="font-size:11px">${esc(x.qualification || '')} · ${esc(x.department || '')}${x.registration_no ? ` · Reg. ${esc(x.registration_no)}` : ''}</div></div>${x.vitals ? `<div style="font-size:11px;text-align:right">${[x.vitals.bp_sys && `BP ${x.vitals.bp_sys}/${x.vitals.bp_dia}`, x.vitals.pulse && `Pulse ${x.vitals.pulse}`, x.vitals.temp && `Temp ${x.vitals.temp}°F`, x.vitals.spo2 && `SpO₂ ${x.vitals.spo2}%`, x.vitals.weight && `Wt ${x.vitals.weight} kg`].filter(Boolean).join(' · ')}</div>` : ''}</div>
      ${x.allergies ? `<p style="margin-top:8px;color:#b00020"><b>Allergies:</b> ${esc(x.allergies)}</p>` : ''}
      ${x.chief_complaint ? `<p style="margin-top:8px"><b>Complaints:</b> ${esc(x.chief_complaint)}</p>` : ''}
      ${x.diagnoses && x.diagnoses.length ? `<p style="margin-top:4px"><b>Diagnosis:</b> ${x.diagnoses.map((d) => `${esc(d.name)}${d.code ? ` (${esc(d.code)})` : ''}`).join(', ')}</p>` : ''}
      <div class="rx-symbol" style="margin-top:10px">℞</div>
      <table class="ptable"><thead><tr><th>#</th><th>Medicine</th><th>Dose</th><th>Frequency</th><th>Duration</th><th>Route</th><th>Instructions</th><th class="r">Qty</th></tr></thead><tbody>${x.items.map((i, k) => `<tr><td>${k + 1}</td><td><b>${esc(i.name)}</b> ${esc(i.strength || '')}<div style="font-size:10px;color:#555">${esc(i.generic_name || '')}</div></td><td>${esc(i.dose || '')}</td><td>${esc(i.frequency || '')}</td><td>${i.duration_days ? `${i.duration_days} days` : ''}</td><td>${esc(i.route || '')}</td><td>${esc(i.instructions || '')}</td><td class="r">${i.quantity}</td></tr>`).join('') || '<tr><td colspan="8">No medicines prescribed.</td></tr>'}</tbody></table>
      ${x.advice ? `<p style="margin-top:8px"><b>Advice:</b> ${esc(x.advice)}</p>` : ''}${x.follow_up_date ? `<p><b>Follow-up:</b> ${fdate(x.follow_up_date)}</p>` : ''}${x.notes ? `<p><b>Notes:</b> ${esc(x.notes)}</p>` : ''}
      <div class="psign"><div></div><div style="text-align:center">______________________<br><b>${esc(x.doctor_name)}</b><br>Digitally finalized ${fdt(x.finalized_at)}</div></div>`,
  },
  invoice: {
    load: (id, portal) => api.get(portal ? `/portal/invoices/${id}` : `/billing/invoices/${id}`, { portal }),
    title: (x) => `Invoice ${x.invoice_no}`,
    render: (x, { thermal }) => `<div class="pt-title">${x.status === 'paid' ? 'Tax invoice / receipt' : 'Tax invoice'}</div>${thermal ? `<div style="font-size:11px">${esc(x.invoice_no)} · ${fdt(x.created_at)}<br>${esc(x.patient_name || x.customer_name || '')} ${esc(x.uhid || '')}</div>` : pinfo([['Invoice', x.invoice_no], ['Date', fdt(x.created_at)], ['Type', titleCase(x.bill_type)], ['Patient', x.patient_name || x.customer_name], ['UHID', x.uhid], ['Doctor', x.doctor_name]])}
      <table class="ptable"><thead><tr><th>Description</th><th class="r">Qty</th>${thermal ? '' : '<th class="r">Rate</th>'}<th class="r">Amount</th></tr></thead><tbody>${x.items.map((i) => `<tr><td>${esc(i.description)}</td><td class="r">${i.quantity}</td>${thermal ? '' : `<td class="r">${inr2(i.unit_price)}</td>`}<td class="r">${inr2(i.amount)}</td></tr>`).join('')}</tbody></table>
      <table style="margin-left:auto;min-width:${thermal ? '100%' : '260px'};font-size:12px">${[['Subtotal', x.subtotal], x.discount ? ['Discount', -x.discount] : null, x.tax ? ['GST included', x.tax] : null, ['Total', x.total], ['Paid', x.paid], x.refunded ? ['Refunded', x.refunded] : null, ['Balance', x.balance]].filter(Boolean).map(([k, v]) => `<tr><td>${k}</td><td style="text-align:right;font-weight:${['Total', 'Balance'].includes(k) ? 800 : 500}">${inr2(v)}</td></tr>`).join('')}</table>
      <p style="margin-top:8px;font-size:11px"><b>${toWords(x.total)}</b></p>
      ${x.payments.length ? `<p style="margin-top:6px;font-size:11px">Payments: ${x.payments.map((p) => `${p.receipt_no} ${p.kind === 'refund' ? '(refund) ' : ''}${inr2(p.amount)} ${titleCase(p.method)}`).join('; ')}</p>` : ''}
      <div class="psign"><div>Patient / attendant signature</div><div>Authorised signatory</div></div>`,
  },
  receipt: {
    load: (id) => api.get(`/billing/payments/${id}`),
    title: (x) => `Receipt ${x.receipt_no}`,
    render: (x) => `<div class="pt-title">${x.kind === 'refund' ? 'Refund voucher' : 'Payment receipt'}</div>${pinfo([['Receipt', x.receipt_no], ['Date', fdt(x.created_at)], ['Invoice', x.invoice_no], ['Received from', x.patient_name], ['UHID', x.uhid], ['Mode', titleCase(x.method)]])}
      <div style="font-size:28px;font-weight:800;margin:16px 0">${inr2(x.amount)}</div><p><b>${toWords(x.amount)}</b></p>${x.reference ? `<p>Reference: ${esc(x.reference)}</p>` : ''}${x.note ? `<p>${esc(x.note)}</p>` : ''}<p>Invoice balance after this transaction: <b>${inr2(x.balance)}</b></p>
      <div class="psign"><div></div><div>Received by: ${esc(x.user_name || '')}</div></div>`,
  },
  'opd-slip': {
    load: (id) => api.get(`/opd/visits/${id}`),
    title: (x) => `OPD slip ${x.token}`,
    render: (x, { thermal }) => `<div class="pt-title">OPD slip</div><div style="text-align:center;margin:6px 0 12px"><div style="font-size:11px;letter-spacing:.2em">TOKEN</div><div style="font-size:${thermal ? 44 : 60}px;font-weight:800;line-height:1">${esc(x.token)}</div><div>${esc(x.doctor_name)} · ${esc(x.department || '')}${x.room ? ` · ${esc(x.room)}` : ''}</div></div>
      ${pinfo([['Patient', x.patient_name], ['UHID', x.uhid], ['Age / Sex', `${age(x)} / ${x.gender || ''}`], ['Visit', x.visit_no], ['Registered', fdt(x.registered_at)], ['Type', titleCase(x.visit_type)], x.invoice_no ? ['Consultation fee', `${inr2(x.invoice_total)} (${x.invoice_paid >= x.invoice_total ? 'paid' : 'due'})`] : null])}
      <p style="font-size:11px">Track your token live on the patient portal. Please wait for your token to be called.</p>`,
  },
  lab: {
    load: (id) => api.get(`/lab/orders/${id}`),
    title: (x) => `Lab report ${x.order_no}`,
    render: (x) => `<div class="pt-title">Laboratory report</div>${pinfo([['Patient', x.patient_name], ['UHID', x.uhid], ['Age / Sex', `${age(x)} / ${x.gender || ''}`], ['Order', x.order_no], ['Sample', `${x.sample_type || ''} ${x.sample_id || ''}`], ['Referred by', x.doctor_name || 'Self'], ['Collected', x.collected_at ? fdt(x.collected_at) : '—'], ['Reported', x.completed_at ? fdt(x.completed_at) : '—'], ['Status', titleCase(x.status)]])}
      <h3 style="margin:10px 0 4px">${esc(x.test)}</h3><table class="ptable"><thead><tr><th>Parameter</th><th>Result</th><th>Unit</th><th>Reference range</th></tr></thead><tbody>${x.results.map((r) => `<tr><td>${esc(r.parameter)}</td><td style="font-weight:${r.flag && r.flag !== 'N' ? 800 : 500}">${esc(r.value)} ${r.flag && r.flag !== 'N' ? `(${r.flag === 'C' ? 'Critical' : r.flag === 'H' ? 'High' : 'Low'})` : ''}</td><td>${esc(r.unit || '')}</td><td>${esc(r.ref_range || '')}</td></tr>`).join('')}</tbody></table>
      ${x.remarks ? `<p><b>Remarks:</b> ${esc(x.remarks)}</p>` : ''}${x.status !== 'verified' ? '<p style="color:#b00020"><b>Provisional — not yet verified.</b></p>' : ''}
      <div class="psign"><div>Technician: ${esc(x.technician_name || '')}</div><div>${x.verified_by_name ? `Verified by: <b>${esc(x.verified_by_name)}</b><br>${fdt(x.verified_at)}` : ''}</div></div>`,
  },
  radiology: {
    load: (id) => api.get(`/radiology/orders/${id}`),
    title: (x) => `Radiology report ${x.order_no}`,
    render: (x) => `<div class="pt-title">${esc(x.modality)} report</div>${pinfo([['Patient', x.patient_name], ['UHID', x.uhid], ['Age / Sex', `${age(x)} / ${x.gender || ''}`], ['Order', x.order_no], ['Study', x.study], ['Referred by', x.doctor_name || 'Self'], ['Scanned', x.scanned_at ? fdt(x.scanned_at) : '—'], ['Reported', x.reported_at ? fdt(x.reported_at) : '—']])}
      <h3 style="margin:10px 0 4px">Findings</h3><p style="white-space:pre-wrap">${esc(x.findings || '')}</p><h3 style="margin:12px 0 4px">Impression</h3><p><b>${esc(x.impression || '')}</b></p>
      <div class="psign"><div>Reported by: ${esc(x.reported_by_name || '')}</div><div>${x.verified_by_name ? `Verified by: <b>${esc(x.verified_by_name)}</b>` : 'Provisional report'}</div></div>`,
  },
  registration: {
    load: (id) => api.get(`/patients/${id}`),
    title: (x) => `Registration ${x.uhid}`,
    render: (x) => `<div class="pt-title">Patient registration</div><div style="display:flex;gap:18px;align-items:center;margin-bottom:12px">${x.photo ? `<img src="${esc(x.photo)}" style="width:90px;height:90px;border-radius:12px;object-fit:cover">` : ''}<div><div style="font-size:22px;font-weight:800">${esc(x.full_name)}</div><div style="font-size:18px;font-weight:800;letter-spacing:.04em">UHID ${esc(x.uhid)}</div></div></div>
      ${pinfo([['Date of birth', x.dob ? fdate(x.dob) : '—'], ['Age / Sex', `${age(x)} / ${x.gender}`], ['Blood group', x.blood_group], ['Mobile', x.mobile], ['Email', x.email], ['Marital status', x.marital_status], ['Occupation', x.occupation], ['Address', [x.address, x.city, x.state, x.pincode].filter(Boolean).join(', ')], ['Emergency', [x.emergency_name, x.emergency_relation, x.emergency_phone].filter(Boolean).join(' · ')], ['Guardian', [x.guardian_name, x.guardian_relation].filter(Boolean).join(' · ')], ['Allergies', x.allergies || 'None'], ['Registered', fdt(x.created_at)]])}
      <p style="font-size:11px">Please carry this UHID on every visit. Your records across OPD, pharmacy, lab and IPD are linked to it.</p><div class="psign"><div>Patient signature</div><div>Registered by ${esc(x.registered_by || '')}</div></div>`,
  },
  admission: {
    load: (id) => api.get(`/ipd/admissions/${id}`),
    title: (x) => `Admission ${x.ipd_no}`,
    render: (x) => `<div class="pt-title">IPD admission form</div>${pinfo([['IPD No.', x.ipd_no], ['UHID', x.uhid], ['Patient', x.patient_name], ['Age / Sex', `${age(x)} / ${x.gender}`], ['Mobile', x.mobile], ['Blood group', x.blood_group], ['Admitted', fdt(x.admitted_at)], ['Type', titleCase(x.admission_type)], ['Ward / bed', `${x.ward || ''} · ${x.bed_no || ''}`], ['Consultant', x.doctor_name], ['Department', x.department], ['Expected discharge', x.expected_discharge ? fdate(x.expected_discharge) : '—'], ['Emergency contact', `${x.emergency_name || ''} ${x.emergency_phone || ''}`], ['Allergies', x.allergies || 'None']])}
      <p><b>Reason for admission:</b> ${esc(x.reason || '')}</p><h3 style="margin:14px 0 6px">Consent</h3><p style="font-size:11px">I hereby consent to admission and to such investigations and treatment as may be deemed necessary by the treating doctors. The hospital’s policies on billing, visiting hours and patient rights have been explained to me.</p>
      <div class="psign"><div>Patient / relative signature</div><div>Admitting officer</div></div>`,
  },
  discharge: {
    load: (id) => api.get(`/ipd/admissions/${id}`),
    title: (x) => `Discharge summary ${x.ipd_no}`,
    render: (x) => `<div class="pt-title">Discharge summary</div>${pinfo([['Patient', x.patient_name], ['UHID', x.uhid], ['IPD No.', x.ipd_no], ['Age / Sex', `${age(x)} / ${x.gender}`], ['Consultant', x.doctor_name], ['Department', x.department], ['Admitted', fdt(x.admitted_at)], ['Discharged', x.discharged_at ? fdt(x.discharged_at) : 'Not yet discharged'], ['Discharge type', titleCase(x.discharge_type || '')]])}
      <p><b>Reason for admission:</b> ${esc(x.reason || '')}</p><p><b>Final diagnosis:</b> ${esc(x.final_diagnosis || '')}</p><h3 style="margin:12px 0 4px">Summary of hospital course</h3><p style="white-space:pre-wrap">${esc(x.discharge_summary || '')}</p>
      ${x.medications.length ? `<h3 style="margin:12px 0 4px">Medications during stay</h3><table class="ptable"><tbody>${x.medications.map((m) => `<tr><td>${esc(m.name)} ${esc(m.strength || '')}</td><td>${esc(m.dose)} · ${esc(m.route)} · ${esc(m.frequency)}</td><td>${fdate(m.start_date)} – ${m.end_date ? fdate(m.end_date) : ''}</td></tr>`).join('')}</tbody></table>` : ''}
      ${x.labs.length ? `<p><b>Investigations:</b> ${x.labs.map((l) => esc(l.test)).join(', ')}</p>` : ''}
      <h3 style="margin:12px 0 4px">Advice on discharge</h3><p style="white-space:pre-wrap">${esc(x.discharge_advice || '')}</p>${x.follow_up_date ? `<p><b>Follow-up:</b> ${fdate(x.follow_up_date)}</p>` : ''}
      <div class="psign"><div></div><div style="text-align:center">______________________<br><b>${esc(x.doctor_name)}</b><br>${esc(x.qualification || '')}</div></div>`,
  },
  payslip: {
    load: (id) => api.get(`/payroll/${id}/payslip`),
    title: (x) => `Payslip ${x.emp_code} ${x.month}`,
    render: (x) => `<div class="pt-title">Payslip — ${new Date(`${x.month}-01T00:00:00`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })}</div>${pinfo([['Employee', x.full_name], ['Employee ID', x.emp_code], ['Designation', x.designation], ['Department', x.department], ['Date of joining', x.joining_date ? fdate(x.joining_date) : '—'], ['Bank', `${x.bank_name || ''} ${x.bank_account_last4 ? 'XXXX' + x.bank_account_last4 : ''}`], ['Working days', x.working_days], ['Paid days', x.paid_days], ['LOP days', x.lop_days]])}
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px"><table class="ptable"><thead><tr><th>Earnings</th><th class="r">Amount</th></tr></thead><tbody>${[['Basic', x.basic], ['HRA', x.hra], ['Allowances', x.allowances], ['Bonus', x.bonus], ['Overtime', x.overtime]].map(([k, v]) => `<tr><td>${k}</td><td class="r">${inr2(v)}</td></tr>`).join('')}<tr><th>Gross earnings</th><th class="r">${inr2(x.gross)}</th></tr></tbody></table>
      <table class="ptable"><thead><tr><th>Deductions</th><th class="r">Amount</th></tr></thead><tbody>${[['Provident fund', x.pf], ['ESI', x.esi], ['Professional tax', x.professional_tax], ['Loss of pay', x.lop_deduction], ['Other', x.other_deductions]].map(([k, v]) => `<tr><td>${k}</td><td class="r">${inr2(v)}</td></tr>`).join('')}<tr><th>Total deductions</th><th class="r">${inr2(x.total_deductions)}</th></tr></tbody></table></div>
      <div style="margin-top:12px;padding:10px;border:2px solid #0b2545;border-radius:6px;display:flex;justify-content:space-between"><b>Net pay</b><b style="font-size:18px">${inr2(x.net_pay)}</b></div><p style="font-size:11px;margin-top:6px"><b>${toWords(x.net_pay)}</b> · Status: ${titleCase(x.status)}</p>`,
  },
  report: {
    load: (key, portal, q) => api.get(`/reports/${key}?${q.toString()}`),
    title: (x) => x.title,
    render: (x) => `<div class="pt-title">${esc(x.title)}</div><p style="text-align:center;margin-top:-6px">${fdate(x.filters.from)} – ${fdate(x.filters.to)}</p>
      ${x.summary ? `<div class="pinfo">${x.summary.map((s) => `<div>${esc(s.label)}: <b>${s.type === 'money' ? inr2(s.value) : esc(typeof s.value === 'number' ? num(s.value) : s.value)}</b></div>`).join('')}</div>` : ''}
      <table class="ptable"><thead><tr>${x.columns.map((c) => `<th class="${['int', 'number', 'money', 'pct'].includes(c.type) ? 'r' : ''}">${esc(c.label)}</th>`).join('')}</tr></thead><tbody>${x.rows.map((r) => `<tr>${x.columns.map((c) => `<td class="${['int', 'number', 'money', 'pct'].includes(c.type) ? 'r' : ''}">${c.type === 'money' ? inr2(r[c.key]) : c.type === 'date' && r[c.key] ? fdate(r[c.key]) : esc(r[c.key] ?? '')}</td>`).join('')}</tr>`).join('')}</tbody></table>`,
  },
};
void ftime;
