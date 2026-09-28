// Waiting-area TV displays (OPD tokens per doctor, pharmacy tokens). Open on any screen signed in as staff.
import { api, session } from '../core/api.js';
import { icon, LOGO } from '../core/icons.js';
import { esc } from '../core/ui.js';

export default async function display(ctx) {
  const kind = ctx.meta.display;
  const app = document.getElementById('app');
  document.title = `${kind === 'opd' ? 'OPD' : 'Pharmacy'} tokens · Deep Hospital`;
  let last = {};
  const clock = () => new Date().toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });
  const head = `<div class="tv-head"><div class="row" style="gap:14px">${LOGO}<div><h1>${esc(session.me.hospital ? session.me.hospital.name : 'Deep Hospital')}</h1><div style="color:rgba(255,255,255,.6);font-weight:600">${kind === 'opd' ? 'OPD token display' : 'Pharmacy token display'}</div></div></div><div class="row" style="gap:18px"><span class="live-dot" style="color:#7ff0c4">Live</span><div class="tv-clock" id="clk">${clock()}</div><button class="btn btn-secondary btn-sm" id="fs">${icon('tv')}Full screen</button></div></div>`;
  const chime = () => { try { const c = new (window.AudioContext || window.webkitAudioContext)(); const o = c.createOscillator(); const g = c.createGain(); o.connect(g); g.connect(c.destination); o.frequency.value = 880; g.gain.setValueAtTime(0.0001, c.currentTime); g.gain.exponentialRampToValueAtTime(0.2, c.currentTime + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + 0.9); o.start(); o.stop(c.currentTime + 1); } catch {} };
  const paint = async () => {
    if (!location.pathname.startsWith('/display')) return clearInterval(t);
    try {
      if (kind === 'opd') {
        const d = await api.get('/opd/dashboard');
        const rooms = d.doctors.filter((x) => x.serving || x.waiting);
        let changed = false;
        for (const r of rooms) { if (r.serving && last[r.id] && last[r.id] !== r.serving) changed = true; last[r.id] = r.serving; }
        app.innerHTML = `<div class="tv">${head}<div class="tv-grid">${rooms.map((r) => `<div class="tv-card"><div class="doc">${esc(r.name)}</div><div class="dept">${esc(r.department || '')} · ${esc(r.room || '')}</div><div class="tok">${esc(r.serving || '—')}</div><div class="nxt"><span style="background:none;padding-left:0;color:rgba(255,255,255,.6)">Next</span>${r.next.map((n) => `<span>${esc(n)}</span>`).join('') || '<span>—</span>'}</div></div>`).join('') || '<h2 style="color:#fff">OPD queues will appear here.</h2>'}</div></div>`;
        if (changed) chime();
      } else {
        const q = await api.get('/pharmacy/queue');
        const now = q.serving ? q.serving.token : '—';
        if (last.ph && last.ph !== now) chime(); last.ph = now;
        app.innerHTML = `<div class="tv">${head}<div class="tv-pharmacy"><div class="tv-card"><div class="col-title">Now serving</div><div class="tok" style="font-size:140px">${esc(now)}</div></div>
          <div class="tv-card"><div class="col-title">Ready for pickup</div>${q.ready.map((o) => `<span class="tk ready">${esc(o.token)}</span>`).join('') || '<span style="color:rgba(255,255,255,.5)">—</span>'}</div>
          <div class="tv-card"><div class="col-title">Waiting</div>${q.waiting.slice(0, 12).map((o) => `<span class="tk">${esc(o.token)}</span>`).join('') || '<span style="color:rgba(255,255,255,.5)">—</span>'}</div></div></div>`;
      }
      document.getElementById('fs').onclick = () => document.documentElement.requestFullscreen && document.documentElement.requestFullscreen();
    } catch (err) { app.innerHTML = `<div class="tv">${head}<h2 style="color:#fff">${esc(err.message)}</h2></div>`; }
  };
  await paint();
  const t = setInterval(paint, 5000);
}
