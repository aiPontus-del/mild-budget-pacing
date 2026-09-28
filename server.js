const express = require('express');
const path = require('path');

const store = require('./store');
const { monthInfo } = require('./pacing');
const alerts = require('./alerts');

const PORT = process.env.PORT || 3000;
const CACHE_MS = Number(process.env.CACHE_MINUTES || 5) * 60 * 1000;
const REFRESH_MS = Number(process.env.REFRESH_MINUTES || 30) * 60 * 1000; // bakgrundskontroll för larm
const CONCURRENCY = Number(process.env.GOOGLE_ADS_CONCURRENCY || 6);

// Mockläge tills alla Google Ads-uppgifter finns (eller om MOCK=1 sätts).
const REQUIRED = [
  'GOOGLE_ADS_DEVELOPER_TOKEN',
  'GOOGLE_ADS_CLIENT_ID',
  'GOOGLE_ADS_CLIENT_SECRET',
  'GOOGLE_ADS_REFRESH_TOKEN',
  'GOOGLE_ADS_LOGIN_CUSTOMER_ID',
];
const MOCK = process.env.MOCK === '1' || REQUIRED.some((k) => !process.env[k]);

// clients.json är valfri: namn och standardbudget per konto-ID.
// I liveläge hämtas kontolistan från MCC:n; konton i clients.json läggs till om de saknas där.
const overrides = require('./clients.json');
const googleAds = MOCK ? null : require('./googleAds');

// ---------- Budgetar och dolda konton ----------
function budgetFor(accountId) {
  const m = store.get().budgets[monthInfo().key] || {};
  const c = overrides.find((x) => x.id === accountId);
  const def = c && c.defaultMonthlyBudget != null ? c.defaultMonthlyBudget : null;
  if (m[accountId] != null) return { monthlyBudget: m[accountId], budgetSource: 'manual', defaultMonthlyBudget: def };
  if (def != null) return { monthlyBudget: def, budgetSource: 'default', defaultMonthlyBudget: def };
  return { monthlyBudget: null, budgetSource: null, defaultMonthlyBudget: null };
}
const isHidden = (id) => store.get().hidden.includes(id);
const withState = (a) => ({ ...a, ...budgetFor(a.id), hidden: isHidden(a.id) });

// ---------- Mockdata ----------
const MOCK_EXTRA = [
  ['1112223334', 'Testkund Bygg & Fasad AB', 250, 1.35],
  ['2223334445', 'Testkund Tandvård Syd', 90, 1.02],
  ['3334445556', 'Testkund Elektronik Online', 600, 0.78],
  ['4445556667', 'Testkund Advokatbyrå', 140, 1.09],
  ['5556667778', 'Testkund Gym & Hälsa', 70, 0, 'stopped'],
  ['6667778889', 'Testkund Vilande konto', 0, 0],
  ['7778889990', 'Testkund Bilverkstad', 110, 0.97, 'error'],
];
function mockAccounts() {
  const base = overrides.map((c, i) => [c.id, c.name, [110, 300, 135][i % 3], [1.0, 1.12, 0.58][i % 3]]);
  // MOCK_ACCOUNTS=200 fyller på med påhittade konton för att prova vyerna med många kunder.
  const words = ['Bygg', 'Tandvård', 'Juridik', 'Bil', 'Hotell', 'El', 'VVS', 'Mäklare', 'Redovisning', 'Café', 'Frisör', 'Golf', 'Möbler', 'Städ', 'Trädgård', 'Optik'];
  const towns = ['Malmö', 'Lund', 'Växjö', 'Borås', 'Umeå', 'Gävle', 'Kalmar', 'Örebro', 'Luleå', 'Visby', 'Falun', 'Ystad'];
  const extra = Array.from({ length: Number(process.env.MOCK_ACCOUNTS || 0) }, (_, i) => [
    String(8000000000 + i * 7919),
    `Testkund ${words[i % words.length]} ${towns[(i * 7) % towns.length]}${i >= words.length * towns.length ? ' ' + i : ''}`,
    [60, 90, 120, 180, 250, 400][(i * 5) % 6],
    [0.55, 0.8, 0.93, 0.97, 1.0, 1.02, 1.04, 1.1, 1.25][(i * 7) % 9],
  ]);
  return [...base, ...MOCK_EXTRA, ...extra].map(([id, name, daily, pace, flag]) => ({ id, name, daily, pace, flag }));
}
function mockData(acc) {
  if (acc.flag === 'error') throw new Error('USER_PERMISSION_DENIED (testdata)');
  const m = monthInfo();
  const dailyCost = {};
  let mtdCost = 0;
  const pad = (x) => String(x).padStart(2, '0');
  for (let d = 1; d <= m.day; d++) {
    const share = d === m.day ? (m.hour + m.minute / 60) / 24 : 1;
    let cost = acc.daily * acc.pace * share * (0.85 + ((d * 7 + acc.id.charCodeAt(0)) % 30) / 100);
    if (acc.flag === 'stopped') cost = d < m.day - 1 ? acc.daily * 0.95 : 0;
    cost = Math.round(cost * 100) / 100;
    if (cost > 0) dailyCost[`${m.key}-${pad(d)}`] = cost;
    mtdCost += cost;
  }
  mtdCost = Math.round(mtdCost * 100) / 100;
  const campaigns = acc.daily > 0 ? [
    { id: `${acc.id}-1`, name: 'Sök | Varumärke', status: 'ENABLED', dailyBudget: Math.round(acc.daily * 0.35), budgetShared: false, cost: Math.round(mtdCost * 0.3) },
    { id: `${acc.id}-2`, name: 'Sök | Tjänster', status: 'ENABLED', dailyBudget: Math.round(acc.daily * 0.65), budgetShared: false, cost: Math.round(mtdCost * 0.7) },
  ] : [];
  return { currency: 'SEK', dailyBudget: acc.daily, mtdCost, dailyCost, campaigns };
}

