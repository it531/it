'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_FILE = process.env.DB_FILE || path.join(DATA_DIR, 'deep-hospital.db');

let db;

function open(file = DB_FILE) {
  if (db) return db;
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  return db;
}

function close() { if (db) { db.close(); db = undefined; } }

function conn() { if (!db) open(); return db; }

// Thin helpers so route code stays readable.
const all = (sql, ...p) => conn().prepare(sql).all(...p).map(plain);
const get = (sql, ...p) => { const r = conn().prepare(sql).get(...p); return r ? plain(r) : undefined; };
const run = (sql, ...p) => conn().prepare(sql).run(...p);
const insert = (sql, ...p) => Number(run(sql, ...p).lastInsertRowid);
function plain(r) { return Object.assign({}, r); }

// Transactions with savepoint nesting. SQLite serialises writers, so everything
// inside tx() — including sequence increments — is atomic.
let depth = 0;
function tx(fn) {
  const c = conn();
  const sp = `sp_${depth}`;
  if (depth === 0) c.exec('BEGIN IMMEDIATE'); else c.exec(`SAVEPOINT ${sp}`);
  depth++;
  try {
    const out = fn();
    depth--;
    if (depth === 0) c.exec('COMMIT'); else c.exec(`RELEASE ${sp}`);
    return out;
  } catch (e) {
    depth--;
    if (depth === 0) c.exec('ROLLBACK'); else c.exec(`ROLLBACK TO ${sp}; RELEASE ${sp}`);
    throw e;
  }
}

// Build "INSERT INTO t (a,b) VALUES (?,?)" from an object, ignoring undefined.
function insertRow(table, obj) {
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined);
  const sql = `INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`;
  return insert(sql, ...keys.map((k) => norm(obj[k])));
}
function updateRow(table, id, obj, where = '', ...whereParams) {
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined);
  if (!keys.length) return 0;
  const sql = `UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ? ${where}`;
  return Number(run(sql, ...keys.map((k) => norm(obj[k])), id, ...whereParams).changes);
}
function norm(v) {
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v !== null && typeof v === 'object') return JSON.stringify(v);
  return v;
}

module.exports = { open, close, conn, all, get, run, insert, tx, insertRow, updateRow, DATA_DIR, DB_FILE };
