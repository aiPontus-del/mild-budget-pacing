# Mild Budget Pacing

Budget pacing för Milds Google Ads-konton, direkt mot Google Ads API. Ingen Supermetrics.

- `public/index.html` – dashboarden (en fil, inga byggsteg)
- `server.js` – Express-server: `/api/pacing`, `/api/budgets/:id`, lösenordsskydd, cache
- `googleAds.js` – hämtar budgetar och kostnad via Google Ads API (REST, GAQL)
- `clients.json` – valfria namn och standardbudgetar per konto-ID (kontolistan hämtas från MCC:n)
- `alerts.js` – larmregler för notiscentret
- `store.js` – lagring av budgetar, dolda konton och larm (fil eller Redis)
- `render.yaml` – färdig uppsättning för Render

## Köra lokalt

```bash
npm install
npm run dev          # mockläge, http://localhost:3000
```

Servern kör i mockläge tills alla fem `GOOGLE_ADS_*`-variabler finns. Dashboarden visar då "Testdata från servern".

## Koppla på Google Ads

Sätt dessa miljövariabler (på Render under Environment, aldrig i koden):

| Variabel | Var den kommer ifrån |
|---|---|
| `GOOGLE_ADS_DEVELOPER_TOKEN` | Google Ads, MCC-kontot → Verktyg → API Center. Minst Explorer-nivå. |
| `GOOGLE_ADS_LOGIN_CUSTOMER_ID` | MCC:ns kund-ID, t.ex. `1234567890` |
| `GOOGLE_ADS_CLIENT_ID` / `GOOGLE_ADS_CLIENT_SECRET` | Google Cloud → APIs & Services → Credentials → OAuth-klient (typ *Web application*) |
| `GOOGLE_ADS_REFRESH_TOKEN` | Se nedan |
| `GOOGLE_ADS_API_VERSION` | `v25` i dag. v22 stängs 7 oktober 2026, så håll koll på Googles sunset-datum. |

Aktivera också **Google Ads API** i samma Cloud-projekt.

### Refresh token

1. Lägg till `https://developers.google.com/oauthplayground` som redirect-URI på OAuth-klienten.
2. Öppna OAuth Playground → kugghjulet → *Use your own OAuth credentials* → klistra in client ID och secret.
3. Scope: `https://www.googleapis.com/auth/adwords`. Logga in med kontot som har åtkomst till MCC:n.
4. *Exchange authorization code for tokens* → kopiera refresh token.

Viktigt: står OAuth-samtyckesskärmen i läget **Testing** slutar refresh token att fungera efter 7 dagar. Sätt den till **In production**. Appen behöver inte verifieras för eget bruk.

## Driftsätta på Render

1. Lägg koden i ett GitHub-repo.
2. Render → New → Blueprint → välj repot. `render.yaml` sätter upp tjänst, disk och variabler.
3. Fyll i hemliga variabler, inklusive `DASHBOARD_PASSWORD`.

### Var månadsbudgetarna sparas

Ändrade månadsbudgetar (per månad), dolda konton och larm sparas tillsammans.

- **Med `REDIS_URL` satt** (rekommenderas): i Redis, t.ex. Upstash gratisnivå. Överlever omstarter och fungerar på Renders gratisplan. Nyckeln är `mild-budget-pacing:state` (ändras med `REDIS_KEY`).
- **Utan `REDIS_URL`**: i `DATA_DIR/state.json`. På Renders gratisplan nollställs filen varje gång tjänsten startar om eller somnar, så då behövs Starter-plan med disk.

`/healthz` visar vilken lagring som används (`store`). Standardbudgetar i `clients.json` gäller alltid som reserv.

## Konton

I liveläge hämtas alla aktiva annonskonton under MCC:n automatiskt (underkonton som själva är MCC tas inte med). Konton döljs eller visas under **Hantera konton** i dashboarden, och valet sparas på servern. Konton utan dagsbudget och utan kostnad i månaden räknas som vilande och visas bara när **Visa vilande** är vald.

`clients.json` behövs inte längre för att få med konton, men kan ge ett konto ett annat namn eller en standardbudget:

```json
{ "id": "1234567890", "name": "Kundnamn", "defaultMonthlyBudget": 10000 }
```

## Notiscenter

Servern kontrollerar alla synliga konton varje gång data hämtas och i bakgrunden var 30:e minut (`REFRESH_MINUTES`). Larmen:

| Larm | När | Nivå |
|---|---|---|
| Månadsbudgeten är slut | Spend hittills ≥ budget och månaden är inte slut | Kritisk |
| Över budget | Prognos mer än 15 % över budget, från dag 4 (`ALERT_MIN_DAY`) | Kritisk |
| Ingen kostnad i går | Aktiv dagsbudget men 0 kr i går | Kritisk |
| Under budget | Prognos mer än 15 % under budget, från dag 4 | Varning |
| Data kunde inte hämtas | Google Ads-anropet för kontot misslyckades | Varning |

Ett larm är aktivt så länge villkoret gäller och flyttas till historiken när det slutar gälla eller kontot döljs. Historiken sparas i 90 dagar (`ALERT_HISTORY_DAYS`).

## Så räknas det

- **Aktiv dagsbudget**: summan av dagsbudgetar för aktiva kampanjer. Delade budgetar räknas en gång. Kampanjer med totalbudget (custom period) räknas inte.
- **Spend hittills**: `metrics.cost_micros` för `THIS_MONTH`, i kontots tidszon.
- **Prognos**: spend ÷ förfluten tid (i timmar, svensk tid) × dagar i månaden.
- **Status**: ±5 % grönt, 5–15 % gult, >15 % rött (över) eller blått (under).
- **Dagsspend för att landa rätt**: (budget − spend) ÷ återstående tid.

Kontodata cachas 5 minuter (`CACHE_MINUTES`) för att spara API-kvot. Knappen Uppdatera hoppar över cachen.
