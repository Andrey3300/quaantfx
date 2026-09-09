'use strict';
/* CHAT2: вложения в чатах поддержки (скрины с обеих сторон, группой как в ТГ).
   Белый список: jpg/png/gif/webp (+svg и pdf — только скачиванием, не инлайн).
   Архивы/exe/прочий хлам отсекаются по mime + расширению + magic-bytes. */
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { UPLOADS } = require('./db');

const CHAT_DIR = path.join(UPLOADS, 'chat');
fs.mkdirSync(CHAT_DIR, { recursive: true });
const QUICK_DIR = path.join(UPLOADS, 'quick'); /* CHAT4: файлы шаблонов быстрых ответов */
fs.mkdirSync(QUICK_DIR, { recursive: true });

const MAX_FILES = 5;
const MAX_SIZE = 8 * 1024 * 1024;

/* mime -> расширение (расширение берём из белого списка, НЕ из имени файла) */
const CHAT_TYPES = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'application/pdf': 'pdf'
};
/* инлайн-превью — только растровые картинки; svg/pdf отдаём скачиванием (XSS-safe) */
const INLINE_RE = /^image\/(jpeg|png|gif|webp)$/;

function chatUpload() {
  return multer({
    storage: multer.diskStorage({
      destination: (req, file, cb) => {
        const dir = path.join(CHAT_DIR, String(req.params.id || req.params.cid || 'x'));
        fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
      },
      filename: (req, file, cb) => {
        const ext = CHAT_TYPES[file.mimetype] || 'bin';
        cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}.${ext}`);
      }
    }),
    limits: { fileSize: MAX_SIZE },
    fileFilter: (req, file, cb) => {
      const ext = String(file.originalname.split('.').pop() || '').toLowerCase();
      const okMime = !!CHAT_TYPES[file.mimetype];
      const okExt = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'pdf'].includes(ext);
      cb(okMime && okExt ? null : new Error('bad_file'), okMime && okExt);
    }
  }).array('files', MAX_FILES);
}

/* middleware: multipart -> multer с человеческими кодами ошибок, остальное — дальше */
function chatFilesMw(req, res, next) {
  if (!req.is('multipart/form-data')) return next();
  chatUpload()(req, res, (err) => {
    if (err) {
      (req.files || []).forEach(f => { try { fs.unlinkSync(f.path); } catch (e) {} });
      if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: 'file_too_big' });
      if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE')
        return res.status(400).json({ error: 'too_many_files' });
      return res.status(400).json({ error: 'bad_file' });
    }
    next();
  });
}

/* magic-bytes проверка содержимого (mime от клиента подделать легко) */
function sniffOk(abs, mime) {
  try {
    const fd = fs.openSync(abs, 'r');
    const buf = Buffer.alloc(600);
    const n = fs.readSync(fd, buf, 0, 600, 0);
    fs.closeSync(fd);
    const h = buf.slice(0, Math.min(n, 16));
    if (mime === 'image/jpeg') return h[0] === 0xFF && h[1] === 0xD8 && h[2] === 0xFF;
    if (mime === 'image/png') return h[0] === 0x89 && h[1] === 0x50 && h[2] === 0x4E && h[3] === 0x47;
    if (mime === 'image/gif') { const s = h.slice(0, 6).toString(); return s === 'GIF87a' || s === 'GIF89a'; }
    if (mime === 'image/webp') return h.slice(0, 4).toString() === 'RIFF' && h.slice(8, 12).toString() === 'WEBP';
    if (mime === 'application/pdf') return h.slice(0, 4).toString() === '%PDF';
    if (mime === 'image/svg+xml') {
      const s = buf.slice(0, n).toString('utf8').trim().slice(0, 500);
      return s.startsWith('<') && s.includes('<svg') && !s.toLowerCase().includes('<script');
    }
  } catch (e) {}
  return false;
}

/* после multer: проверить содержимое, вернуть мета [{n,o,m,s}] или кинуть {code} */
function collectChatFiles(req) {
  const out = [];
  for (const f of (req.files || [])) {
    if (!sniffOk(f.path, f.mimetype)) {
      try { fs.unlinkSync(f.path); } catch (e) {}
      const e = new Error('bad_file'); e.code = 'bad_file'; throw e;
    }
    out.push({ n: path.basename(f.filename), o: String(f.originalname).slice(0, 120), m: f.mimetype, s: f.size });
  }
  return out;
}
function discardUpload(req) {
  (req.files || []).forEach(f => { try { fs.unlinkSync(f.path); } catch (e) {} });
}

function parseFiles(raw) {
  try { const a = JSON.parse(raw || '[]'); return Array.isArray(a) ? a : []; } catch (e) { return []; }
}

/* отдача файла с защитой от traversal; svg/pdf — только скачиванием */
function serveAbs(res, abs, meta) {
  if (!abs || !fs.existsSync(abs)) return res.status(404).end();
  res.set('X-Content-Type-Options', 'nosniff');
  if (meta && INLINE_RE.test(meta.m || '')) {
    res.type(meta.m);
    return res.sendFile(abs);
  }
  return res.download(abs, (meta && meta.o) || 'file');
}
function sendChatFile(res, chatId, stored, meta) {
  const safe = path.basename(String(stored || ''));
  const abs = path.join(CHAT_DIR, String(chatId), safe);
  if (!safe || !abs.startsWith(CHAT_DIR)) return res.status(404).end();
  return serveAbs(res, abs, meta);
}

/* ── CHAT4: шаблоны быстрых ответов ── */
function quickUploadMw(req, res, next) {
  if (!req.is('multipart/form-data')) return next();
  multer({
    storage: multer.diskStorage({
      destination: (req2, file, cb) => cb(null, QUICK_DIR),
      filename: (req2, file, cb) => {
        const ext = CHAT_TYPES[file.mimetype] || 'bin';
        cb(null, `q${Date.now()}-${Math.round(Math.random() * 1e9)}.${ext}`);
      }
    }),
    limits: { fileSize: MAX_SIZE },
    fileFilter: (req2, file, cb) => {
      const ext = String(file.originalname.split('.').pop() || '').toLowerCase();
      const okk = !!CHAT_TYPES[file.mimetype] && ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'pdf'].includes(ext);
      cb(okk ? null : new Error('bad_file'), okk);
    }
  }).array('files', MAX_FILES)(req, res, (err) => {
    if (err) {
      (req.files || []).forEach(f => { try { fs.unlinkSync(f.path); } catch (e) {} });
      if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: 'file_too_big' });
      if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE')
        return res.status(400).json({ error: 'too_many_files' });
      return res.status(400).json({ error: 'bad_file' });
    }
    next();
  });
}
function collectQuickFiles(req) {
  const out = [];
  for (const f of (req.files || [])) {
    if (!sniffOk(f.path, f.mimetype)) {
      try { fs.unlinkSync(f.path); } catch (e) {}
      const e = new Error('bad_file'); e.code = 'bad_file'; throw e;
    }
    out.push({ n: path.basename(f.filename), o: String(f.originalname).slice(0, 120), m: f.mimetype, s: f.size });
  }
  return out;
}
/* копирование файлов шаблона в чат (сообщение хранит свои копии — удаление шаблона историю не ломает) */
function copyQuickFiles(itemFiles, chatId) {
  const dir = path.join(CHAT_DIR, String(chatId));
  fs.mkdirSync(dir, { recursive: true });
  const out = [];
  for (const f of (itemFiles || [])) {
    const src = path.join(QUICK_DIR, path.basename(String(f.n || '')));
    if (!fs.existsSync(src)) continue;
    const ext = (CHAT_TYPES[f.m] || 'bin');
    const dst = `${Date.now()}-${Math.round(Math.random() * 1e9)}.${ext}`;
    fs.copyFileSync(src, path.join(dir, dst));
    out.push({ n: dst, o: f.o || 'file', m: f.m, s: f.s });
  }
  return out;
}
function unlinkQuickFiles(itemFiles) {
  for (const f of (itemFiles || [])) {
    try { fs.unlinkSync(path.join(QUICK_DIR, path.basename(String(f.n || '')))); } catch (e) {}
  }
}
function sendQuickFile(res, stored, meta) {
  const safe = path.basename(String(stored || ''));
  const abs = path.join(QUICK_DIR, safe);
  if (!safe || !abs.startsWith(QUICK_DIR)) return res.status(404).end();
  return serveAbs(res, abs, meta);
}

module.exports = { chatFilesMw, collectChatFiles, discardUpload, parseFiles, sendChatFile, MAX_FILES, MAX_SIZE,
  quickUploadMw, collectQuickFiles, copyQuickFiles, unlinkQuickFiles, sendQuickFile };
