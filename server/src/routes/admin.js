'use strict';
const express = require('express');
const path = require('path');
const db = require('../db');
const { UPLOADS } = require('../db');
const { admin } = require('../auth');
const bcrypt = require('bcryptjs');
/* N1: пароль-подтверждение смены кошельков (хранится только bcrypt-хэш) */
const WALLET_GUARD_HASH = '$2a$10$F.eORxa04A/.wuYDWuUhQ.ZdU5XhFkxFobpEuuMm37angL1wbabpG';

const router = express.Router();
router.use(admin); // всё ниже — только для роли admin

router.get('/me', (req, res) => {
  res.json({ user: { id: req.user.id, email: req.user.email, role: req.user.role, clientId: req.user.client_id } });
});
const now = () => Date.now() / 1000;

/* ── сводка для дашборда ── */
router.get('/stats', (req, res) => {
  const q = s => db.prepare(s).get().c;
  res.json({
    users: q(`SELECT COUNT(*) c FROM users WHERE role='user'`),
    blocked: q(`SELECT COUNT(*) c FROM users WHERE role='user' AND blocked=1`),
    pendingDeposits: q(`SELECT COUNT(*) c FROM deposits WHERE status='pending'`),
    pendingWithdrawals: q(`SELECT COUNT(*) c FROM withdrawals WHERE status='pending'`),
    pendingVerifications: q(`SELECT COUNT(*) c FROM verifications WHERE status='pending'`),
    openTrades: q(`SELECT COUNT(*) c FROM trades WHERE status='open'`)
  });
});

/* ── пользователи ── */
router.get('/users', (req, res) => {
  const s = String(req.query.search || '').trim();
  let sql = 'SELECT * FROM users', args = [];
  if (s) {
    sql += ' WHERE email LIKE ? OR client_id LIKE ? OR nick LIKE ?';
    args = [`%${s}%`, `%${s}%`, `%${s}%`];
  }
  sql += ' ORDER BY id LIMIT 500';
  res.json({
    users: db.prepare(sql).all(...args).map(u => ({
      id: u.id, email: u.email, clientId: u.client_id, role: u.role, blocked: !!u.blocked,
      created: u.created_at, verifyStatus: u.verify_status, emailVerified: !!u.email_verified,
      demo: u.demo_balance, real: u.real_balance, nick: u.nick
    }))
  });
});
router.post('/users/:id/block', (req, res) => {
  const u = db.prepare('SELECT id, role FROM users WHERE id=?').get(req.params.id);
  if (!u) return res.status(404).json({ error: 'not_found' });
  if (u.role === 'admin') return res.status(400).json({ error: 'cannot_block_admin' });
  db.prepare('UPDATE users SET blocked=1 WHERE id=?').run(u.id);
  db.prepare('DELETE FROM sessions WHERE user_id=?').run(u.id); // выкидываем из всех сессий
  res.json({ ok: true });
});
router.post('/users/:id/unblock', (req, res) => {
  const u = db.prepare('SELECT id FROM users WHERE id=?').get(req.params.id);
  if (!u) return res.status(404).json({ error: 'not_found' });
  db.prepare('UPDATE users SET blocked=0 WHERE id=?').run(u.id);
  res.json({ ok: true });
});

/* ── сделки всех пользователей ── */
router.get('/trades', (req, res) => {
  const lim = Math.min(500, parseInt(req.query.limit, 10) || 200);
  const w = [], args = [];
  if (req.query.user_id) { w.push('t.user_id=?'); args.push(Number(req.query.user_id)); }
  if (req.query.status === 'open' || req.query.status === 'closed') { w.push('t.status=?'); args.push(req.query.status); }
  const sql = `SELECT t.*, u.email FROM trades t JOIN users u ON u.id=t.user_id`
    + (w.length ? ' WHERE ' + w.join(' AND ') : '')
    + ` ORDER BY t.id DESC LIMIT ?`;
  args.push(lim);
  res.json({ trades: db.prepare(sql).all(...args) });
});

