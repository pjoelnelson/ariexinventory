'use strict';
/*
 * Barcode Inventory - self-hosted server
 * No external packages: uses Node's built-in http, crypto and sqlite modules.
 * Start with:  node server.js   (then open http://localhost:3000)
 */
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');
const SESSION_DAYS = 14;
const ROLES = ['admin', 'operator', 'viewer'];
const RANK = { viewer: 1, operator: 2, admin: 3 };

// ---------------------------------------------------------------- database
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_FILE = path.join(DATA_DIR, 'inventory.db');
const db = new DatabaseSync(DB_FILE);
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('admin','operator','viewer')),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS items (
  id           INTEGER PRIMARY KEY,
  barcode      TEXT NOT NULL UNIQUE,
  name         TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  location     TEXT NOT NULL DEFAULT '',
  quantity     INTEGER NOT NULL DEFAULT 0,
  min_quantity INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE TABLE IF NOT EXISTS transactions (
  id            INTEGER PRIMARY KEY,
  item_id       INTEGER REFERENCES items(id) ON DELETE SET NULL,
  barcode       TEXT NOT NULL,
  item_name     TEXT NOT NULL,
  direction     TEXT NOT NULL CHECK (direction IN ('IN','OUT','ADJUST')),
  qty           INTEGER NOT NULL,
  balance_after INTEGER NOT NULL,
  note          TEXT NOT NULL DEFAULT '',
  user_id       INTEGER,
  username      TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS tx_created ON transactions(created_at);
CREATE INDEX IF NOT EXISTS tx_item ON transactions(item_id);
`);

const q = {
  userByName: db.prepare('SELECT * FROM users WHERE username = ?'),
  userById: db.prepare('SELECT id, username, role, created_at FROM users WHERE id = ?'),
  userCount: db.prepare('SELECT COUNT(*) AS n FROM users'),
  adminCount: db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'"),
  sessionUser: db.prepare(`SELECT u.id, u.username, u.role FROM sessions s JOIN users u ON u.id = s.user_id
                           WHERE s.token = ? AND s.expires_at > ?`),
  itemByBarcode: db.prepare('SELECT * FROM items WHERE barcode = ?'),
  itemById: db.prepare('SELECT * FROM items WHERE id = ?'),
  insertTx: db.prepare(`INSERT INTO transactions (item_id, barcode, item_name, direction, qty, balance_after, note, user_id, username)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
};

function inTransaction(fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}

// ---------------------------------------------------------------- passwords & sessions
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}
function verifyPassword(pw, stored) {
  const [alg, saltHex, hashHex] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(pw, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}
function createSession(userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)')
    .run(token, userId, Date.now() + SESSION_DAYS * 864e5);
  return token;
}
setInterval(() => db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now()), 3600e3).unref();

// simple brute-force protection for logins
const loginFails = new Map();
function loginBlocked(ip) {
  const f = loginFails.get(ip);
  return f && f.count >= 10 && f.until > Date.now();
}
function noteLoginFail(ip) {
  const f = loginFails.get(ip);
  if (!f || f.until < Date.now()) loginFails.set(ip, { count: 1, until: Date.now() + 15 * 60e3 });
  else f.count++;
}

// ---------------------------------------------------------------- http helpers
class HttpError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; }
}
const fail = (status, message, extra) => { throw new HttpError(status, message, extra); };

