'use strict';
const express = require('express');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const db = require('../db');
const { UPLOADS } = require('../db');
const { auth, authSupport } = require('../auth'); /* S1 */
const { ASSETS } = require('../engine');
const { getSettings } = require('../settings'); /* PLAT1: лимиты сделок */
const { chatFilesMw, collectChatFiles, discardUpload, parseFiles, sendChatFile } = require('../chatfiles'); /* CHAT2 */

const router = express.Router();
const now = () => Date.now() / 1000;

function balancesOf(id) {
  const r = db.prepare('SELECT demo_balance, real_balance FROM users WHERE id=?').get(id);
  return { demo: r.demo_balance, real: r.real_balance };
}
function publicUser(u) {
  return {
    id: u.id, email: u.email, clientId: u.client_id, role: u.role, blocked: !!u.blocked,
    created: u.created_at,
    profile: { first: u.first, last: u.last, phone: u.phone, dob: u.dob, country: u.country, nick: u.nick, hide: !!u.hide_profile },
    balances: { demo: u.demo_balance, real: u.real_balance },
    bonusLocked: Math.min(u.bonus_locked || 0, u.real_balance),
    emailVerified: !!u.email_verified,
    verifyStatus: u.verify_status,
    avatar: u.avatar_path ? `/api/avatar/${u.id}` : null
  };
}

/* ── профиль ── */
router.get('/me', auth, (req, res) => {
  res.json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id)) });
});

/* резервированные имена: нельзя занимать в нике/имени (F2) */
const RESERVED_NAMES = ['admin', 'administrator', 'moderator', 'support', 'staff', 'owner', 'root', 'system', 'official', 'synth', 'otc'];

router.put('/me', auth, (req, res) => {
  const b = req.body || {};
  const s = (v, max = 64) => String(v == null ? '' : v).slice(0, max).trim();
  const nick = s(b.nick, 24) || 'user', first = s(b.first);
  if (RESERVED_NAMES.includes(nick.toLowerCase()) || RESERVED_NAMES.includes(first.toLowerCase()))
    return res.status(400).json({ error: 'reserved_name' });
  /* PF: телефон — цифры 7–15 (+/пробелы/скобки допустимы); после KYC (ok/pending) first/last/dob/country заморожены */
  const phone = s(b.phone, 24);
  if (phone) {
    const dig = phone.replace(/\D/g, '');
    if (!/^[+0-9][0-9\s\-()]*$/.test(phone) || dig.length < 7 || dig.length > 15)
      return res.status(400).json({ error: 'bad_phone' });
  }
  const locked = req.user.verify_status === 'ok' || req.user.verify_status === 'pending';
  if (locked) {
    db.prepare(`UPDATE users SET phone=?, nick=?, hide_profile=? WHERE id=?`)
      .run(phone, nick, b.hide ? 1 : 0, req.user.id);
  } else {
    db.prepare(`UPDATE users SET first=?, last=?, phone=?, dob=?, country=?, nick=?, hide_profile=? WHERE id=?`)
      .run(first, s(b.last), phone, s(b.dob, 10), s(b.country, 8), nick, b.hide ? 1 : 0, req.user.id);
  }
  res.json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id)) });
});

router.post('/me/password', auth, (req, res) => {
  const cur = String(req.body.current || ''), next = String(req.body.next || '');
  if (!bcrypt.compareSync(cur, req.user.pass_hash)) return res.status(400).json({ error: 'bad_current' });
  if (next.length < 6) return res.status(400).json({ error: 'weak_password' });
  db.prepare('UPDATE users SET pass_hash=? WHERE id=?').run(bcrypt.hashSync(next, 10), req.user.id);
  res.json({ ok: true });
});

router.post('/me/verify-email', auth, (req, res) => {
  /* EM: демо без SMTP — статус не меняем; реальная отправка/код — на будущее */
  res.json({ ok: true });
});

/* ── аватар ── */
const avStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(UPLOADS, 'avatars')),
  filename: (req, file, cb) => cb(null, `u${req.user.id}.jpg`)
});
const avUpload = multer({
  storage: avStorage, limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /^image\/(jpeg|png|webp|gif)$/.test(file.mimetype))
});
router.post('/me/avatar', auth, avUpload.single('avatar'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'bad_image' });
  db.prepare('UPDATE users SET avatar_path=? WHERE id=?').run(req.file.path, req.user.id);
  res.json({ avatar: `/api/avatar/${req.user.id}` });
});
router.get('/avatar/:id', (req, res) => {
  const u = db.prepare('SELECT avatar_path FROM users WHERE id=?').get(req.params.id);
  if (!u || !u.avatar_path || !fs.existsSync(u.avatar_path)) return res.status(404).end();
  res.sendFile(u.avatar_path);
});