/* ── депозиты: очередь, апрув/реджект ── */
router.get('/deposits', (req, res) => {
  let sql = 'SELECT d.*, u.email FROM deposits d JOIN users u ON u.id=d.user_id';
  const args = [];
  if (['pending', 'done', 'rejected'].includes(req.query.status)) { sql += ' WHERE d.status=?'; args.push(req.query.status); }
  sql += ' ORDER BY d.id DESC LIMIT 500';
  res.json({ deposits: db.prepare(sql).all(...args) });
});
router.post('/deposits/:id/approve', (req, res) => {
  const d = db.prepare('SELECT * FROM deposits WHERE id=?').get(req.params.id);
  if (!d) return res.status(404).json({ error: 'not_found' });
  if (d.status !== 'pending') return res.status(409).json({ error: 'already_decided' });
  db.transaction(() => {
    db.prepare(`UPDATE deposits SET status='done', decided_at=?, decided_by=? WHERE id=?`)
      .run(now(), req.user.id, d.id);
    db.prepare('UPDATE users SET real_balance = real_balance + ? WHERE id=?')
      .run(d.amount + d.bonus, d.user_id);
    if (d.promo_code)
      db.prepare('UPDATE promocodes SET uses = uses + 1 WHERE UPPER(code)=UPPER(?)').run(d.promo_code);
    /* O1: бонус запирается до открутки вейджера (множитель из промокода) */
    if (d.bonus > 0) {
      const pr = db.prepare('SELECT wager_mult FROM promocodes WHERE UPPER(code)=UPPER(?)').get(d.promo_code);
      const mult = (pr && pr.wager_mult > 0) ? pr.wager_mult : 20;
      db.prepare('UPDATE users SET bonus_locked = bonus_locked + ?, wager_need = wager_need + ? WHERE id=?')
        .run(d.bonus, d.bonus * mult, d.user_id);
    }
  })();
  res.json({ ok: true, credited: d.amount + d.bonus });
});
router.post('/deposits/:id/reject', (req, res) => {
  const d = db.prepare('SELECT * FROM deposits WHERE id=?').get(req.params.id);
  if (!d) return res.status(404).json({ error: 'not_found' });
  if (d.status !== 'pending') return res.status(409).json({ error: 'already_decided' });
  db.prepare(`UPDATE deposits SET status='rejected', reject_reason=?, decided_at=?, decided_by=? WHERE id=?`)
    .run(String(req.body.reason || '').slice(0, 300), now(), req.user.id, d.id);
  res.json({ ok: true });
});

/* ── выводы: очередь, апрув/реджект (при реджекте деньги возвращаются) ── */
router.get('/withdrawals', (req, res) => {
  let sql = 'SELECT w.*, u.email, u.lang AS user_lang FROM withdrawals w JOIN users u ON u.id=w.user_id';
  const args = [];
  if (['pending', 'done', 'rejected'].includes(req.query.status)) { sql += ' WHERE w.status=?'; args.push(req.query.status); }
  sql += ' ORDER BY w.id DESC LIMIT 500';
  res.json({ withdrawals: db.prepare(sql).all(...args) });
});
router.post('/withdrawals/:id/approve', (req, res) => {
  const w = db.prepare('SELECT * FROM withdrawals WHERE id=?').get(req.params.id);
  if (!w) return res.status(404).json({ error: 'not_found' });
  if (w.status !== 'pending') return res.status(409).json({ error: 'already_decided' });
  db.prepare(`UPDATE withdrawals SET status='done', decided_at=?, decided_by=? WHERE id=?`)
    .run(now(), req.user.id, w.id);
  res.json({ ok: true });
});
router.post('/withdrawals/:id/reject', (req, res) => {
  const w = db.prepare('SELECT * FROM withdrawals WHERE id=?').get(req.params.id);
  if (!w) return res.status(404).json({ error: 'not_found' });
  if (w.status !== 'pending') return res.status(409).json({ error: 'already_decided' });
  db.transaction(() => {
    db.prepare(`UPDATE withdrawals SET status='rejected', reject_reason=?, decided_at=?, decided_by=? WHERE id=?`)
      .run(String(req.body.reason || '').slice(0, 300), now(), req.user.id, w.id);
    db.prepare('UPDATE users SET real_balance = real_balance + ? WHERE id=?')
      .run(w.amount, w.user_id); // возврат средств
  })();
  res.json({ ok: true, refunded: w.amount });
});

