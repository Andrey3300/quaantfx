'use strict';
/* примитивный in-memory rate limiter для /api/auth (по IP+пути) */
const buckets = new Map();
function rateLimit(limit, windowMs) {
  return (req, res, next) => {
    const key = req.ip + '|' + req.path;
    const t = Date.now();
    let b = buckets.get(key);
    if (!b || t > b.reset) { b = { n: 0, reset: t + windowMs }; buckets.set(key, b); }
    if (++b.n > limit) return res.status(429).json({ error: 'too_many_requests' });
    next();
  };
}
setInterval(() => {
  const t = Date.now();
  for (const [k, b] of buckets) if (t > b.reset) buckets.delete(k);
}, 60000).unref();

module.exports = rateLimit;
