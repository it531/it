import { api } from '../core/api.js';
import { navigate, setQuery } from '../core/router.js';
import { icon } from '../core/icons.js';
import { esc, $, $$, fdate, ftime, inr, badge, avatar, empty, errorState, skeletonBlock, toast, modal, countUp, tabs, confirmDialog } from '../core/ui.js';
import { patientPicker, medicinePicker } from '../core/pickers.js';
import { page, can } from '../shell.js';
import { paymentModal } from './billing.js';

export default async function pharmacy(ctx) {
  const el = page({ title: 'Pharmacy', subtitle: 'Prescriptions arrive automatically from OPD and IPD. Dispensing deducts stock (FEFO) and raises the invoice.',
    actions: `<a class="btn btn-secondary" href="/display/pharmacy" target="_blank">${icon('tv')}Token display</a>${can('pharmacy', 'add') ? `<button class="btn btn-secondary" id="counter">${icon('plus')}Counter sale</button>` : ''}<button class="btn btn-primary btn-lg" id="call-next">${icon('skip')}Call next</button>` });
  el.innerHTML = `<div class="tabs" id="tabs"></div><div id="body">${skeletonBlock(400)}</div>`;
  let tab = ctx.query.tab || 'queue';
  tabs($('#tabs'), [['queue', 'Live queue'], ['orders', 'All orders']], tab, (k) => { tab = k; setQuery({ tab: k }); render(); });
  const render = () => (tab === 'queue' ? queue() : orders());

  async function queue() {
    const body = $('#body');
    let q;
    try { q = await api.get('/pharmacy/queue'); } catch (err) { body.innerHTML = errorState(err, 'retry'); $('#retry').onclick = queue; return; }
    if (!ctx.isCurrent() || tab !== 'queue') return;
    const s = q.stats;
    body.innerHTML = `<div class="kpis c4">${[['Pending', s.pending, 'clock'], ['Ready for pickup', q.ready.length, 'checkCircle'], ['Dispensed today', s.dispensed, 'pill'], ['Sales today', s.sales, 'rupee', 'inr']].map(([l, v, ic, f]) => `<div class="kpi"><div class="label">${icon(ic)}${l}</div><div class="value" data-count="${v || 0}" ${f ? `data-fmt="${f}"` : ''}>0</div></div>`).join('')}</div>
      <div class="grid g-main section"><div id="serving"></div>
        <div class="col gap-16">
          <div class="panel"><div class="panel-head"><h3>Waiting (${q.waiting.length})</h3><span class="live-dot">Live</span></div><div class="panel-body col gap-8">${q.waiting.map((o, i) => `<div class="queue-item" style="animation-delay:${i * 0.03}s"><div class="tok">${esc(o.token)}</div><div class="grow"><div class="cell-main truncate">${esc(o.patient_name)}</div><div class="cell-sub">${esc(o.uhid || 'Counter')} · ${o.item_count} item(s) · ${ftime(o.created_at)}</div></div><button class="btn btn-ghost btn-sm" data-open="${o.id}">Serve</button></div>`).join('') || empty({ title: 'No one waiting', text: 'Finalized prescriptions appear here automatically.', illo: 'pill' })}</div></div>
          <div class="panel"><div class="panel-head"><h3>Ready for pickup (${q.ready.length})</h3></div><div class="panel-body col gap-8">${q.ready.map((o) => `<div class="queue-item"><div class="tok" style="background:var(--teal-50);color:var(--teal)">${esc(o.token)}</div><div class="grow"><div class="cell-main truncate">${esc(o.patient_name)}</div><div class="cell-sub">Ready since ${ftime(o.ready_at)}</div></div><button class="btn btn-success btn-sm" data-open="${o.id}">Hand over</button></div>`).join('') || '<p class="small muted">Nothing awaiting pickup.</p>'}</div></div>
          ${q.processing.length > 1 ? `<div class="panel"><div class="panel-head"><h3>Also in process</h3></div><div class="panel-body col gap-8">${q.processing.filter((o) => !q.serving || o.id !== q.serving.id).map((o) => `<div class="queue-item"><div class="tok">${esc(o.token)}</div><div class="grow"><div class="cell-main">${esc(o.patient_name)}</div></div><button class="btn btn-ghost btn-sm" data-open="${o.id}">Open</button></div>`).join('')}</div></div>` : ''}
          <div class="panel"><div class="panel-head"><h3>Dispensed today</h3></div><div class="panel-body flush list">${q.dispensed.slice(-6).reverse().map((o) => `<div class="list-row"><span class="token-pill ghost">${esc(o.token)}</span><div class="grow"><div class="cell-main truncate">${esc(o.patient_name)}</div><div class="cell-sub">${ftime(o.dispensed_at)}</div></div>${badge('dispensed')}</div>`).join('') || '<div class="panel-body small muted">None yet today.</div>'}</div></div>
        </div></div>`;
    countUp(body);
    renderServing(q.serving ? q.serving.id : null);
    $$('[data-open]', body).forEach((b) => (b.onclick = () => renderServing(Number(b.dataset.open))));
  }

  async function renderServing(orderId) {
    const box = $('#serving');
    if (!orderId) { box.innerHTML = `<div class="now-serving" style="min-height:360px"><div class="eyebrow">Now serving</div><div class="token">—</div><div class="who"><span>Press “Call next” to serve the next token.</span></div></div>`; return; }
    box.innerHTML = skeletonBlock(360);
    const o = await api.get(`/pharmacy/orders/${orderId}`);
    const canAct = can('pharmacy', 'edit');
    box.innerHTML = `<div class="now-serving"><div class="row between"><div class="eyebrow">${o.status === 'ready' ? 'Ready for pickup' : 'Now serving'}</div>${badge(o.status)}</div>
      <div class="token flash">${esc(o.token)}</div>
      <div class="who">${esc(o.patient_name || o.customer_name)} <span>· ${esc(o.uhid || 'Counter sale')}${o.doctor_name ? ` · ${esc(o.doctor_name)}` : ''}${o.rx_no ? ` · ${esc(o.rx_no)}` : ''}</span></div></div>
      <div class="panel mt-16"><div class="panel-head"><h3>Medicines</h3><span class="small muted">Order ${esc(o.order_no)} · ${fdate(o.created_at)} ${ftime(o.created_at)}</span></div>
      <table class="table"><thead><tr><th>Medicine</th><th>Directions</th><th class="r">Stock</th><th class="r">Qty</th><th class="r">Amount</th></tr></thead><tbody>
      ${o.items.map((it) => `<tr><td><div class="cell-main">${esc(it.name)} ${esc(it.strength || '')}</div><div class="cell-sub">${esc(it.dosage_form || '')}</div></td><td class="small">${esc([it.dose, it.frequency, it.duration_days ? `${it.duration_days} days` : '', it.instructions].filter(Boolean).join(' · '))}</td>
        <td class="r num"><span class="badge ${it.stock < it.quantity ? 'red' : 'green'} plain">${it.stock}</span></td>
        <td class="r">${o.status === 'dispensed' ? `<b>${it.dispensed_qty}</b>` : `<input class="input input-sm" type="number" min="0" max="${it.quantity}" value="${Math.min(it.quantity, it.stock)}" data-q="${it.id}" style="width:74px;text-align:right" ${canAct ? '' : 'disabled'}>`}</td>
        <td class="r num">${inr((o.status === 'dispensed' ? it.dispensed_qty : Math.min(it.quantity, it.stock)) * it.unit_price, 2)}</td></tr>`).join('')}</tbody></table>
      <div class="panel-body row wrap" style="gap:10px;border-top:1px solid var(--line)">
        ${canAct && ['waiting', 'processing'].includes(o.status) ? `<button class="btn btn-secondary" id="p-ready">${icon('bell')}Ready for pickup</button>` : ''}
        ${canAct && ['processing', 'ready', 'waiting'].includes(o.status) ? `<button class="btn btn-success" id="p-dispense">${icon('checkCircle')}Dispense & complete</button>` : ''}
        ${o.invoice_id ? `<a class="btn btn-secondary" href="/print/invoice/${o.invoice_id}" target="_blank">${icon('printer')}Invoice</a>` : ''}
        ${o.prescription_id ? `<a class="btn btn-ghost" href="/print/prescription/${o.prescription_id}" target="_blank">${icon('file')}Prescription</a>` : ''}
        <span class="grow"></span>${canAct && !['dispensed', 'cancelled'].includes(o.status) ? `<button class="btn btn-danger btn-sm" id="p-cancel">${icon('x')}Cancel</button>` : ''}
      </div></div>
      ${o.items.some((i) => i.stock < i.quantity) && o.status !== 'dispensed' ? `<div class="callout warn mt-12">${icon('alert')}<div>Some medicines are short. Quantities are capped at available stock; the balance can be purchased outside or the order dispensed later.</div></div>` : ''}`;
    const setStatus = async (status, btn, extra = {}) => {
      btn && btn.classList.add('loading');
      try {
        const r = await api.post(`/pharmacy/orders/${o.id}/status`, { status, ...extra });
        if (status === 'dispensed') {
          toast(`${o.token} dispensed — stock updated`, 'success');
          if (r.invoice_id && can('billing', 'add')) {
            const inv = await api.get(`/billing/invoices/${r.invoice_id}`);
            if (inv.balance > 0) paymentModal(inv, () => {});
          }
        } else toast(status === 'ready' ? `${o.token} marked ready — patient notified` : `Order ${status}`);
        queue();
      } catch (err) { toast(err.message, 'error'); btn && btn.classList.remove('loading'); }
    };
    $('#p-ready')?.addEventListener('click', (e) => setStatus('ready', e.currentTarget));
    $('#p-dispense')?.addEventListener('click', (e) => { const quantities = {}; $$('[data-q]', box).forEach((i) => (quantities[i.dataset.q] = Number(i.value))); setStatus('dispensed', e.currentTarget, { quantities }); });
    $('#p-cancel')?.addEventListener('click', async () => { if (await confirmDialog({ title: `Cancel ${o.token}?`, message: 'The order will be removed from the queue. No stock is deducted.', confirm: 'Cancel order', danger: true })) setStatus('cancelled'); });
  }

  async function orders() {
    const body = $('#body'); body.innerHTML = skeletonBlock(300);
    const rows = await api.get('/pharmacy/orders');
    body.innerHTML = `<div class="panel">${rows.length ? `<div class="table-wrap"><table class="table"><thead><tr><th>Token</th><th>Order</th><th>Patient</th><th>Doctor</th><th>Source</th><th>Items</th><th>Created</th><th class="r">Invoice</th><th>Status</th></tr></thead><tbody>${rows.map((o) => `<tr><td><span class="token-pill">${esc(o.token || '—')}</span></td><td class="mono small">${esc(o.order_no)}</td><td><div class="cell-main">${esc(o.patient_name || '')}</div><div class="cell-sub">${esc(o.uhid || '')}</div></td><td class="small">${esc(o.doctor_name || '—')}</td><td>${badge(o.source === 'opd' ? 'new' : o.source, o.source.toUpperCase())}</td><td class="num">${o.item_count}</td><td class="small">${fdate(o.created_at)} ${ftime(o.created_at)}</td><td class="r num">${o.invoice_id ? `<a href="/billing/${o.invoice_id}">${inr(o.invoice_total, 2)}</a>` : '—'}</td><td>${badge(o.status)}</td></tr>`).join('')}</tbody></table></div>` : empty({ title: 'No pharmacy orders yet', illo: 'pill' })}</div>`;
  }

  $('#call-next').onclick = async (e) => {
    e.currentTarget.classList.add('loading');
    try { const n = await api.post('/pharmacy/call-next'); toast(`Now serving ${n.token} — ${n.patient_name}`); tab = 'queue'; $$('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.k === 'queue')); await queue(); renderServing(n.id); }
    catch (err) { toast(err.message, 'info'); } finally { e.currentTarget.classList.remove('loading'); }
  };
  $('#counter')?.addEventListener('click', counterSale);
  await render();
  const t = setInterval(() => { if (!ctx.isCurrent() || !document.body.contains(el)) return clearInterval(t); if (tab === 'queue' && !document.querySelector('.backdrop') && !document.activeElement.matches('input')) queue(); }, 20000);

  function counterSale() {
    const m = modal({ title: 'Counter sale', subtitle: 'Walk-in purchase or patient without an e-prescription. A pharmacy token is issued.', size: 'lg',
      body: `<div class="form-grid"><div class="field s8"><label>Patient (optional)</label><input class="input" id="cs-p" placeholder="Search UHID / name / mobile"></div><div class="field s4"><label>or customer name</label><input class="input" id="cs-name"></div>
        <div class="field s12"><label>Add medicine</label><input class="input" id="cs-med" placeholder="Search medicine"></div><div class="s12" id="cs-lines"></div></div>`,
      foot: `<button class="btn btn-secondary" data-close>Cancel</button><button class="btn btn-primary" id="cs-go">${icon('ticket')}Create order & token</button>` });
    let patient = null; const lines = [];
    patientPicker($('#cs-p', m.el), (p) => { patient = p; $('#cs-p', m.el).value = `${p.full_name} (${p.uhid})`; });
    const paint = () => { $('#cs-lines', m.el).innerHTML = lines.length ? `<table class="table compact"><tbody>${lines.map((l, i) => `<tr><td class="strong">${esc(l.name)} ${esc(l.strength || '')}</td><td class="muted small">${l.stock} in stock</td><td><input class="input input-sm" type="number" min="1" value="${l.quantity}" data-li="${i}" style="width:80px"></td><td class="r num">${inr(l.quantity * l.selling_price, 2)}</td><td><button class="btn btn-ghost btn-sm" data-rm="${i}">${icon('x')}</button></td></tr>`).join('')}</tbody></table>` : '<p class="small muted">No medicines added.</p>'; };
    paint();
    medicinePicker($('#cs-med', m.el), (med) => { lines.push({ ...med, quantity: 10 }); $('#cs-med', m.el).value = ''; paint(); });
    m.el.addEventListener('input', (e) => { if (e.target.dataset.li) { lines[Number(e.target.dataset.li)].quantity = Number(e.target.value); } });
    m.el.addEventListener('click', (e) => { const r = e.target.closest('[data-rm]'); if (r) { lines.splice(Number(r.dataset.rm), 1); paint(); } });
    $('#cs-go', m.el).onclick = async () => {
      try { const r = await api.post('/pharmacy/order', { patient_id: patient ? patient.id : undefined, customer_name: patient ? undefined : $('#cs-name', m.el).value, items: lines.map((l) => ({ medicine_id: l.id, quantity: l.quantity })) }); m.el.remove(); toast(`Token ${r.token} issued`); queue(); }
      catch (err) { toast(err.message, 'error'); }
    };
  }
  void navigate; void avatar;
}
