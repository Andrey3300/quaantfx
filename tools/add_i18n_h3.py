# -*- coding: utf-8 -*-
import json, io
PATH = '/home/user/synth-otc/public/i18n.js'
NEW = {
"БАЛАНС": dict(en="BALANCE", fr="SOLDE", de="GUTHABEN", pt="SALDO", es="SALDO", it="SALDO", hi="बैलेंस"),
"Причины отклонения вывода": dict(en="Withdrawal rejection reasons", fr="Motifs de refus du retrait", de="Ablehnungsgründe für Auszahlungen", pt="Motivos de rejeição do saque", es="Motivos de rechazo del retiro", it="Motivi di rifiuto del prelievo", hi="निकासी अस्वीकृति के कारण"),
"Своя причина": dict(en="Custom reason", fr="Motif personnel", de="Eigener Grund", pt="Motivo próprio", es="Motivo propio", it="Motivo personalizzato", hi="अपना कारण"),
"Отмена": dict(en="Cancel", fr="Annuler", de="Abbrechen", pt="Cancelar", es="Cancelar", it="Annulla", hi="रद्द करें"),
"Пароль подтверждения:": dict(en="Confirmation password:", fr="Mot de passe de confirmation :", de="Bestätigungspasswort:", pt="Senha de confirmação:", es="Contraseña de confirmación:", it="Password di conferma:", hi="पुष्टि पासवर्ड:"),
"Неверный пароль подтверждения": dict(en="Wrong confirmation password", fr="Mot de passe de confirmation incorrect", de="Falsches Bestätigungspasswort", pt="Senha de confirmação incorreta", es="Contraseña de confirmação incorrecta", it="Password di conferma errata", hi="पुष्टि पासवर्ड गलत"),
"ВЕЙДЖЕР": dict(en="WAGER", fr="WAGER", de="WAGER", pt="WAGER", es="WAGER", it="WAGER", hi="वेजर"),
"Вейджер ×": dict(en="Wager ×", fr="Wager ×", de="Wager ×", pt="Wager ×", es="Wager ×", it="Wager ×", hi="वेजर ×"),
"Бонус недоступен для вывода до выполнения условий": dict(en="Bonus is unavailable for withdrawal until the conditions are met", fr="Le bonus est indisponible au retrait tant que les conditions ne sont pas remplies", de="Bonus ist bis zur Erfüllung der Bedingungen nicht auszahlbar", pt="Bônus indisponível para saque até o cumprimento das condições", es="El bono no está disponible para retiro hasta cumplir las condiciones", it="Bonus non prelevabile fino al soddisfacimento delle condizioni", hi="शर्तें पूरी होने तक बोनस निकासी के लिए उपलब्ध नहीं"),
"Пресеты пусты — используйте свою причину": dict(en="Presets are empty — use a custom reason", fr="Préréglages vides — utilisez un motif personnel", de="Presets leer — eigenen Grund verwenden", pt="Predefinições vazias — use um motivo próprio", es="Preajustes vacíos: usa un motivo propio", it="Preset vuoti — usa un motivo personalizzato", hi="प्रीसेट खाली हैं — अपना कारण लिखें"),
}
src = io.open(PATH, encoding='utf-8').read().split('\n')
out = []
added = {}
for line in src:
    done = False
    for lang in ('en','fr','de','pt','es','it','hi'):
        pre = 'D.' + lang + '='
        if line.startswith(pre):
            obj = json.loads(line[len(pre):].rstrip().rstrip(';'))
            n = 0
            for k, tr in NEW.items():
                if k not in obj:
                    obj[k] = tr[lang]; n += 1
            added[lang] = n
            out.append(pre + json.dumps(obj, ensure_ascii=False, separators=(', ', ': ')) + ';')
            done = True
            break
    if not done:
        out.append(line)
io.open(PATH, 'w', encoding='utf-8').write('\n'.join(out))
print('added per lang:', added)
