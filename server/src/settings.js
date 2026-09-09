'use strict';
/* PLAT1: платформенные настройки (лимиты, вейджер, выплаты) — JSON в meta. */
const db = require('./db');
const eng = require('./engine');

const DEFAULTS = {
  minDeposit: 10, maxDeposit: 1000000,
  minWithdrawal: 10, maxWithdrawal: 1000000,
  minTrade: 1, maxTrade: 100000,
  defaultWager: 20,
  payouts: {},
  marketHours: { enabled:false, friClose:'22:00', sunOpen:'22:00', nightStart:'', nightEnd:'', warnMin:15 }
};

function getSettings() {
  try {
    const r = db.prepare("SELECT value FROM meta WHERE key='platform_settings'").get();
    if (r && r.value) {
      const s = { ...DEFAULTS, ...JSON.parse(r.value) };
      if (!s.payouts || typeof s.payouts !== 'object') s.payouts = {};
      s.marketHours = { ...DEFAULTS.marketHours, ...((s.marketHours && typeof s.marketHours === 'object') ? s.marketHours : {}) };
      return s;
    }
  } catch (e) {}
  return { ...DEFAULTS, payouts: {} };
}

function saveSettings(s) {
  db.prepare(`INSERT INTO meta (key, value) VALUES ('platform_settings', ?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(JSON.stringify(s));
  eng.setPayoutOverrides(s.payouts);
  return s;
}

function applyBoot() {
  try { eng.setPayoutOverrides(getSettings().payouts); } catch (e) {}
}

const LANGS = ['ru','en','fr','de','pt','es','it','hi'];
const DEFAULT_INSTR = {
  ru: '1. Переведите точную сумму на адрес выше.\n2. Дождитесь хотя бы одного подтверждения сети.\n3. Прикрепите скриншот перевода ниже и нажмите «Я оплатил — создать заявку».',
  en: '1. Send the exact amount to the address above.\n2. Wait for at least one network confirmation.\n3. Attach a screenshot of the transfer below and click “I paid — create request”.',
  fr: '1. Envoyez le montant exact à l’adresse ci-dessus.\n2. Attendez au moins une confirmation du réseau.\n3. Joignez une capture d’écran du transfert ci-dessous et cliquez sur « J’ai payé — créer une demande ».',
  de: '1. Senden Sie den genauen Betrag an die oben angegebene Adresse.\n2. Warten Sie auf mindestens eine Netzwerkbestätigung.\n3. Fügen Sie unten einen Screenshot der Überweisung bei und klicken Sie auf „Ich habe bezahlt — Antrag erstellen“.',
  pt: '1. Envie o valor exato para o endereço acima.\n2. Aguarde pelo menos uma confirmação da rede.\n3. Anexe uma captura de tela da transferência abaixo e clique em “Paguei — criar solicitação”.',
  es: '1. Envíe el importe exacto a la dirección de arriba.\n2. Espere al menos una confirmación de la red.\n3. Adjunte una captura de pantalla de la transferencia abajo y pulse «He pagado — crear solicitud».',
  it: '1. Invia l’importo esatto all’indirizzo qui sopra.\n2. Attendi almeno una conferma della rete.\n3. Allega uno screenshot del trasferimento qui sotto e fai clic su «Ho pagato — crea richiesta».',
  hi: '1. ऊपर दिए गए पते पर सटीक राशि भेजें।\n2. नेटवर्क की कम से कम एक पुष्टि की प्रतीक्षा करें।\n3. नीचे ट्रांसफर का स्क्रीनशॉट संलग्न करें और “मैंने भुगतान किया — अनुरोध बनाएं” पर क्लिक करें।'
};
function getDepositInstr(){
  let stored={};
  try{
    const r=db.prepare("SELECT value FROM meta WHERE key='deposit_instructions'").get();
    if(r&&r.value) stored=JSON.parse(r.value)||{};
  }catch(e){}
  const out={};
  for(const l of LANGS) out[l]=(stored[l]||'').trim()?stored[l]:DEFAULT_INSTR[l];
  return out;
}
function saveDepositInstr(obj){
  let prev={};
  try{
    const r=db.prepare("SELECT value FROM meta WHERE key='deposit_instructions'").get();
    if(r&&r.value) prev=JSON.parse(r.value)||{};
  }catch(e){}
  const clean={};
  for(const l of LANGS){
    if(obj&&Object.prototype.hasOwnProperty.call(obj,l)) clean[l]=String(obj[l]||'').slice(0,2000);
    else clean[l]=String(prev[l]||'').slice(0,2000);
  }
  db.prepare(`INSERT INTO meta (key,value) VALUES ('deposit_instructions',?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(JSON.stringify(clean));
  return clean;
}
module.exports = { DEFAULTS, getSettings, saveSettings, applyBoot, LANGS, getDepositInstr, saveDepositInstr };
