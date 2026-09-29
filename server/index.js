'use strict';
process.env.TZ = process.env.TZ || 'Asia/Kolkata';

const path = require('node:path');
const express = require('express');
const db = require('./db');
const { HttpError } = require('./lib/util');

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', process.env.TRUST_PROXY === 'true' ? 1 : false);

  // Security headers (CSP allows only self + Google Fonts + Unsplash imagery).
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(self), microphone=(), geolocation=()');
    res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; script-src 'self'; connect-src 'self'; frame-ancestors 'none'");
    if (process.env.NODE_ENV === 'production') res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    next();
  });

  app.use(express.json({ limit: '8mb' }));

  const api = express.Router();
  api.use((req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  api.get('/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));
  for (const r of ['auth', 'platform', 'admin', 'patients', 'opd', 'pharmacy', 'clinical', 'billing', 'hr', 'insights', 'portal']) api.use(require(`./routes/${r}`));
  api.use((req, res) => res.status(404).json({ error: 'Not found' }));
  app.use('/api', api);

  const pub = path.join(__dirname, '..', 'public');
  app.use(express.static(pub, { index: false, maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0 }));
  app.get(/^\/(?!api\/).*/, (req, res) => res.sendFile(path.join(pub, 'index.html')));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Malformed JSON body' });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Upload too large' });
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, details: err.details });
    if (/UNIQUE constraint failed/.test(err.message)) return res.status(409).json({ error: 'This record already exists (duplicate number or name).' });
    if (/CHECK constraint failed/.test(err.message)) return res.status(409).json({ error: 'The change would make stock negative or violates a data rule.' });
    if (/FOREIGN KEY constraint failed/.test(err.message)) return res.status(409).json({ error: 'The record is linked to other data and cannot be changed this way.' });
    console.error('[error]', req.method, req.originalUrl, err);
    res.status(500).json({ error: 'Something went wrong on our side. Please retry, or contact your administrator if it persists.' });
  });
  return app;
}

// First-run bootstrap. Production never gets demo credentials: the owner account comes
// from SUPERADMIN_USERNAME / SUPERADMIN_PASSWORD environment variables.
function bootstrap() {
  db.open();
  require('./services/hospitals').ensurePermissions();
  const hasOwner = db.get('SELECT id FROM users WHERE is_super_admin = 1');
  if (hasOwner) return;
  const prod = process.env.NODE_ENV === 'production';
  const demo = process.env.SEED_DEMO === 'true' || (!prod && process.env.SEED_DEMO !== 'false');
  if (demo) {
    console.log('[bootstrap] Empty database — loading Deep Hospital demo data (development only).');
    require('./seed').seed();
    return;
  }
  const u = process.env.SUPERADMIN_USERNAME; const p = process.env.SUPERADMIN_PASSWORD;
  if (!u || !p || p.length < 12) {
    console.error('[bootstrap] Set SUPERADMIN_USERNAME and SUPERADMIN_PASSWORD (min 12 chars) to create the platform owner account.');
    process.exit(1);
  }
  const { hashPassword } = require('./lib/crypto');
  db.insertRow('users', { hospital_id: null, username: u, full_name: 'Platform Owner', password_hash: hashPassword(p), is_super_admin: 1, must_change_password: 1, created_at: require('./lib/util').now() });
  console.log(`[bootstrap] Super admin "${u}" created.`);
}

if (require.main === module) {
  // Bind the port first so hosting platforms see the app as up while first-run
  // demo data is created; requests simply wait until bootstrap finishes.
  const port = Number(process.env.PORT) || 3000;
  createApp().listen(port, () => {
    bootstrap();
    require('./lib/automation').start();
    console.log(`Deep Hospital running on http://localhost:${port}`);
  });
}

module.exports = { createApp, bootstrap };
