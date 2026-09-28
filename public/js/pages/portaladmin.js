import { api } from '../core/api.js';
import { icon } from '../core/icons.js';
import { esc, $, toast, avatar, ageSex } from '../core/ui.js';
import { patientPicker } from '../core/pickers.js';
import { page, can } from '../shell.js';

export default async function portalAdmin() {
  const el = page({ title: 'Patient portal', subtitle: 'Mobile-first self-service for patients: live tokens, prescriptions, reports, bills and appointments.',
    hero: { img: '/img/patient-care.jpg', eyebrow: 'Patient experience', compact: true }, actions: `<a class="btn btn-primary" href="/portal/login" target="_blank">${icon('external')}Open patient portal</a>` });
  const url = `${location.origin}/portal`;
  el.innerHTML = `<div class="grid g2"><div class="panel"><div class="panel-head"><h3>Give a patient portal access</h3></div><div class="panel-body col gap-12"><input class="input" id="pp" placeholder="Search patient by UHID, name or mobile"><div id="sel"></div></div></div>
    <div class="panel"><div class="panel-head"><h3>What patients see</h3></div><div class="panel-body">${[['ticket', 'Live OPD token', 'Now serving, patients ahead and estimated wait.'], ['pill', 'Pharmacy status', 'Queued → preparing → ready → collected.'], ['file', 'Prescriptions', 'Every finalized prescription, downloadable as PDF.'], ['flask', 'Reports', 'Lab & radiology results after verification only.'], ['receipt', 'Bills', 'Invoices, payments and outstanding balance.'], ['calendar', 'Appointments', 'Book, view and cancel appointments.']].map(([ic, t, d]) => `<div class="row" style="padding:8px 0;align-items:flex-start"><span class="type-ico">${icon(ic)}</span><div><b>${t}</b><div class="small muted">${d}</div></div></div>`).join('')}</div></div></div>
    <div class="callout mt-16">${icon('phone')}<div>Portal address: <b class="mono">${esc(url)}</b> — patients sign in with their UHID or registered mobile and the password you set. Notifications (token, pharmacy ready, reports, reminders) are queued for SMS / WhatsApp / email / push.</div></div>`;
  patientPicker($('#pp'), (p) => {
    const pw = Math.random().toString(36).slice(2, 8) + Math.floor(Math.random() * 90 + 10);
    $('#sel').innerHTML = `<div class="row" style="padding:12px;border:1px solid var(--line);border-radius:14px">${avatar(p.full_name)}<div class="grow"><b>${esc(p.full_name)}</b><div class="small muted">${esc(p.uhid)} · ${esc(ageSex(p))} · ${esc(p.mobile)}</div></div></div><div class="field"><label>Temporary password</label><input class="input mono" id="pw" value="${pw}"></div><button class="btn btn-primary" id="go" ${can('portal', 'edit') || can('patients', 'edit') ? '' : 'disabled'}>${icon('key')}Enable access</button>`;
    $('#go').onclick = async () => { try { await api.post(`/patients/${p.id}/portal`, { password: $('#pw').value }); toast(`Portal enabled for ${p.full_name}`); } catch (err) { toast(err.message, 'error'); } };
  });
}