/* ── верификация (запрос от пользователя) ── */
const vrStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(UPLOADS, 'verify', String(req.user.id));
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const safe = file.originalname.replace(/[^\w.\-]+/g, '_').slice(-40);
    cb(null, `${Date.now()}-${Math.round(Math.random() * 1e6)}-${safe}`);
  }
});
const vrUpload = multer({
  storage: vrStorage, limits: { fileSize: 8 * 1024 * 1024, files: 3 },
  fileFilter: (req, file, cb) => cb(null, /^(image\/(jpeg|png|webp)|application\/pdf)$/.test(file.mimetype))
});
const DOC_TYPES = ['id', 'passport', 'residence'];
router.post('/verify', auth, vrUpload.fields([{ name: 'docs', maxCount: 2 }, { name: 'selfie', maxCount: 1 }]), (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
  if (!(u.first && u.last && u.dob))
    return res.status(400).json({ error: 'fill_profile_first' });
  if (u.verify_status === 'pending')
    return res.status(409).json({ error: 'already_pending' });
  const docType = String((req.body || {}).doc_type || '');
  if (!DOC_TYPES.includes(docType)) return res.status(400).json({ error: 'bad_doc_type' });
  const docs = (req.files && req.files.docs) || [];
  const selfies = (req.files && req.files.selfie) || [];
  if (!docs.length) return res.status(400).json({ error: 'no_doc_files' });
  if (!selfies.length) return res.status(400).json({ error: 'no_selfie' });
  const files = []
    .concat(docs.map(f => ({ n: f.filename, k: 'doc' })))
    .concat(selfies.map(f => ({ n: f.filename, k: 'selfie' })));
  db.prepare('INSERT INTO verifications (user_id, files, doc_type, status, created_at) VALUES (?,?,?,\'pending\',?)')
    .run(u.id, JSON.stringify(files), docType, now());
  db.prepare('UPDATE users SET verify_status=\'pending\' WHERE id=?').run(u.id);
  res.json({ ok: true });
});
router.get('/verify', auth, (req, res) => {
  const rows = db.prepare('SELECT id, status, reject_reason, doc_type, created_at, decided_at FROM verifications WHERE user_id=? ORDER BY id DESC')
    .all(req.user.id);
  res.json({ requests: rows });
});

/* ── сделки ── */
function tradeRow(t) {
  return {
    id: t.id, account: t.account, asset: t.asset, dir: t.dir, amount: t.amount,
    payoutPct: t.payout_pct, entryPrice: t.entry_price, entryTime: t.entry_time,
    closeTime: t.close_time, tfLabel: t.tf_label, status: t.status,
    closePrice: t.close_price, won: t.won == null ? null : !!t.won,
    tie: t.tie == null ? null : !!t.tie, payout: t.payout, profit: t.profit
  };
}

router.get('/trades', auth, (req, res) => {
  const acc = req.query.account === 'real' ? 'real' : 'demo';
  const open = db.prepare(`SELECT * FROM trades WHERE user_id=? AND account=? AND status='open' ORDER BY id`).all(req.user.id, acc).map(tradeRow);
  const closed = db.prepare(`SELECT * FROM trades WHERE user_id=? AND account=? AND status='closed' ORDER BY id DESC LIMIT 400`).all(req.user.id, acc).map(tradeRow);
  res.json({ open, closed, balances: balancesOf(req.user.id) });
});