// ---------- Hämtning ----------
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

async function listAccounts() {
  if (MOCK) return mockAccounts();
  const fromMcc = await googleAds.listClientAccounts();
  const byId = new Map(fromMcc.map((a) => [a.id, a]));
  for (const o of overrides) {
    if (byId.has(o.id)) byId.get(o.id).name = o.name || byId.get(o.id).name;
    else byId.set(o.id, { id: o.id, name: o.name });
  }
  return [...byId.values()];
}

async function buildPayload() {
  const list = await listAccounts();
  const accounts = await mapLimit(list, CONCURRENCY, async (acc) => {
    const base = { id: acc.id, name: acc.name };
    try {
      const data = MOCK ? mockData(acc) : await googleAds.fetchAccount(acc.id);
      return { ...base, ...data };
    } catch (err) {
      console.error(`[${acc.name}]`, err.message);
      return { ...base, currency: acc.currency || 'SEK', dailyBudget: 0, mtdCost: 0, dailyCost: {}, campaigns: [], error: `Kunde inte hämta: ${err.message}` };
    }
  });
  accounts.sort((a, b) => a.name.localeCompare(b.name, 'sv'));
  return { mode: MOCK ? 'mock' : 'live', generatedAt: new Date().toISOString(), accounts };
}

let cache = null; // { at, payload }
let inflight = null;

async function checkAlerts(payload) {
  const changed = alerts.evaluate(payload.accounts.map(withState), monthInfo(), store.get());
  if (changed) await store.save().catch((e) => console.error('Kunde inte spara larm:', e.message));
}

async function getPayload(force) {
  if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache.payload;
  if (!inflight) {
    inflight = buildPayload()
      .then(async (payload) => {
        cache = { at: Date.now(), payload };
        await checkAlerts(payload);
        return payload;
      })
      .finally(() => { inflight = null; });
  }
  return inflight;
}

const knownId = (id) => (cache?.payload.accounts || []).some((a) => a.id === id) || overrides.some((c) => c.id === id);

// ---------- App ----------
const app = express();
app.use(express.json());

// Enkel inloggning. Sätt DASHBOARD_PASSWORD, annars är sidan öppen.
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

app.get('/healthz', (req, res) => res.json({ ok: true, mode: MOCK ? 'mock' : 'live', store: store.kind }));

