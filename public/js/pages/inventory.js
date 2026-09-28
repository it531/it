import { api } from '../core/api.js';
import { navigate, setQuery } from '../core/router.js';
import { icon } from '../core/icons.js';
import { esc, $, $$, fdate, fdt, inr, inr2, num, badge, empty, errorState, skeletonRows, skeletonKpis, toast, modal, countUp, tabs, debounce, formData, showErrors, field, select, titleCase, todayISO, addDaysISO } from '../core/ui.js';
import { medicinePicker, departments } from '../core/pickers.js';
import { page, can } from '../shell.js';

export default async function inventory(ctx) {
  if (ctx.params.id) return medicineDetail(ctx);
  const el = page({ title: 'Inventory', subtitle: 'Medicines with batch & expiry tracking, equipment, consumables, surgical and general stores.',
    actions: `${can('inventory', 'add') ? `<button class="btn btn-secondary" id="new-po">${icon('truck')}Purchase order</button><button class="btn btn-primary" id="new-med">${icon('plus')}Add medicine</button>` : ''}` });
  el.innerHTML = `<div id="ov">${skeletonKpis(6)}</div><div class="tabs mt-24" id="tabs"></div><div id="body"></div>`;
  let ov;
  const loadOv = async () => {
    ov = await api.get('/inventory/overview');
    const s = ov.stats;
    $('#ov').innerHTML = `<div class="kpis c6">${[['Medicines', s.medicines, 'pill'], ['Stock value', s.stock_value, 'rupee', 'cinr'], ['Low stock', s.low_stock, 'alert', null, s.low_stock ? 'alert' : ''], ['Expiring ≤60 d', s.expiring, 'clock'], ['Expired batches', s.expired, 'x', null, s.expired ? 'alert' : ''], ['Open POs', s.open_pos, 'truck']].map(([l, v, ic, f, c]) => `<div class="kpi ${c || ''}"><div class="label">${icon(ic)}${l}</div><div class="value" data-count="${v || 0}" ${f ? `data-fmt="${f}"` : ''}>0</div></div>`).join('')}</div>`;
    countUp($('#ov'));
  };
  let tab = ctx.query.tab || 'medicines';
  tabs($('#tabs'), [['medicines', 'Medicines'], ['alerts', 'Alerts'], ['expiry', 'Expiry'], ['items', 'Equipment & consumables'], ['po', 'Purchase & GRN'], ['suppliers', 'Suppliers'], ['movements', 'Stock movements']], tab, (k) => { tab = k; setQuery({ tab: k }); render(); });
  const render = async () => {
    const body = $('#body'); body.innerHTML = skeletonRows(8, 6);
    try {
      if (!ov) await loadOv();
      if (tab === 'medicines') return medicines(body);
      if (tab === 'alerts') return alerts(body);
      if (tab === 'expiry') return expiry(body);
      if (tab === 'items') return items(body);
      if (tab === 'po') return pos(body);
      if (tab === 'suppliers') return suppliers(body);
      if (tab === 'movements') return movements(body);
    } catch (err) { body.innerHTML = errorState(err); }
  };

  async function medicines(body) {
    body.innerHTML = `<div class="panel"><div class="panel-body" style="padding-bottom:12px"><div class="input-icon">${icon('search')}<input class="input" id="mq" placeholder="Search by brand, generic name or category"></div></div><div id="ml"></div></div>`;
    const load = async () => {
      const q = $('#mq').value.trim();
      const rows = await api.get(`/medicines?all=1${q ? `&q=${encodeURIComponent(q)}` : ''}`);
      $('#ml').innerHTML = rows.length ? `<div class="table-wrap"><table class="table"><thead><tr><th>Medicine</th><th>Category</th><th>Form</th><th class="r">MRP</th><th class="r">Stock</th><th>Next expiry</th><th>Supplier</th><th></th></tr></thead><tbody>${rows.map((m) => `<tr class="click" data-href="/inventory/medicine/${m.id}"><td><div class="cell-main">${esc(m.name)} <span class="muted">${esc(m.strength || '')}</span></div><div class="cell-sub">${esc(m.generic_name || '')} · ${esc(m.brand || '')}</div></td><td class="small">${esc(m.category || '')}</td><td class="small">${esc(m.dosage_form || '')}</td><td class="r num">${inr2(m.selling_price)}</td><td class="r"><span class="badge ${m.stock <= 0 ? 'red' : m.stock < m.min_stock ? 'amber' : 'green'} plain">${num(m.stock)}</span><div class="cell-sub">min ${m.min_stock}</div></td><td class="small">${m.next_expiry ? fdate(m.next_expiry) : '—'}</td><td class="small">${esc(m.supplier_name || '—')}</td><td>${m.is_active ? '' : badge('inactive')}</td></tr>`).join('')}</tbody></table></div>` : empty({ title: 'No medicines found', illo: 'pill' });
    };
    $('#mq').oninput = debounce(load, 220);
    load();
  }
  function alerts(body) {
    body.innerHTML = `<div class="grid g2"><div class="panel"><div class="panel-head"><h3>Below minimum stock</h3>${badge('pending', `${ov.low_stock.length + ov.items_low.length}`)}</div><div class="panel-body flush list">${[...ov.low_stock.map((m) => `<div class="list-row"><div class="grow"><div class="cell-main">${esc(m.name)} ${esc(m.strength || '')}</div><div class="cell-sub">Stock ${m.stock} · minimum ${m.min_stock} · shortfall ${m.min_stock - m.stock}</div></div><div class="progress" style="width:90px"><i style="width:${Math.min(100, (m.stock / Math.max(m.min_stock, 1)) * 100)}%;background:${m.stock === 0 ? 'var(--red)' : 'var(--amber)'}"></i></div>${can('inventory', 'add') ? `<button class="btn btn-soft btn-sm" data-reorder="${m.id}" data-q="${Math.max(m.min_stock * 4 - m.stock, m.min_stock)}" data-c="${m.purchase_price}">${icon('truck')}Reorder</button>` : ''}</div>`), ...ov.items_low.map((i) => `<div class="list-row"><div class="grow"><div class="cell-main">${esc(i.name)}</div><div class="cell-sub">${esc(titleCase(i.category))} · stock ${i.stock} ${esc(i.unit || '')} · minimum ${i.min_stock}</div></div><span class="badge amber">Low</span></div>`)].join('') || `<div class="panel-body">${empty({ title: 'All stock above minimum', illo: 'pill' })}</div>`}</div></div>
      <div class="panel"><div class="panel-head"><h3>Expiry alerts</h3>${badge('pending', `${ov.expiring.length}`)}</div><div class="panel-body flush list">${ov.expiring.map((b) => `<div class="list-row"><div class="grow"><div class="cell-main">${esc(b.name)} ${esc(b.strength || '')}</div><div class="cell-sub">Batch ${esc(b.batch_no)} · ${b.qty} units · expiry ${fdate(b.expiry_date)}</div></div>${b.days_left < 0 ? '<span class="badge red">Expired</span>' : `<span class="badge ${b.days_left <= 30 ? 'amber' : 'violet'}">${b.days_left} days</span>`}</div>`).join('') || `<div class="panel-body">${empty({ title: 'No expiries in the next 60 days' })}</div>`}</div></div></div>`;
    $$('[data-reorder]', body).forEach((b) => (b.onclick = () => poModal([{ item_type: 'medicine', medicine_id: Number(b.dataset.reorder), quantity: Number(b.dataset.q), unit_cost: Number(b.dataset.c) }])));
  }
  async function expiry(body) {
    const r = await api.get('/reports/pharmacy_expiry');
    body.innerHTML = `<div class="panel">${r.rows.length ? `<table class="table"><thead><tr>${r.columns.map((c) => `<th class="${['int', 'money'].includes(c.type) ? 'r' : ''}">${esc(c.label)}</th>`).join('')}<th></th></tr></thead><tbody>${r.rows.map((x) => `<tr><td class="strong">${esc(x.name)}</td><td>${esc(x.strength || '')}</td><td class="mono small">${esc(x.batch_no)}</td><td>${fdate(x.expiry_date)}</td><td class="r"><span class="badge ${x.days_left < 0 ? 'red' : x.days_left <= 30 ? 'amber' : 'violet'} plain">${x.days_left}</span></td><td class="r num">${x.qty}</td><td class="r num">${inr2(x.value)}</td><td></td></tr>`).join('')}</tbody></table>` : empty({ title: 'No batches expiring within 90 days' })}</div>`;
  }
  async function items(body) {
    const rows = await api.get('/inventory/items');
    const deps = await departments();
    body.innerHTML = `<div class="panel"><div class="panel-head"><h3>General inventory</h3>${can('inventory', 'add') ? `<button class="btn btn-soft btn-sm" id="add-item">${icon('plus')}Add item</button>` : ''}</div><div class="panel-body flush">${rows.length ? `<table class="table"><thead><tr><th>Code</th><th>Item</th><th>Category</th><th>Location</th><th class="r">Stock</th><th class="r">Unit cost</th><th></th></tr></thead><tbody>${rows.map((i) => `<tr><td class="mono small">${esc(i.code || '')}</td><td class="strong">${esc(i.name)}</td><td>${badge(i.category === 'equipment' ? 'confirmed' : i.category === 'surgical' ? 'reported' : i.category === 'consumable' ? 'booked' : 'draft', titleCase(i.category))}</td><td class="small">${esc(i.location || '')}</td><td class="r"><span class="badge ${i.stock < i.min_stock ? 'amber' : 'green'} plain">${num(i.stock)} ${esc(i.unit || '')}</span></td><td class="r num">${inr2(i.unit_cost)}</td><td class="r">${can('inventory', 'edit') ? `<button class="btn btn-ghost btn-sm" data-issue="${i.id}">${icon('arrowRight')}Issue / adjust</button>` : ''}</td></tr>`).join('')}</tbody></table>` : empty({ title: 'No items yet' })}</div></div>`;
    $('#add-item')?.addEventListener('click', () => {
      const m = modal({ title: 'Add inventory item', size: 'lg', body: `<form class="form-grid" id="itf">${field('Code', '<input class="input" name="code">', { cls: 's3' })}${field('Name', '<input class="input" name="name">', { req: true, cls: 's6' })}${field('Category', select('category', [['equipment', 'Equipment'], ['consumable', 'Consumable'], ['surgical', 'Surgical'], ['general', 'General']], 'consumable', { blank: null }), { cls: 's3' })}${field('Unit', '<input class="input" name="unit" value="pcs">', { cls: 's3' })}${field('Opening stock', '<input class="input" type="number" name="stock" value="0">', { cls: 's3' })}${field('Minimum stock', '<input class="input" type="number" name="min_stock" value="0">', { cls: 's3' })}${field('Unit cost ₹', '<input class="input" type="number" name="unit_cost" value="0">', { cls: 's3' })}${field('Location', '<input class="input" name="location" value="Main Store">', { cls: 's6' })}</form>`, foot: '<button class="btn btn-secondary" data-close>Cancel</button><button class="btn btn-primary" id="itg">Save</button>' });
      $('#itg', m.el).onclick = async () => { const f = $('#itf', m.el); try { await api.post('/inventory/items', formData(f)); toast('Item added'); m.el.remove(); items(body); } catch (err) { showErrors(f, err); toast(err.message, 'error'); } };
    });
    $$('[data-issue]', body).forEach((b) => (b.onclick = () => {
      const it = rows.find((x) => String(x.id) === b.dataset.issue);
      const m = modal({ title: `Stock movement · ${it.name}`, subtitle: `Current stock ${it.stock} ${it.unit || ''}`, size: 'sm', body: `<form class="col gap-12" id="mvf">${field('Movement', select('movement', [['issue', 'Issue to department'], ['transfer', 'Transfer'], ['adjustment', 'Adjustment (+/−)'], ['return', 'Return to store']], 'issue', { blank: null }))}${field('Quantity', '<input class="input" type="number" name="qty" value="1">', { hint: 'For adjustments use negative numbers to reduce.' })}${field('Department', select('to_department_id', deps.map((d) => [d.id, d.name]), ''))}${field('Note', '<input class="input" name="note">', { req: true })}</form>`, foot: '<button class="btn btn-secondary" data-close>Cancel</button><button class="btn btn-primary" id="mvg">Save</button>' });
      $('#mvg', m.el).onclick = async () => { const d = formData($('#mvf', m.el)); try { await api.post('/inventory/movement', { item_type: 'item', item_id: it.id, movement: d.movement, qty: Number(d.qty), to_department_id: d.to_department_id ? Number(d.to_department_id) : undefined, note: d.note }); toast('Stock updated'); m.el.remove(); items(body); } catch (err) { toast(err.message, 'error'); } };
    }));
  }
  async function pos(body) {
    const rows = await api.get('/purchase-orders');
    body.innerHTML = `<div class="panel">${rows.length ? `<table class="table"><thead><tr><th>PO</th><th>Supplier</th><th>Created</th><th class="r">Items</th><th class="r">Value</th><th>GRN</th><th>Status</th><th></th></tr></thead><tbody>${rows.map((p) => `<tr><td class="mono strong">${esc(p.po_no)}</td><td>${esc(p.supplier_name)}</td><td class="small">${fdate(p.created_at)}<div class="cell-sub">${esc(p.created_by_name || '')}</div></td><td class="r num">${p.items}</td><td class="r num">${inr2(p.total)}</td><td class="mono small">${esc(p.grn_no || '—')}${p.received_at ? `<div class="cell-sub">${fdate(p.received_at)}</div>` : ''}</td><td>${badge(p.status)}</td><td class="r nowrap">${p.status === 'ordered' && can('inventory', 'edit') ? `<button class="btn btn-success btn-sm" data-grn="${p.id}">${icon('check')}Receive (GRN)</button><button class="btn btn-ghost btn-sm" data-cancel="${p.id}">${icon('x')}</button>` : ''}</td></tr>`).join('')}</tbody></table>` : empty({ title: 'No purchase orders yet', action: can('inventory', 'add') ? `<button class="btn btn-primary" id="po-e">${icon('plus')}Create purchase order</button>` : '' })}</div>`;
    $('#po-e')?.addEventListener('click', () => poModal());
    $$('[data-cancel]', body).forEach((b) => (b.onclick = async () => { try { await api.post(`/purchase-orders/${b.dataset.cancel}/cancel`); toast('PO cancelled'); pos(body); } catch (err) { toast(err.message, 'error'); } }));
    $$('[data-grn]', body).forEach((b) => (b.onclick = async () => {
      const po = await api.get(`/purchase-orders/${b.dataset.grn}`);
      const m = modal({ title: `Goods receipt · ${po.po_no}`, subtitle: `${esc(po.supplier_name)} — enter batch number and expiry for every medicine`, size: 'lg', body: `<table class="table"><thead><tr><th>Item</th><th class="r">Qty</th><th>Batch no.</th><th>Expiry</th><th>MRP</th></tr></thead><tbody>${po.items.map((i) => `<tr><td class="strong">${esc(i.item_name)}</td><td class="r num">${i.quantity}</td>${i.item_type === 'medicine' ? `<td><input class="input input-sm" data-b="${i.id}" placeholder="Batch" style="width:130px"></td><td><input class="input input-sm" type="date" data-e="${i.id}" min="${addDaysISO(todayISO(), 1)}" value="${addDaysISO(todayISO(), 540)}"></td><td><input class="input input-sm" type="number" data-m="${i.id}" style="width:90px" placeholder="MRP"></td>` : '<td colspan="3" class="muted small">General item — stock is added directly</td>'}</tr>`).join('')}</tbody></table>`,
        foot: `<button class="btn btn-secondary" data-close>Cancel</button><button class="btn btn-success" id="grn-go">${icon('check')}Post GRN & add stock</button>` });
      $('#grn-go', m.el).onclick = async () => {
        const lines = {}; for (const i of po.items) if (i.item_type === 'medicine') lines[i.id] = { batch_no: $(`[data-b="${i.id}"]`, m.el).value, expiry_date: $(`[data-e="${i.id}"]`, m.el).value, mrp: Number($(`[data-m="${i.id}"]`, m.el).value) || undefined };
        try { const r = await api.post(`/purchase-orders/${po.id}/receive`, { lines }); toast(`${r.grn_no} posted — stock updated`); m.el.remove(); ov = null; await loadOv(); pos(body); } catch (err) { toast(err.message, 'error'); }
      };
    }));
  }
  async function suppliers(body) {
    const rows = await api.get('/suppliers');
    body.innerHTML = `<div class="panel"><div class="panel-head"><h3>Suppliers</h3>${can('inventory', 'add') ? `<button class="btn btn-soft btn-sm" id="add-sup">${icon('plus')}Add supplier</button>` : ''}</div><div class="panel-body flush"><table class="table"><thead><tr><th>Supplier</th><th>Contact</th><th>GSTIN</th><th class="r">POs</th><th class="r">Purchased</th></tr></thead><tbody>${rows.map((s) => `<tr><td><div class="cell-main">${esc(s.name)}</div><div class="cell-sub">${esc(s.address || '')}</div></td><td class="small">${esc(s.contact_person || '')}<div class="cell-sub">${esc(s.phone || '')} · ${esc(s.email || '')}</div></td><td class="mono small">${esc(s.gstin || '')}</td><td class="r num">${s.pos}</td><td class="r num">${inr(s.purchased)}</td></tr>`).join('')}</tbody></table></div></div>`;
    $('#add-sup')?.addEventListener('click', () => {
      const m = modal({ title: 'Add supplier', body: `<form class="form-grid" id="sf">${field('Name', '<input class="input" name="name">', { req: true, cls: 's12' })}${field('Contact person', '<input class="input" name="contact_person">')}${field('Phone', '<input class="input" name="phone">')}${field('Email', '<input class="input" name="email">')}${field('GSTIN', '<input class="input" name="gstin">')}${field('Address', '<input class="input" name="address">', { cls: 's12' })}</form>`, foot: '<button class="btn btn-secondary" data-close>Cancel</button><button class="btn btn-primary" id="sg">Save</button>' });
      $('#sg', m.el).onclick = async () => { const f = $('#sf', m.el); try { await api.post('/suppliers', formData(f)); toast('Supplier added'); m.el.remove(); suppliers(body); } catch (err) { showErrors(f, err); toast(err.message, 'error'); } };
    });
  }
  async function movements(body) {
    const rows = await api.get('/inventory/movements');
    body.innerHTML = `<div class="panel"><table class="table compact"><thead><tr><th>Time</th><th>Item</th><th>Batch</th><th>Movement</th><th class="r">Qty</th><th>Ref / dept</th><th>By</th></tr></thead><tbody>${rows.map((m) => `<tr><td class="small">${fdt(m.created_at)}</td><td class="strong small">${esc(m.item_name)}</td><td class="mono small">${esc(m.batch_no || '')}</td><td>${badge(m.qty > 0 ? 'received' : 'pending', titleCase(m.movement))}</td><td class="r num strong" style="color:${m.qty > 0 ? 'var(--green)' : 'var(--red)'}">${m.qty > 0 ? '+' : ''}${m.qty}</td><td class="small">${esc(m.department || (m.ref_type ? `${m.ref_type.replace('_', ' ')} #${m.ref_id}` : m.note || ''))}</td><td class="small">${esc(m.user_name || 'System')}</td></tr>`).join('')}</tbody></table></div>`;
  }

  async function poModal(preset = []) {
    const sups = await api.get('/suppliers');
    const lines = preset.map((l) => ({ ...l }));
    if (lines.length && !lines[0].name) { for (const l of lines) { const m = await api.get(`/medicines/${l.medicine_id}`); l.name = `${m.name} ${m.strength || ''}`; l.supplier_id = m.supplier_id; } }
    const m = modal({ title: 'New purchase order', size: 'lg', body: `<div class="form-grid"><div class="field s6"><label>Supplier</label><select class="select" id="po-s">${sups.map((s) => `<option value="${s.id}" ${lines[0] && lines[0].supplier_id === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></div><div class="field s6"><label>Add medicine</label><input class="input" id="po-m" placeholder="Search"></div><div class="s12" id="po-l"></div><div class="field s12"><label>Notes</label><input class="input" id="po-n"></div></div>`,
      foot: `<button class="btn btn-secondary" data-close>Cancel</button><button class="btn btn-primary" id="po-go">${icon('truck')}Place order</button>` });
    const paint = () => { $('#po-l', m.el).innerHTML = lines.length ? `<table class="table compact"><thead><tr><th>Item</th><th>Qty</th><th>Unit cost</th><th class="r">Amount</th><th></th></tr></thead><tbody>${lines.map((l, i) => `<tr><td class="strong">${esc(l.name)}</td><td><input class="input input-sm" type="number" data-i="${i}" data-k="quantity" value="${l.quantity}" style="width:90px"></td><td><input class="input input-sm" type="number" step="0.01" data-i="${i}" data-k="unit_cost" value="${l.unit_cost}" style="width:100px"></td><td class="r num">${inr2(l.quantity * l.unit_cost)}</td><td><button class="btn btn-ghost btn-sm" data-rm="${i}">${icon('x')}</button></td></tr>`).join('')}</tbody></table>` : '<p class="small muted">Add medicines to order.</p>'; };
    paint();
    medicinePicker($('#po-m', m.el), (x) => { lines.push({ item_type: 'medicine', medicine_id: x.id, name: `${x.name} ${x.strength || ''}`, quantity: Math.max(x.min_stock * 2, 50), unit_cost: x.purchase_price }); $('#po-m', m.el).value = ''; paint(); });
    m.el.addEventListener('change', (e) => { if (e.target.dataset.i) { lines[Number(e.target.dataset.i)][e.target.dataset.k] = Number(e.target.value); paint(); } });
    m.el.addEventListener('click', (e) => { const r = e.target.closest('[data-rm]'); if (r) { lines.splice(Number(r.dataset.rm), 1); paint(); } });
    $('#po-go', m.el).onclick = async () => { try { const r = await api.post('/purchase-orders', { supplier_id: Number($('#po-s', m.el).value), items: lines, notes: $('#po-n', m.el).value }); toast(`${r.po_no} placed`); m.el.remove(); tab = 'po'; $$('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.k === 'po')); ov = null; render(); } catch (err) { toast(err.message, 'error'); } };
  }

  $('#new-po')?.addEventListener('click', () => poModal());
  $('#new-med')?.addEventListener('click', () => medicineModal(null, () => { ov = null; render(); }));
  render();
}

async function medicineModal(med, done) {
  const sups = await api.get('/suppliers').catch(() => []);
  const v = med || { gst_rate: 12, default_route: 'Oral', is_active: 1 };
  const m = modal({ title: med ? `Edit ${med.name}` : 'Add medicine', size: 'xl', body: `<form class="form-grid" id="mf">
    ${field('Medicine name', `<input class="input" name="name" value="${esc(v.name || '')}">`, { req: true, cls: 's4' })}${field('Generic name', `<input class="input" name="generic_name" value="${esc(v.generic_name || '')}">`, { cls: 's4' })}${field('Brand', `<input class="input" name="brand" value="${esc(v.brand || '')}">`, { cls: 's4' })}
    ${field('Strength', `<input class="input" name="strength" value="${esc(v.strength || '')}">`, { cls: 's3' })}${field('Dosage form', select('dosage_form', ['Tablet', 'Capsule', 'Syrup', 'Suspension', 'Injection', 'Cream', 'Gel', 'Ointment', 'Drops', 'Inhaler', 'Nasal spray', 'Sachet', 'IV fluid'], v.dosage_form), { cls: 's3' })}${field('Category', `<input class="input" name="category" value="${esc(v.category || '')}">`, { cls: 's3' })}${field('Default route', select('default_route', ['Oral', 'Topical', 'IV', 'IM', 'SC', 'Nasal', 'Inhalation'], v.default_route), { cls: 's3' })}
    ${field('Manufacturer', `<input class="input" name="manufacturer" value="${esc(v.manufacturer || '')}">`, { cls: 's4' })}${field('HSN', `<input class="input" name="hsn" value="${esc(v.hsn || '')}">`, { cls: 's2' })}${field('GST %', `<input class="input" type="number" name="gst_rate" value="${esc(v.gst_rate)}">`, { cls: 's2' })}${field('Supplier', select('supplier_id', sups.map((s) => [s.id, s.name]), v.supplier_id), { cls: 's4' })}
    ${field('Purchase price ₹', `<input class="input" type="number" step="0.01" name="purchase_price" value="${esc(v.purchase_price ?? '')}">`, { cls: 's3' })}${field('Selling price (MRP) ₹', `<input class="input" type="number" step="0.01" name="selling_price" value="${esc(v.selling_price ?? '')}">`, { cls: 's3' })}${field('Minimum stock', `<input class="input" type="number" name="min_stock" value="${esc(v.min_stock ?? 0)}">`, { cls: 's3' })}${field('Storage', `<input class="input" name="storage" value="${esc(v.storage || 'Below 25°C')}">`, { cls: 's3' })}
    ${med ? `<div class="field s12"><label class="check"><input type="checkbox" name="is_active" ${v.is_active ? 'checked' : ''}> Active (available for prescribing)</label></div>` : `<div class="form-section">Opening stock (optional)</div>${field('Batch number', '<input class="input" name="batch_no">', { cls: 's4' })}${field('Expiry date', '<input class="input" type="date" name="expiry_date">', { cls: 's4' })}${field('Quantity', '<input class="input" type="number" name="opening_qty" value="0">', { cls: 's4' })}`}
  </form>`, foot: `<button class="btn btn-secondary" data-close>Cancel</button><button class="btn btn-primary" id="mg">${icon('save')}Save</button>` });
  $('#mg', m.el).onclick = async () => {
    const f = $('#mf', m.el); const d = formData(f);
    for (const k of ['purchase_price', 'selling_price', 'gst_rate', 'min_stock', 'opening_qty']) if (d[k] !== undefined && d[k] !== '') d[k] = Number(d[k]);
    if (d.supplier_id) d.supplier_id = Number(d.supplier_id); else delete d.supplier_id;
    try { if (med) await api.put(`/medicines/${med.id}`, d); else await api.post('/medicines', d); toast(med ? 'Medicine updated — change audited' : 'Medicine added'); m.el.remove(); done(); }
    catch (err) { showErrors(f, err); toast(err.message, 'error'); }
  };
}

async function medicineDetail(ctx) {
  const el = page({ title: 'Medicine', crumbs: [['/inventory', 'Inventory'], [null, 'Medicine']] });
  el.innerHTML = skeletonRows(6, 5);
  let m;
  try { m = await api.get(`/medicines/${ctx.params.id}`); } catch (err) { el.innerHTML = errorState(err); return; }
  $('.page-head h1').textContent = `${m.name} ${m.strength || ''}`;
  if (can('inventory', 'edit') || can('pharmacy', 'edit')) $('.page-head').insertAdjacentHTML('beforeend', `<div class="actions"><button class="btn btn-secondary" id="edit">${icon('edit')}Edit</button></div>`);
  el.innerHTML = `<div class="kpis c4"><div class="kpi"><div class="label">In stock</div><div class="value">${num(m.stock)}</div></div><div class="kpi"><div class="label">Minimum</div><div class="value">${num(m.min_stock)}</div></div><div class="kpi"><div class="label">MRP</div><div class="value">${inr2(m.selling_price)}</div></div><div class="kpi"><div class="label">Next expiry</div><div class="value" style="font-size:20px">${m.next_expiry ? fdate(m.next_expiry) : '—'}</div></div></div>
    <div class="grid g2 section"><div class="panel"><div class="panel-head"><h3>Batches (FEFO order)</h3></div><table class="table"><thead><tr><th>Batch</th><th>Expiry</th><th class="r">Qty</th><th class="r">Cost</th><th>Supplier</th></tr></thead><tbody>${m.batches.map((b) => `<tr><td class="mono strong">${esc(b.batch_no)}</td><td>${fdate(b.expiry_date)} ${b.expiry_date < todayISO() ? badge('rejected', 'Expired') : ''}</td><td class="r num">${b.qty}</td><td class="r num">${inr2(b.purchase_price)}</td><td class="small">${esc(b.supplier || '')}</td></tr>`).join('')}</tbody></table></div>
    <div class="panel"><div class="panel-head"><h3>Recent movements</h3></div><table class="table compact"><tbody>${m.movements.map((x) => `<tr><td class="small">${fdt(x.created_at)}</td><td>${esc(titleCase(x.movement))}</td><td class="mono small">${esc(x.batch_no || '')}</td><td class="r num strong" style="color:${x.qty > 0 ? 'var(--green)' : 'var(--red)'}">${x.qty > 0 ? '+' : ''}${x.qty}</td><td class="small">${esc(x.user_name || 'System')}</td></tr>`).join('')}</tbody></table></div></div>
    <div class="panel section"><div class="panel-body grid g4">${[['Generic', m.generic_name], ['Brand', m.brand], ['Manufacturer', m.manufacturer], ['Category', m.category], ['Form', m.dosage_form], ['HSN / GST', `${m.hsn || '—'} / ${m.gst_rate}%`], ['Storage', m.storage], ['Supplier', m.supplier_name]].map(([k, v]) => `<div><div class="xs muted strong">${k}</div><div class="strong">${esc(v || '—')}</div></div>`).join('')}</div></div>`;
  $('#edit')?.addEventListener('click', () => medicineModal(m, () => medicineDetail(ctx)));
  void navigate;
}