/* ── верификация (KYC): очередь, просмотр файлов, решение ── */
function parseVFiles(raw) {
  try {
    return JSON.parse(raw || '[]').map(f => typeof f === 'string' ? { n: f, k: 'doc' } : f);
  } catch (e) { return []; }
}
router.get('/verifications', (req, res) => {
  let sql = 'SELECT v.*, u.email, u.first, u.last, u.dob, u.country FROM verifications v JOIN users u ON u.id=v.user_id';
  const args = [];
  if (['pending', 'ok', 'rejected'].includes(req.query.status)) { sql += ' WHERE v.status=?'; args.push(req.query.status); }
  sql += ' ORDER BY v.id DESC LIMIT 500';
  res.json({
    verifications: db.prepare(sql).all(...args).map(v => ({
      ...v, docType: v.doc_type || '', files: parseVFiles(v.files)
    }))
  });
});
router.get('/verifications/:id', (req, res) => {
  const v = db.prepare('SELECT v.*, u.email, u.first, u.last, u.dob, u.country FROM verifications v JOIN users u ON u.id=v.user_id WHERE v.id=?')
    .get(req.params.id);
  if (!v) return res.status(404).json({ error: 'not_found' });
  const files = parseVFiles(v.files).map((f, i) => ({ ...f, url: `/api/admin/verifications/${v.id}/file/${i}` }));
  res.json({ verification: { ...v, docType: v.doc_type || '', files } });
});
router.get('/verifications/:id/file/:idx', (req, res) => {
  const v = db.prepare('SELECT * FROM verifications WHERE id=?').get(req.params.id);
  if (!v) return res.status(404).json({ error: 'not_found' });
  const f = parseVFiles(v.files)[Number(req.params.idx)];
  if (!f) return res.status(404).json({ error: 'not_found' });
  res.sendFile(path.join(UPLOADS, 'verify', String(v.user_id), path.basename(f.n)));
});
router.post('/verifications/:id/approve', (req, res) => {
  const v = db.prepare('SELECT * FROM verifications WHERE id=?').get(req.params.id);
  if (!v) return res.status(404).json({ error: 'not_found' });
  if (v.status !== 'pending') return res.status(409).json({ error: 'already_decided' });
  db.transaction(() => {
    db.prepare(`UPDATE verifications SET status='ok', decided_at=?, decided_by=? WHERE id=?`)
      .run(now(), req.user.id, v.id);
    db.prepare(`UPDATE users SET verify_status='ok' WHERE id=?`).run(v.user_id);
  })();
  res.json({ ok: true });
});
router.post('/verifications/:id/reject', (req, res) => {
  const v = db.prepare('SELECT * FROM verifications WHERE id=?').get(req.params.id);
  if (!v) return res.status(404).json({ error: 'not_found' });
  if (v.status !== 'pending') return res.status(409).json({ error: 'already_decided' });
  db.transaction(() => {
    db.prepare(`UPDATE verifications SET status='rejected', reject_reason=?, decided_at=?, decided_by=? WHERE id=?`)
      .run(String(req.body.reason || '').slice(0, 300), now(), req.user.id, v.id);
    db.prepare(`UPDATE users SET verify_status='rejected' WHERE id=?`).run(v.user_id);
  })();
  res.json({ ok: true });
});

/* ── кошельки: редактирование адресов + лог изменений ── */
const { METHODS } = require('./finance');
router.get('/wallets', (req, res) => {
  res.json({
    wallets: METHODS.map(m => {
      const w = db.prepare('SELECT addr, updated_at FROM wallets WHERE method_id=?').get(m.id);
      return { id: m.id, name: m.name, sym: m.sym, net: m.net, addr: w ? w.addr : m.addr, updatedAt: w ? w.updated_at : null };
    }),
    log: db.prepare(`SELECT l.*, u.email AS by_email FROM wallet_log l LEFT JOIN users u ON u.id=l.changed_by ORDER BY l.id DESC LIMIT 100`).all()
  });
});
router.put('/wallets/:id', (req, res) => {
  const m = METHODS.find(x => x.id === req.params.id);
  if (!m) return res.status(404).json({ error: 'not_found' });
  const guard = String((req.body || {}).guard || '');
  if (!bcrypt.compareSync(guard, WALLET_GUARD_HASH)) return res.status(403).json({ error: 'bad_guard' });
  const addr = String((req.body || {}).addr || '').trim();
  if (addr.length < 10) return res.status(400).json({ error: 'bad_addr' });
  const cur = db.prepare('SELECT addr FROM wallets WHERE method_id=?').get(m.id);
  const old = cur ? cur.addr : m.addr;
  if (old === addr) return res.json({ ok: true, changed: false });
  db.prepare(`INSERT INTO wallets (method_id, addr, updated_at, updated_by) VALUES (?,?,?,?)
    ON CONFLICT(method_id) DO UPDATE SET addr=excluded.addr, updated_at=excluded.updated_at, updated_by=excluded.updated_by`)
    .run(m.id, addr, now(), req.user.id);
  db.prepare('INSERT INTO wallet_log (method_id, old_addr, new_addr, changed_by, changed_at) VALUES (?,?,?,?,?)')
    .run(m.id, old, addr, req.user.id, now());
  res.json({ ok: true, changed: true });
});

