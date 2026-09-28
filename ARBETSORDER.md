# Arbetsorder: Mild Budget Pacing på Milds server

Pontus Arvidson · 2026-09-28

Sätt upp Mild Budget Pacing på Milds server så att den nås på en egen adress. Hur du löser det tekniskt är ditt val.

## Vad vi har byggt

- En intern dashboard som visar budget pacing för kunderna under Milds Google Ads-MCC: spend hittills i månaden, prognos vid månadsslut, avvikelse mot budget och larm i ett notiscenter.
- Den läser bara från Google Ads API och ändrar aldrig något i kontona.
- En Node.js-app (Express) utan databas och utan byggsteg. Gränssnittet är en HTML-fil som appen levererar.
- Ändrade månadsbudgetar, dolda konton och larmhistorik sparas i en JSON-fil på servern (`state.json`).
- Testversion: https://mild-budget-pacing.onrender.com

## Så ska det fungera

- Nås via HTTPS på en adress hos Mild, t.ex. `pacing.<milds-domän>`.
- Ett gemensamt skydd för hela sidan: användarnamn `mild`, lösenord `mild`. Inga egna konton per anställd.
- Körs i en instans och startar om av sig själv.
- `state.json` ligger kvar mellan omstarter.
- Servern behöver nå `googleads.googleapis.com` och `oauth2.googleapis.com` via HTTPS.

## Det här får du

- Den här zip-filen med koden. Kräver Node.js 20 eller senare: `npm install` och `npm start`. Alla inställningar finns med förklaring i `.env.example`.
- Inloggningsuppgifterna till Google Ads API tar du fram själv: developer token (API Center i MCC:n, kräver administratörsbehörighet), OAuth client ID och secret (Google Cloud-projekt med Google Ads API aktiverat), refresh token och MCC:ns kund-ID. Använd Milds befintliga developer token om det redan finns en. Skapa refresh token med ett konto som bara har läsbehörighet i MCC:n. Stegen står i README, och värdena motsvarar `GOOGLE_ADS_*` i `.env.example`.
- Uppgifterna läggs in som miljövariabler: `GOOGLE_ADS_DEVELOPER_TOKEN`, `GOOGLE_ADS_CLIENT_ID`, `GOOGLE_ADS_CLIENT_SECRET`, `GOOGLE_ADS_REFRESH_TOKEN` och `GOOGLE_ADS_LOGIN_CUSTOMER_ID` (bara siffror). Så länge någon av dem saknas kör appen med testdata, så den kan sättas upp innan de finns. När alla fem är satta och appen startats om svarar `/healthz` `"mode":"live"` och sidan visar "Live från Google Ads".

## Klart när

- [ ] Sidan nås via HTTPS och frågar efter mild/mild
- [ ] Uppe till höger står "Live från Google Ads" och kunderna syns
- [ ] En ändrad månadsbudget finns kvar efter omstart
- [ ] Appen startar av sig själv när servern startas om

Frågor om hur det ska fungera: Pontus.
