const express = require('express');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const BUDGETS_FILE = path.join(DATA_DIR, 'budgets.json');
const CACHE_MS = Number(process.env.CACHE_MINUTES || 5) * 60 * 1000;

// Mockläge tills alla Google Ads-uppgifter finns (eller om MOCK=1 sätts).
const REQUIRED = [
  'GOOGLE_ADS_DEVELOPER_TOKEN',
  'GOOGLE_ADS_CLIENT_ID',
  'GOOGLE_ADS_CLIENT_SECRET',
  'GOOGLE_ADS_REFRESH_TOKEN',
  'GOOGLE_ADS_LOGIN_CUSTOMER_ID',
];
const MOCK = process.env.MOCK === '1' || REQUIRED.some((k) => !process.env[k]);

const clients = require('./clients.json');
const googleAds = MOCK ? null : require('./googleAds');

// ---------- Manuella månadsbudgetar ----------
fs.mkdirSync(DATA_DIR, { recursive: true });
function readBudgets() {
  try { return JSON.parse(fs.readFileSync(BUDGETS_FILE, 'utf8')); } catch { return {}; }
}
function writeBudgets(b) {
  const tmp = BUDGETS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(b, null, 2));
  fs.renameSync(tmp, BUDGETS_FILE);
}
// Budgetar lagras per månad ("2026-09"), så en ny månad börjar på auto
// om ingen budget lagts in, medan clients.json kan ange en standardbudget.
function monthKey() {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Stockholm', year: 'numeric', month: '2-digit' }).format(new Date());
  return p.slice(0, 7);
}
// Ordning: ändrad budget för aktuell månad → standardbudget i clients.json → null (auto).
function budgetFor(accountId) {
  const m = readBudgets()[monthKey()] || {};
  const c = clients.find((x) => x.id === accountId);
  const def = c && c.defaultMonthlyBudget != null ? c.defaultMonthlyBudget : null;
  if (m[accountId] != null) return { monthlyBudget: m[accountId], budgetSource: 'manual', defaultMonthlyBudget: def };
  if (def != null) return { monthlyBudget: def, budgetSource: 'default', defaultMonthlyBudget: def };
  return { monthlyBudget: null, budgetSource: null, defaultMonthlyBudget: null };
}

// ---------- Mockdata ----------
function mockAccount(c, i) {
  const now = new Date();
  const day = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Stockholm', day: 'numeric' }).format(now));
  const daily = [110, 300, 135, 220, 80][i % 5];
  const pace = [1.0, 1.12, 0.58, 0.93, 1.3][i % 5];
  const cost = Math.round(daily * pace * Math.max(0.5, day - 0.5) * 100) / 100;
  return {
    currency: 'SEK',
    dailyBudget: daily,
    mtdCost: cost,
    campaigns: [
      { id: `${c.id}-1`, name: 'Sök | Varumärke', status: 'ENABLED', dailyBudget: Math.round(daily * 0.35), budgetShared: false, cost: Math.round(cost * 0.3) },
      { id: `${c.id}-2`, name: 'Sök | Tjänster', status: 'ENABLED', dailyBudget: Math.round(daily * 0.65), budgetShared: false, cost: Math.round(cost * 0.7) },
    ],
  };
}

// ---------- Hämtning med cache ----------
let cache = null; // { at, payload }

async function buildPayload() {
  const accounts = await Promise.all(clients.map(async (c, i) => {
    const base = { id: c.id, name: c.name, ...budgetFor(c.id) };
    try {
      const data = MOCK ? mockAccount(c, i) : await googleAds.fetchAccount(c.id);
      return { ...base, ...data };
    } catch (err) {
      console.error(`[${c.name}]`, err.message);
      return { ...base, currency: 'SEK', dailyBudget: 0, mtdCost: 0, campaigns: [], error: `Kunde inte hämta: ${err.message}` };
    }
  }));
  return { mode: MOCK ? 'mock' : 'live', generatedAt: new Date().toISOString(), accounts };
}

async function getPayload(force) {
  if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache.payload;
  const payload = await buildPayload();
  cache = { at: Date.now(), payload };
  return payload;
}

// ---------- App ----------
const app = express();
app.use(express.json());

// Enkel inloggning. Sätt DASHBOARD_PASSWORD på Render, annars är sidan öppen.
if (process.env.DASHBOARD_PASSWORD) {
  const user = process.env.DASHBOARD_USER || 'mild';
  app.use((req, res, next) => {
    if (req.path === '/healthz') return next();
    const [scheme, encoded] = (req.headers.authorization || '').split(' ');
    if (scheme === 'Basic' && encoded) {
      const [u, ...rest] = Buffer.from(encoded, 'base64').toString().split(':');
      if (u === user && rest.join(':') === process.env.DASHBOARD_PASSWORD) return next();
    }
    res.set('WWW-Authenticate', 'Basic realm="Mild Budget Pacing", charset="UTF-8"');
    res.status(401).send('Inloggning krävs');
  });
}

app.get('/healthz', (req, res) => res.json({ ok: true, mode: MOCK ? 'mock' : 'live' }));

app.get('/api/pacing', async (req, res) => {
  try {
    const payload = await getPayload(req.query.refresh === '1');
    // Budgetar läses alltid färskt så ändringar syns direkt även om kontodata är cachad.
    res.json({ ...payload, accounts: payload.accounts.map((a) => ({ ...a, ...budgetFor(a.id) })) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/budgets/:id', (req, res) => {
  const id = req.params.id;
  if (!clients.some((c) => c.id === id)) return res.status(404).json({ error: 'Okänt konto' });
  const v = req.body?.monthlyBudget;
  if (v !== null && !(typeof v === 'number' && isFinite(v) && v >= 0)) {
    return res.status(400).json({ error: 'monthlyBudget måste vara ett tal ≥ 0 eller null' });
  }
  const b = readBudgets();
  const key = monthKey();
  b[key] = b[key] || {};
  if (v === null) delete b[key][id]; // återställ till standard/auto
  else b[key][id] = v;
  writeBudgets(b);
  res.json({ id, month: key, ...budgetFor(id) });
});

app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`Budget pacing kör på http://localhost:${PORT} (${MOCK ? 'mockläge' : 'Google Ads ' + googleAds.API_VERSION})`);
});
