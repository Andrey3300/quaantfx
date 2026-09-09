'use strict';
const express = require('express');
const path = require('path');
const db = require('../db');
const { UPLOADS } = require('../db');
const { admin } = require('../auth');
const { getSettings, saveSettings, DEFAULTS, LANGS, getDepositInstr, saveDepositInstr } = require('../settings'); /* PLAT1 */
const { ASSETS } = require('../engine'); /* PLAT1: проверка активов в выплатах */
const bcrypt = require('bcryptjs');
const { chatFilesMw, collectChatFiles, discardUpload, parseFiles, sendChatFile,
  quickUploadMw, collectQuickFiles, copyQuickFiles, unlinkQuickFiles, sendQuickFile, MAX_FILES } = require('../chatfiles'); /* CHAT2+CHAT4 */
/* N1: пароль-подтверждение смены кошельков (хранится только bcrypt-хэш) */
const WALLET_GUARD_HASH = '$2a$10$F.eORxa04A/.wuYDWuUhQ.ZdU5XhFkxFobpEuuMm37angL1wbabpG';

const router = express.Router();
router.use(admin); // всё ниже — только персонал (admin/moder)

/* ── STAFF1: права по разделам 0=нет 1=смотреть 2=делать; admin = всё ── */
const STAFF_SECTIONS=['dash','users','trades','deposits','withdrawals','verify','promos','wallets','chats','contacts'];
function need(sec,lvl){ return (req,res,next)=>{
  if(req.user.role==='admin') return next();
  let p={}; try{ p=JSON.parse(req.user.perms||'{}'); }catch(e){}
  if((Number(p[sec])||0)>=lvl) return next();
  return res.status(403).json({ error:'forbidden' });
};}
function adminOnly(req,res,next){
  if(req.user.role==='admin') return next();
  return res.status(403).json({ error:'forbidden' });
}
/* FIX2: подпись юзера email + видимый ID; поиск юзера по id/client_id/email */
function userLabel(id){
  const u=db.prepare('SELECT email,client_id FROM users WHERE id=?').get(id);
  return u?`${u.email} · #${u.client_id}`:'user#'+id;
}
function resolveUser(q){
  q=String(q||'').trim(); if(!q) return null;
  let u=db.prepare(`SELECT id FROM users WHERE role='user' AND (CAST(id AS TEXT)=? OR client_id=? OR email=?)`).get(q,q,q);
  if(!u){ const e=q.replace(/[%_\\]/g,'\\$&');
    u=db.prepare(`SELECT id FROM users WHERE role='user' AND email LIKE ? ESCAPE '\\'`).get(`%${e}%`); }
  return u?u.id:null;
}
function logAdmin(req,action,target,detail){
  try{ db.prepare('INSERT INTO admin_log (actor_id,actor_email,action,target,detail,created_at) VALUES (?,?,?,?,?,?)')
    .run(req.user.id,req.user.email,action,String(target||''),String(detail||''),now()); }catch(e){}
}

router.get('/me', (req, res) => {
  let perms='all';
  if(req.user.role!=='admin'){ try{ perms=JSON.parse(req.user.perms||'{}'); }catch(e){ perms={}; } }
  res.json({ user: { id: req.user.id, email: req.user.email, role: req.user.role, clientId: req.user.client_id, nick: req.user.nick||'', perms } });
});
const now = () => Date.now() / 1000;

