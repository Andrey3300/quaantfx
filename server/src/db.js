'use strict';
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');

const DATA_DIR = path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, 'uploads', 'avatars'), { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, 'uploads', 'verify'), { recursive: true });

const db = new Database(process.env.DB_PATH || path.join(DATA_DIR, 'synth.sqlite'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  pass_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  blocked INTEGER NOT NULL DEFAULT 0,
  client_id TEXT NOT NULL,
  created_at REAL NOT NULL,
  first TEXT NOT NULL DEFAULT '',
  last TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  dob TEXT NOT NULL DEFAULT '',
  country TEXT NOT NULL DEFAULT 'RU',
  nick TEXT NOT NULL DEFAULT 'user',
  hide_profile INTEGER NOT NULL DEFAULT 0,
  avatar_path TEXT,
  email_verified INTEGER NOT NULL DEFAULT 0,
  verify_status TEXT NOT NULL DEFAULT 'none',
  demo_balance REAL NOT NULL DEFAULT 10000,
  real_balance REAL NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS sessions(
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at REAL NOT NULL,
  expires_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS trades(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  account TEXT NOT NULL CHECK(account IN ('demo','real')),
  asset TEXT NOT NULL,
  dir TEXT NOT NULL CHECK(dir IN ('UP','DOWN')),
  amount REAL NOT NULL,
  payout_pct REAL NOT NULL,
  entry_price REAL NOT NULL,
  entry_time REAL NOT NULL,
  close_time REAL NOT NULL,
  tf_label TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open',
  close_price REAL, won INTEGER, tie INTEGER, payout REAL, profit REAL
);
CREATE INDEX IF NOT EXISTS idx_trades_open ON trades(status, close_time);
CREATE INDEX IF NOT EXISTS idx_trades_user ON trades(user_id, status);
CREATE TABLE IF NOT EXISTS deposits(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  method TEXT NOT NULL,
  amount REAL NOT NULL,
  promo_code TEXT,
  bonus REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  reject_reason TEXT,
  created_at REAL NOT NULL,
  decided_at REAL,
  decided_by INTEGER
);
CREATE TABLE IF NOT EXISTS withdrawals(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  method TEXT NOT NULL,
  amount REAL NOT NULL,
  addr TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  reject_reason TEXT,
  created_at REAL NOT NULL,
  decided_at REAL,
  decided_by INTEGER
);
CREATE TABLE IF NOT EXISTS verifications(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  files TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'pending',
  reject_reason TEXT,
  created_at REAL NOT NULL,
  decided_at REAL,
  decided_by INTEGER
);
CREATE TABLE IF NOT EXISTS promocodes(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE NOT NULL,
  bonus_pct REAL NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  uses INTEGER NOT NULL DEFAULT 0,
  created_at REAL NOT NULL
);
`);

db.exec(`
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS wallets(
  method_id TEXT PRIMARY KEY,
  addr TEXT NOT NULL,
  updated_at REAL,
  updated_by INTEGER
);
CREATE TABLE IF NOT EXISTS wallet_log(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  method_id TEXT NOT NULL,
  old_addr TEXT NOT NULL,
  new_addr TEXT NOT NULL,
  changed_by INTEGER,
  changed_at REAL
);
CREATE TABLE IF NOT EXISTS chats(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  specialist TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  created_at REAL
);
CREATE TABLE IF NOT EXISTS chat_messages(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  sender TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at REAL
);
`);
/* миграция: тип документа в верификациях */
{
  const cols = db.prepare('PRAGMA table_info(verifications)').all().map(c => c.name);
  if (!cols.includes('doc_type')) db.exec(`ALTER TABLE verifications ADD COLUMN doc_type TEXT NOT NULL DEFAULT ''`);
}
/* миграция O1: запертый бонус + скрытый вейджер у юзера */
{
  const cols = db.prepare('PRAGMA table_info(users)').all().map(c => c.name);
  if (!cols.includes('bonus_locked')) db.exec(`ALTER TABLE users ADD COLUMN bonus_locked REAL NOT NULL DEFAULT 0`);
  if (!cols.includes('wager_need')) db.exec(`ALTER TABLE users ADD COLUMN wager_need REAL NOT NULL DEFAULT 0`);
  if (!cols.includes('wager_done')) db.exec(`ALTER TABLE users ADD COLUMN wager_done REAL NOT NULL DEFAULT 0`);
}
/* миграция O2: снапшоты баланса/бонуса в заявках на вывод */
{
  const cols = db.prepare('PRAGMA table_info(withdrawals)').all().map(c => c.name);
  if (!cols.includes('bal_snap')) db.exec(`ALTER TABLE withdrawals ADD COLUMN bal_snap REAL`);
  if (!cols.includes('bonus_snap')) db.exec(`ALTER TABLE withdrawals ADD COLUMN bonus_snap REAL`);
}
/* миграция O1: множитель вейджера у промокодов */
{
  const cols = db.prepare('PRAGMA table_info(promocodes)').all().map(c => c.name);
  if (!cols.includes('wager_mult')) db.exec(`ALTER TABLE promocodes ADD COLUMN wager_mult REAL NOT NULL DEFAULT 20`);
}
/* L1: редактируемые пресеты причин отклонения вывода */
db.exec(`
CREATE TABLE IF NOT EXISTS reject_presets(
  slot INTEGER PRIMARY KEY,
  text TEXT NOT NULL DEFAULT ''
);
`);
{
  const DEF = [
    'KYC не пройден. Пройдите верификацию и повторите заявку.',
    'Адрес вывода не совпадает с адресом пополнения. Предоставьте подтверждение владения адресом.',
    'Имя владельца счёта не совпадает с данными KYC.',
    'Подозрение на мультиаккаунтинг. Обратитесь в поддержку.',
    'Технические работы у платёжного провайдера. Заявка будет обработана позже.',
    'Превышен лимит вывода для вашего уровня аккаунта.'
  ];
  const ins = db.prepare('INSERT OR IGNORE INTO reject_presets (slot, text) VALUES (?,?)');
  DEF.forEach((t, i) => ins.run(i + 1, t));
}

/* ── 8-значные клиентские ID: последовательно от случайного большого старта ── */
function nextClientId() {
  const row = db.prepare(`SELECT value FROM meta WHERE key='client_id_seq'`).get();
  const seq = row ? Number(row.value) : 10000000 + Math.floor(Math.random() * 90000000);
  db.prepare(`INSERT INTO meta (key, value) VALUES ('client_id_seq', ?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(String(seq + 1));
  return String(seq);
}

/* ── сиды ── */
const now = () => Date.now() / 1000;
if (!db.prepare('SELECT id FROM users WHERE email=?').get('admin@synth.local')) {
  db.prepare('INSERT INTO users (email, pass_hash, role, client_id, created_at, nick) VALUES (?,?,?,?,?,?)')
    .run('admin@synth.local', bcrypt.hashSync('admin123', 10), 'admin', nextClientId(), now(), 'admin');
  console.log('[seed] admin создан: admin@synth.local / admin123 — СМЕНИТЕ ПАРОЛЬ');
}
if (!db.prepare('SELECT id FROM promocodes WHERE code=?').get('WELCOME')) {
  db.prepare('INSERT INTO promocodes (code, bonus_pct, active, created_at) VALUES (?,?,1,?)')
    .run('WELCOME', 50, now());
  console.log('[seed] промокод WELCOME 50%');
}

module.exports = db;
module.exports.DATA_DIR = DATA_DIR;
module.exports.UPLOADS = path.join(DATA_DIR, 'uploads');
module.exports.nextClientId = nextClientId;
/* W: мультиязычные причины отклонения + язык клиента */
try { db.exec("ALTER TABLE users ADD COLUMN lang TEXT NOT NULL DEFAULT ''"); } catch (e) {}
try { db.exec("ALTER TABLE reject_presets ADD COLUMN tr TEXT NOT NULL DEFAULT '{}'"); } catch (e) {}
/* W: встроенные переводы дефолтных причин — заполняются только в пустые tr, правки админа не трогаем */
const DEF_TR = {
  1: { en: 'KYC not completed. Please verify your identity and resubmit the request.', fr: "KYC non validé. Veuillez vérifier votre identité et soumettre à nouveau la demande.", de: 'KYC nicht bestanden. Bitte verifizieren Sie sich und stellen Sie den Antrag erneut.', pt: 'KYC não concluído. Verifique sua identidade e reenvie a solicitação.', es: 'KYC no completado. Verifique su identidad y vuelva a enviar la solicitud.', it: 'KYC non completato. Verifica la tua identità e invia di nuovo la richiesta.', hi: 'KYC पूर्ण नहीं। कृपया पहचान सत्यापित करें और अनुरोध दोबारा भेजें।' },
  2: { en: 'Withdrawal address does not match the deposit address. Provide proof of address ownership.', fr: "L'adresse de retrait ne correspond pas à l'adresse de dépôt. Fournissez une preuve de propriété de l'adresse.", de: 'Die Auszahlungsadresse stimmt nicht mit der Einzahlungsadresse überein. Legen Sie einen Adressnachweis vor.', pt: 'O endereço de saque não corresponde ao endereço de depósito. Apresente comprovação de propriedade do endereço.', es: 'La dirección de retiro no coincide con la dirección de depósito. Proporcione prueba de propiedad de la dirección.', it: "L'indirizzo di prelievo non corrisponde all'indirizzo di deposito. Fornisci la prova di proprietà dell'indirizzo.", hi: 'निकासी पता जमा पते से मेल नहीं खाता। पते के स्वामित्व का प्रमाण दें।' },
  3: { en: 'Account holder name does not match the KYC data.', fr: 'Le nom du titulaire ne correspond pas aux données KYC.', de: 'Der Name des Kontoinhabers stimmt nicht mit den KYC-Daten überein.', pt: 'O nome do titular não corresponde aos dados do KYC.', es: 'El nombre del titular no coincide con los datos KYC.', it: 'Il nome del titolare non corrisponde ai dati KYC.', hi: 'खाता धारक का नाम KYC डेटा से मेल नहीं खाता।' },
  4: { en: 'Suspicion of multi-accounting. Contact support.', fr: 'Soupçon de multi-comptes. Contactez le support.', de: 'Verdacht auf Mehrfachkonten. Wenden Sie sich an den Support.', pt: 'Suspeita de multicontas. Contacte o suporte.', es: 'Sospecha de multicuentas. Contacte con soporte.', it: 'Sospetto di multi-account. Contatta il supporto.', hi: 'मल्टी-अकाउंटिंग का संदेह। सपोर्ट से संपर्क करें।' },
  5: { en: 'Technical work at the payment provider. The request will be processed later.', fr: 'Maintenance chez le prestataire de paiement. La demande sera traitée plus tard.', de: 'Technische Arbeiten beim Zahlungsanbieter. Der Antrag wird später bearbeitet.', pt: 'Manutenção no provedor de pagamento. A solicitação será processada depois.', es: 'Trabajos técnicos en el proveedor de pagos. La solicitud se procesará más tarde.', it: 'Manutenzione tecnica presso il provider di pagamento. La richiesta sarà elaborata più tardi.', hi: 'भुगतान प्रदाता पर तकनीकी कार्य। अनुरोध बाद में संसाधित होगा।' },
  6: { en: 'Withdrawal limit for your account level exceeded.', fr: 'Limite de retrait dépassée pour votre niveau de compte.', de: 'Auszahlungslimit für Ihr Kontolevel überschritten.', pt: 'Limite de saque do seu nível de conta excedido.', es: 'Límite de retiro para su nivel de cuenta superado.', it: 'Limite di prelievo per il tuo livello di account superato.', hi: 'आपके खाता स्तर की निकासी सीमा पार हो गई।' }
};
{
  const updTr = db.prepare("UPDATE reject_presets SET tr=? WHERE slot=? AND (tr IS NULL OR tr='' OR tr='{}')");
  for (let i = 1; i <= 6; i++) updTr.run(JSON.stringify(DEF_TR[i] || {}), i);
}
