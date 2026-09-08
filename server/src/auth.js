'use strict';
const crypto = require('crypto');
const db = require('./db');

const SESSION_TTL = 30 * 24 * 3600; // 30 дней
const now = () => Date.now() / 1000;
const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?,?,?,?)')
    .run(sha256(token), userId, now(), now() + SESSION_TTL);
  return token;
}
function destroySession(token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(sha256(token));
}
function userFromCookie(req, name) {
  const token = req.cookies && req.cookies[name];
  if (!token) return null;
  const row = db.prepare(
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > ?`
  ).get(sha256(token), now());
  return row || null;
}
function userFromReq(req) { return userFromCookie(req, 'sid'); }
function adminFromReq(req) { return userFromCookie(req, 'asid') || userFromCookie(req, 'sid'); }
function auth(req, res, next) {
  const u = userFromReq(req);
  if (!u) return res.status(401).json({ error: 'unauthorized' });
  if (u.blocked) return res.status(403).json({ error: 'blocked' });
  req.user = u;
  next();
}
function authSupport(req, res, next) { /* S1: как auth, но заблокированным тоже доступен чат поддержки */
  const u = userFromReq(req);
  if (!u) return res.status(401).json({ error: 'unauthorized' });
  req.user = u;
  next();
}
function admin(req, res, next) {
  const u = adminFromReq(req);
  if (!u) return res.status(401).json({ error: 'unauthorized' });
  if (u.blocked) return res.status(403).json({ error: 'blocked' });
  if (u.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
  req.user = u;
  next();
}
function purgeExpired() {
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now());
}

module.exports = { createSession, destroySession, userFromReq, adminFromReq, auth, authSupport, admin, purgeExpired, SESSION_TTL };