/* ── сводка для дашборда ── */
router.get('/stats', need('dash',1), (req, res) => {
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
router.get('/users', need('users',1), (req, res) => {
  const s = String(req.query.search || '').trim();
  let sql = `SELECT * FROM users WHERE role='user'`, args = [];
  if (s) {
    sql += ' AND (email LIKE ? OR client_id LIKE ? OR nick LIKE ?)';
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
router.post('/users/:id/block', need('users',2), (req, res) => {
  const u = db.prepare('SELECT id, email, role FROM users WHERE id=?').get(req.params.id);
  if (!u) return res.status(404).json({ error: 'not_found' });
  if (u.role !== 'user') return res.status(400).json({ error: 'cannot_block_admin' }); /* STAFF1: персонал — через вкладку Команда */
  db.prepare('UPDATE users SET blocked=1 WHERE id=?').run(u.id);
  db.prepare('DELETE FROM sessions WHERE user_id=?').run(u.id); // выкидываем из всех сессий
  logAdmin(req,'user.block',u.email,'');
  res.json({ ok: true });
});
router.post('/users/:id/unblock', need('users',2), (req, res) => {
  const u = db.prepare('SELECT id, email, role FROM users WHERE id=?').get(req.params.id);
  if (!u) return res.status(404).json({ error: 'not_found' });
  if (u.role !== 'user') return res.status(400).json({ error: 'cannot_block_admin' });
  db.prepare('UPDATE users SET blocked=0 WHERE id=?').run(u.id);
  logAdmin(req,'user.unblock',u.email,'');
  res.json({ ok: true });
});

/* ── сделки всех пользователей ── */
router.get('/trades', need('trades',1), (req, res) => {
  const lim = Math.min(500, parseInt(req.query.limit, 10) || 200);
  const w = [], args = [];
  if (req.query.user) { const uid = resolveUser(req.query.user);
    if (uid) { w.push('t.user_id=?'); args.push(uid); } else w.push('1=0');
  } else if (req.query.user_id) { w.push('t.user_id=?'); args.push(Number(req.query.user_id)); }
  if (req.query.status === 'open' || req.query.status === 'closed') { w.push('t.status=?'); args.push(req.query.status); }
  const sql = `SELECT t.*, u.email FROM trades t JOIN users u ON u.id=t.user_id`
    + (w.length ? ' WHERE ' + w.join(' AND ') : '')
    + ` ORDER BY t.id DESC LIMIT ?`;
  args.push(lim);
  res.json({ trades: db.prepare(sql).all(...args) });
});

/* ── депозиты: очередь, апрув/реджект ── */
router.get('/deposits', need('deposits',1), (req, res) => {
  let sql = 'SELECT d.*, u.email FROM deposits d JOIN users u ON u.id=d.user_id';
  const args = [], cond = [];
  if (['pending', 'done', 'rejected'].includes(req.query.status)) { cond.push('d.status=?'); args.push(req.query.status); }
  if (req.query.user) { const uid = resolveUser(req.query.user);
    if (uid) { cond.push('d.user_id=?'); args.push(uid); } else cond.push('1=0'); }
  if (cond.length) sql += ' WHERE ' + cond.join(' AND ');
  sql += ' ORDER BY d.id DESC LIMIT 500';
  res.json({ deposits: db.prepare(sql).all(...args) });
});
router.get('/deposit-instructions', need('wallets',1), (req, res) => {
  res.json({ langs: LANGS, instructions: getDepositInstr() });
});
router.put('/deposit-instructions', need('wallets',2), (req, res) => {
  saveDepositInstr((req.body&&req.body.instructions)||{});
  logAdmin(req,'deposit-instr.update','platform','инструкция пополнения обновлена');
  res.json({ instructions: getDepositInstr() });
});
router.get('/deposits/:id/screenshot', need('deposits',1), (req, res) => {
  const d = db.prepare('SELECT user_id, screenshot FROM deposits WHERE id=?').get(req.params.id);
  if (!d || !d.screenshot) return res.status(404).json({ error: 'not_found' });
  res.sendFile(path.join(UPLOADS, 'deposits', String(d.user_id), path.basename(d.screenshot)));
});
router.post('/deposits/:id/approve', need('deposits',2), (req, res) => {
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
      const mult = (pr && pr.wager_mult > 0) ? pr.wager_mult : (getSettings().defaultWager || 20); /* PLAT1 */
      db.prepare('UPDATE users SET bonus_locked = bonus_locked + ?, wager_need = wager_need + ? WHERE id=?')
        .run(d.bonus, d.bonus * mult, d.user_id);
    }
  })();
  logAdmin(req,'deposit.approve','#'+d.id,'$'+(d.amount+d.bonus)+' → '+userLabel(d.user_id));
  res.json({ ok: true, credited: d.amount + d.bonus });
});
router.post('/deposits/:id/reject', need('deposits',2), (req, res) => {
  const d = db.prepare('SELECT * FROM deposits WHERE id=?').get(req.params.id);
  if (!d) return res.status(404).json({ error: 'not_found' });
  if (d.status !== 'pending') return res.status(409).json({ error: 'already_decided' });
  db.prepare(`UPDATE deposits SET status='rejected', reject_reason=?, decided_at=?, decided_by=? WHERE id=?`)
    .run(String(req.body.reason || '').slice(0, 300), now(), req.user.id, d.id);
  logAdmin(req,'deposit.reject','#'+d.id,userLabel(d.user_id)+(req.body.reason?': '+String(req.body.reason).slice(0,100):''));
  res.json({ ok: true });
});

/* ── выводы: очередь, апрув/реджект (при реджекте деньги возвращаются) ── */
router.get('/withdrawals', need('withdrawals',1), (req, res) => {
  let sql = 'SELECT w.*, u.email, u.lang AS user_lang FROM withdrawals w JOIN users u ON u.id=w.user_id';
  const args = [], cond = [];
  if (['pending', 'done', 'rejected'].includes(req.query.status)) { cond.push('w.status=?'); args.push(req.query.status); }
  if (req.query.user) { const uid = resolveUser(req.query.user);
    if (uid) { cond.push('w.user_id=?'); args.push(uid); } else cond.push('1=0'); }
  if (cond.length) sql += ' WHERE ' + cond.join(' AND ');
  sql += ' ORDER BY w.id DESC LIMIT 500';
  res.json({ withdrawals: db.prepare(sql).all(...args) });
});
router.post('/withdrawals/:id/approve', need('withdrawals',2), (req, res) => {
  const w = db.prepare('SELECT * FROM withdrawals WHERE id=?').get(req.params.id);
  if (!w) return res.status(404).json({ error: 'not_found' });
  if (w.status !== 'pending') return res.status(409).json({ error: 'already_decided' });
  db.prepare(`UPDATE withdrawals SET status='done', decided_at=?, decided_by=? WHERE id=?`)
    .run(now(), req.user.id, w.id);
  logAdmin(req,'withdrawal.approve','#'+w.id,'$'+w.amount+' '+userLabel(w.user_id));
  res.json({ ok: true });
});
router.post('/withdrawals/:id/reject', need('withdrawals',2), (req, res) => {
  const w = db.prepare('SELECT * FROM withdrawals WHERE id=?').get(req.params.id);
  if (!w) return res.status(404).json({ error: 'not_found' });
  if (w.status !== 'pending') return res.status(409).json({ error: 'already_decided' });
  db.transaction(() => {
    db.prepare(`UPDATE withdrawals SET status='rejected', reject_reason=?, decided_at=?, decided_by=? WHERE id=?`)
      .run(String(req.body.reason || '').slice(0, 300), now(), req.user.id, w.id);
    db.prepare('UPDATE users SET real_balance = real_balance + ? WHERE id=?')
      .run(w.amount, w.user_id); // возврат средств
  })();
  logAdmin(req,'withdrawal.reject','#'+w.id,'возврат $'+w.amount+' '+userLabel(w.user_id)+(req.body.reason?': '+String(req.body.reason).slice(0,100):''));
  res.json({ ok: true, refunded: w.amount });
});

/* ── верификация (KYC): очередь, просмотр файлов, решение ── */
function parseVFiles(raw) {
  try {
    return JSON.parse(raw || '[]').map(f => typeof f === 'string' ? { n: f, k: 'doc' } : f);
  } catch (e) { return []; }
}
router.get('/verifications', need('verify',1), (req, res) => {
  let sql = 'SELECT v.*, u.email, u.first, u.last, u.dob, u.country FROM verifications v JOIN users u ON u.id=v.user_id';
  const args = [], cond = [];
  if (['pending', 'ok', 'rejected'].includes(req.query.status)) { cond.push('v.status=?'); args.push(req.query.status); }
  if (req.query.user) { const uid = resolveUser(req.query.user);
    if (uid) { cond.push('v.user_id=?'); args.push(uid); } else cond.push('1=0'); }
  if (cond.length) sql += ' WHERE ' + cond.join(' AND ');
  sql += ' ORDER BY v.id DESC LIMIT 500';
  res.json({
    verifications: db.prepare(sql).all(...args).map(v => ({
      ...v, docType: v.doc_type || '', files: parseVFiles(v.files)
    }))
  });
});
router.get('/verifications/:id', need('verify',1), (req, res) => {
  const v = db.prepare('SELECT v.*, u.email, u.first, u.last, u.dob, u.country FROM verifications v JOIN users u ON u.id=v.user_id WHERE v.id=?')
    .get(req.params.id);
  if (!v) return res.status(404).json({ error: 'not_found' });
  const files = parseVFiles(v.files).map((f, i) => ({ ...f, url: `/api/admin/verifications/${v.id}/file/${i}` }));
  res.json({ verification: { ...v, docType: v.doc_type || '', files } });
});
router.get('/verifications/:id/file/:idx', need('verify',1), (req, res) => {
  const v = db.prepare('SELECT * FROM verifications WHERE id=?').get(req.params.id);
  if (!v) return res.status(404).json({ error: 'not_found' });
  const f = parseVFiles(v.files)[Number(req.params.idx)];
  if (!f) return res.status(404).json({ error: 'not_found' });
  res.sendFile(path.join(UPLOADS, 'verify', String(v.user_id), path.basename(f.n)));
});
router.post('/verifications/:id/approve', need('verify',2), (req, res) => {
  const v = db.prepare('SELECT * FROM verifications WHERE id=?').get(req.params.id);
  if (!v) return res.status(404).json({ error: 'not_found' });
  if (v.status !== 'pending') return res.status(409).json({ error: 'already_decided' });
  db.transaction(() => {
    db.prepare(`UPDATE verifications SET status='ok', decided_at=?, decided_by=? WHERE id=?`)
      .run(now(), req.user.id, v.id);
    db.prepare(`UPDATE users SET verify_status='ok' WHERE id=?`).run(v.user_id);
  })();
  logAdmin(req,'verify.approve','#'+v.id,userLabel(v.user_id));
  res.json({ ok: true });
});
router.post('/verifications/:id/reject', need('verify',2), (req, res) => {
  const v = db.prepare('SELECT * FROM verifications WHERE id=?').get(req.params.id);
  if (!v) return res.status(404).json({ error: 'not_found' });
  if (v.status !== 'pending') return res.status(409).json({ error: 'already_decided' });
  db.transaction(() => {
    db.prepare(`UPDATE verifications SET status='rejected', reject_reason=?, decided_at=?, decided_by=? WHERE id=?`)
      .run(String(req.body.reason || '').slice(0, 300), now(), req.user.id, v.id);
    db.prepare(`UPDATE users SET verify_status='rejected' WHERE id=?`).run(v.user_id);
  })();
  logAdmin(req,'verify.reject','#'+v.id,userLabel(v.user_id)+(req.body.reason?': '+String(req.body.reason).slice(0,100):''));
  res.json({ ok: true });
});

/* ── кошельки: редактирование адресов + лог изменений ── */
const { METHODS } = require('./finance');
router.get('/wallets', need('wallets',1), (req, res) => {
  res.json({
    wallets: METHODS.map(m => {
      const w = db.prepare('SELECT addr, updated_at FROM wallets WHERE method_id=?').get(m.id);
      return { id: m.id, name: m.name, sym: m.sym, net: m.net, addr: w ? w.addr : m.addr, updatedAt: w ? w.updated_at : null };
    }),
    log: db.prepare(`SELECT l.*, u.email AS by_email FROM wallet_log l LEFT JOIN users u ON u.id=l.changed_by ORDER BY l.id DESC LIMIT 100`).all()
  });
});
router.put('/wallets/:id', need('wallets',2), (req, res) => {
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
  logAdmin(req,'wallet.update',m.id,old.slice(0,24)+'… → '+addr.slice(0,24)+'…');
  res.json({ ok: true, changed: true });
});

/* ── промокоды ── */
router.get('/promos', need('promos',1), (req, res) => {
  res.json({ promos: db.prepare('SELECT * FROM promocodes ORDER BY id DESC').all() });
});
router.post('/promos', need('promos',2), (req, res) => {
  const code = String(req.body.code || '').trim().toUpperCase();
  const pct = Number(req.body.bonus_pct);
  if (!/^[A-Z0-9_-]{3,32}$/.test(code)) return res.status(400).json({ error: 'bad_code' });
  if (!(pct > 0 && pct <= 1000)) return res.status(400).json({ error: 'bad_pct' });
  if (db.prepare('SELECT id FROM promocodes WHERE UPPER(code)=?').get(code))
    return res.status(409).json({ error: 'exists' });
  const mult = Number(req.body.wager_mult);
  db.prepare('INSERT INTO promocodes (code, bonus_pct, active, created_at, wager_mult) VALUES (?,?,1,?,?)')
    .run(code, pct, now(), (mult > 0 && mult <= 1000) ? mult : 20);
  logAdmin(req,'promo.create',code,pct+'%');
  res.json({ ok: true });
});
router.post('/promos/:id/toggle', need('promos',2), (req, res) => {
  const p = db.prepare('SELECT * FROM promocodes WHERE id=?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'not_found' });
  db.prepare('UPDATE promocodes SET active = 1 - active WHERE id=?').run(p.id);
  logAdmin(req,'promo.toggle',p.code,!p.active?'вкл':'выкл');
  res.json({ ok: true, active: !p.active });
});
router.delete('/promos/:id', need('promos',2), (req, res) => {
  const p = db.prepare('SELECT * FROM promocodes WHERE id=?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'not_found' });
  db.prepare('DELETE FROM promocodes WHERE id=?').run(p.id);
  logAdmin(req,'promo.delete',p.code,p.bonus_pct+'%');
  res.json({ ok: true });
});

/* ── L1: пресеты причин отклонения вывода ── */
router.get('/presets', need('withdrawals',1), (req, res) => {
  res.json({ presets: db.prepare('SELECT slot, text, tr FROM reject_presets ORDER BY slot').all().map(p => {
    let tr = {}; try { tr = JSON.parse(p.tr || '{}'); } catch (e) {}
    return { slot: p.slot, text: p.text, tr };
  }) });
});
router.put('/presets', need('withdrawals',2), (req, res) => { /* W: слот = строка (legacy) или {text, tr:{lang:text}} */
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
  logAdmin(req,'presets.update','','');
  res.json({ ok: true });
});

/* ── контакты для страницы условий (видны всем на /terms.html) ── */
router.get('/contacts', need('contacts',1), (req, res) => {
  res.json({ contacts: db.getContacts() });
});
router.put('/contacts', need('contacts',2), (req, res) => {
  try {
    res.json({ ok: true, contacts: db.setContacts(req.body || {}) });
  } catch (e) {
    res.status(400).json({ error: e.message === 'bad_email' ? 'bad_email' : 'bad_request' });
  }
});

/* ── чаты поддержки (J2 + CHAT1: непрочитанные, правки, удаления) ── */
router.get('/chats', need('chats',1), (req, res) => {
  const cond=[],args=[];
  if(req.query.status==='open'||req.query.status==='closed'){ cond.push('c.status=?'); args.push(req.query.status); }
  if(req.query.tag){ cond.push('EXISTS(SELECT 1 FROM chat_tag_map m WHERE m.chat_id=c.id AND m.tag_id=?)'); args.push(Number(req.query.tag)); }
  if(req.query.search){ const q=String(req.query.search).trim().replace(/[%_\\]/g,'\\$&');
    cond.push(`(u.email LIKE ? ESCAPE '\\' OR u.client_id LIKE ? ESCAPE '\\' OR EXISTS(SELECT 1 FROM chat_messages m WHERE m.chat_id=c.id AND m.deleted=0 AND m.text LIKE ? ESCAPE '\\'))`);
    args.push(`%${q}%`,`%${q}%`,`%${q}%`); }
  const rows = db.prepare(`SELECT c.*, u.email, u.client_id,
    (SELECT m.text FROM chat_messages m WHERE m.chat_id=c.id AND m.deleted=0 ORDER BY m.id DESC LIMIT 1) AS last_msg,
    (SELECT m.created_at FROM chat_messages m WHERE m.chat_id=c.id AND m.deleted=0 ORDER BY m.id DESC LIMIT 1) AS last_at,
    (SELECT m.files FROM chat_messages m WHERE m.chat_id=c.id AND m.deleted=0 ORDER BY m.id DESC LIMIT 1) AS last_files
    FROM chats c LEFT JOIN users u ON u.id=c.user_id`
    +(cond.length?' WHERE '+cond.join(' AND '):'')
    +` ORDER BY (c.status='closed'), last_at DESC, c.id DESC LIMIT 500`).all(...args);
  const tmap={};
  try{ for(const r of db.prepare('SELECT m.chat_id, t.id, t.name, t.color FROM chat_tag_map m JOIN chat_tags t ON t.id=m.tag_id').all())
    (tmap[r.chat_id]=tmap[r.chat_id]||[]).push({id:r.id,name:r.name,color:r.color}); }catch(e){}
  res.json({ chats: rows.map(c => ({ ...c, unread: c.admin_unread || 0, lastFiles: parseFiles(c.last_files).length, tags: tmap[c.id]||[] })) });
});
router.get('/chats/:id/messages', need('chats',1), (req, res) => {
  const c = db.prepare('SELECT c.*, u.email, u.client_id, u.demo_balance, u.real_balance, u.country, u.lang, u.verify_status FROM chats c LEFT JOIN users u ON u.id=c.user_id WHERE c.id=?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'not_found' });
  db.prepare('UPDATE chats SET admin_unread=0 WHERE id=?').run(c.id); /* админ открыл чат — прочитано */
  res.json({
    chat: c,
    messages: db.prepare('SELECT id, sender, text, created_at, orig_text, edited_at, deleted, files FROM chat_messages WHERE chat_id=? ORDER BY id')
      .all(c.id).map(m => ({
        id: m.id, sender: m.sender, text: m.text, createdAt: m.created_at,
        orig: m.orig_text || null, edited: !!m.edited_at, deleted: !!m.deleted,
        files: parseFiles(m.files).map((f, i) => ({ m: f.m, s: f.s, o: f.o, url: `/api/admin/chats/${c.id}/files/${m.id}/${i}` }))
      }))
  });
});
router.post('/chats/:id/messages', need('chats',2), chatFilesMw, (req, res) => {
  const c = db.prepare('SELECT id FROM chats WHERE id=?').get(req.params.id);
  if (!c) { discardUpload(req); return res.status(404).json({ error: 'not_found' }); }
  const text = String((req.body && req.body.text) || '').trim().slice(0, 2000);
  let files = [];
  try { files = collectChatFiles(req); }
  catch (e) { return res.status(400).json({ error: e.code || 'bad_file' }); }
  /* CHAT4: подставленный шаблон — его файлы копируются в сообщение */
  const qid = Number((req.body && req.body.quick_item) || 0);
  if (qid) {
    const qi = db.prepare('SELECT files FROM quick_items WHERE id=?').get(qid);
    if (!qi) { discardUpload(req); return res.status(404).json({ error: 'quick_not_found' }); }
    const qf = parseFiles(qi.files);
    if (qf.length + files.length > MAX_FILES) { discardUpload(req); return res.status(400).json({ error: 'too_many_files' }); }
    try { files = copyQuickFiles(qf, c.id).concat(files); }
    catch (e) { discardUpload(req); return res.status(400).json({ error: 'bad_file' }); }
  }
  if (!text && !files.length) return res.status(400).json({ error: 'empty' });
  const r = db.prepare('INSERT INTO chat_messages (chat_id, sender, text, created_at, files) VALUES (?,?,?,?,?)')
    .run(c.id, 'support', text, now(), JSON.stringify(files));
  db.prepare('UPDATE chats SET user_unread=user_unread+1 WHERE id=?').run(c.id); /* красная точка юзеру */
  res.json({ id: Number(r.lastInsertRowid) });
});
/* CHAT2: файл из сообщения (админу видны и файлы из удалённых — аудит) */
router.get('/chats/:cid/files/:mid/:idx', need('chats',1), (req, res) => {
  const m = db.prepare('SELECT files FROM chat_messages WHERE id=? AND chat_id=?').get(req.params.mid, req.params.cid);
  if (!m) return res.status(404).end();
  const f = parseFiles(m.files)[Number(req.params.idx)];
  if (!f) return res.status(404).end();
  sendChatFile(res, req.params.cid, f.n, f);
});
/* CHAT1: правка сообщения. Оригинал (первая версия) сохраняется в orig_text и виден
   только админу; юзер видит только новый текст. Удалённое править нельзя. */
router.put('/chats/:cid/messages/:mid', need('chats',2), (req, res) => {
  const text = String((req.body && req.body.text) || '').trim().slice(0, 2000);
  if (!text) return res.status(400).json({ error: 'empty' });
  const m = db.prepare('SELECT * FROM chat_messages WHERE id=? AND chat_id=?').get(req.params.mid, req.params.cid);
  if (!m) return res.status(404).json({ error: 'not_found' });
  if (m.deleted) return res.status(409).json({ error: 'deleted' });
  if (m.sender !== 'support') return res.status(403).json({ error: 'not_own' }); /* CHAT3: сообщения юзера не трогаем */
  if (parseFiles(m.files).length) return res.status(400).json({ error: 'has_files' }); /* CHAT2: вложения не правим, только удаляем */
  if (m.text === text) return res.json({ ok: true, changed: false });
  db.prepare(`UPDATE chat_messages SET text=?, edited_at=?,
    orig_text=COALESCE(orig_text, ?) WHERE id=?`).run(text, now(), m.text, m.id);
  res.json({ ok: true, changed: true });
});
/* CHAT1: удаление сообщения (soft). У юзера пропадает полностью, в админке остаётся с пометкой. */
router.delete('/chats/:cid/messages/:mid', need('chats',2), (req, res) => {
  const m = db.prepare('SELECT id, sender, deleted, text FROM chat_messages WHERE id=? AND chat_id=?').get(req.params.mid, req.params.cid);
  if (!m) return res.status(404).json({ error: 'not_found' });
  if (m.sender !== 'support') return res.status(403).json({ error: 'not_own' }); /* CHAT3: сообщения юзера не трогаем */
  if (!m.deleted) db.prepare('UPDATE chat_messages SET deleted=1 WHERE id=?').run(m.id);
  const cu = db.prepare('SELECT u.email FROM chats c JOIN users u ON u.id=c.user_id WHERE c.id=?').get(req.params.cid);
  const sub=(m.text||'(вложение)').trim();
  let ex=sub;
  if(sub.length>60){ const sp=sub.slice(0,60).search(/ [^ ]*$/); ex=(sp>20?sub.slice(0,sp):sub.slice(0,60))+'…'; }
  logAdmin(req,'chatmsg.delete',(cu?cu.email:'chat#'+req.params.cid),ex);
  res.json({ ok: true });
});

/* ── CHAT7: закрытие обращений + теги ── */
const CLOSE_MSG={
  ru:'Спасибо за обращение! Если появятся вопросы — просто напишите сюда.',
  en:'Thanks for contacting us! If you have any questions, just write here.',
  fr:'Merci de nous avoir contactés ! Si vous avez des questions, écrivez simplement ici.',
  de:'Danke für Ihre Anfrage! Wenn Sie Fragen haben, schreiben Sie einfach hier.',
  pt:'Obrigado pelo seu contato! Se tiver dúvidas, basta escrever aqui.',
  es:'¡Gracias por contactarnos! Si tiene preguntas, simplemente escriba aquí.',
  it:'Grazie per averci contattato! Se ha domande, scriva pure qui.',
  hi:'संपर्क करने के लिए धन्यवाद! यदि कोई प्रश्न हो, तो बस यहाँ लिखें।'};
router.post('/chats/:id/close', need('chats',2), (req, res) => {
  const c=db.prepare('SELECT c.*, u.lang FROM chats c LEFT JOIN users u ON u.id=c.user_id WHERE c.id=?').get(req.params.id);
  if(!c) return res.status(404).json({ error:'not_found' });
  if(c.status==='closed') return res.json({ ok:true, changed:false });
  db.prepare('UPDATE chats SET status=?, admin_unread=0 WHERE id=?').run('closed',c.id);
  const tx=CLOSE_MSG[c.lang]||CLOSE_MSG.en;
  db.prepare("INSERT INTO chat_messages (chat_id,sender,text,created_at,files) VALUES (?, 'system', ?, ?, ?)").run(c.id,tx,now(),'[]');
  res.json({ ok:true, changed:true });
});
router.post('/chats/:id/reopen', need('chats',2), (req, res) => {
  const c=db.prepare('SELECT id,status FROM chats WHERE id=?').get(req.params.id);
  if(!c) return res.status(404).json({ error:'not_found' });
  if(c.status!=='closed') return res.json({ ok:true, changed:false });
  db.prepare('UPDATE chats SET status=? WHERE id=?').run('open',c.id);
  res.json({ ok:true, changed:true });
});
router.get('/chat-tags', need('chats',1), (req, res) => {
  res.json({ tags: db.prepare(`SELECT t.id,t.name,t.color,COUNT(m.chat_id) c FROM chat_tags t
    LEFT JOIN chat_tag_map m ON m.tag_id=t.id GROUP BY t.id ORDER BY t.name`).all()
    .map(t=>({id:t.id,name:t.name,color:t.color,count:t.c})) });
});
router.post('/chat-tags', need('chats',1), (req, res) => {
  const name=String((req.body&&req.body.name)||'').trim().slice(0,40);
  if(!name) return res.status(400).json({ error:'empty' });
  if(db.prepare('SELECT id FROM chat_tags WHERE name=?').get(name)) return res.status(409).json({ error:'exists' });
  const color=Number(db.prepare('SELECT COUNT(*) n FROM chat_tags').get().n)%6; /* по кругу: все цвета видно сразу */
  const r=db.prepare('INSERT INTO chat_tags (name,created_at,color) VALUES (?,?,?)').run(name,now(),color);
  res.json({ id:Number(r.lastInsertRowid), color });
});
router.put('/chat-tags/:id', need('chats',1), (req, res) => {
  const name=String((req.body&&req.body.name)||'').trim().slice(0,40);
  if(!name) return res.status(400).json({ error:'empty' });
  const t=db.prepare('SELECT id FROM chat_tags WHERE id=?').get(req.params.id);
  if(!t) return res.status(404).json({ error:'not_found' });
  if(db.prepare('SELECT id FROM chat_tags WHERE name=? AND id!=?').get(name,t.id)) return res.status(409).json({ error:'exists' });
  db.prepare('UPDATE chat_tags SET name=? WHERE id=?').run(name,t.id);
  res.json({ ok:true });
});
router.delete('/chat-tags/:id', need('chats',1), (req, res) => {
  const t=db.prepare('SELECT id FROM chat_tags WHERE id=?').get(req.params.id);
  if(!t) return res.status(404).json({ error:'not_found' });
  db.prepare('DELETE FROM chat_tag_map WHERE tag_id=?').run(t.id);
  db.prepare('DELETE FROM chat_tags WHERE id=?').run(t.id);
  res.json({ ok:true });
});
router.post('/chats/:id/tags', need('chats',1), (req, res) => {
  const c=db.prepare('SELECT id FROM chats WHERE id=?').get(req.params.id);
  const t=db.prepare('SELECT id FROM chat_tags WHERE id=?').get(Number((req.body&&req.body.tag_id)||0));
  if(!c||!t) return res.status(404).json({ error:'not_found' });
  db.prepare('INSERT OR IGNORE INTO chat_tag_map (chat_id,tag_id) VALUES (?,?)').run(c.id,t.id);
  res.json({ ok:true });
});
router.delete('/chats/:id/tags/:tagid', need('chats',1), (req, res) => {
  db.prepare('DELETE FROM chat_tag_map WHERE chat_id=? AND tag_id=?').run(req.params.id,req.params.tagid);
  res.json({ ok:true });
});

/* ── CHAT4: быстрые ответы (группы-папки + шаблоны) ── */
function quickItemJson(it) {
  return {
    id: it.id, groupId: it.group_id, text: it.text,
    files: parseFiles(it.files).map((f, i) => ({ m: f.m, s: f.s, o: f.o, url: `/api/admin/quick/items/${it.id}/files/${i}` }))
  };
}
router.get('/quick', need('chats',1), (req, res) => {
  const groups = db.prepare('SELECT * FROM quick_groups ORDER BY pos, id').all();
  const items = db.prepare('SELECT * FROM quick_items ORDER BY pos, id').all();
  res.json({
    groups: groups.map(g => ({
      id: g.id, name: g.name,
      items: items.filter(i => i.group_id === g.id).map(quickItemJson)
    }))
  });
});
router.post('/quick/groups', need('chats',2), (req, res) => {
  const name = String((req.body && req.body.name) || '').trim().slice(0, 80);
  if (!name) return res.status(400).json({ error: 'empty' });
  const mx = db.prepare('SELECT COALESCE(MAX(pos),0) p FROM quick_groups').get().p;
  const r = db.prepare('INSERT INTO quick_groups (name, pos, created_at) VALUES (?,?,?)').run(name, mx + 1, now());
  res.json({ id: Number(r.lastInsertRowid) });
});
router.put('/quick/groups/:id', need('chats',2), (req, res) => {
  const name = String((req.body && req.body.name) || '').trim().slice(0, 80);
  if (!name) return res.status(400).json({ error: 'empty' });
  const g = db.prepare('SELECT id FROM quick_groups WHERE id=?').get(req.params.id);
  if (!g) return res.status(404).json({ error: 'not_found' });
  db.prepare('UPDATE quick_groups SET name=? WHERE id=?').run(name, g.id);
  res.json({ ok: true });
});
router.delete('/quick/groups/:id', need('chats',2), (req, res) => {
  const g = db.prepare('SELECT id, name FROM quick_groups WHERE id=?').get(req.params.id);
  if (!g) return res.status(404).json({ error: 'not_found' });
  logAdmin(req,'quickgroup.delete',g.name,'');
  const items = db.prepare('SELECT files FROM quick_items WHERE group_id=?').all(g.id);
  items.forEach(i => unlinkQuickFiles(parseFiles(i.files)));
  db.prepare('DELETE FROM quick_items WHERE group_id=?').run(g.id);
  db.prepare('DELETE FROM quick_groups WHERE id=?').run(g.id);
  res.json({ ok: true });
});
router.post('/quick/groups/:gid/items', need('chats',2), quickUploadMw, (req, res) => {
  const g = db.prepare('SELECT id FROM quick_groups WHERE id=?').get(req.params.gid);
  if (!g) { discardUpload(req); return res.status(404).json({ error: 'not_found' }); }
  const text = String((req.body && req.body.text) || '').trim().slice(0, 2000);
  let files = [];
  try { files = collectQuickFiles(req); }
  catch (e) { return res.status(400).json({ error: e.code || 'bad_file' }); }
  if (!text && !files.length) return res.status(400).json({ error: 'empty' });
  const mx = db.prepare('SELECT COALESCE(MAX(pos),0) p FROM quick_items WHERE group_id=?').get(g.id).p;
  const r = db.prepare('INSERT INTO quick_items (group_id, text, files, pos, created_at) VALUES (?,?,?,?,?)')
    .run(g.id, text, JSON.stringify(files), mx + 1, now());
  res.json({ id: Number(r.lastInsertRowid) });
});
router.put('/quick/items/:id', need('chats',2), quickUploadMw, (req, res) => {
  const it = db.prepare('SELECT * FROM quick_items WHERE id=?').get(req.params.id);
  if (!it) { discardUpload(req); return res.status(404).json({ error: 'not_found' }); }
  const text = String((req.body && req.body.text) || '').trim().slice(0, 2000);
  let files = parseFiles(it.files);
  if (req.files && req.files.length) { /* замена картинок целиком */
    try {
      const nf = collectQuickFiles(req);
      unlinkQuickFiles(files);
      files = nf;
    } catch (e) { return res.status(400).json({ error: e.code || 'bad_file' }); }
  } else if (String((req.body && req.body.clear_files) || '') === '1') { /* CHAT5: убрать все картинки */
    unlinkQuickFiles(files);
    files = [];
  }
  if (!text && !files.length) return res.status(400).json({ error: 'empty' });
  db.prepare('UPDATE quick_items SET text=?, files=? WHERE id=?').run(text, JSON.stringify(files), it.id);
  res.json({ ok: true });
});
router.delete('/quick/items/:id', need('chats',2), (req, res) => {
  const it = db.prepare('SELECT files FROM quick_items WHERE id=?').get(req.params.id);
  if (!it) return res.status(404).json({ error: 'not_found' });
  unlinkQuickFiles(parseFiles(it.files));
  db.prepare('DELETE FROM quick_items WHERE id=?').run(req.params.id);
  logAdmin(req,'quickitem.delete','#'+req.params.id,'');
  res.json({ ok: true });
});
router.get('/quick/items/:id/files/:idx', need('chats',1), (req, res) => {
  const it = db.prepare('SELECT files FROM quick_items WHERE id=?').get(req.params.id);
  if (!it) return res.status(404).end();
  const f = parseFiles(it.files)[Number(req.params.idx)];
  if (!f) return res.status(404).end();
  sendQuickFile(res, f.n, f);
});

/* ── STAFF1: персонал (только суперадмин) ── */
function cleanPerms(p){
  const o={};
  if(p&&typeof p==='object') for(const s of STAFF_SECTIONS){ const v=Number(p[s]); if(v===1||v===2) o[s]=v; }
  return o;
}
const adminCount=()=>db.prepare("SELECT COUNT(*) c FROM users WHERE role='admin'").get().c;
function staffJson(u){
  let perms='all';
  if(u.role!=='admin'){ try{ perms=JSON.parse(u.perms||'{}'); }catch(e){ perms={}; } }
  return { id:u.id, email:u.email, nick:u.nick||'', role:u.role, perms, blocked:!!u.blocked, created:u.created_at };
}
router.get('/staff', adminOnly, (req, res) => {
  res.json({ staff: db.prepare("SELECT id,email,nick,role,perms,blocked,created_at FROM users WHERE role IN ('admin','moder') ORDER BY id").all().map(staffJson) });
});
router.post('/staff', adminOnly, (req, res) => {
  const b=req.body||{};
  const email=String(b.email||'').trim().toLowerCase();
  const pass=String(b.pass||'');
  const nick=String(b.nick||'').trim().slice(0,40);
  const role=(b.role==='admin')?'admin':'moder';
  if(!/^[^@\s]{1,64}@[^@\s]{1,64}\.[^@\s]{1,32}$/.test(email)) return res.status(400).json({ error:'bad_email' });
  if(pass.length<6) return res.status(400).json({ error:'bad_pass' });
  if(db.prepare('SELECT id FROM users WHERE email=?').get(email)) return res.status(409).json({ error:'exists' });
  const perms= role==='admin' ? '{}' : JSON.stringify(cleanPerms(b.perms));
  if(role==='moder' && !Object.keys(JSON.parse(perms)).length) return res.status(400).json({ error:'no_perms' });
  const r=db.prepare('INSERT INTO users (email,pass_hash,role,perms,client_id,created_at,nick) VALUES (?,?,?,?,?,?,?)')
    .run(email,bcrypt.hashSync(pass,10),role,perms,db.nextClientId(),now(),nick||email.split('@')[0]);
  logAdmin(req,'staff.create',email,role);
  res.json({ id:Number(r.lastInsertRowid) });
});
router.put('/staff/:id', adminOnly, (req, res) => {
  const b=req.body||{};
  const u=db.prepare("SELECT * FROM users WHERE id=? AND role IN ('admin','moder')").get(req.params.id);
  if(!u) return res.status(404).json({ error:'not_found' });
  const self=u.id===req.user.id;
  const set=[],args=[];
  if(b.nick!=null){ set.push('nick=?'); args.push(String(b.nick).trim().slice(0,40)); }
  if(b.pass!=null&&String(b.pass)){ if(String(b.pass).length<6) return res.status(400).json({ error:'bad_pass' });
    set.push('pass_hash=?'); args.push(bcrypt.hashSync(String(b.pass),10)); }
  if(!self){
    if(b.role!=null){ const role=(b.role==='admin')?'admin':'moder';
      if(u.role==='admin'&&role!=='admin'&&adminCount()<=1) return res.status(400).json({ error:'last_admin' });
      set.push('role=?'); args.push(role);
      if(role==='admin'){ set.push("perms='{}'"); }
    }
    if(b.perms!=null){ const curRole=(b.role!=null)?((b.role==='admin')?'admin':'moder'):u.role;
      if(curRole==='moder'){ const cp=cleanPerms(b.perms);
        if(!Object.keys(cp).length) return res.status(400).json({ error:'no_perms' });
        set.push('perms=?'); args.push(JSON.stringify(cp)); } }
  } else if(b.role!=null||b.perms!=null) return res.status(400).json({ error:'cannot_self' });
  if(!set.length) return res.json({ ok:true, changed:false });
  db.prepare(`UPDATE users SET ${set.join(',')} WHERE id=?`).run(...args,u.id);
  logAdmin(req,'staff.update',u.email,(b.role!=null?'role→'+b.role+'; ':'')+(b.perms!=null?'perms; ':'')+(b.pass?'pass;':''));
  res.json({ ok:true, changed:true });
});
router.post('/staff/:id/block', adminOnly, (req, res) => {
  const u=db.prepare("SELECT id,email,role FROM users WHERE id=? AND role IN ('admin','moder')").get(req.params.id);
  if(!u) return res.status(404).json({ error:'not_found' });
  if(u.id===req.user.id) return res.status(400).json({ error:'cannot_self' });
  if(u.role==='admin'&&adminCount()<=1) return res.status(400).json({ error:'last_admin' });
  db.prepare('UPDATE users SET blocked=1 WHERE id=?').run(u.id);
  db.prepare('DELETE FROM sessions WHERE user_id=?').run(u.id);
  logAdmin(req,'staff.block',u.email,'');
  res.json({ ok:true });
});
router.post('/staff/:id/unblock', adminOnly, (req, res) => {
  const u=db.prepare("SELECT id,email FROM users WHERE id=? AND role IN ('admin','moder')").get(req.params.id);
  if(!u) return res.status(404).json({ error:'not_found' });
  db.prepare('UPDATE users SET blocked=0 WHERE id=?').run(u.id);
  logAdmin(req,'staff.unblock',u.email,'');
  res.json({ ok:true });
});
router.delete('/staff/:id', adminOnly, (req, res) => {
  const u=db.prepare("SELECT id,email,role FROM users WHERE id=? AND role IN ('admin','moder')").get(req.params.id);
  if(!u) return res.status(404).json({ error:'not_found' });
  if(u.id===req.user.id) return res.status(400).json({ error:'cannot_self' });
  if(u.role==='admin'&&adminCount()<=1) return res.status(400).json({ error:'last_admin' });
  logAdmin(req,'staff.delete',u.email,u.role);
  db.prepare('DELETE FROM sessions WHERE user_id=?').run(u.id);
  db.prepare('DELETE FROM users WHERE id=?').run(u.id);
  res.json({ ok:true });
});

/* ── STAFF1: журнал действий ── */
router.get('/audit', adminOnly, (req, res) => {
  const lim=Math.min(500,parseInt(req.query.limit,10)||200);
  const a=String(req.query.action||'').trim();
  const sql='SELECT * FROM admin_log'+(a?' WHERE action LIKE ?':'')+' ORDER BY id DESC LIMIT ?';
  const args=a?[a+'%',lim]:[lim];
  res.json({ log:db.prepare(sql).all(...args) });
});


/* ── PLAT1: настройки платформы (только админ) ── */
router.get('/settings', adminOnly, (req, res) => {
  res.json({ settings: getSettings(), base: require('../engine').basePayouts() });
});
router.post('/settings', adminOnly, (req, res) => {
  const b=(req.body&&req.body.settings)||req.body||{};
  const num=(v,min,max,d)=>{ v=Number(v); return (Number.isFinite(v)&&v>=min&&v<=max)?v:d; };
  const s={
    minDeposit: num(b.minDeposit,0,100000000,DEFAULTS.minDeposit),
    maxDeposit: num(b.maxDeposit,1,100000000,DEFAULTS.maxDeposit),
    minWithdrawal: num(b.minWithdrawal,0,100000000,DEFAULTS.minWithdrawal),
    maxWithdrawal: num(b.maxWithdrawal,1,100000000,DEFAULTS.maxWithdrawal),
    minTrade: num(b.minTrade,0.01,100000000,DEFAULTS.minTrade),
    maxTrade: num(b.maxTrade,0.01,100000000,DEFAULTS.maxTrade),
    defaultWager: num(b.defaultWager,1,1000,DEFAULTS.defaultWager),
    payouts: {},
    marketHours: { ...DEFAULTS.marketHours }
  };
  { const m=(b.marketHours&&typeof b.marketHours==='object')?b.marketHours:{};
    const hm=(v,d)=>{ const mm=/^(\d{1,2}):(\d{2})$/.exec(String(v||'').trim()); if(!mm) return d;
      const h=+mm[1],mi=+mm[2]; return (h<=23&&mi<=59)?(String(h).padStart(2,'0')+':'+String(mi).padStart(2,'0')):d; };
    s.marketHours={ enabled:!!m.enabled, friClose:hm(m.friClose,'22:00'), sunOpen:hm(m.sunOpen,'22:00'),
      nightStart:(m.nightStart===''||m.nightStart==null)?'':hm(m.nightStart,''), nightEnd:(m.nightEnd===''||m.nightEnd==null)?'':hm(m.nightEnd,''),
      warnMin:num(m.warnMin,1,120,15) };
  }
  if(s.minDeposit>s.maxDeposit||s.minWithdrawal>s.maxWithdrawal||s.minTrade>s.maxTrade)
    return res.status(400).json({ error:'bad_range' });
  if(b.payouts&&typeof b.payouts==='object') for(const [id,p] of Object.entries(b.payouts)){
    if(!ASSETS[id]) return res.status(400).json({ error:'bad_asset', asset:id });
    const pct=Number(p);
    if(!(pct>=1&&pct<=1000)) return res.status(400).json({ error:'bad_payout', asset:id });
    s.payouts[id]=pct;
  }
  saveSettings(s);
  logAdmin(req,'settings.update','platform',`деп ${s.minDeposit}..${s.maxDeposit} · выв ${s.minWithdrawal}..${s.maxWithdrawal} · сдел ${s.minTrade}..${s.maxTrade} · вейджер x${s.defaultWager} · выплат: ${Object.keys(s.payouts).length}`);
  res.json({ settings: s });
});

/* ── PLAT1: рассылка в чаты поддержки (только админ) ── */
function broadcastTargets(f){
  f=f||{};
  const cond=["u.role='user'","u.blocked=0"],args=[];
  if(f.country){ cond.push('u.country=?'); args.push(String(f.country).trim().toUpperCase().slice(0,8)); }
  if(f.kyc){ cond.push('u.verify_status=?'); args.push(String(f.kyc).slice(0,16)); }
  if(f.hasDeposit){ cond.push("EXISTS(SELECT 1 FROM deposits d WHERE d.user_id=u.id AND d.status='done')"); }
  return db.prepare(`SELECT u.id,u.email FROM users u WHERE ${cond.join(' AND ')} ORDER BY u.id`).all(...args);
}
router.get('/broadcast/count', adminOnly, (req, res) => {
  const list=broadcastTargets({ country:req.query.country, kyc:req.query.kyc, hasDeposit:req.query.hasDeposit==='1' });
  res.json({ count: list.length });
});
router.post('/broadcast', adminOnly, (req, res) => {
  const text=String((req.body&&req.body.text)||'').trim().slice(0,2000);
  if(!text) return res.status(400).json({ error:'empty' });
  const list=broadcastTargets((req.body&&req.body.filters)||{});
  if(!list.length) return res.json({ ok:true, sent:0 });
  const findChat=db.prepare('SELECT id FROM chats WHERE user_id=? ORDER BY id DESC LIMIT 1');
  const mkChat=db.prepare("INSERT INTO chats (user_id,specialist,status,created_at) VALUES (?,?,'open',?)");
  const ins=db.prepare("INSERT INTO chat_messages (chat_id,sender,text,created_at,files) VALUES (?,'support',?,?,?)");
  const bump=db.prepare('UPDATE chats SET status=\'open\', user_unread=user_unread+1 WHERE id=?');
  db.transaction((users)=>{
    for(const u of users){
      let c=findChat.get(u.id);
      if(!c) c={ id:Number(mkChat.run(u.id,'Support',now()).lastInsertRowid) };
      ins.run(c.id,text,now(),'[]');
      bump.run(c.id);
    }
  })(list);
  logAdmin(req,'broadcast',list.length+' users',text.slice(0,80));
  res.json({ ok:true, sent:list.length });
});

/* ── PLAT1: отмена сделки (возврат стейка) ── */
router.post('/trades/:id/cancel', need('trades',2), (req, res) => {
  const t=db.prepare('SELECT * FROM trades WHERE id=?').get(req.params.id);
  if(!t) return res.status(404).json({ error:'not_found' });
  if(t.status==='cancelled') return res.status(409).json({ error:'already' });
  const col=t.account==='demo'?'demo_balance':'real_balance';
  const delta=t.status==='open'?t.amount:(t.amount-(t.payout||0));
  db.transaction(()=>{
    db.prepare(`UPDATE users SET ${col}=${col}+? WHERE id=?`).run(delta,t.user_id);
    db.prepare(`UPDATE trades SET status='cancelled' WHERE id=?`).run(t.id);
  })();
  logAdmin(req,'trade.cancel','#'+t.id,`${userLabel(t.user_id)} · ${t.asset} ${t.dir} $${t.amount} · возврат $${delta}`);
  res.json({ ok:true, refund:delta });
});

module.exports = router;