function isHttps(req) {
  return req.socket.encrypted || String(req.headers['x-forwarded-proto'] || '').startsWith('https');
}
function clientIp(req) {
  return String(req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.socket.remoteAddress || '')
    .split(',')[0].trim();
}
function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function sendJson(res, status, data, headers = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    const type = String(req.headers['content-type'] || '');
    if (!type.includes('application/json')) return reject(new HttpError(415, 'Expected JSON'));
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 1e6) { reject(new HttpError(413, 'Request too large')); req.destroy(); }
      else chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch { reject(new HttpError(400, 'Invalid JSON')); }
    });
    req.on('error', reject);
  });
}
function str(v, max = 200) { return String(v ?? '').trim().slice(0, max); }
function int(v, { min = -Infinity, max = Infinity, def } = {}) {
  if (v === undefined || v === null || v === '') { if (def !== undefined) return def; fail(400, 'Number required'); }
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) fail(400, `Enter a whole number between ${min} and ${max}`);
  return n;
}
function requireRole(user, role) {
  if (!user) fail(401, 'Please sign in');
  if (RANK[user.role] < RANK[role]) fail(403, 'Your account is not allowed to do this');
}
function csvCell(v) {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // stop spreadsheet formula injection
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// ---------------------------------------------------------------- business logic
function txFilters(params) {
  const where = []; const args = [];
  const search = str(params.get('q'));
  if (search) { where.push('(barcode LIKE ? OR item_name LIKE ? OR note LIKE ? OR username LIKE ?)'); const s = `%${search}%`; args.push(s, s, s, s); }
  const dir = params.get('direction');
  if (['IN', 'OUT', 'ADJUST'].includes(dir)) { where.push('direction = ?'); args.push(dir); }
  const itemId = params.get('item_id');
  if (itemId) { where.push('item_id = ?'); args.push(int(itemId, { min: 1 })); }
  const from = params.get('from'); const to = params.get('to');
  if (from && !isNaN(Date.parse(from))) { where.push('created_at >= ?'); args.push(new Date(from).toISOString().slice(0, 19) + 'Z'); }
  if (to && !isNaN(Date.parse(to))) { where.push('created_at < ?'); args.push(new Date(to).toISOString().slice(0, 19) + 'Z'); }
  return { sql: where.length ? 'WHERE ' + where.join(' AND ') : '', args };
}

function applyMovement(user, item, direction, qty, note) {
  return inTransaction(() => {
    const fresh = q.itemById.get(item.id);
    let balance;
    if (direction === 'IN') balance = fresh.quantity + qty;
    else if (direction === 'OUT') {
      if (fresh.quantity < qty) fail(409, `Only ${fresh.quantity} of "${fresh.name}" in stock - cannot check out ${qty}`, { item: fresh });
      balance = fresh.quantity - qty;
    } else balance = qty; // ADJUST sets the count directly
    db.prepare("UPDATE items SET quantity = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?").run(balance, fresh.id);
    const change = direction === 'ADJUST' ? balance - fresh.quantity : qty;
    const r = q.insertTx.run(fresh.id, fresh.barcode, fresh.name, direction, change, balance, note, user.id, user.username);
    return {
      item: q.itemById.get(fresh.id),
      transaction: db.prepare('SELECT * FROM transactions WHERE id = ?').get(r.lastInsertRowid),
    };
  });
}

function createItem(body) {
  const name = str(body.name, 120);
  if (!name) fail(400, 'Item name is required');
  let barcode = str(body.barcode, 120);
  if (barcode && q.itemByBarcode.get(barcode)) fail(409, 'That barcode is already registered');
  return inTransaction(() => {
    const r = db.prepare('INSERT INTO items (barcode, name, description, location, quantity, min_quantity) VALUES (?, ?, ?, ?, 0, ?)')
      .run(barcode || 'TMP-' + crypto.randomUUID(), name, str(body.description, 1000), str(body.location, 120),
        int(body.min_quantity, { min: 0, max: 1e9, def: 0 }));
    const id = Number(r.lastInsertRowid);
    if (!barcode) db.prepare('UPDATE items SET barcode = ? WHERE id = ?').run('INV-' + String(id).padStart(6, '0'), id);
    return q.itemById.get(id);
  });
}

// ---------------------------------------------------------------- API routes
async function api(req, res, url, user) {
  const m = req.method;
  const p = url.pathname;
  let match;

  // --- auth / setup
  if (p === '/api/me' && m === 'GET') {
    return sendJson(res, 200, { user, setupNeeded: q.userCount.get().n === 0 });
  }
  if (p === '/api/setup' && m === 'POST') {
    const body = await readJson(req);
    if (q.userCount.get().n > 0) fail(409, 'Setup has already been completed');
    const username = str(body.username, 50); const password = String(body.password || '');
    if (!username || password.length < 8) fail(400, 'Choose a username and a password of at least 8 characters');
    const r = db.prepare("INSERT INTO users (username, password_hash, role) VALUES (?, ?, 'admin')").run(username, hashPassword(password));
    return login(res, req, Number(r.lastInsertRowid));
  }
  if (p === '/api/login' && m === 'POST') {
    const ip = clientIp(req);
    if (loginBlocked(ip)) fail(429, 'Too many failed attempts. Try again in 15 minutes.');
    const body = await readJson(req);
    const row = q.userByName.get(str(body.username, 50));
    if (!row || !verifyPassword(String(body.password || ''), row.password_hash)) {
      noteLoginFail(ip); fail(401, 'Wrong username or password');
    }
    loginFails.delete(ip);
    return login(res, req, row.id);
  }
  if (p === '/api/logout' && m === 'POST') {
    const token = parseCookies(req).sid;
    if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return sendJson(res, 200, { ok: true }, { 'Set-Cookie': `sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0` });
  }
  if (p === '/api/me/password' && m === 'POST') {
    requireRole(user, 'viewer');
    const body = await readJson(req);
    const row = q.userByName.get(user.username);
    if (!verifyPassword(String(body.current || ''), row.password_hash)) fail(400, 'Current password is wrong');
    if (String(body.password || '').length < 8) fail(400, 'New password must be at least 8 characters');
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(body.password), user.id);
    return sendJson(res, 200, { ok: true });
  }

  // everything below needs a signed-in user
  requireRole(user, 'viewer');

  // --- scanning
  if (p === '/api/scan' && m === 'POST') {
    requireRole(user, 'operator');
    const body = await readJson(req);
    const barcode = str(body.barcode, 120);
    if (!barcode) fail(400, 'No barcode scanned');
    const direction = body.direction === 'OUT' ? 'OUT' : 'IN';
    const qty = int(body.qty, { min: 1, max: 1e6, def: 1 });
    const item = q.itemByBarcode.get(barcode);
    if (!item) fail(404, `Unknown barcode: ${barcode}`, { unknown: true, barcode });
    return sendJson(res, 200, applyMovement(user, item, direction, qty, str(body.note, 500)));
  }

  // --- dashboard
  if (p === '/api/stats' && m === 'GET') {
    const since = url.searchParams.get('since');
    const sinceIso = since && !isNaN(Date.parse(since)) ? new Date(since).toISOString().slice(0, 19) + 'Z' : new Date(Date.now() - 864e5).toISOString().slice(0, 19) + 'Z';
    const totals = db.prepare('SELECT COUNT(*) AS items, COALESCE(SUM(quantity),0) AS units, COALESCE(SUM(quantity <= min_quantity AND min_quantity > 0),0) AS low FROM items').get();
    const today = db.prepare(`SELECT COALESCE(SUM(CASE WHEN direction='IN' THEN qty END),0) AS ins,
                                     COALESCE(SUM(CASE WHEN direction='OUT' THEN qty END),0) AS outs,
                                     COUNT(*) AS scans FROM transactions WHERE created_at >= ?`).get(sinceIso);
    const lowStock = db.prepare('SELECT * FROM items WHERE min_quantity > 0 AND quantity <= min_quantity ORDER BY quantity - min_quantity, name LIMIT 50').all();
    const recent = db.prepare('SELECT * FROM transactions ORDER BY id DESC LIMIT 15').all();
    return sendJson(res, 200, { totals, today, lowStock, recent });
  }

  // --- items
  if (p === '/api/items' && m === 'GET') {
    const search = str(url.searchParams.get('q'));
    const rows = search
      ? db.prepare('SELECT * FROM items WHERE barcode LIKE ? OR name LIKE ? OR location LIKE ? OR description LIKE ? ORDER BY name LIMIT 1000')
        .all(...Array(4).fill(`%${search}%`))
      : db.prepare('SELECT * FROM items ORDER BY name LIMIT 1000').all();
    return sendJson(res, 200, { items: rows });
  }
  if (p === '/api/items' && m === 'POST') {
    requireRole(user, 'operator');
    return sendJson(res, 201, { item: createItem(await readJson(req)) });
  }
  if ((match = p.match(/^\/api\/items\/(\d+)$/))) {
    const item = q.itemById.get(Number(match[1]));
    if (!item) fail(404, 'Item not found');
    if (m === 'GET') return sendJson(res, 200, { item });
    if (m === 'PUT') {
      requireRole(user, 'operator');
      const body = await readJson(req);
      const name = str(body.name ?? item.name, 120);
      const barcode = str(body.barcode ?? item.barcode, 120);
      if (!name || !barcode) fail(400, 'Name and barcode are required');
      const clash = q.itemByBarcode.get(barcode);
      if (clash && clash.id !== item.id) fail(409, 'That barcode belongs to another item');
      db.prepare(`UPDATE items SET barcode = ?, name = ?, description = ?, location = ?, min_quantity = ?,
                  updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?`)
        .run(barcode, name, str(body.description ?? item.description, 1000), str(body.location ?? item.location, 120),
          int(body.min_quantity ?? item.min_quantity, { min: 0, max: 1e9 }), item.id);
      return sendJson(res, 200, { item: q.itemById.get(item.id) });
    }
    if (m === 'DELETE') {
      requireRole(user, 'admin');
      db.prepare('DELETE FROM items WHERE id = ?').run(item.id); // history rows are kept
      return sendJson(res, 200, { ok: true });
    }
  }
  if ((match = p.match(/^\/api\/items\/(\d+)\/adjust$/)) && m === 'POST') {
    requireRole(user, 'admin');
    const item = q.itemById.get(Number(match[1]));
    if (!item) fail(404, 'Item not found');
    const body = await readJson(req);
    const qty = int(body.quantity, { min: 0, max: 1e9 });
    return sendJson(res, 200, applyMovement(user, item, 'ADJUST', qty, str(body.note, 500) || 'Stock count correction'));
  }

  // --- history
  if (p === '/api/transactions' && m === 'GET') {
    const { sql, args } = txFilters(url.searchParams);
    const limit = int(url.searchParams.get('limit'), { min: 1, max: 500, def: 50 });
    const offset = int(url.searchParams.get('offset'), { min: 0, def: 0 });
    const total = db.prepare(`SELECT COUNT(*) AS n FROM transactions ${sql}`).get(...args).n;
    const rows = db.prepare(`SELECT * FROM transactions ${sql} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...args, limit, offset);
    return sendJson(res, 200, { rows, total });
  }
  if (p === '/api/transactions.csv' && m === 'GET') {
    const { sql, args } = txFilters(url.searchParams);
    const rows = db.prepare(`SELECT * FROM transactions ${sql} ORDER BY id DESC LIMIT 200000`).all(...args);
    const cols = ['id', 'created_at', 'direction', 'qty', 'balance_after', 'barcode', 'item_name', 'username', 'note'];
    const csv = [cols.join(',')].concat(rows.map((r) => cols.map((c) => csvCell(r[c])).join(','))).join('\r\n');
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="inventory-history-${new Date().toISOString().slice(0, 10)}.csv"`,
      'Cache-Control': 'no-store',
    });
    return res.end('﻿' + csv);
  }
  if (p === '/api/items.csv' && m === 'GET') {
    const rows = db.prepare('SELECT * FROM items ORDER BY name').all();
    const cols = ['barcode', 'name', 'location', 'quantity', 'min_quantity', 'description', 'updated_at'];
    const csv = [cols.join(',')].concat(rows.map((r) => cols.map((c) => csvCell(r[c])).join(','))).join('\r\n');
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="inventory-stock-${new Date().toISOString().slice(0, 10)}.csv"`,
      'Cache-Control': 'no-store',
    });
    return res.end('﻿' + csv);
  }

  // --- users (admin)
  if (p === '/api/users' && m === 'GET') {
    requireRole(user, 'admin');
    return sendJson(res, 200, { users: db.prepare('SELECT id, username, role, created_at FROM users ORDER BY username').all() });
  }
  if (p === '/api/users' && m === 'POST') {
    requireRole(user, 'admin');
    const body = await readJson(req);
    const username = str(body.username, 50); const password = String(body.password || '');
    if (!username) fail(400, 'Username is required');
    if (password.length < 8) fail(400, 'Password must be at least 8 characters');
    if (!ROLES.includes(body.role)) fail(400, 'Pick a role');
    if (q.userByName.get(username)) fail(409, 'That username is taken');
    const r = db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run(username, hashPassword(password), body.role);
    return sendJson(res, 201, { user: q.userById.get(r.lastInsertRowid) });
  }
  if ((match = p.match(/^\/api\/users\/(\d+)$/))) {
    requireRole(user, 'admin');
    const target = q.userById.get(Number(match[1]));
    if (!target) fail(404, 'User not found');
    if (m === 'PUT') {
      const body = await readJson(req);
      if (body.role !== undefined) {
        if (!ROLES.includes(body.role)) fail(400, 'Pick a role');
        if (target.role === 'admin' && body.role !== 'admin' && q.adminCount.get().n <= 1) fail(400, 'You need at least one admin');
        db.prepare('UPDATE users SET role = ? WHERE id = ?').run(body.role, target.id);
      }
      if (body.password !== undefined) {
        if (String(body.password).length < 8) fail(400, 'Password must be at least 8 characters');
        db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(String(body.password)), target.id);
        db.prepare('DELETE FROM sessions WHERE user_id = ?').run(target.id);
      }
      return sendJson(res, 200, { user: q.userById.get(target.id) });
    }
    if (m === 'DELETE') {
      if (target.id === user.id) fail(400, "You can't delete your own account");
      if (target.role === 'admin' && q.adminCount.get().n <= 1) fail(400, 'You need at least one admin');
      db.prepare('DELETE FROM users WHERE id = ?').run(target.id);
      return sendJson(res, 200, { ok: true });
    }
  }

  // --- backup (admin): consistent copy of the whole database
  if (p === '/api/backup' && m === 'GET') {
    requireRole(user, 'admin');
    const tmp = path.join(os.tmpdir(), `inventory-backup-${crypto.randomUUID()}.db`);
    db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="inventory-backup-${new Date().toISOString().slice(0, 10)}.db"`,
    });
    const stream = fs.createReadStream(tmp);
    stream.pipe(res);
    stream.on('close', () => fs.unlink(tmp, () => {}));
    return;
  }

  fail(404, 'Not found');
}