app.get('/api/pacing', async (req, res) => {
  try {
    const payload = await getPayload(req.query.refresh === '1');
    // Budgetar och dolda konton läses alltid färskt, även när kontodata är cachad.
    res.json({ ...payload, accounts: payload.accounts.map(withState) });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: `Kunde inte hämta konton från Google Ads: ${err.message}` });
  }
});

app.put('/api/budgets/:id', async (req, res) => {
  const id = req.params.id;
  if (!knownId(id)) return res.status(404).json({ error: 'Okänt konto' });
  const v = req.body?.monthlyBudget;
  if (v !== null && !(typeof v === 'number' && isFinite(v) && v >= 0)) {
    return res.status(400).json({ error: 'monthlyBudget måste vara ett tal ≥ 0 eller null' });
  }
  const s = store.get();
  const key = monthInfo().key;
  s.budgets[key] = s.budgets[key] || {};
  if (v === null) delete s.budgets[key][id]; // återställ till standard/auto
  else s.budgets[key][id] = v;
  try {
    await store.save();
  } catch (err) {
    console.error('Kunde inte spara budget:', err.message);
    return res.status(500).json({ error: 'Budgeten kunde inte sparas' });
  }
  if (cache) await checkAlerts(cache.payload);
  res.json({ id, month: key, ...budgetFor(id) });
});

// Visa eller dölj ett eller flera konton: { ids: [...], hidden: true|false }
app.put('/api/accounts', async (req, res) => {
  const ids = req.body?.ids;
  const hidden = req.body?.hidden;
  if (!Array.isArray(ids) || !ids.length || typeof hidden !== 'boolean') {
    return res.status(400).json({ error: 'Ange ids (lista med konto-ID) och hidden (true eller false)' });
  }
  const unknown = ids.filter((id) => !knownId(String(id)));
  if (unknown.length) return res.status(404).json({ error: `Okända konton: ${unknown.join(', ')}` });
  const s = store.get();
  const set = new Set(s.hidden);
  ids.forEach((id) => (hidden ? set.add(String(id)) : set.delete(String(id))));
  s.hidden = [...set];
  try {
    await store.save();
  } catch (err) {
    console.error('Kunde inte spara kontoval:', err.message);
    return res.status(500).json({ error: 'Ändringen kunde inte sparas' });
  }
  if (cache) await checkAlerts(cache.payload);
  res.json({ ids, hidden });
});

app.get('/api/alerts', (req, res) => {
  const all = [...store.get().alerts].sort((a, b) => Date.parse(b.openedAt) - Date.parse(a.openedAt));
  res.json({
    minDay: alerts.MIN_DAY,
    refreshMinutes: REFRESH_MS / 60000,
    active: all.filter((x) => !x.resolvedAt),
    history: all.filter((x) => x.resolvedAt).sort((a, b) => Date.parse(b.resolvedAt) - Date.parse(a.resolvedAt)),
  });
});

app.use(express.static(path.join(__dirname, 'public')));

const HOST = process.env.HOST || '0.0.0.0';

store.load()
  .catch((err) => console.error('Kunde inte läsa sparat tillstånd, startar tomt:', err.message))
  .finally(() => {
    const server = app.listen(PORT, HOST, () => {
      console.log(`Budget pacing kör på http://${HOST}:${PORT} (${MOCK ? 'mockläge' : 'Google Ads ' + googleAds.API_VERSION}, lagring: ${store.kind})`);
    });
    // Bakgrundskontroll så att larm uppdateras även när ingen har sidan öppen.
    const tick = () => getPayload(true).catch((e) => console.error('Bakgrundskontroll misslyckades:', e.message));
    setTimeout(tick, 5000);
    const timer = setInterval(tick, REFRESH_MS);

    // Avsluta snyggt vid omstart (systemd, Docker): vänta in pågående skrivningar.
    const shutdown = (signal) => {
      console.log(`${signal} mottagen, stänger ned`);
      clearInterval(timer);
      server.close(() => {
        store.flush().finally(() => process.exit(0));
      });
      setTimeout(() => process.exit(0), 5000).unref();
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  });
