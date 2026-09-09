'use strict';
/* Рыночные часы: единое правило закрытия обычных форекс-пар.
   OTC/крипта/сырьё/индексы не закрываются никогда (см. isClosable).
   Время — UTC, формат "HH:MM". */

function parseHM(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim());
  if (!m) return null;
  const h = +m[1], mi = +m[2];
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
}

function isClosable(name, cat) {
  return cat === 'currencies' && !String(name || '').includes('OTC');
}

/* Состояние закрываемых активов в момент t (unix sec).
   mh: {enabled, friClose, sunOpen, nightStart, nightEnd}
   Возвращает {closed, closesAt, opensAt} (метки — unix sec или null). */
function marketState(mh, t) {
  mh = mh || {};
  if (!mh.enabled) return { closed: false, closesAt: null, opensAt: null };
  const fc = parseHM(mh.friClose) != null ? parseHM(mh.friClose) : 22 * 60;
  const so = parseHM(mh.sunOpen) != null ? parseHM(mh.sunOpen) : 22 * 60;
  let ns = parseHM(mh.nightStart), ne = parseHM(mh.nightEnd);
  if (!(ns != null && ne != null) || ns === ne) { ns = null; ne = null; } /* ns>ne = через полночь */

  const d = new Date(t * 1000);
  const day = d.getUTCDay();
  const mins = d.getUTCHours() * 60 + d.getUTCMinutes();
  const midnight = t - (d.getUTCHours() * 3600 + d.getUTCMinutes() * 60 + d.getUTCSeconds());
  const DAY = 86400;

  let closed = false, opensAt = null, closesAt = null;

  /* выходные: пт с friClose … вс до sunOpen */
  if (day === 6) { closed = true; opensAt = midnight + DAY + so * 60; }
  else if (day === 5 && mins >= fc) { closed = true; opensAt = midnight + 2 * DAY + so * 60; }
  else if (day === 0 && mins < so) { closed = true; opensAt = midnight + so * 60; }
  else if (day === 5) { closesAt = midnight + fc * 60; }

  /* ночная пауза (если выходные уже закрыли — их opensAt главнее) */
  if (ns != null) {
    const wrap = ns > ne;
    const inPause = wrap ? (mins >= ns || mins < ne) : (mins >= ns && mins < ne);
    if (!closed && inPause) {
      closed = true;
      opensAt = !wrap ? midnight + ne * 60 : (mins >= ns ? midnight + DAY + ne * 60 : midnight + ne * 60);
    } else if (!closed) {
      const nextNight = !wrap
        ? (mins < ns ? midnight + ns * 60 : midnight + DAY + ns * 60)
        : midnight + ns * 60; /* открыты только между ne и ns */
      if (nextNight > t && (closesAt == null || nextNight < closesAt)) closesAt = nextNight;
    }
  }
  if (closesAt != null && closesAt <= t) closesAt = null;
  return { closed, closesAt, opensAt };
}

module.exports = { parseHM, isClosable, marketState };
