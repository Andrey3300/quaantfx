/* G6: один раз скачивает готовые SVG-паки (circle-flags + cryptocurrency-icons) в public/img/icons.
   Запуск: node scripts/fetch-icons.mjs  (нужен интернет только при скачивании; дальше иконки локальные). */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const FLAGS = ['us','eu','gb','jp','au','ca','ch','nz','hu','sg','mx','my','bh','cn','eg','cl','ma','co','om','qa','ua','id','no','hk','fr','de','nl','pt','es','it','in'];
const COINS = ['btc','eth','ada','sol','doge','bnb','dot','link','ltc','avax','trx','matic','usdt','usdc'];

const FLAG_URL = c => `https://raw.githubusercontent.com/hatscripts/circle-flags/gh-pages/flags/${c}.svg`;
const COIN_URL = c => `https://raw.githubusercontent.com/spothq/cryptocurrency-icons/master/svg/color/${c}.svg`;

async function grab(url, dest) {
  if (fs.existsSync(dest) && fs.statSync(dest).size > 100) return 'skip';
  const res = await fetch(url);
  if (!res.ok) return 'miss ' + res.status;
  const body = await res.text();
  if (!body.trim().startsWith('<')) return 'bad';
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, body);
  return 'ok';
}

let ok = 0, skip = 0, miss = [];
for (const c of FLAGS) {
  const r = await grab(FLAG_URL(c), path.join(root, 'public/img/icons/flags', c + '.svg'));
  if (r === 'ok') ok++; else if (r === 'skip') skip++; else miss.push('flag:' + c);
}
for (const c of COINS) {
  const r = await grab(COIN_URL(c), path.join(root, 'public/img/icons/coins', c + '.svg'));
  if (r === 'ok') ok++; else if (r === 'skip') skip++; else miss.push('coin:' + c);
}
console.log(`icons: ok=${ok} skip=${skip} miss=${miss.length ? miss.join(',') : 'none'}`);
