# Driftsättning på egen server

Två sätt att köra tjänsten. Välj det som passar serverns uppsättning.

- **A. Docker** – enklast om servern redan kör Docker.
- **B. Node + systemd** – direkt på en Linux-server.

I båda fallen ligger nginx (eller motsvarande) framför och sköter HTTPS. Tjänsten lyssnar bara lokalt.

## Krav

| | |
|---|---|
| OS | Linux (testat med Node 20+) |
| Node.js | 20 LTS eller senare (bara för alternativ B) |
| Minne | 256 MB räcker |
| Disk | Några MB för `state.json`. Katalogen ska vara beständig och backas upp. |
| Utgående trafik | HTTPS (443) till `googleads.googleapis.com` och `oauth2.googleapis.com` |
| Inkommande trafik | HTTPS via reverse proxy, t.ex. `pacing.<milds-domän>` |
| Instanser | **Exakt en.** Tillståndet ligger i en fil, så tjänsten får inte köras i flera exemplar samtidigt. |

## Konfiguration

All konfiguration sker med miljövariabler. Se `.env.example` för hela listan med förklaringar. Hemligheterna (lösenord och Google-uppgifter) levereras separat av Pontus och ska aldrig checkas in.

## A. Docker

```bash
git clone https://github.com/aiPontus-del/mild-budget-pacing.git /opt/mild-budget-pacing
cd /opt/mild-budget-pacing
cp .env.example .env && chmod 600 .env   # fyll i värdena
docker compose up -d --build
docker compose logs -f                   # ska visa "Budget pacing kör på ..."
```

Data sparas i volymen `pacing-data` (monterad på `/data` i containern).

Uppdatering:

```bash
cd /opt/mild-budget-pacing && git pull && docker compose up -d --build
```

## B. Node + systemd

```bash
# 1. Användare och kod
sudo useradd --system --home /opt/mild-budget-pacing --shell /usr/sbin/nologin mildpacing
sudo git clone https://github.com/aiPontus-del/mild-budget-pacing.git /opt/mild-budget-pacing
cd /opt/mild-budget-pacing && sudo npm ci --omit=dev
sudo chown -R root:root /opt/mild-budget-pacing

# 2. Konfiguration (DATA_DIR=/var/lib/mild-budget-pacing, HOST=127.0.0.1)
sudo cp .env.example /etc/mild-budget-pacing.env
sudo chmod 600 /etc/mild-budget-pacing.env && sudo chown mildpacing /etc/mild-budget-pacing.env
sudo nano /etc/mild-budget-pacing.env

# 3. Tjänst
sudo cp deploy/mild-budget-pacing.service /etc/systemd/system/
# Kontrollera att ExecStart pekar på rätt node (which node)
sudo systemctl daemon-reload
sudo systemctl enable --now mild-budget-pacing
journalctl -u mild-budget-pacing -f
```

systemd skapar `/var/lib/mild-budget-pacing` automatiskt (StateDirectory).

Uppdatering:

```bash
cd /opt/mild-budget-pacing && sudo git pull && sudo npm ci --omit=dev && sudo systemctl restart mild-budget-pacing
```

## HTTPS med nginx

Utgå från `deploy/nginx-mild-budget-pacing.conf`: byt domännamn, skaffa certifikat (t.ex. certbot) och ladda om nginx. Vill ni begränsa åtkomsten till kontorsnätet eller VPN finns `allow`/`deny` förberett i filen.

## Kontroll efter installation

1. `curl http://127.0.0.1:3000/healthz` ger `{"ok":true,"mode":"mock",...}` utan Google-uppgifter, eller `"mode":"live"` med.
2. Sidan kräver inloggning (användare `mild` eller `DASHBOARD_USER`).
3. Uppe till höger står "Live från Google Ads" när Google-uppgifterna är inlagda.
4. Ändra en månadsbudget, starta om tjänsten och kontrollera att ändringen finns kvar.
5. Loggen visar inga `Kunde inte hämta`-fel. Enstaka konton med fel visas även i dashboarden.

## Backup

Hela tillståndet (ändrade budgetar, dolda konton, larmhistorik) ligger i `DATA_DIR/state.json`. Ta med filen i serverns ordinarie backup. Försvinner den börjar tjänsten om från standardbudgetar och tom historik. Inget hämtat från Google Ads går förlorat.

## Felsökning

| Symptom | Trolig orsak |
|---|---|
| `mode: mock` trots att uppgifterna är ifyllda | Någon av de fem `GOOGLE_ADS_*`-variablerna saknas eller är tom |
| `OAuth-fel: invalid_grant` | Refresh token har gått ut. Vanligast när OAuth-appen står i läget "Testing" (7 dagars livslängd). Ny token behövs. |
| `The developer token is only approved for use with test accounts` | Developer token saknar Explorer- eller Basic-nivå |
| `USER_PERMISSION_DENIED` på ett konto | Kontot ligger inte under MCC:n i `GOOGLE_ADS_LOGIN_CUSTOMER_ID` |
| `UNSUPPORTED_VERSION` / 404 mot API:t | `GOOGLE_ADS_API_VERSION` är för gammal. Byt till aktuell version. |
| 502 från nginx | Tjänsten är nere. Se `journalctl -u mild-budget-pacing` eller `docker compose logs`. |
