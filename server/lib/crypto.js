'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DATA_DIR } = require('../db');

// ── Password hashing: scrypt with per-password salt. Plain-text passwords are never stored.
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(pw), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}
function verifyPassword(pw, stored) {
  try {
    const [alg, N, r, p, salt, hash] = String(stored).split('$');
    if (alg !== 'scrypt') return false;
    const expected = Buffer.from(hash, 'base64');
    const got = crypto.scryptSync(String(pw), Buffer.from(salt, 'base64'), expected.length, { N: +N, r: +r, p: +p });
    return crypto.timingSafeEqual(expected, got);
  } catch { return false; }
}

// ── Field encryption (AES-256-GCM) for ID numbers, bank accounts, documents.
// Production: set DATA_ENCRYPTION_KEY (64 hex chars). Development: a key file is created in data/.
let KEY;
function key() {
  if (KEY) return KEY;
  if (process.env.DATA_ENCRYPTION_KEY) {
    KEY = Buffer.from(process.env.DATA_ENCRYPTION_KEY, 'hex');
    if (KEY.length !== 32) throw new Error('DATA_ENCRYPTION_KEY must be 32 bytes (64 hex chars)');
    return KEY;
  }
  if (process.env.NODE_ENV === 'production') throw new Error('DATA_ENCRYPTION_KEY is required in production');
  const f = path.join(DATA_DIR, '.dev-encryption-key');
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(f)) fs.writeFileSync(f, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  KEY = Buffer.from(fs.readFileSync(f, 'utf8').trim(), 'hex');
  return KEY;
}
function encrypt(plain) {
  if (plain === null || plain === undefined || plain === '') return null;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return `v1:${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${enc.toString('base64')}`;
}
function decrypt(blob) {
  if (!blob) return null;
  const [v, iv, tag, data] = blob.split(':');
  if (v !== 'v1') return null;
  const d = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8');
}
// Deterministic keyed hash so encrypted identifiers can still be searched by exact value.
function blindIndex(value) {
  return crypto.createHmac('sha256', key()).update(String(value).replace(/\s+/g, '').toUpperCase()).digest('hex');
}

const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

module.exports = { hashPassword, verifyPassword, encrypt, decrypt, blindIndex, randomToken, sha256 };
