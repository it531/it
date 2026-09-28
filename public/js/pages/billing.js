import { api } from '../core/api.js';
import { navigate, setQuery } from '../core/router.js';
import { icon } from '../core/icons.js';
import { esc, $, $$, fdate, ftime, fdt, inr, inr2, badge, empty, errorState, skeletonRows, skeletonKpis, toast, modal, countUp, tabs, debounce, confirmDialog, titleCase, formData } from '../core/ui.js';
import { patientPicker, doctors } from '../core/pickers.js';
import { page, can } from '../shell.js';

const METHODS = [['cash', 'Cash'], ['upi', 'UPI'], ['card', 'Card'], ['bank_transfer', 'Bank transfer'], ['other', 'Other']];

export default async function billing(ctx) {
  if (ctx.meta.insurance) return insurance(ctx);
  if (ctx.params.id) return invoice(ctx);
  const el = page({ title: 'Billing', subtitle: 'Centralised billing for OPD, IPD, pharmacy, laboratory, radiology and procedures.',
    actions: can('billing', 'add') ? `<button class="btn btn-primary" id="new-bill">${icon('plus')}New bill</button>` : '' });
  el.innerHTML = `<div id="sum">${skeletonKpis(5)}</div><div class="tabs mt-24" id="tabs"></div><div id="body"></div>`;
  api.get('/billing/summary').then((s) => {
    $('#sum').innerHTML = `<div class="kpis c5">${[['Collected today', s.collected_today, 'wallet', 'inr', 'accent'], ['Billed today', s.billed_today, 'receipt', 'inr'], ['Outstanding', s.outstanding, 'alert', 'inr', s.outstanding ? 'alert' : ''], ['Open invoices', s.open_invoices, 'file'], ['Refunds this month', s.refunds_month, 'refresh', 'inr']].map(([l, v, ic, f, cls]) => `<div class="kpi ${cls || ''}"><div class="label">${icon(ic)}${l}</div><div class="value" data-count="${v || 0}" ${f ? `data-fmt="${f}"` : ''}>0</div></div>`).join('')}</div>
      ${s.modes.length ? `<div class="row wrap mt-12 small muted" style="gap:14px">Today by mode: ${s.modes.map((m) => `<span><b style="color:var(--ink)">${inr(m.amount)}</b> ${esc(titleCase(m.method))}</span>`).join('')}</div>` : ''}`;
    countUp($('#sum'));
  }).catch(() => ($('#sum').innerHTML = ''));
  let tab = ctx.query.tab || 'invoices';
  tabs($('#tabs'), [['invoices', 'Invoices'], ['payments', 'Receipts & refunds']], tab, (k) => { tab = k; setQuery({ tab: k }); render(); });
  const render = () => (tab === 'invoices' ? invoices() : payments());

  async function invoices() {
    const q = ctx.query;
    $('#body').innerHTML = `<div class="panel"><div class="panel-body row wrap" style="gap:10px;padding-bottom:12px">
      <div class="input-icon grow" style="min-width:240px">${icon('search')}<input class="input" id="iq" placeholder="Invoice no., patient, UHID, mobile" value="${esc(q.q || '')}"></div>
      <select class="select" id="ist" style="width:170px"><option value="">All statuses</option>${[['outstanding', 'Outstanding'], ['unpaid', 'Unpaid'], ['partial', 'Partially paid'], ['paid', 'Paid'], ['refunded', 'Refunded'], ['cancelled', 'Cancelled']].map(([v, l]) => `<option value="${v}" ${q.status === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <select class="select" id="ity" style="width:160px"><option value="">All types</option>${['opd', 'ipd', 'pharmacy', 'laboratory', 'radiology', 'procedure', 'package', 'other'].map((t) => `<option value="${t}" ${q.bill_type === t ? 'selected' : ''}>${titleCase(t)}</option>`).join('')}</select>
      <input class="input" type="date" id="ifrom" style="width:160px" value="${esc(q.from || '')}"><input class="input" type="date" id="ito" style="width:160px" value="${esc(q.to || '')}">
    </div><div id="ilist">${skeletonRows(8, 7)}</div></div>`;
    const load = async () => {
      const params = { q: $('#iq').value.trim(), status: $('#ist').value, bill_type: $('#ity').value, from: $('#ifrom').value, to: $('#ito').value };
      setQuery(params); Object.assign(ctx.query, params);
      const rows = await api.get(`/billing/invoices?${new URLSearchParams(Object.fromEntries(Object.entries(params).filter(([, v]) => v)))}`);
      $('#ilist').innerHTML = rows.length ? `<div class="table-wrap"><table class="table"><thead><tr><th>Invoice</th><th>Date</th><th>Patient</th><th>Type</th><th class="r">Total</th><th class="r">Paid</th><th class="r">Balance</th><th>Status</th><th></th></tr></thead><tbody>
        ${rows.map((i) => `<tr class="click" data-href="/billing/${i.id}"><td class="mono strong">${esc(i.invoice_no)}</td><td class="small">${fdate(i.created_at)}<div class="cell-sub">${ftime(i.created_at)}</div></td><td><div class="cell-main">${esc(i.patient_name || '—')}</div><div class="cell-sub">${esc(i.uhid || '')}</div></td><td>${esc(titleCase(i.bill_type))}</td><td class="r num">${inr2(i.total)}</td><td class="r num">${inr2(i.paid)}</td><td class="r num strong" style="${i.balance > 0 ? 'color:var(--red)' : ''}">${inr2(i.balance)}</td><td>${badge(i.status)}</td>
        <td class="r nowrap">${i.balance > 0 && i.status !== 'cancelled' && can('billing', 'add') ? `<button class="btn btn-soft btn-sm" data-pay="${i.id}">${icon('wallet')}Collect</button>` : ''}</td></tr>`).join('')}</tbody></table></div>` : empty({ title: 'No invoices match', text: 'Try widening the filters.', illo: 'search' });
      $$('[data-pay]').forEach((b) => (b.onclick = async (e) => { e.stopPropagation(); const inv = await api.get(`/billing/invoices/${b.dataset.pay}`); paymentModal(inv, () => { load(); }); }));
    };
    const deb = debounce(load, 250);
    $('#iq').oninput = deb;
    ['#ist', '#ity', '#ifrom', '#ito'].forEach((s) => ($(s).onchange = load));
    load().catch((err) => ($('#ilist').innerHTML = errorState(err)));
  }

  async function payments() {
    $('#body').innerHTML = skeletonRows(8, 7);
    const rows = await api.get(`/billing/payments${ctx.query.date ? `?date=${ctx.query.date}` : ''}`);
    $('#body').innerHTML = `<div class="panel">${rows.length ? `<div class="table-wrap"><table class="table"><thead><tr><th>Receipt</th><th>Date</th><th>Invoice</th><th>Patient</th><th>Mode</th><th>Reference</th><th class="r">Amount</th><th>By</th><th></th></tr></thead><tbody>${rows.map((p) => `<tr><td class="mono strong">${esc(p.receipt_no)}</td><td class="small">${fdt(p.created_at)}</td><td class="mono small"><a href="/billing/${p.invoice_id}">${esc(p.invoice_no)}</a></td><td>${esc(p.patient_name || '')}<div class="cell-sub">${esc(p.uhid || '')}</div></td><td>${esc(titleCase(p.method))}</td><td class="small mono">${esc(p.reference || '—')}</td><td class="r num strong" style="color:${p.kind === 'refund' ? 'var(--red)' : 'var(--green)'}">${p.kind === 'refund' ? '−' : ''}${inr2(p.amount)}</td><td class="small">${esc(p.user_name || '')}</td><td><a class="btn btn-ghost btn-sm" href="/print/receipt/${p.id}" target="_blank">${icon('printer')}</a></td></tr>`).join('')}</tbody></table></div>` : empty({ title: 'No receipts yet' })}</div>`;
  }

  $('#new-bill')?.addEventListener('click', () => newBill());
  if (ctx.query.new) { const pid = ctx.query.patient; setQuery({ new: null, patient: null }); newBill(pid); }
  render();
}

// ───────── Payment modal (shared with pharmacy)
export function paymentModal(inv, onDone) {
  const m = modal({ title: `Collect payment · ${inv.invoice_no}`, subtitle: `${esc(inv.patient_name || inv.customer_name || '')} · Balance <b>${inr2(inv.balance)}</b>`, size: 'sm',
    body: `<form class="col gap-16" id="payf"><div class="field"><label>Amount (₹)</label><input class="input" name="amount" type="number" step="0.01" min="0.01" max="${inv.balance}" value="${inv.balance}" style="font-size:22px;font-weight:800;height:52px"><div class="hint">Partial payments are allowed — the balance stays outstanding.</div></div>
      <div class="field"><label>Payment mode</label><div class="seg" id="pm">${METHODS.map(([v, l], i) => `<button type="button" data-k="${v}" class="${i === 0 ? 'on' : ''}">${l}</button>`).join('')}</div></div>
      <div class="field hidden" id="ref-f"><label>Transaction reference</label><input class="input" name="reference" placeholder="UPI ref / card auth / UTR"></div>
      <div class="field"><label>Note</label><input class="input" name="note"></div></form>`,
    foot: `<button class="btn btn-secondary" data-close>Cancel</button><button class="btn btn-success" id="pay-go">${icon('checkCircle')}Record payment</button>` });
  let method = 'cash';
  $('#pm', m.el).onclick = (e) => { const b = e.target.closest('button'); if (!b) return; method = b.dataset.k; $$('#pm button', m.el).forEach((x) => x.classList.toggle('on', x === b)); $('#ref-f', m.el).classList.toggle('hidden', method === 'cash' || method === 'other'); };
  $('#pay-go', m.el).onclick = async (e) => {
    const d = formData($('#payf', m.el));
    e.currentTarget.classList.add('loading');
    try {
      const r = await api.post(`/billing/invoices/${inv.id}/payments`, { amount: Number(d.amount), method, reference: d.reference || undefined, note: d.note || undefined });
      m.el.remove();
      modal({ title: 'Payment recorded', size: 'sm', body: `<div style="text-align:center"><div class="eyebrow">Receipt</div><div class="mono strong" style="font-size:22px">${esc(r.receipt_no)}</div><div style="font-size:36px;font-weight:800;color:var(--green);margin-top:8px">${inr2(Number(d.amount))}</div><div class="small muted">Balance remaining ${inr2(r.invoice.balance)}</div></div>`,
        foot: `<a class="btn btn-secondary" href="/print/receipt/${r.id}" target="_blank">${icon('printer')}Print receipt</a><button class="btn btn-primary" data-close>Done</button>` });
      onDone && onDone(r);
    } catch (err) { toast(err.message, 'error'); e.target.closest('button')?.classList.remove('loading'); }
  };
}

// ───────── New manual bill
async function newBill(patientId) {
  const docs = await doctors();
  const m = modal({ title: 'New bill', subtitle: 'Procedures, packages and other services. OPD/IPD/pharmacy/lab bills are generated automatically.', size: 'lg',
    body: `<div class="form-grid"><div class="field s8"><label>Patient <span class="req">*</span></label><input class="input" id="nb-p" placeholder="Search UHID / name / mobile"></div>
      <div class="field s4"><label>Bill type</label><select class="select" id="nb-type">${['procedure', 'package', 'opd', 'laboratory', 'radiology', 'other'].map((t) => `<option value="${t}">${titleCase(t)}</option>`).join('')}</select></div>
      <div class="field s6"><label>Doctor (optional)</label><select class="select" id="nb-doc"><option value="">—</option>${docs.map((d) => `<option value="${d.id}">${esc(d.name)}</option>`).join('')}</select></div>
      <div class="field s6"><label>Discount (₹)</label><input class="input" id="nb-disc" type="number" min="0" value="0" ${can('billing', 'approve') ? '' : 'disabled title="Requires approval permission"'}></div>
      <div class="s12"><div class="row between mb-8"><b>Items</b><button class="btn btn-soft btn-sm" id="nb-add">${icon('plus')}Add item</button></div><div id="nb-items" class="col gap-8"></div><div class="row mt-12" style="justify-content:flex-end;font-size:18px">Total&nbsp;<b id="nb-total">₹0</b></div></div></div>`,
    foot: `<button class="btn btn-secondary" data-close>Cancel</button><button class="btn btn-primary" id="nb-go">${icon('receipt')}Create invoice</button>` });
  let patient = null;
  const items = [{ description: '', quantity: 1, unit_price: 0 }];
  const presets = ['Dressing', 'Injection charges', 'Nebulisation', 'ECG', 'Minor procedure', 'Physiotherapy session', 'Health check-up package', 'Medical certificate'];
  const paint = () => {
    $('#nb-items', m.el).innerHTML = items.map((it, i) => `<div class="row" style="gap:8px"><input class="input grow" data-k="description" data-i="${i}" value="${esc(it.description)}" placeholder="Description" list="nb-pre"><input class="input" style="width:80px" type="number" min="1" data-k="quantity" data-i="${i}" value="${it.quantity}"><input class="input" style="width:120px" type="number" min="0" data-k="unit_price" data-i="${i}" value="${it.unit_price}" placeholder="Rate"><button class="btn btn-ghost btn-icon" data-rm="${i}">${icon('x')}</button></div>`).join('') + `<datalist id="nb-pre">${presets.map((p) => `<option>${p}</option>`).join('')}</datalist>`;
    total();
  };
  const total = () => { const t = items.reduce((s, i) => s + i.quantity * i.unit_price, 0) - Number($('#nb-disc', m.el).value || 0); $('#nb-total', m.el).textContent = inr2(Math.max(0, t)); };
  paint();
  m.el.addEventListener('input', (e) => { if (e.target.dataset.i !== undefined) { const it = items[Number(e.target.dataset.i)]; it[e.target.dataset.k] = e.target.dataset.k === 'description' ? e.target.value : Number(e.target.value); } total(); });
  m.el.addEventListener('click', (e) => { const r = e.target.closest('[data-rm]'); if (r && items.length > 1) { items.splice(Number(r.dataset.rm), 1); paint(); } });
  $('#nb-add', m.el).onclick = () => { items.push({ description: '', quantity: 1, unit_price: 0 }); paint(); };
  patientPicker($('#nb-p', m.el), (p) => { patient = p; $('#nb-p', m.el).value = `${p.full_name} · ${p.uhid}`; });
  if (patientId) api.get(`/patients/${patientId}`).then((p) => { patient = p; $('#nb-p', m.el).value = `${p.full_name} · ${p.uhid}`; });
  $('#nb-go', m.el).onclick = async () => {
    if (!patient) return toast('Select a patient', 'error');
    try { const r = await api.post('/billing/invoices', { patient_id: patient.id, bill_type: $('#nb-type', m.el).value, doctor_id: $('#nb-doc', m.el).value || undefined, discount: Number($('#nb-disc', m.el).value) || 0, items: items.filter((i) => i.description) }); m.el.remove(); toast(`Invoice ${r.invoice_no} created`); navigate(`/billing/${r.id}`); }
    catch (err) { toast(err.message, 'error'); }
  };
}

// ───────── Invoice detail
async function invoice(ctx) {
  const el = page({ title: 'Invoice', crumbs: [['/billing', 'Billing'], [null, 'Invoice']] });
  el.innerHTML = skeletonRows(6, 4);
  let inv;
  try { inv = await api.get(`/billing/invoices/${ctx.params.id}`); } catch (err) { el.innerHTML = errorState(err); return; }
  $('.page-head h1').textContent = inv.invoice_no;
  const active = inv.status !== 'cancelled';
  $('.page-head').insertAdjacentHTML('beforeend', `<div class="actions">
    ${inv.balance > 0 && active && can('billing', 'add') ? `<button class="btn btn-success" id="pay">${icon('wallet')}Collect ${inr2(inv.balance)}</button>` : ''}
    <a class="btn btn-secondary" href="/print/invoice/${inv.id}" target="_blank">${icon('printer')}Print A4</a><a class="btn btn-secondary" href="/print/invoice/${inv.id}?paper=thermal" target="_blank">${icon('printer')}Thermal</a>
    ${can('billing', 'approve') && active ? `<button class="btn btn-secondary btn-icon" id="more">${icon('moreH')}</button>` : ''}</div>`);
  el.innerHTML = `<div class="grid g-side">
    <div class="panel"><div class="panel-body row wrap between" style="gap:20px"><div><div class="eyebrow">Billed to</div><h3 class="mt-4">${esc(inv.patient_name || inv.customer_name || '—')}</h3><div class="small muted">${esc(inv.uhid || '')} ${inv.mobile ? `· ${esc(inv.mobile)}` : ''}</div>${inv.patient_id ? `<a class="small strong" href="/patients/${inv.patient_id}">Open patient profile</a>` : ''}</div>
      <div><div class="eyebrow">Details</div><div class="small mt-4">${esc(titleCase(inv.bill_type))} bill · ${fdt(inv.created_at)}</div><div class="small">${esc(inv.doctor_name || '')} ${inv.department_name ? `· ${esc(inv.department_name)}` : ''}</div></div><div>${badge(inv.status)}</div></div>
      <table class="table"><thead><tr><th>#</th><th>Description</th><th>Category</th><th class="r">Qty</th><th class="r">Rate</th><th class="r">Amount</th></tr></thead><tbody>${inv.items.map((it, i) => `<tr><td class="muted">${i + 1}</td><td class="strong">${esc(it.description)}</td><td class="small">${esc(titleCase(it.category))}</td><td class="r num">${it.quantity}</td><td class="r num">${inr2(it.unit_price)}</td><td class="r num strong">${inr2(it.amount)}</td></tr>`).join('')}</tbody></table>
      <div class="panel-body" style="border-top:1px solid var(--line)"><div style="max-width:320px;margin-left:auto">
        <div class="stat-line"><span class="muted">Subtotal</span><b>${inr2(inv.subtotal)}</b></div>${inv.discount ? `<div class="stat-line"><span class="muted">Discount</span><b style="color:var(--green)">−${inr2(inv.discount)}</b></div>` : ''}${inv.tax ? `<div class="stat-line"><span class="muted">GST included</span><b>${inr2(inv.tax)}</b></div>` : ''}
        <div class="stat-line" style="font-size:17px"><span class="strong">Total</span><b>${inr2(inv.total)}</b></div><div class="stat-line"><span class="muted">Paid</span><b style="color:var(--green)">${inr2(inv.paid)}</b></div>${inv.refunded ? `<div class="stat-line"><span class="muted">Refunded</span><b style="color:var(--violet)">${inr2(inv.refunded)}</b></div>` : ''}
        <div class="stat-line" style="font-size:17px"><span class="strong">Balance</span><b style="color:${inv.balance > 0 ? 'var(--red)' : 'var(--green)'}">${inr2(inv.balance)}</b></div></div>
        ${inv.notes ? `<div class="small muted mt-12">${esc(inv.notes)}</div>` : ''}</div></div>
    <div class="panel"><div class="panel-head"><h3>Payments</h3></div><div class="panel-body flush list">${inv.payments.length ? inv.payments.map((p) => `<div class="list-row"><div class="grow"><div class="cell-main">${p.kind === 'refund' ? 'Refund' : 'Payment'} · ${esc(titleCase(p.method))}</div><div class="cell-sub">${esc(p.receipt_no)} · ${fdt(p.created_at)} · ${esc(p.user_name || '')}${p.reference ? ` · ${esc(p.reference)}` : ''}</div>${p.note ? `<div class="cell-sub">${esc(p.note)}</div>` : ''}</div><b class="num" style="color:${p.kind === 'refund' ? 'var(--red)' : 'var(--green)'}">${p.kind === 'refund' ? '−' : ''}${inr2(p.amount)}</b><a class="btn btn-ghost btn-sm" href="/print/receipt/${p.id}" target="_blank">${icon('printer')}</a></div>`).join('') : `<div class="panel-body">${empty({ title: 'No payments yet', text: 'Record full or partial payment by cash, UPI, card or bank transfer.' })}</div>`}</div>
      ${inv.insurance_claim_status && inv.insurance_claim_status !== 'none' ? `<div class="panel-body" style="border-top:1px solid var(--line)"><div class="small"><b>Insurance claim</b> ${badge(inv.insurance_claim_status)} ${inr2(inv.insurance_claim_amount)}</div></div>` : ''}</div>
  </div>`;
  $('#pay')?.addEventListener('click', () => paymentModal(inv, () => invoice(ctx)));
  $('#more')?.addEventListener('click', (e) => {
    import('../core/ui.js').then(({ dropdown }) => {
      const d = dropdown(e.currentTarget, `<div class="item" data-a="discount">${icon('rupee')}Apply discount</div>${inv.paid - inv.refunded > 0 ? `<div class="item" data-a="refund">${icon('refresh')}Refund</div>` : ''}${can('insurance', 'edit') || can('billing', 'approve') ? `<div class="item" data-a="ins">${icon('umbrella')}Insurance claim</div>` : ''}${inv.paid - inv.refunded <= 0 ? `<div class="sep"></div><div class="item" data-a="cancel" style="color:var(--red)">${icon('x')}Cancel invoice</div>` : ''}`);
      d.onclick = async (ev) => {
        const a = ev.target.closest('.item')?.dataset.a; d.remove();
        if (a === 'discount') { const reason = await confirmDialog({ title: 'Apply discount', message: `Invoice subtotal ${inr2(inv.subtotal)}. Enter the reason; you will be asked for the amount next.`, input: 'Reason for discount', confirm: 'Next' }); if (!reason) return; const amt = await confirmDialog({ title: 'Discount amount', message: 'Enter amount in ₹', input: 'Amount (₹)', confirm: 'Apply' }); if (!amt) return; try { await api.post(`/billing/invoices/${inv.id}/discount`, { discount: Number(amt), reason }); toast('Discount applied'); invoice(ctx); } catch (err) { toast(err.message, 'error'); } }
        if (a === 'refund') refundModal(inv, () => invoice(ctx));
        if (a === 'cancel') { const reason = await confirmDialog({ title: 'Cancel invoice?', message: 'Cancelled invoices are excluded from revenue. This is audited.', input: 'Reason', confirm: 'Cancel invoice', danger: true }); if (!reason) return; try { await api.post(`/billing/invoices/${inv.id}/cancel`, { reason }); toast('Invoice cancelled'); invoice(ctx); } catch (err) { toast(err.message, 'error'); } }
        if (a === 'ins') insuranceModal(inv, () => invoice(ctx));
      };
    });
  });
}

function refundModal(inv, done) {
  const max = inv.paid - inv.refunded;
  const m = modal({ title: 'Issue refund', subtitle: `Refundable ${inr2(max)}`, size: 'sm', body: `<form class="col gap-12" id="rf"><div class="field"><label>Amount</label><input class="input" name="amount" type="number" step="0.01" max="${max}" value="${max}"></div><div class="field"><label>Mode</label><select class="select" name="method">${METHODS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select></div><div class="field"><label>Reason <span class="req">*</span></label><input class="input" name="reason" required></div></form>`,
    foot: `<button class="btn btn-secondary" data-close>Cancel</button><button class="btn btn-danger" id="rf-go">Refund</button>` });
  $('#rf-go', m.el).onclick = async () => { const d = formData($('#rf', m.el)); try { await api.post(`/billing/invoices/${inv.id}/refund`, { ...d, amount: Number(d.amount) }); toast('Refund recorded'); m.el.remove(); done(); } catch (err) { toast(err.message, 'error'); } };
}
function insuranceModal(inv, done) {
  const m = modal({ title: 'Insurance claim', size: 'sm', body: `<form class="col gap-12" id="insf"><div class="field"><label>Claim amount</label><input class="input" name="insurance_claim_amount" type="number" value="${inv.insurance_claim_amount || inv.total}"></div><div class="field"><label>Status</label><select class="select" name="insurance_claim_status">${['none', 'submitted', 'approved', 'rejected', 'settled'].map((s) => `<option ${s === inv.insurance_claim_status ? 'selected' : ''}>${s}</option>`).join('')}</select></div></form>`,
    foot: `<button class="btn btn-secondary" data-close>Cancel</button><button class="btn btn-primary" id="ins-go">Save</button>` });
  $('#ins-go', m.el).onclick = async () => { const d = formData($('#insf', m.el)); try { await api.post(`/billing/invoices/${inv.id}/insurance`, { insurance_claim_amount: Number(d.insurance_claim_amount), insurance_claim_status: d.insurance_claim_status }); toast('Claim updated'); m.el.remove(); done(); } catch (err) { toast(err.message, 'error'); } };
}

async function insurance(ctx) {
  const el = page({ title: 'Insurance', subtitle: 'Track TPA / insurer claims raised against invoices.' });
  el.innerHTML = skeletonRows(6, 6);
  const rows = await api.get('/insurance/claims');
  el.innerHTML = `<div class="panel">${rows.length ? `<table class="table"><thead><tr><th>Invoice</th><th>Patient</th><th>Insurer / policy</th><th>Type</th><th class="r">Invoice total</th><th class="r">Claim</th><th>Status</th><th></th></tr></thead><tbody>${rows.map((r) => `<tr><td class="mono strong"><a href="/billing/${r.id}">${esc(r.invoice_no)}</a></td><td>${esc(r.patient_name)}<div class="cell-sub">${esc(r.uhid)}</div></td><td>${esc(r.insurance_provider || '—')}<div class="cell-sub">${esc(r.insurance_policy_no || '')}</div></td><td>${esc(titleCase(r.bill_type))}</td><td class="r num">${inr2(r.total)}</td><td class="r num">${inr2(r.insurance_claim_amount || 0)}</td><td>${badge(r.insurance_claim_status || 'pending', r.insurance_claim_status ? undefined : 'Not raised')}</td><td>${can('insurance', 'edit') || can('billing', 'approve') ? `<button class="btn btn-ghost btn-sm" data-ins="${r.id}">${icon('edit')}</button>` : ''}</td></tr>`).join('')}</tbody></table>` : empty({ title: 'No insurance claims yet', text: 'IPD bills for insured patients and invoices with claims appear here.' })}</div>`;
  $$('[data-ins]', el).forEach((b) => (b.onclick = async () => insuranceModal(await api.get(`/billing/invoices/${b.dataset.ins}`), () => insurance(ctx))));
}
