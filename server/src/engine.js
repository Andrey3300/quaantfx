'use strict';
/*
 * Синтетический движок котировок.
 * ВАЖНО: скопирован 1-в-1 из клиентского кода, чтобы поведение котировок
 * и свечей совпадало с тем, что рисует график. Не менять без синхронизации с фронтом.
 */

const TICK_MS = 500;

class Engine {
  constructor(basePrice, fastSigma, slowSigma) {
    this.basePrice = basePrice; this.price = basePrice;
    this.fastSigma = fastSigma; this.fastMom = 0; this.fastAlpha = .45;
    this.slowDrift = 0; this.slowSigma = slowSigma; this.slowTheta = .002;
    this.regimeBias = 0; this.regimeTick = 0; this.regimePer = 400 + Math.random() * 500;
    this.globalMR = .00003;
  }
  _gauss() {
    let u, v;
    do { u = Math.random() } while (u === 0);
    do { v = Math.random() } while (v === 0);
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
  next() {
    if (++this.regimeTick >= this.regimePer) {
      const dir = Math.random() < .5 ? 1 : -1;
      this.regimeBias = dir * this.slowSigma * (.2 + Math.random() * .6);
      this.regimePer = 400 + Math.random() * 500; this.regimeTick = 0;
    }
    this.slowDrift += this.slowTheta * (this.regimeBias - this.slowDrift) + this._gauss() * this.slowSigma * .2;
    this.slowDrift = Math.max(-this.slowSigma * 3, Math.min(this.slowSigma * 3, this.slowDrift));
    this.fastMom = this.fastAlpha * this.fastMom + (1 - this.fastAlpha) * this._gauss();
    const dev = (this.price - this.basePrice) / this.basePrice, absD = Math.abs(dev);
    const mr = absD < .15 ? dev * this.globalMR : Math.sign(dev) * this.globalMR * (.15 + Math.pow(absD - .15, 1.8) * 2.5);
    this.price *= (1 + this.slowDrift + this.fastMom * this.fastSigma - mr);
    if (this.price <= 0) this.price = this.basePrice * .05;
    return this.price;
  }
}

class TFAgg {
  constructor(sec, max) { this.sec = sec; this.max = max; this.data = []; this.cur = null; }
  push(price, ts) {
    const ct = Math.floor(ts / this.sec) * this.sec;
    if (!this.cur || this.cur.time !== ct) {
      if (this.cur) { this.data.push(this.cur); if (this.data.length > this.max) this.data.shift(); }
      const o = this.cur ? this.cur.close : price;
      this.cur = { time: ct, open: o, high: Math.max(o, price), low: Math.min(o, price), close: price };
    } else {
      if (price > this.cur.high) this.cur.high = price;
      if (price < this.cur.low) this.cur.low = price;
      this.cur.close = price;
    }
  }
  all() { return this.cur ? this.data.concat([this.cur]) : this.data.slice(); }
}

const TFS = { S5: 5, S15: 15, S30: 30, M1: 60, M5: 300, M15: 900, M30: 1800, H1: 3600 };
/* U2: живой тик идёт с тем же бустом, что и хвост истории — иначе свежий участок «слипается» */
const LIVE_BOOST = 2.6;
/* HIST: глубина колец. DEPTH=home (дефолт, мощная машина: S5≈сутки, H1≈год),
   DEPTH=lite (Vercel/слабый хостинг: текущие ~40–60 дней). */
const DEPTH = (process.env.DEPTH || 'home').toLowerCase() === 'lite' ? 'lite' : 'home';
const TF_MAX = DEPTH === 'home'
  ? { S5: 17280, S15: 11520, S30: 11520, M1: 20160, M5: 17280, M15: 11520, M30: 11520, H1: 8760 }
  : { S5: 1600, S15: 1600, S30: 1600, M1: 2000, M5: 1500, M15: 1200, M30: 900, H1: 1440 };
const BUILD_DAYS = DEPTH === 'home' ? 365 : 61;

class Asset {
  constructor(name, base, fS, sS, dec, cat, payout) {
    this.name = name; this.dec = dec; this.cat = cat; this.payout = payout; this.basePayout = payout; /* PLAT1: база для сброса оверрайдов */
    this.eng = new Engine(base, fS, sS); this.built = false; this.aggs = {};
    for (const [tf, sec] of Object.entries(TFS)) this.aggs[tf] = new TFAgg(sec, TF_MAX[tf]);
  }
  build(days, snap) {
    if (this.built) return; this.built = true;
    const now = Math.floor(Date.now() / 1000);
    const of = this.eng.fastSigma, os = this.eng.slowSigma;
    const base = this.eng.basePrice;
    const aggs = Object.values(this.aggs);
    /* U2: поправка на фазу — чтобы амплитуда свечей не зависела от возраста истории */
    const ERA_K = { 1800: 1.5, 300: 1.35, 60: 1.15, 5: 1 };
    /* U2: якорь к базе. Постоянная времени 12ч >> любой свечи (макс. H1=1ч) —
       диапазоны свечей не сжимаются, но блуждание за 40 дней не уносит цену. */
    const TAU = 43200;
    const runPhase = (step, sub, fromDays, toDays) => {
      /* U1: шаг крупнее 5с означает «длинный» тик — сигмы масштабируем √(step/5),
         иначе старая история сжимается в линию против живых свечей */
      const k = Math.sqrt((step / sub) / 0.5); /* живой тик = 500мс */
      const ek = ERA_K[step] || 1;
      this.eng.fastSigma = of * LIVE_BOOST * k * ek; /* U2: единая амплитуда билда и лайва */
      this.eng.slowSigma = os * k * ek;
      const anchor = (step / sub) / TAU; /* U2: тяга к базе за подшаг */
      const n = Math.floor((fromDays - toDays) * 86400 / step);
      let ts = now - Math.round(fromDays * 86400 / step) * step;
      for (let i = 0; i < n; i++, ts += step) {
        for (let j = 0; j < sub; j++) {
          this.eng.next();
          this.eng.price = base + (this.eng.price - base) * (1 - anchor); /* U2: якорь */
          const p = this.eng.price, t = ts + ((j * step / sub) | 0);
          /* U2: в мелкой эре пушим в M5+ ровно раз в 60с (1 точка), как эра (60,1) —
             иначе свежие M5-свечи получают диапазон выше старых из-за плотности выборки */
          const pushCoarse = step > 5 || (i % 12 === 0 && j === 0);
          for (let k2 = 0; k2 < aggs.length; k2++) {
            if (!pushCoarse && aggs[k2].sec >= 300) continue;
            /* HIST: пуш старше покрытия кольца (max свечей × шаг) всё равно вытеснится
               shift'ами — пропускаем сразу, иначе грубые фазы деградируют квадратично */
            if (now - t > aggs[k2].max * aggs[k2].sec) continue;
            aggs[k2].push(p, t);
          }
        }
      }
    };
    /* M1: фазовая генерация — каждая фаза покрывает потребности своего ТФ */
    /* HIST: в home-режиме фазы глубже; (60,4) даёт ровную 15-секундную сетку для S15 */
    if (days > 100) {
      runPhase(1800, 12, days, 60); /* H1/M30: пуш каждые 150с */
      runPhase(300, 6, 60, 14);     /* M15/M5: пуш каждые 50с */
      runPhase(60, 4, 14, 2);       /* M1/S30/S15: пуш каждые 15с */
      runPhase(5, 3, 2, 0);         /* S5–M1: мелко */
    } else {
      runPhase(1800, 12, days, 15); /* M30/H1: пуш каждые 150с */
      runPhase(300, 6, 15, 6);      /* M15: пуш каждые 50с */
      runPhase(60, 1, 6, 1.5);      /* M5: 5 пушей */
      runPhase(5, 3, 1.5, 0);       /* S5–M1: мелко */
    }
    /* U2: финальная цена = база. Глобальное умножение не искажает диапазоны свечей. */
    {
      const kk = base / this.eng.price;
      if (isFinite(kk) && kk > 0) {
        for (const ag of aggs) {
          for (const c of ag.data) { c.open *= kk; c.high *= kk; c.low *= kk; c.close *= kk; }
          if (ag.cur) { ag.cur.open *= kk; ag.cur.high *= kk; ag.cur.low *= kk; ag.cur.close *= kk; }
        }
        this.eng.price = base;
      }
    }
    this.eng.fastSigma = of * LIVE_BOOST; this.eng.slowSigma = os; /* U2: лайв с бустом */
    /* M2: сшивка с сохранённой ценой после рестарта + закрытие временной дыры */
    if (snap && snap.price > 0 && snap.t && snap.t < now) {
      const k = snap.price / this.eng.price;
      if (isFinite(k) && k > 0) {
        for (const ag of aggs) {
          for (const c of ag.data) { c.open *= k; c.high *= k; c.low *= k; c.close *= k; }
          if (ag.cur) { ag.cur.open *= k; ag.cur.high *= k; ag.cur.low *= k; ag.cur.close *= k; }
        }
        this.eng.price = snap.price;
      }
      const gap = Math.min(now - snap.t, BUILD_DAYS * 86400); /* HIST: догон в пределах глубины колец */
      const n = Math.floor(gap / 60);
      let ts = now - gap;
      const k60 = Math.sqrt(60 / 0.5); /* U1: догон с 60-секундной амплитудой */
      this.eng.fastSigma = of * LIVE_BOOST * k60; this.eng.slowSigma = os * k60;
      const anchor60 = 30 / TAU; /* U2: тот же якорь (подшаг 30с) */
      for (let i = 0; i < n; i++, ts += 60) {
        this.eng.next(); this.eng.price = base + (this.eng.price - base) * (1 - anchor60); const p = this.eng.price;
        this.eng.next(); this.eng.price = base + (this.eng.price - base) * (1 - anchor60); const p2 = this.eng.price;
        for (let k2 = 0; k2 < aggs.length; k2++) {
          if (now - ts > aggs[k2].max * aggs[k2].sec) continue; /* HIST: старше покрытия — пропуск */
          aggs[k2].push(p, ts); aggs[k2].push(p2, ts + 30);
        }
      }
      this.eng.fastSigma = of * LIVE_BOOST; this.eng.slowSigma = os;
    }
  }
  price() { return this.eng.price; }
  candles(tf) { return this.aggs[tf].all(); }
  /* HIST: окно истории для пагинации ?before&limit (по времени свечи, по возрастанию).
     before==null → последнее окно (свежий край). */
  window(tf, before, limit) {
    const all = this.aggs[tf].all();
    const oldest = all.length ? all[0].time : null;
    const latest = all.length ? all[all.length - 1].time : null;
    let arr = all;
    if (before != null && isFinite(before)) {
      let lo = 0, hi = all.length;
      while (lo < hi) { const m = (lo + hi) >> 1; if (all[m].time < before) lo = m + 1; else hi = m; }
      arr = all.slice(0, lo);
    }
    const candles = arr.slice(-limit);
    const hasMore = candles.length > 0 ? candles[0].time > oldest : false;
    return { candles, hasMore, oldest, latest };
  }
  fmt(p) { return p.toFixed(this.dec); }
}

/* каталог активов: [id, cat, payout, base, fastSigma, slowSigma, dec] */
const RAW = [
  ['EUR/USD', 'currencies', 92, 1.08500, .00020, .000014, 5], ['GBP/USD', 'currencies', 91, 1.26500, .00025, .000017, 5],
  ['AUD/USD', 'currencies', 88, 0.65200, .00018, .000012, 5], ['EUR/GBP', 'currencies', 87, 0.85800, .00016, .000011, 5],
  ['NZD/USD', 'currencies', 86, 0.60100, .00017, .000012, 5], ['USD/JPY', 'currencies', 88, 149.500, .00020, .000014, 3],
  ['USD/CHF', 'currencies', 87, 0.86800, .00015, .000010, 5], ['EUR/JPY', 'currencies', 88, 162.000, .00023, .000016, 3],
  ['GBP/JPY', 'currencies', 86, 188.500, .00027, .000018, 3], ['AUD/CAD', 'currencies', 86, 0.91200, .00016, .000011, 5],
  ['USD/CAD', 'currencies', 85, 1.38500, .00018, .000012, 5], ['EUR/CHF', 'currencies', 84, 0.94200, .00014, .000010, 5],
  ['EUR/NZD', 'currencies', 83, 1.75000, .00026, .000018, 5], ['GBP/AUD', 'currencies', 82, 2.02000, .00028, .000019, 5],
  ['AUD/JPY', 'currencies', 82, 97.5000, .00022, .000015, 3], ['EUR/HUF', 'currencies', 80, 395.000, .00055, .000038, 2],
  ['USD/SGD', 'currencies', 80, 1.35000, .00016, .000011, 5], ['USD/MXN', 'currencies', 78, 17.2000, .00028, .000019, 3],
  ['USD/MYR', 'currencies', 76, 4.72000, .00020, .000014, 4],
  ['EUR/USD OTC', 'currencies', 92, 1.08500, .00020, .000014, 5], ['GBP/USD OTC', 'currencies', 92, 1.26500, .00025, .000017, 5],
  ['AUD/USD OTC', 'currencies', 92, 0.65200, .00018, .000012, 5], ['EUR/GBP OTC', 'currencies', 92, 0.85800, .00016, .000011, 5],
  ['NZD/USD OTC', 'currencies', 92, 0.60100, .00017, .000012, 5], ['USD/JPY OTC', 'currencies', 92, 149.500, .00020, .000014, 3],
  ['USD/CHF OTC', 'currencies', 91, 0.86800, .00015, .000010, 5], ['EUR/JPY OTC', 'currencies', 90, 162.000, .00023, .000016, 3],
  ['AUD/JPY OTC', 'currencies', 82, 97.5000, .00022, .000015, 3], ['AUD/CAD OTC', 'currencies', 75, 0.91200, .00016, .000011, 5],
  ['USD/CAD OTC', 'currencies', 75, 1.38500, .00018, .000012, 5], ['EUR/CHF OTC', 'currencies', 74, 0.94200, .00014, .000010, 5],
  ['EUR/NZD OTC', 'currencies', 72, 1.75000, .00026, .000018, 5], ['GBP/AUD OTC', 'currencies', 80, 2.02000, .00028, .000019, 5],
  ['GBP/JPY OTC', 'currencies', 88, 188.500, .00027, .000018, 3], ['USD/SGD OTC', 'currencies', 82, 1.35000, .00016, .000011, 5],
  ['USD/MXN OTC', 'currencies', 31, 17.2000, .00028, .000019, 3], ['EUR/HUF OTC', 'currencies', 85, 395.000, .00055, .000038, 2],
  ['USD/MYR OTC', 'currencies', 75, 4.72000, .00020, .000014, 4], ['BHD/CNY OTC', 'currencies', 80, 18.7500, .00025, .000017, 3],
  ['USD/EGP OTC', 'currencies', 80, 48.7500, .00035, .000024, 3], ['USD/CLP OTC', 'currencies', 86, 900.000, .00060, .000042, 1],
  ['MAD/USD OTC', 'currencies', 85, 0.09900, .00018, .000012, 5], ['USD/COP OTC', 'currencies', 32, 4100.00, .00055, .000038, 1],
  ['OMR/CNY OTC', 'currencies', 45, 18.9500, .00025, .000017, 3], ['QAR/CNY OTC', 'currencies', 43, 1.95000, .00022, .000015, 4],
  ['AUD/NZD OTC', 'currencies', 37, 1.09200, .00017, .000012, 5], ['UAH/USD OTC', 'currencies', 39, 0.02440, .00035, .000024, 6],
  ['USD/IDR OTC', 'currencies', 52, 15680.0, .00040, .000028, 1], ['CHF/NOK OTC', 'currencies', 80, 12.2000, .00030, .000021, 3],
  ['Bitcoin OTC', 'crypto', 81, 67500, .0022, .00015, 2], ['Ethereum OTC', 'crypto', 92, 3250, .0018, .00012, 2],
  ['Cardano OTC', 'crypto', 74, 0.580, .0015, .00010, 4], ['Solana OTC', 'crypto', 74, 165.00, .0017, .00011, 2],
  ['Dogecoin OTC', 'crypto', 80, 0.1450, .0014, .000090, 4], ['BNB OTC', 'crypto', 92, 585.00, .0019, .00013, 2],
  ['Polkadot OTC', 'crypto', 92, 6.850, .0020, .00014, 3], ['Chainlink OTC', 'crypto', 92, 14.50, .0021, .00014, 3],
  ['Litecoin OTC', 'crypto', 92, 85.00, .0018, .00012, 2], ['Avalanche OTC', 'crypto', 86, 38.00, .0022, .00015, 2],
  ['TRON OTC', 'crypto', 86, 0.1650, .0016, .00011, 4], ['Polygon OTC', 'crypto', 82, 0.7200, .0019, .00013, 4],
  ['Bitcoin ETF OTC', 'crypto', 92, 67500, .0022, .00015, 2],
  ['Gold OTC', 'commodities', 80, 2650.00, .00035, .000024, 2], ['Silver OTC', 'commodities', 80, 31.500, .00042, .000029, 3],
  ['Brent Oil OTC', 'commodities', 80, 85.500, .00045, .000031, 2], ['WTI Crude Oil OTC', 'commodities', 80, 81.250, .00044, .000030, 2],
  ['Natural Gas OTC', 'commodities', 45, 3.2500, .00070, .000048, 3], ['Palladium spot OTC', 'commodities', 45, 1050.00, .00040, .000028, 2],
  ['Platinum spot OTC', 'commodities', 45, 980.00, .00038, .000026, 2],
  ['US100', 'indices', 75, 17800, .00030, .000021, 1], ['SP500', 'indices', 75, 5100, .00027, .000019, 1],
  ['AUS 200', 'indices', 75, 7800, .00029, .000020, 1], ['CAC 40', 'indices', 53, 8050, .00033, .000023, 1],
  ['D30EUR', 'indices', 53, 18200, .00032, .000022, 1], ['DJI30', 'indices', 53, 39200, .00025, .000017, 1],
  ['JPN225', 'indices', 53, 38500, .00028, .000019, 1], ['E35EUR', 'indices', 53, 4850, .00031, .000021, 1],
  ['E50EUR', 'indices', 53, 5050, .00030, .000021, 1], ['F40EUR', 'indices', 53, 8100, .00032, .000022, 1],
  ['SMI 20', 'indices', 53, 11900, .00026, .000018, 1], ['AEX 25', 'indices', 53, 880, .00029, .000020, 1],
  ['HONG KONG 33', 'indices', 53, 17200, .00034, .000023, 1]
];

const ASSETS = {};
RAW.forEach(r => { ASSETS[r[0]] = new Asset(r[0], r[3], r[4], r[5], r[6], r[1], r[2]); });

/* тик всех движков; история (свечи) строится только у «построенных» активов */
let lastCoarse = 0;
function tickAll(nowSec) {
  /* U2: в M5+ живой тик пушится раз в 60с — та же плотность выборки, что у истории */
  const coarse = nowSec - lastCoarse >= 60;
  if (coarse) lastCoarse = nowSec;
  for (const a of Object.values(ASSETS)) {
    const p = a.eng.next();
    /* U2: слабый якорь к базе в лайве (постоянная ~7ч — свечи не сжимает),
       без него цену за сутки уносит на ±13%+ */
    a.eng.price = a.eng.basePrice + (a.eng.price - a.eng.basePrice) * 0.99998;
    if (a.built) for (const ag of Object.values(a.aggs)) {
      if (ag.sec >= 300 && !coarse) continue;
      ag.push(p, nowSec);
    }
  }
}

/* PLAT1: переопределения выплат из настроек (админка) */
const PAYOUT_OVERRIDES = {};
function setPayoutOverrides(map){
  for(const k of Object.keys(PAYOUT_OVERRIDES)) delete PAYOUT_OVERRIDES[k];
  for(const [id,p] of Object.entries(map||{})){
    const pct=Number(p);
    if(ASSETS[id] && Number.isFinite(pct) && pct>=1 && pct<=1000) PAYOUT_OVERRIDES[id]=pct;
  }
  for(const [id,a] of Object.entries(ASSETS)) a.payout = PAYOUT_OVERRIDES[id] || a.basePayout;
}
function catalog() {
  return RAW.map(r => ({ id: r[0], cat: r[1], payout: PAYOUT_OVERRIDES[r[0]] || r[2], dec: r[6] }));
}

const BOOT = Date.now() / 1000; /* V2: эпоха сервера — клиент сбрасывает кэш истории при рестарте */
function basePayouts(){ const o={}; for(const r of RAW) o[r[0]]=r[2]; return o; }
module.exports = { TICK_MS, TFS, ASSETS, tickAll, catalog, BOOT, DEPTH, BUILD_DAYS, setPayoutOverrides, PAYOUT_OVERRIDES, basePayouts };
