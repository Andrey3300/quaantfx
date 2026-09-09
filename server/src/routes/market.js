'use strict';
const express = require('express');
const db = require('../db');
const { ASSETS, TFS, catalog, BOOT, DEPTH, BUILD_DAYS } = require('../engine');
const { getSettings } = require('../settings'); /* PLAT1: лимиты клиенту */
const { isClosable, marketState } = require('../market-hours'); /* рыночные часы */

const router = express.Router();

/* M2: снапшот цен читается один раз за запуск */
let SNAP = null, SNAP_READ = false;
function snapFor(asset) {
  if (!SNAP_READ) {
    SNAP_READ = true;
    try { const r = db.prepare("SELECT value FROM meta WHERE key='price_snap'").get(); if (r) SNAP = JSON.parse(r.value); } catch (e) {}
  }
  if (!SNAP || !SNAP.prices) return null;
  const p = SNAP.prices[asset];
  return (p != null) ? { price: p, t: SNAP.t } : null;
}

/* каталог активов (для пикера на фронте) */
router.get('/assets', (req, res) => {
  const l=getSettings();
  const st=marketState(l.marketHours, Math.floor(Date.now()/1000));
  const assets=catalog().map(a=> isClosable(a.id,a.cat)
    ? { ...a, closed:st.closed, closesAt:st.closesAt }
    : { ...a, closed:false, closesAt:null });
  res.json({ assets, warnMin:(l.marketHours&&l.marketHours.warnMin)||15,
    limits:{ minTrade:l.minTrade, maxTrade:l.maxTrade, minDeposit:l.minDeposit, maxDeposit:l.maxDeposit, minWithdrawal:l.minWithdrawal } });
});

/* история свечей окнами: ?tf=M1&before=<unix_s>&limit=1600.
   Без before — свежее окно (~1600 свечей, как раньше); с before — чанк старше before.
   История строится лениво при первом запросе актива (один раз за запуск). */
router.get('/chart/:asset', (req, res) => {
  const a = ASSETS[decodeURIComponent(req.params.asset)];
  if (!a) return res.status(404).json({ error: 'unknown_asset' });
  const tf = TFS[req.query.tf] ? req.query.tf : 'M1';
  if (!a.built) a.build(BUILD_DAYS, snapFor(a.name)); /* HIST: глубина по DEPTH (home: 365 сут, lite: 61) */
  const limit = Math.max(100, Math.min(2000, parseInt(req.query.limit, 10) || 1600));
  const before = req.query.before != null && req.query.before !== '' ? Number(req.query.before) : null;
  if (req.query.before != null && req.query.before !== '' && !isFinite(before))
    return res.status(400).json({ error: 'bad_before' });
  const w = a.window(tf, before, limit);
  res.json({ asset: a.name, tf, dec: a.dec, candles: w.candles, hasMore: w.hasMore, oldest: w.oldest, latest: w.latest });
});

/* ── публичные контакты для страницы условий (редактируются в админке) ── */
router.get('/contacts', (req, res) => {
  res.json({ contacts: db.getContacts() });
});

/* ── настроение рынка: доля UP среди открытых сделок; без сделок — синтетика (тренд+дрейф) ── */
router.get('/sentiment', (req, res) => {
  const a = ASSETS[req.query.asset];
  if (!a) return res.status(404).json({ error: 'unknown_asset' });
  let up = 0, dn = 0;
  try {
    for (const r of db.prepare("SELECT dir,COUNT(*) c FROM trades WHERE asset=? AND status='open' GROUP BY dir").all(a.name))
      if (r.dir === 'UP') up += r.c; else dn += r.c;
  } catch (e) {}
  const total = up + dn;
  if (total >= 3) return res.json({ up: Math.max(2, Math.min(98, Math.round(up / total * 100))), total, synth: false });
  let skew = 0;
  try {
    if (a.built) {
      const cs = a.window('M1', null, 31).candles;
      if (cs && cs.length >= 10) {
        const f = cs[0].close, l = cs[cs.length - 1].close;
        if (f > 0) skew = Math.max(-38, Math.min(38, (l - f) / f * 4000));
      }
    }
  } catch (e) {}
  const t = Date.now() / 1000;
  const drift = 6 * Math.sin(t / 47 + a.name.length) + 4 * Math.sin(t / 23 + 1.7);
  res.json({ up: Math.max(5, Math.min(95, Math.round(50 + skew + drift))), total, synth: true });
});

/* глубина истории (для диагностики) */
router.get('/depth', (req, res) => {
  res.json({ depth: DEPTH, buildDays: BUILD_DAYS });
});

/* ── котировки: SSE-стрим цен (раз в 500 мс) ── */
const clients = new Set();
router.get('/quotes', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.flushHeaders();
  const wanted = String(req.query.assets || '').split(',')
    .map(s => s.trim()).filter(n => ASSETS[n]);
  const client = { res, assets: wanted };
  clients.add(client);
  res.write('data: ' + JSON.stringify({ ts: Date.now() / 1000, prices: priceMap(wanted), epoch: BOOT }) + '\n\n'); /* V2 */
  req.on('close', () => clients.delete(client));
});

function priceMap(names) {
  const out = {};
  const list = names && names.length ? names : Object.keys(ASSETS);
  for (const n of list) out[n] = ASSETS[n].price();
  return out;
}
function broadcast() {
  if (!clients.size) return;
  const ts = Date.now() / 1000;
  for (const c of clients) {
    try { c.res.write('data: ' + JSON.stringify({ ts, prices: priceMap(c.assets), epoch: BOOT }) + '\n\n'); } /* V2 */
    catch (e) { clients.delete(c); }
  }
}

module.exports = router;
module.exports.broadcast = broadcast;
