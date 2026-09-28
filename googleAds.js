// Minimal Google Ads API-klient (REST) för budget pacing.
// Kräver Node 18+ (inbyggd fetch). Inga externa beroenden.

const API_VERSION = process.env.GOOGLE_ADS_API_VERSION || 'v25';

const env = (k) => {
  const v = process.env[k];
  if (!v) throw new Error(`Miljövariabeln ${k} saknas`);
  return v;
};

let cachedToken = null; // { token, expiresAt }

async function getAccessToken() {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.token;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env('GOOGLE_ADS_CLIENT_ID'),
      client_secret: env('GOOGLE_ADS_CLIENT_SECRET'),
      refresh_token: env('GOOGLE_ADS_REFRESH_TOKEN'),
      grant_type: 'refresh_token',
    }),
  });
  const text = await res.text();
  let body = {};
  try { body = JSON.parse(text); } catch { /* inte JSON */ }
  if (!res.ok || !body.access_token) {
    throw new Error(`OAuth-fel: ${body.error_description || body.error || `HTTP ${res.status}`}`);
  }
  cachedToken = { token: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
  return cachedToken.token;
}

async function search(customerId, query) {
  const token = await getAccessToken();
  const url = `https://googleads.googleapis.com/${API_VERSION}/customers/${customerId}/googleAds:searchStream`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'developer-token': env('GOOGLE_ADS_DEVELOPER_TOKEN'),
      'login-customer-id': env('GOOGLE_ADS_LOGIN_CUSTOMER_ID').replace(/-/g, ''),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const detail = Array.isArray(body) ? body[0]?.error : body?.error;
    const gaErr = detail?.details?.[0]?.errors?.[0]?.message;
    throw new Error(gaErr || detail?.message || `Google Ads API svarade ${res.status}`);
  }
  // searchStream returnerar en array av batcher: [{ results: [...] }, ...]
  return (body || []).flatMap((batch) => batch.results || []);
}

// Aktiva kampanjer med sina budgetar (oavsett om de spenderat i månaden).
const BUDGET_QUERY = `
  SELECT
    customer.currency_code,
    campaign.id,
    campaign.name,
    campaign.status,
    campaign_budget.id,
    campaign_budget.amount_micros,
    campaign_budget.period,
    campaign_budget.explicitly_shared
  FROM campaign
  WHERE campaign.status IN ('ENABLED', 'PAUSED')`;

// Kostnad per kampanj och dag hittills i månaden (Google räknar i kontots tidszon).
const COST_QUERY = `
  SELECT
    campaign.id,
    campaign.name,
    campaign.status,
    segments.date,
    metrics.cost_micros
  FROM campaign
  WHERE segments.date DURING THIS_MONTH
    AND metrics.cost_micros > 0`;

// Alla vanliga annonskonton (inte underkonton som själva är MCC) under inloggnings-MCC:n.
const CLIENTS_QUERY = `
  SELECT
    customer_client.id,
    customer_client.descriptive_name,
    customer_client.currency_code,
    customer_client.status,
    customer_client.manager,
    customer_client.level
  FROM customer_client
  WHERE customer_client.manager = false
    AND customer_client.status = 'ENABLED'`;

const micros = (v) => (v == null ? 0 : Number(v) / 1_000_000);

async function fetchAccount(customerId) {
  const id = String(customerId).replace(/-/g, '');
  const [budgetRows, costRows] = await Promise.all([search(id, BUDGET_QUERY), search(id, COST_QUERY)]);

  const campaigns = new Map();
  let currency = null;
  const countedBudgets = new Set();
  let dailyBudget = 0;

  for (const r of budgetRows) {
    currency = currency || r.customer?.currencyCode;
    const b = r.campaignBudget || {};
    const isDaily = !b.period || b.period === 'DAILY';
    const daily = isDaily ? micros(b.amountMicros) : null;
    campaigns.set(r.campaign.id, {
      id: r.campaign.id,
      name: r.campaign.name,
      status: r.campaign.status,
      dailyBudget: daily,
      budgetShared: !!b.explicitlyShared,
      cost: 0,
    });
    // Delade budgetar räknas en gång; bara aktiva kampanjer räknas in.
    if (r.campaign.status === 'ENABLED' && daily != null && b.id && !countedBudgets.has(b.id)) {
      countedBudgets.add(b.id);
      dailyBudget += daily;
    }
  }

  let mtdCost = 0;
  const byDate = {};
  for (const r of costRows) {
    const cost = micros(r.metrics?.costMicros);
    mtdCost += cost;
    const d = r.segments?.date;
    if (d) byDate[d] = (byDate[d] || 0) + cost;
    const c = campaigns.get(r.campaign.id);
    if (c) c.cost += cost;
    else campaigns.set(r.campaign.id, { id: r.campaign.id, name: r.campaign.name, status: r.campaign.status, dailyBudget: null, budgetShared: false, cost });
  }

  // Visa bara kampanjer som är aktiva eller har spenderat i månaden.
  const list = [...campaigns.values()].filter((c) => c.status === 'ENABLED' || c.cost > 0);

  return { currency: currency || 'SEK', dailyBudget, mtdCost, dailyCost: byDate, campaigns: list };
}

async function listClientAccounts() {
  const mcc = env('GOOGLE_ADS_LOGIN_CUSTOMER_ID').replace(/-/g, '');
  const rows = await search(mcc, CLIENTS_QUERY);
  const seen = new Set();
  return rows
    .map((r) => r.customerClient)
    .filter((c) => c && !seen.has(String(c.id)) && seen.add(String(c.id)))
    .map((c) => ({ id: String(c.id), name: c.descriptiveName || String(c.id), currency: c.currencyCode }));
}

module.exports = { fetchAccount, listClientAccounts, API_VERSION };
