# -*- coding: utf-8 -*-
import json, io
PATH = '/home/user/synth-otc/public/i18n.js'
NEW = {
"Нет заявок в обработке": dict(en="No pending requests", fr="Aucune demande en cours", de="Keine Anträge in Bearbeitung", pt="Nenhuma solicitação pendente", es="Sin solicitudes en proceso", it="Nessuna richiesta in elaborazione", hi="कोई लंबित अनुरोध नहीं"),
"Нет запросов в обработке": dict(en="No pending requests", fr="Aucune requête en cours", de="Keine Anfragen in Bearbeitung", pt="Nenhuma solicitação pendente", es="Sin solicitudes en proceso", it="Nessuna richiesta in elaborazione", hi="कोई लंबित अनुरोध नहीं"),
"Это не админский аккаунт": dict(en="This is not an admin account", fr="Ce n'est pas un compte administrateur", de="Das ist kein Admin-Konto", pt="Esta não é uma conta de administrador", es="Esta no es una cuenta de administrador", it="Questo non è un account admin", hi="यह एडमिन खाता नहीं है"),
"Неверная почта или пароль": dict(en="Wrong email or password", fr="E-mail ou mot de passe incorrect", de="Falsche E-Mail oder Passwort", pt="Email ou senha incorretos", es="Correo o contraseña incorrectos", it="Email o password errati", hi="ईमेल या पासवर्ड गलत"),
"Избранное": dict(en="Favorites", fr="Favoris", de="Favoriten", pt="Favoritos", es="Favoritos", it="Preferiti", hi="पसंदीदा"),
"Крипто": dict(en="Crypto", fr="Crypto", de="Krypto", pt="Cripto", es="Cripto", it="Crypto", hi="क्रिप्टो"),
"Сырьё": dict(en="Commodities", fr="Matières premières", de="Rohstoffe", pt="Commodities", es="Materias primas", it="Materie prime", hi="कमोडिटी"),
"Индексы": dict(en="Indices", fr="Indices", de="Indizes", pt="Índices", es="Índices", it="Indici", hi="इंडेक्स"),
"Валюты": dict(en="Currencies", fr="Devises", de="Währungen", pt="Moedas", es="Divisas", it="Valute", hi="मुद्राएँ"),
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
