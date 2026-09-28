import { api } from '../core/api.js';
import { setQuery } from '../core/router.js';
import { icon } from '../core/icons.js';
import { esc, $, fdt, empty, errorState, skeletonRows, debounce, avatar, toast } from '../core/ui.js';
import { page } from '../shell.js';

const TONE = { auth: 'grey', patient: 'blue', prescription: 'violet', billing: 'green', ipd: 'teal', user: 'amber', role: 'amber', settings: 'amber', pharmacy: 'violet', medicine: 'violet', opd: 'blue', lab: 'teal', platform: 'red', backup: 'grey' };

export default async function audit(ctx) {
  const q = ctx.query;
  const el = page({ title: 'Audit log', subtitle: 'Who did what, when — every important action is recorded and cannot be edited from the application.' });
  el.innerHTML = `<div class="panel"><div class="panel-body row wrap" style="gap:10px;padding-bottom:12px">
    <div class="input-icon" style="width:200px">${icon('user')}<input class="input" id="au" placeholder="User" value="${esc(q.user || '')}"></div>
    <div class="input-icon" style="width:220px">${icon('filter')}<input class="input" id="aa" placeholder="Action e.g. patient, refund" value="${esc(q.action || '')}" list="acts"></div>
    <datalist id="acts">${['auth.login', 'auth.login_failed', 'patient.created', 'patient.updated', 'patient.viewed', 'prescription.finalized', 'medicine.updated', 'billing.payment', 'billing.refund', 'billing.discount', 'ipd.admitted', 'ipd.discharged', 'user.permissions_changed', 'role.permissions_changed', 'settings.updated'].map((a) => `<option>${a}</option>`).join('')}</datalist>
    <div class="input-icon grow">${icon('search')}<input class="input" id="ar" placeholder="Reference — UHID, IPD no., invoice, receipt…" value="${esc(q.ref || '')}"></div>
    <input class="input" type="date" id="af" style="width:160px" value="${esc(q.from || '')}"><input class="input" type="date" id="at" style="width:160px" value="${esc(q.to || '')}">
  </div><div id="al">${skeletonRows(10, 5)}</div></div>`;
  const load = async () => {
    const p = { user: $('#au').value.trim(), action: $('#aa').value.trim(), ref: $('#ar').value.trim(), from: $('#af').value, to: $('#at').value };
    setQuery(p);
    try {
      const rows = await api.get(`/audit?${new URLSearchParams(Object.fromEntries(Object.entries(p).filter(([, v]) => v)))}`);
      $('#al').innerHTML = rows.length ? `<div class="table-wrap"><table class="table compact"><thead><tr><th>Time</th><th>User</th><th>Action</th><th>Reference</th><th>Details</th><th>IP</th></tr></thead><tbody>${rows.map((r) => { const k = r.action.split('.')[0]; let det = ''; try { det = r.details ? JSON.stringify(JSON.parse(r.details)) : ''; } catch { det = r.details; } return `<tr><td class="small nowrap">${fdt(r.created_at)}</td><td><div class="row" style="gap:8px">${avatar(r.username || 'system', 'sm')}<span class="strong small">${esc(r.username || 'system')}</span></div></td><td><span class="badge ${TONE[k] || 'grey'} plain mono" style="font-size:11.5px">${esc(r.action)}</span></td><td class="mono small strong">${esc(r.ref || (r.entity ? `${r.entity} #${r.entity_id || ''}` : ''))}</td><td class="small muted" style="max-width:420px;word-break:break-word">${esc(det.length > 220 ? det.slice(0, 220) + '…' : det)}</td><td class="mono xs muted">${esc(r.ip || '')}</td></tr>`; }).join('')}</tbody></table></div><div class="table-foot"><span>${rows.length} entries (latest first)</span></div>` : empty({ title: 'No audit entries match', illo: 'search' });
    } catch (err) { $('#al').innerHTML = errorState(err); }
  };
  const deb = debounce(load, 250);
  ['#au', '#aa', '#ar'].forEach((s) => ($(s).oninput = deb));
  ['#af', '#at'].forEach((s) => ($(s).onchange = load));
  load();
  void toast;
}
