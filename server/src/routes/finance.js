'use strict';
const express = require('express');
const db = require('../db');
const { auth } = require('../auth');

const router = express.Router();
const now = () => Date.now() / 1000;

/* способы пополнения/вывода */
const METHODS = [
  { id: 'btc', name: 'Bitcoin', sym: 'BTC', col: '#F7931A', rate: 67500, net: 'Bitcoin', addr: 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh' },
  { id: 'eth', name: 'Ethereum', sym: 'ETH', col: '#627EEA', rate: 3250, net: 'ERC-20', addr: '0x71C7656EC7ab88b098defB751B7401B5f6d8976F' },
  { id: 'usdt_trc', name: 'Tether', sym: 'USDT', col: '#26A17B', rate: 1, net: 'TRC-20', addr: 'TN3W4H6rK2ce4vX9YnFQHwKENnHjoxb3m9' },
  { id: 'usdt_erc', name: 'Tether', sym: 'USDT', col: '#26A17B', rate: 1, net: 'ERC-20', addr: '0x9f8F72aA9304c8B593d555F12eF6589cC3A579A2' },
  { id: 'usdc', name: 'USD Coin', sym: 'USDC', col: '#2775CA', rate: 1, net: 'ERC-20', addr: '0x4E83362442B8d1beC281594cEa3050c8EB01311C' },
  { id: 'ltc', name: 'Litecoin', sym: 'LTC', col: '#A6A9AA', rate: 85, net: 'Litecoin', addr: 'ltc1qz8k2v3n0sdw5s3hq0l4h7v9n5x6kfp8z4a3vqm' },
  { id: 'sol', name: 'Solana', sym: 'SOL', col: '#9945FF', rate: 165, net: 'Solana', addr: '7EqQdEULxWcraVx3mXKFjc84LhCkMGZCkRuDpvcMwJeK' },
  { id: 'bnb', name: 'BNB', sym: 'BNB', col: '#F3BA2F', rate: 585, net: 'BEP-20', addr: '0xB8c77482e45F1F44dE1745F52C74426C631bDD52' },
  { id: 'doge', name: 'Dogecoin', sym: 'DOGE', col: '#C2A633', rate: 0.145, net: 'Dogecoin', addr: 'D7Y55r6Yoc1G8EECxkQ6SuSjTgGbJ8BVLv' },
  { id: 'trx', name: 'TRON', sym: 'TRX', col: '#FF060A', rate: 0.165, net: 'TRC-20', addr: 'TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7' }
];

/* текущий адрес: переопределённый админом или дефолтный */
function addrOf(id) {
  const w = db.prepare('SELECT addr FROM wallets WHERE method_id=?').get(id);
  return w ? w.addr : (METHODS.find(m => m.id === id) || {}).addr;
}
router.get('/methods', (req, res) => res.json({ methods: METHODS.map(m => ({ ...m, addr: addrOf(m.id) })) }));

/* проверка промокода до отправки депозита */
router.get('/promo/check', auth, (req, res) => {
  const code = String(req.query.code || '').trim().toUpperCase();
  if (!code) return res.status(400).json({ error: 'empty_code' });
  const p = db.prepare('SELECT code, bonus_pct FROM promocodes WHERE UPPER(code)=? AND active=1').get(code);
  if (!p) return res.status(404).json({ error: 'invalid_code' });
  res.json({ code: p.code, bonusPct: p.bonus_pct });
});

/* заявка на пополнение: НЕ зачисляется, ждёт апрува админа */
router.post('/deposits', auth, (req, res) => {
  const b = req.body || {};
  const m = METHODS.find(x => x.id === b.method);
  if (!m) return res.status(400).json({ error: 'bad_method' });
  const amount = Number(b.amount);
  if (!(amount >= 10 && amount <= 1000000)) return res.status(400).json({ error: 'bad_amount' });

  let promo = null, bonus = 0;
  const code = String(b.promo || '').trim().toUpperCase();
  if (code) {
    promo = db.prepare('SELECT * FROM promocodes WHERE UPPER(code)=? AND active=1').get(code);
    if (!promo) return res.status(400).json({ error: 'invalid_promo' });
    bonus = Math.round(amount * promo.bonus_pct) / 100; // amount*pct/100, округление до цента
  }
  const info = db.prepare(`INSERT INTO deposits (user_id, method, amount, promo_code, bonus, status, created_at)
    VALUES (?,?,?,?,?, 'pending', ?)`)
    .run(req.user.id, m.sym + ' · ' + m.net, amount, promo ? promo.code : null, bonus, now());
  const dep = db.prepare('SELECT * FROM deposits WHERE id=?').get(info.lastInsertRowid);
  res.json({ deposit: { id: dep.id, amount: dep.amount, bonus: dep.bonus, status: dep.status, createdAt: dep.created_at } });
});

/* заявка на вывод: средства резервируются сразу, решение за админом */
router.post('/withdrawals', auth, (req, res) => {
  const b = req.body || {};
  const m = METHODS.find(x => x.id === b.method);
  if (!m) return res.status(400).json({ error: 'bad_method' });
  const amount = Number(b.amount);
  if (!(amount >= 10 && amount <= 1000000)) return res.status(400).json({ error: 'bad_amount' });
  const addr = String(b.addr || '').trim();
  if (addr.length < 10) return res.status(400).json({ error: 'bad_addr' });

  const u = db.prepare('SELECT real_balance, bonus_locked FROM users WHERE id=?').get(req.user.id);
  if (u.real_balance < amount) return res.status(402).json({ error: 'insufficient_funds' });
  /* O1: бонус заперт — вывести можно только свои */
  const locked = Math.min(u.bonus_locked || 0, u.real_balance);
  if (amount > u.real_balance - locked) return res.status(402).json({ error: 'bonus_locked' });

  const tx = db.transaction(() => {
    db.prepare('UPDATE users SET real_balance = real_balance - ? WHERE id=? AND real_balance >= ?')
      .run(amount, req.user.id, amount);
    db.prepare(`INSERT INTO withdrawals (user_id, method, amount, addr, status, created_at, bal_snap, bonus_snap)
      VALUES (?,?,?,?, 'pending', ?,?,?)`)
      .run(req.user.id, m.sym + ' · ' + m.net, amount, addr, now(), u.real_balance - amount, locked);
  });
  tx();
  const wd = db.prepare('SELECT * FROM withdrawals WHERE user_id=? ORDER BY id DESC LIMIT 1').get(req.user.id);
  res.json({
    withdrawal: { id: wd.id, amount: wd.amount, status: wd.status, createdAt: wd.created_at },
    realBalance: db.prepare('SELECT real_balance AS b FROM users WHERE id=?').get(req.user.id).b
  });
});

/* история операций (депозиты + выводы) */
router.get('/ops', auth, (req, res) => {
  const deps = db.prepare('SELECT * FROM deposits WHERE user_id=?').all(req.user.id)
    .map(d => ({ type: 'deposit', id: d.id, method: d.method, amount: d.amount, bonus: d.bonus, promo: d.promo_code, status: d.status, reason: d.reject_reason, ts: d.created_at }));
  const wds = db.prepare('SELECT * FROM withdrawals WHERE user_id=?').all(req.user.id)
    .map(w => ({ type: 'withdraw', id: w.id, method: w.method, amount: w.amount, addr: w.addr, status: w.status, reason: w.reject_reason, ts: w.created_at }));
  res.json({ ops: deps.concat(wds).sort((a, b) => b.ts - a.ts) });
});

module.exports = router;
module.exports.METHODS = METHODS;