router.post('/trades', auth, (req, res) => {
  const b = req.body || {};
  const account = b.account === 'real' ? 'real' : 'demo';
  const asset = ASSETS[b.asset];
  if (!asset) return res.status(400).json({ error: 'bad_asset' });
  if (b.dir !== 'UP' && b.dir !== 'DOWN') return res.status(400).json({ error: 'bad_dir' });
  const amount = Number(b.amount);
  const tlim = getSettings();
  if (!(amount >= tlim.minTrade && amount <= tlim.maxTrade)) return res.status(400).json({ error: 'bad_amount', min: tlim.minTrade, max: tlim.maxTrade });
  const expiry = Math.round(Number(b.expiry));
  if (!(expiry >= 5 && expiry <= 14400)) /* макс. 4 часа */ return res.status(400).json({ error: 'bad_expiry' });
  { /* рыночные часы: закрытый актив / экспирация за закрытием */
    const { isClosable:isCl, marketState:ms } = require('../market-hours');
    if (isCl(b.asset, asset.cat)) {
      const st = ms(getSettings().marketHours, now());
      if (st.closed) return res.status(403).json({ error: 'market_closed' });
      if (st.closesAt && now() + expiry > st.closesAt - 60)
        return res.status(400).json({ error: 'expiry_beyond_close', closesAt: st.closesAt });
    }
  }

  const col = account === 'demo' ? 'demo_balance' : 'real_balance';
  const u = db.prepare(`SELECT ${col} AS bal FROM users WHERE id=?`).get(req.user.id);
  if (u.bal < amount) return res.status(402).json({ error: 'insufficient_funds', balance: u.bal });

  const t = now();
  const info = db.transaction(() => {
    db.prepare(`UPDATE users SET ${col} = ${col} - ? WHERE id=? AND ${col} >= ?`)
      .run(amount, req.user.id, amount);
    return db.prepare(`INSERT INTO trades
      (user_id, account, asset, dir, amount, payout_pct, entry_price, entry_time, close_time, tf_label)
      VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(req.user.id, account, b.asset, b.dir, amount, asset.payout, asset.price(), t, t + expiry,
        String(b.tfLabel || '').slice(0, 8));
  })();
  const tr = db.prepare('SELECT * FROM trades WHERE id=?').get(info.lastInsertRowid);
  res.json({ trade: tradeRow(tr), balances: balancesOf(req.user.id) });
});

/* W: клиент сообщает язык системы — админка подбирает язык причины */
router.put('/lang', auth, (req, res) => {
  const OK = ['ru', 'en', 'fr', 'de', 'pt', 'es', 'it', 'hi'];
  const lang = String((req.body && req.body.lang) || '');
  if (!OK.includes(lang)) return res.status(400).json({ error: 'bad_lang' });
  db.prepare('UPDATE users SET lang=? WHERE id=?').run(lang, req.user.id);
  res.json({ ok: true });
});

/* ── чат с поддержкой (J2) ── */
const SUPPORT_AGENTS = ['John', 'Kevin', 'Sarah', 'Emma', 'Michael'];
router.get('/support/chats', authSupport, (req, res) => {
  const rows = db.prepare(`SELECT c.*,
    (SELECT m.text FROM chat_messages m WHERE m.chat_id=c.id AND m.deleted=0 ORDER BY m.id DESC LIMIT 1) AS last_msg,
    (SELECT m.created_at FROM chat_messages m WHERE m.chat_id=c.id AND m.deleted=0 ORDER BY m.id DESC LIMIT 1) AS last_at
    FROM chats c WHERE c.user_id=? ORDER BY c.id DESC`).all(req.user.id);
  res.json({ chats: rows });
});
router.get('/support/unread', authSupport, (req, res) => {
  const r = db.prepare('SELECT COALESCE(SUM(user_unread),0) n FROM chats WHERE user_id=?').get(req.user.id);
  res.json({ unread: Number(r.n) || 0 });
});
router.post('/support/chats', authSupport, (req, res) => {
  const specialist = SUPPORT_AGENTS[Math.floor(Math.random() * SUPPORT_AGENTS.length)];
  const r = db.prepare(`INSERT INTO chats (user_id, specialist, status, created_at) VALUES (?,?, 'open', ?)`)
    .run(req.user.id, specialist, now());
  res.json({ chat: { id: Number(r.lastInsertRowid), specialist, status: 'open', created_at: now() } });
});
router.get('/support/chats/:id/messages', authSupport, (req, res) => {
  const c = db.prepare('SELECT * FROM chats WHERE id=? AND user_id=?').get(req.params.id, req.user.id);
  if (!c) return res.status(404).json({ error: 'not_found' });
  db.prepare('UPDATE chats SET user_unread=0 WHERE id=?').run(c.id); /* юзер прочитал */
  res.json({
    specialist: c.specialist, status: c.status,
    messages: db.prepare('SELECT id, sender, text, created_at, files FROM chat_messages WHERE chat_id=? AND deleted=0 ORDER BY id')
      .all(c.id).map(m => ({
        id: m.id, sender: m.sender, text: m.text, created_at: m.created_at,
        files: parseFiles(m.files).map((f, i) => ({ m: f.m, s: f.s, o: f.o, url: `/api/support/chats/${c.id}/files/${m.id}/${i}` }))
      }))
  }); /* CHAT1: удалённые юзеру не отдаём, правки — только новый текст */
});
router.post('/support/chats/:id/messages', authSupport, chatFilesMw, (req, res) => {
  const c = db.prepare('SELECT id FROM chats WHERE id=? AND user_id=?').get(req.params.id, req.user.id);
  if (!c) { discardUpload(req); return res.status(404).json({ error: 'not_found' }); }
  const text = String((req.body && req.body.text) || '').trim().slice(0, 2000);
  let files = [];
  try { files = collectChatFiles(req); }
  catch (e) { return res.status(400).json({ error: e.code || 'bad_file' }); }
  if (!text && !files.length) return res.status(400).json({ error: 'empty' });
  const r = db.prepare('INSERT INTO chat_messages (chat_id, sender, text, created_at, files) VALUES (?,?,?,?,?)')
    .run(c.id, 'user', text, now(), JSON.stringify(files));
  db.prepare(`UPDATE chats SET status='open', admin_unread = admin_unread + 1 WHERE id=?`).run(c.id); /* CHAT1+CHAT7: красная точка; закрытый переоткрывается */
  res.json({ id: Number(r.lastInsertRowid) });
});
/* CHAT2: файл из сообщения (только свой чат; из удалённого сообщения — 404) */
router.get('/support/chats/:id/files/:mid/:idx', authSupport, (req, res) => {
  const c = db.prepare('SELECT id FROM chats WHERE id=? AND user_id=?').get(req.params.id, req.user.id);
  if (!c) return res.status(404).json({ error: 'not_found' });
  const m = db.prepare('SELECT files, deleted FROM chat_messages WHERE id=? AND chat_id=?').get(req.params.mid, c.id);
  if (!m || m.deleted) return res.status(404).end();
  const f = parseFiles(m.files)[Number(req.params.idx)];
  if (!f) return res.status(404).end();
  sendChatFile(res, c.id, f.n, f);
});

module.exports = router;
