'use strict';
const fs = require('fs');
const { JSDOM } = require('jsdom');
const i18nSrc = fs.readFileSync(__dirname + '/../public/i18n.js', 'utf8');

const FIX = `
<body>
  <div class="note" id="wd-note">Заявки обрабатываются до 24 часов</div>
  <input id="wd-addr" placeholder="Адрес получателя">
  <input id="wd-amt" placeholder="Минимум $10">
  <small id="frag"> · промокод</small>
  <span id="dir">на графике</span>
  <div class="auth-lang"><span id="lang-cur-auth">x</span></div>
  <span id="lang-cur-user"></span>
  <div id="lang-list">MARKER</div>
</body>`;

const LANGS = ['en','fr','de','pt','es','it','hi'];
let fail = 0;
const ok = (c, m) => { if (c) console.log('  ok  ' + m); else { console.log('  FAIL ' + m); fail++; } };

// 1) dict coverage of new keys
const dicts = {};
for (const L of LANGS) {
  const line = i18nSrc.split('\n').find(l => l.startsWith('D.' + L + '='));
  dicts[L] = JSON.parse(line.slice(('D.' + L + '=').length).replace(/;$/, ''));
}
const must = ['Заявки обрабатываются до 24 часов','Ничего не найдено','Нет активных','на графике','отдельная панель',
 'Скопировать сигнал','Ожидание сигналов...','Операций пока нет','Сделок пока нет','Выполнено','В обработке',
 'Сделок','Винрейт','Чистый результат','Оборот','Лучшая сделка','ДАТА','ПРОГНОЗ','СУММА','РЕЗУЛЬТАТ','ПРОФИТ',
 '▲ Вверх','▼ Вниз','▲ ВВЕРХ','▼ ВНИЗ','Проигрыш','промокод','бонус','Поддержка','Напишите сообщение...','Отправить',
 'Нет обращений','Ответить...','Консультант','Онлайн','ДД.ММ.ГГГГ','Чаты','Дашборд','Пользователи','Сделки','Промокоды',
 'Кошельки','Зачислить','Отклонить','Выплачено','Отклонить + возврат','Разблокировать','Заблокировать','Сохранить',
 'заблокирован','активен','открыта','возврат','выигрыш','проигрыш','на проверке','отклонено','подтверждён','выключен',
 'Никого не найдено','Сделок нет','Заявок нет','Запросов нет','Промокодов нет','Изменений пока нет','Пользователей',
 'Заблокировано','Депозиты в очереди','Выводы в очереди','KYC в очереди','Открытых сделок','Новый промокод',
 'Существующие','Адреса кошельков','Лог изменений','Заявки на пополнение','Заявки на вывод','Запросы',
 'Причина отклонения:','Причина отклонения (будет видна пользователю):','Ошибка: {m}','РЕАЛЬНЫЙ',
 'Нет заявок в обработке','Нет запросов в обработке','Это не админский аккаунт','Неверная почта или пароль',
 'Избранное','Крипто','Сырьё','Индексы','Пароль изменён','Текущий пароль неверный','Не удалось сменить пароль',
 'Не удалось создать заявку','Недостаточно средств на реальном счёте','Не удалось загрузить историю {a}'];
for (const L of LANGS) {
  const miss = must.filter(k => dicts[L][k] == null);
  ok(miss.length === 0, L + ': all ' + must.length + ' new keys present' + (miss.length ? ' MISSING: ' + miss.slice(0,5).join('|') : ''));
}

// 2) per-lang DOM behaviour
for (const L of LANGS) {
  const html = '<!DOCTYPE html><html><head><script>' + i18nSrc.replace(/<\/script/g,'<\\/script') + '</script></head>' + FIX + '</html>';
  const dom = new JSDOM(html, { url: 'http://localhost/', runScripts: 'dangerously',
    beforeParse(w){ w.localStorage.setItem('synthotc_lang_guest', L); } });
  const w = dom.window;
  if (w.applyLang) w.applyLang(); /* детерминированно: стартовый applyLang ждёт DOMContentLoaded */
  const note = w.document.getElementById('wd-note').textContent;
  ok(note !== 'Заявки обрабатываются до 24 часов', L + ': withdrawal note translated -> ' + note.slice(0, 24));
  ok(w.document.getElementById('wd-addr').getAttribute('placeholder') !== 'Адрес получателя', L + ': placeholder translated');
  ok(w.document.getElementById('frag').textContent.trim().startsWith('·') && w.document.getElementById('frag').textContent !== ' · промокод', L + ': fragment "· промокод" translated');
  ok(w.document.getElementById('dir').textContent !== 'на графике', L + ': "на графике" translated');
  // H8: applyLang must NOT rebuild #lang-list
  ok(w.document.getElementById('lang-list').textContent === 'MARKER', L + ': applyLang leaves #lang-list untouched (H8)');
  // setLang rebuilds + updates labels
  w.setLang('ru');
  ok(w.document.getElementById('lang-list').textContent !== 'MARKER', L + ': setLang rebuilds #lang-list');
  ok(w.document.getElementById('lang-cur-auth').textContent === 'Русский', L + ': label updated on setLang');
  ok(w.document.getElementById('wd-note').textContent === 'Заявки обрабатываются до 24 часов', L + ': setLang(ru) returns RU');
  // getLang exposed
  ok(w.getLang() === 'ru', L + ': getLang() exposed');
  w.close();
}

console.log(fail ? '\nFAILED: ' + fail : '\nALL TESTS PASSED');
process.exit(fail ? 1 : 0);
