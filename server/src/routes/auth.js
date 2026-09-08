'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { createSession, destroySession } = require('../auth');
const rateLimit = require('../ratelimit');

const router = express.Router();
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function setSid(res, token) {
  res.cookie('sid', token, { httpOnly: true, sameSite: 'lax', maxAge: 30 * 24 * 3600 * 1000, path: '/' });
}
function setAsid(res, token) {
  res.cookie('asid', token, { httpOnly: true, sameSite: 'lax', maxAge: 30 * 24 * 3600 * 1000, path: '/' });
}

router.post('/register', rateLimit(20, 60000), (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const pass = String(req.body.pass || '');
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'bad_email' });
  if (pass.length < 6) return res.status(400).json({ error: 'weak_password' });
  if (db.prepare('SELECT id FROM users WHERE email=?').get(email))
    return res.status(409).json({ error: 'exists' });
  const clientId = db.nextClientId();
  const info = db.prepare('INSERT INTO users (email, pass_hash, client_id, created_at) VALUES (?,?,?,?)')
    .run(email, bcrypt.hashSync(pass, 10), clientId, Date.now() / 1000);
  setSid(res, createSession(info.lastInsertRowid));
  res.json({ ok: true });
});

router.post('/login', rateLimit(20, 60000), (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const u = db.prepare('SELECT * FROM users WHERE email=?').get(email);
  if (!u || !bcrypt.compareSync(String(req.body.pass || ''), u.pass_hash))
    return res.status(401).json({ error: 'bad_credentials' });
  if (u.blocked) {
    /* S1: заблокированный получает сессию, чтобы писать в чат поддержки */
    if (!req.body.admin) setSid(res, createSession(u.id));
    return res.status(403).json({ error: 'blocked' });
  }
  if (req.body.admin) { /* K1: админская сессия в отдельной куке asid */
    if (u.role !== 'admin') return res.status(403).json({ error: 'not_admin' });
    setAsid(res, createSession(u.id));
  } else {
    setSid(res, createSession(u.id));
  }
  res.json({ ok: true, role: u.role });
});

router.post('/logout', (req, res) => {
  if (req.body && req.body.admin) {
    destroySession(req.cookies && req.cookies.asid);
    res.clearCookie('asid', { path: '/' });
  } else {
    destroySession(req.cookies && req.cookies.sid);
    res.clearCookie('sid', { path: '/' });
  }
  res.json({ ok: true });
});

module.exports = router;
