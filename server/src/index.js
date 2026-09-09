'use strict';
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');

const db = require('./db');
const { ASSETS, TICK_MS, tickAll, DEPTH, BUILD_DAYS } = require('./engine');
const { purgeExpired } = require('./auth');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '300kb' }));
app.use(cookieParser());

/* ── API ── */
app.use('/api/auth', require('./routes/auth'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/finance', require('./routes/finance'));
app.use('/api', require('./routes/user'));     // /api/me, /api/trades, /api/verify, /api/avatar
app.use('/api', require('./routes/market'));   // /api/assets, /api/chart/:asset, /api/quotes (SSE)
const { broadcast } = require('./routes/market');
try{ require('./settings').applyBoot(); }catch(e){} /* PLAT1: выплаты из настроек */

app.use('/api', (req, res) => res.status(404).json({ error: 'not_found' }));

/* ── статика: фронтенд (оригинальный одностраничник + админка) ── */
/* статика: поддерживаем и каноническую раскладку (server/src → ../../public),
   и плоскую (src лежит в корне рядом с public) */
const PUBLIC_DIR = (() => {
  const canon = path.join(__dirname, '..', '..', 'public');
  const flat = path.join(__dirname, '..', 'public');
  return require('fs').existsSync(canon) ? canon : (require('fs').existsSync(flat) ? flat : canon);
})();
app.get('/admin', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'admin.html')));
app.use(express.static(PUBLIC_DIR));

/* ── ошибки ── */
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'bad_json' });
  console.error(err);
  res.status(500).json({ error: 'server_error' });
});

/* ── серверный тик: котировки + закрытие сделок по экспирации ── */
function settleDue(nowSec) {
  const rows = db.prepare(`SELECT * FROM trades WHERE status='open' AND close_time <= ?`).all(nowSec);
  if (!rows.length) return;
  const upd = db.prepare(`UPDATE trades SET status='closed', close_price=?, won=?, tie=?, payout=?, profit=? WHERE id=?`);
  const addDemo = db.prepare(`UPDATE users SET demo_balance = demo_balance + ? WHERE id=?`);
  const addReal = db.prepare(`UPDATE users SET real_balance = real_balance + ? WHERE id=?`);
  const realVol = {};
  for (const t of rows) {
    const a = ASSETS[t.asset];
    const cp = a ? a.price() : t.entry_price;
    const won = t.dir === 'UP' ? cp > t.entry_price : cp < t.entry_price;
    const tie = cp === t.entry_price;
    const pct = t.payout_pct / 100;
    const payout = tie ? t.amount : (won ? t.amount * (1 + pct) : 0);
    const profit = tie ? 0 : (won ? t.amount * pct : -t.amount);
    upd.run(cp, won ? 1 : 0, tie ? 1 : 0, payout, profit, t.id);
    if (payout > 0) (t.account === 'demo' ? addDemo : addReal).run(payout, t.user_id);
    if (t.account === 'real') realVol[t.user_id] = (realVol[t.user_id] || 0) + t.amount;
  }
  /* O1: закрытые сделки с реального счёта тихо крутят вейджер */
  const wg = db.prepare(`SELECT bonus_locked, wager_need, wager_done FROM users WHERE id=?`);
  const wgUpd = db.prepare(`UPDATE users SET wager_done=?, bonus_locked=? WHERE id=?`);
  for (const uid of Object.keys(realVol)) {
    const u = wg.get(uid);
    if (!u || u.wager_need <= 0 || u.bonus_locked <= 0) continue;
    const done = u.wager_done + realVol[uid];
    const unlocked = done >= u.wager_need;
    wgUpd.run(done, unlocked ? 0 : u.bonus_locked, uid);
  }
}

/* M2: снапшот цен для бесшовного рестарта */
function saveSnap() {
  try {
    const prices = {};
    for (const [name, a] of Object.entries(ASSETS)) prices[name] = a.price();
    db.prepare(`INSERT INTO meta (key, value) VALUES ('price_snap', ?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value`)
      .run(JSON.stringify({ t: Math.floor(Date.now() / 1000), prices }));
  } catch (e) {}
}
setInterval(saveSnap, 5 * 60 * 1000).unref();
process.on('SIGINT', () => { saveSnap(); process.exit(0); });
process.on('SIGTERM', () => { saveSnap(); process.exit(0); });

setInterval(() => {
  const nowSec = Date.now() / 1000;
  tickAll(nowSec);
  settleDue(nowSec);
  broadcast();
}, TICK_MS);

setInterval(purgeExpired, 6 * 3600 * 1000).unref();

const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, '0.0.0.0', () => {
  console.log(`SYNTH·OTC server: http://localhost:${PORT}`);
  console.log(`Активов: ${Object.keys(ASSETS).length}, тик: ${TICK_MS}ms, DEPTH=${DEPTH} (${BUILD_DAYS} сут)`);
});