/* ── промокоды ── */
router.get('/promos', (req, res) => {
  res.json({ promos: db.prepare('SELECT * FROM promocodes ORDER BY id DESC').all() });
});
router.post('/promos', (req, res) => {
  const code = String(req.body.code || '').trim().toUpperCase();
  const pct = Number(req.body.bonus_pct);
  if (!/^[A-Z0-9_-]{3,32}$/.test(code)) return res.status(400).json({ error: 'bad_code' });
  if (!(pct > 0 && pct <= 1000)) return res.status(400).json({ error: 'bad_pct' });
  if (db.prepare('SELECT id FROM promocodes WHERE UPPER(code)=?').get(code))
    return res.status(409).json({ error: 'exists' });
  const mult = Number(req.body.wager_mult);
  db.prepare('INSERT INTO promocodes (code, bonus_pct, active, created_at, wager_mult) VALUES (?,?,1,?,?)')
    .run(code, pct, now(), (mult > 0 && mult <= 1000) ? mult : 20);
  res.json({ ok: true });
});
router.post('/promos/:id/toggle', (req, res) => {
  const p = db.prepare('SELECT * FROM promocodes WHERE id=?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'not_found' });
  db.prepare('UPDATE promocodes SET active = 1 - active WHERE id=?').run(p.id);
  res.json({ ok: true, active: !p.active });
});

/* ── L1: пресеты причин отклонения вывода ── */
router.get('/presets', (req, res) => {
  res.json({ presets: db.prepare('SELECT slot, text, tr FROM reject_presets ORDER BY slot').all().map(p => {
    let tr = {}; try { tr = JSON.parse(p.tr || '{}'); } catch (e) {}
    return { slot: p.slot, text: p.text, tr };
  }) });
});
router.put('/presets', (req, res) => { /* W: слот = строка (legacy) или {text, tr:{lang:text}} */
  const slots = (req.body && req.body.slots) || {};
  for (let i = 1; i <= 6; i++) {
    const v = slots[i];
    if (v && typeof v === 'object') {
      const tr = {}; for (const k in (v.tr || {})) if (typeof v.tr[k] === 'string') tr[k] = v.tr[k].slice(0, 300);
      db.prepare('UPDATE reject_presets SET text=?, tr=? WHERE slot=?').run(String(v.text || '').slice(0, 300), JSON.stringify(tr), i);
    } else if (v != null) {
      db.prepare('UPDATE reject_presets SET text=? WHERE slot=?').run(String(v).slice(0, 300), i);
    }
  }
  res.json({ ok: true });
});

/* ── чаты поддержки (J2) ── */
router.get('/chats', (req, res) => {
  const rows = db.prepare(`SELECT c.*, u.email, u.client_id,
    (SELECT m.text FROM chat_messages m WHERE m.chat_id=c.id ORDER BY m.id DESC LIMIT 1) AS last_msg,
    (SELECT m.created_at FROM chat_messages m WHERE m.chat_id=c.id ORDER BY m.id DESC LIMIT 1) AS last_at
    FROM chats c LEFT JOIN users u ON u.id=c.user_id ORDER BY last_at DESC, c.id DESC`).all();
  res.json({ chats: rows });
});
router.get('/chats/:id/messages', (req, res) => {
  const c = db.prepare('SELECT c.*, u.email FROM chats c LEFT JOIN users u ON u.id=c.user_id WHERE c.id=?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'not_found' });
  res.json({ chat: c, messages: db.prepare('SELECT id, sender, text, created_at FROM chat_messages WHERE chat_id=? ORDER BY id').all(c.id) });
});
router.post('/chats/:id/messages', (req, res) => {
  const text = String((req.body && req.body.text) || '').trim().slice(0, 2000);
  if (!text) return res.status(400).json({ error: 'empty' });
  const c = db.prepare('SELECT id FROM chats WHERE id=?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'not_found' });
  const r = db.prepare('INSERT INTO chat_messages (chat_id, sender, text, created_at) VALUES (?,?,?,?)').run(c.id, 'support', text, Date.now() / 1000);
  res.json({ id: Number(r.lastInsertRowid) });
});

module.exports = router;