function login(res, req, userId) {
  const token = createSession(userId);
  const secure = isHttps(req) ? '; Secure' : '';
  return sendJson(res, 200, { user: q.userById.get(userId) }, {
    'Set-Cookie': `sid=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure}`,
  });
}

// ---------------------------------------------------------------- static files
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };
function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || !path.extname(rel)) rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

// ---------------------------------------------------------------- server
async function handle(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; script-src 'self' https://cdnjs.cloudflare.com; style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'");
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) {
      const token = parseCookies(req).sid;
      const user = token ? q.sessionUser.get(token, Date.now()) || null : null;
      await api(req, res, url, user);
    } else if (req.method === 'GET' || req.method === 'HEAD') {
      serveStatic(req, res, url);
    } else { res.writeHead(405); res.end(); }
  } catch (err) {
    if (err instanceof HttpError) sendJson(res, err.status, { error: err.message, ...(err.extra || {}) });
    else { console.error(err); if (!res.headersSent) sendJson(res, 500, { error: 'Server error - see the server window' }); }
  }
}

// Plain http for this PC; https (needed for phone cameras) when certs\server.pfx exists.
const CERT_DIR = path.join(__dirname, 'certs');
const HTTPS_PORT = Number(process.env.HTTPS_PORT) || 3443;
let httpsServer = null;
if (fs.existsSync(path.join(CERT_DIR, 'server.pfx'))) {
  try {
    httpsServer = require('node:https').createServer({
      pfx: fs.readFileSync(path.join(CERT_DIR, 'server.pfx')),
      passphrase: fs.readFileSync(path.join(CERT_DIR, 'passphrase.txt'), 'utf8').trim(),
    }, handle);
  } catch (err) { console.error('  Could not load the https certificate:', err.message); }
}

let pending = httpsServer ? 2 : 1;
function ready() {
  if (--pending) return;
  const lan = Object.values(os.networkInterfaces()).flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal && !i.address.startsWith('169.254.')).map((i) => i.address);
  console.log('\n  Barcode Inventory is running');
  console.log(`  On this PC:        http://localhost:${PORT}`);
  for (const a of lan) console.log(`  On your network:   http://${a}:${PORT}`);
  if (httpsServer) for (const a of lan) console.log(`  Phones (camera):   https://${a}:${HTTPS_PORT}`);
  else console.log('  Phone camera scanning needs https: run make-certificate.ps1, then restart.');
  console.log(`  Database file:     ${DB_FILE}`);
  if (q.userCount.get().n === 0) console.log('\n  First run: open the page above to create the admin account.');
  console.log('\n  Keep this window open. Press Ctrl+C to stop.\n');
}
http.createServer(handle).listen(PORT, HOST, ready);
if (httpsServer) httpsServer.listen(HTTPS_PORT, HOST, ready);
