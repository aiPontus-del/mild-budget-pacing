# Arbetsorder: Mild Budget Pacing på Milds server

Beställare: Pontus Arvidson, Mild Media · 2026-09-28

## Uppdraget

Sätt upp Mild Budget Pacing på en av Milds servrar. Den ska nås via HTTPS på en egen subdomän, vara lösenordsskyddad och vara kopplad till Milds Google Ads-MCC.

Mild Budget Pacing är en intern dashboard som visar hur kundernas Google Ads-konton förbrukar sin månadsbudget: spend hittills, prognos vid månadsslut, avvikelse och larm. Den läser bara från Google Ads och gör aldrig ändringar i kontona. Manuellt satta månadsbudgetar sparas i en fil på servern.

Tjänsten är en liten Node.js-app (Express, två beroenden) utan databas och utan byggsteg. Den körs i dag som test på Render: https://mild-budget-pacing.onrender.com.

Jobbet är klart när alla punkter under Acceptanskriterier är avbockade.

## Så hänger det ihop

```
Webbläsare --HTTPS--> nginx (TLS) --127.0.0.1:3000--> Mild Budget Pacing --HTTPS--> Google Ads API
                                                              |
                                                     state.json i DATA_DIR (backup)
```

Tjänsten lyssnar bara lokalt bakom nginx. Den hämtar kontodata från Google Ads och sparar egna inställningar i en fil på servern.

## Underlag

| Vad | Var | Kommentar |
| --- | --- | --- |
| Källkod | Den här zip-filen, eller repot aiPontus-del/mild-budget-pacing | Be Pontus om läsbehörighet till repot om ni vill hämta uppdateringar med git |
| Installationsguide | `DRIFT.md` | Steg för steg för Docker och systemd, felsökningstabell |
| Alla miljövariabler | `.env.example` | Med förklaring per rad |
| Färdiga konfigfiler | `Dockerfile`, `docker-compose.yml`, `deploy/` | Byt domännamn och sökvägar vid behov |
| Google Ads-uppgifter | Från Pontus via säker kanal, inte e-post eller chatt | Developer token, OAuth client ID och secret, refresh token, MCC-ID |
| Lösenord till dashboarden | Bestäms av Pontus | Sätts som `DASHBOARD_PASSWORD` |

Tjänsten kan installeras och testas innan Google-uppgifterna finns. Då körs den med testdata och visar "Testdata från servern".

## Krav på servern

| Krav | Nivå |
| --- | --- |
| Operativsystem | Linux |
| Körmiljö | Docker med Compose, eller Node.js 20 LTS eller senare |
| Minne | 256 MB |
| Disk | Några MB, beständig och med i backupen (`state.json`) |
| Utgående trafik | HTTPS (443) till `googleads.googleapis.com` och `oauth2.googleapis.com` |
| Inkommande trafik | HTTPS via nginx eller motsvarande reverse proxy |
| Antal instanser | Exakt en. Tillståndet ligger i en fil och tjänsten får inte köras i flera exemplar. |
| Certifikat | Giltigt TLS-certifikat för subdomänen, t.ex. Let's Encrypt |

## Arbetsmoment

Detaljerade kommandon finns i `DRIFT.md`. Ordningen gör att allt kan testas innan riktiga Google-uppgifter läggs in.

1. Bestäm subdomän och körsätt (Docker eller systemd) tillsammans med Pontus. Se Beslut att ta innan start.
2. Skapa DNS-post för subdomänen mot servern.
3. Lägg koden på servern: `git clone` till `/opt/mild-budget-pacing` eller packa upp zip-filen där.
4. Skapa konfigurationen från `.env.example`. Behörighet 600. Sätt `DASHBOARD_PASSWORD` men lämna Google-fälten tomma.
5. Starta tjänsten:
    - Docker: `docker compose up -d --build`
    - systemd: installera `deploy/mild-budget-pacing.service`, `systemctl enable --now mild-budget-pacing`
6. Kontrollera lokalt: `curl http://127.0.0.1:3000/healthz` ska svara `"mode":"mock"`.
7. Konfigurera nginx från `deploy/nginx-mild-budget-pacing.conf` och skaffa certifikat. Kontrollera att sidan öppnas via HTTPS och kräver inloggning.
8. Lägg in Google-uppgifterna från Pontus och starta om tjänsten. `/healthz` ska nu svara `"mode":"live"`.
9. Gå igenom Acceptanskriterier tillsammans med Pontus.
10. Lägg till `DATA_DIR` (eller Docker-volymen `pacing-data`) i serverns backup.

## Konfiguration

All konfiguration sker med miljövariabler. Hela listan med förklaringar finns i `.env.example`.

