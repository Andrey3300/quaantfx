'use strict';
const express = require('express');
const db = require('../db');
const { ASSETS, TFS, catalog, BOOT } = require('../engine');

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
  res.json({ assets: catalog() });
});

/* история свечей; строится лениво при первом запросе актива (~0.5с, один раз) */
router.get('/chart/:asset', (req, res) => {
  const a = ASSETS[req.params.asset];
  if (!a) return res.status(404).json({ error: 'unknown_asset' });
  const tf = TFS[req.query.tf] ? req.query.tf : 'M1';
  if (!a.built) a.build(61, snapFor(a.name)); /* M1: 61 сутки фазовой генерацией */
  res.json({ asset: a.name, tf, dec: a.dec, candles: a.candles(tf) });
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