| Variabel | Värde på Milds server | Källa |
| --- | --- | --- |
| `PORT` | `3000` | Standard |
| `HOST` | `127.0.0.1` med systemd, `0.0.0.0` i Docker | Utvecklaren |
| `DATA_DIR` | `/var/lib/mild-budget-pacing` med systemd, `/data` i Docker | Utvecklaren |
| `DASHBOARD_USER` | `mild` | Standard, kan ändras |
| `DASHBOARD_PASSWORD` | Hemligt | Pontus |
| `GOOGLE_ADS_DEVELOPER_TOKEN` | Hemligt | Pontus |
| `GOOGLE_ADS_CLIENT_ID` | Hemligt | Pontus |
| `GOOGLE_ADS_CLIENT_SECRET` | Hemligt | Pontus |
| `GOOGLE_ADS_REFRESH_TOKEN` | Hemligt | Pontus |
| `GOOGLE_ADS_LOGIN_CUSTOMER_ID` | MCC:ns kund-ID, bara siffror | Pontus |
| `GOOGLE_ADS_API_VERSION` | `v25` | Standard, se Drift och underhåll |

`MOCK_ACCOUNTS` och `REDIS_URL` används bara i testmiljön på Render och ska inte sättas på Milds server.

## Säkerhet

- Tjänsten lyssnar bara lokalt. Endast nginx når den, och all trafik utifrån går via HTTPS.
- Dashboarden skyddas med HTTP Basic Auth (`DASHBOARD_USER` och `DASHBOARD_PASSWORD`). Undantaget är `/healthz`, som bara svarar status och läge.
- Om möjligt: begränsa åtkomsten till kontorets IP eller VPN med `allow`/`deny` i nginx. Förberett i exempelfilen.
- Konfigurationsfilen med hemligheter ska ha behörighet 600 och aldrig checkas in i Git eller skickas i klartext.
- Tjänsten körs som egen användare utan inloggningsskal (systemd) eller som `node` i containern (Docker). systemd-filen har härdning påslagen.
- Google Ads-behörigheten går inte att begränsa till läsning via API:t. Koden gör bara läsfrågor, och refresh token skapas med ett Google-konto som bara har läsbehörighet i MCC:n.

## Acceptanskriterier

- [ ] Dashboarden nås via HTTPS på den valda subdomänen med giltigt certifikat
- [ ] Sidan kräver inloggning, och fel lösenord ger 401
- [ ] `/healthz` svarar `"mode":"live"`
- [ ] Uppe till höger står "Live från Google Ads", och kontona under MCC:n visas med spend för innevarande månad
- [ ] Loggen visar inga fel av typen `Kunde inte hämta` (eller så har Pontus godkänt enstaka konton med fel)
- [ ] En ändrad månadsbudget och ett dolt konto finns kvar efter omstart av tjänsten
- [ ] Tjänsten startar av sig själv efter omstart av servern
- [ ] Datakatalogen ingår i serverns backup
- [ ] Tjänsten nås inte direkt på port 3000 utifrån
- [ ] Pontus har fått adressen, inloggningen och en kort beskrivning av hur tjänsten uppdateras

## Drift och underhåll

- **Uppdatering:** `git pull` och sedan `docker compose up -d --build`, eller `npm ci --omit=dev` och `systemctl restart mild-budget-pacing`. Pontus meddelar när en ny version finns.
- **Backup:** allt tillstånd ligger i `state.json` i datakatalogen. Utan filen börjar tjänsten om från standardbudgetar, men ingen data från Google Ads går förlorad.
- **Google Ads API-version:** Google stänger äldre versioner ungefär en gång per kvartal. v22 stängs 7 oktober 2026. När loggen visar `UNSUPPORTED_VERSION` byts `GOOGLE_ADS_API_VERSION` till aktuell version och tjänsten startas om. Se https://developers.google.com/google-ads/api/docs/sunset-dates.
- **Refresh token:** går ut om Google-kontot byter lösenord eller om OAuth-appen står i läget "Testing". Då visar loggen `invalid_grant` och Pontus tar fram en ny token.
- **Loggar:** `journalctl -u mild-budget-pacing` eller `docker compose logs`. Felsökningstabell finns i `DRIFT.md`.

## Beslut att ta innan start

- [ ] Vilken server tjänsten ska ligga på
- [ ] Subdomän, t.ex. `pacing.<milds-domän>`
- [ ] Docker eller Node + systemd, efter vad servern redan kör
- [ ] Om åtkomsten ska begränsas till kontorsnätet eller VPN, utöver lösenordet
- [ ] Hur hemligheterna förs över från Pontus, t.ex. lösenordshanterare
- [ ] Om utvecklaren ska ha läsbehörighet till GitHub-repot för kommande uppdateringar
