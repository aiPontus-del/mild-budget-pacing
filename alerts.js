// Larmregler för notiscentret. Körs varje gång kontodata hämtas.
// Ett larm är "aktivt" så länge villkoret gäller och blir "löst" när det slutar gälla.

const crypto = require('crypto');
const { derive } = require('./pacing');

const MIN_DAY = Number(process.env.ALERT_MIN_DAY || 4); // inga pacinglarm före denna dag i månaden
const HISTORY_DAYS = Number(process.env.ALERT_HISTORY_DAYS || 90);
const MAX_ALERTS = 1000;

const kr = (n, cur = 'SEK') => {
  try { return new Intl.NumberFormat('sv-SE', { style: 'currency', currency: cur, maximumFractionDigits: 0 }).format(n); }
  catch { return `${Math.round(n)} ${cur}`; }
};
const pct = (n) => `${n > 0 ? '+' : '−'}${Math.abs(n).toLocaleString('sv-SE', { maximumFractionDigits: 1 })} %`;

// Returnerar de villkor som gäller för ett konto just nu.
function conditions(a, m) {
  const out = [];
  if (a.error) {
    out.push({ type: 'error', severity: 'warning', title: 'Data kunde inte hämtas', detail: a.error });
    return out;
  }
  const dormant = !(a.dailyBudget > 0) && !(a.mtdCost > 0);
  if (dormant) return out;

  const p = derive(a, m);
  const cur = a.currency || 'SEK';

  if (p.budget > 0 && a.mtdCost >= p.budget && m.day < m.daysInMonth) {
    out.push({
      type: 'exhausted', severity: 'critical', title: 'Månadsbudgeten är slut',
      detail: `${kr(a.mtdCost, cur)} spenderat av ${kr(p.budget, cur)} med ${m.daysInMonth - m.day} dagar kvar.`,
    });
  } else if (m.day >= MIN_DAY && p.dev != null && p.dev > 15) {
    out.push({
      type: 'over', severity: 'critical', title: 'Över budget',
      detail: `Prognos ${kr(p.forecast, cur)} mot budget ${kr(p.budget, cur)} (${pct(p.dev)}).`,
    });
  }
  if (m.day >= MIN_DAY && p.dev != null && p.dev < -15) {
    out.push({
      type: 'under', severity: 'warning', title: 'Under budget',
      detail: `Prognos ${kr(p.forecast, cur)} mot budget ${kr(p.budget, cur)} (${pct(p.dev)}).`,
    });
  }
  // Ingen kostnad i går trots aktiva kampanjer: annonserna kan ha stannat.
  if (m.day >= 2 && a.dailyBudget > 0 && a.dailyCost && !(a.dailyCost[m.yesterday] > 0)) {
    out.push({
      type: 'stopped', severity: 'critical', title: 'Ingen kostnad i går',
      detail: `Aktiv dagsbudget ${kr(a.dailyBudget, cur)} men 0 kr i kostnad ${m.yesterday}. Kontrollera betalning, godkännanden och kampanjstatus.`,
    });
  }
  return out;
}

// Uppdaterar state.alerts utifrån aktuella konton. Returnerar true om något ändrades.
function evaluate(accounts, m, state) {
  const now = new Date().toISOString();
  const hidden = new Set(state.hidden);
  const active = new Map(state.alerts.filter((x) => !x.resolvedAt).map((x) => [x.key, x]));
  const seen = new Set();
  let changed = false;

  for (const a of accounts) {
    if (hidden.has(a.id)) continue;
    for (const c of conditions(a, m)) {
      const key = `${a.id}:${c.type}`;
      seen.add(key);
      const existing = active.get(key);
      if (existing) {
        if (existing.detail !== c.detail || existing.accountName !== a.name) {
          Object.assign(existing, { detail: c.detail, accountName: a.name, updatedAt: now });
          changed = true;
        }
      } else {
        state.alerts.push({
          id: crypto.randomUUID(), key, accountId: a.id, accountName: a.name,
          ...c, openedAt: now, updatedAt: now, resolvedAt: null,
        });
        changed = true;
      }
    }
  }

  // Allt som inte längre gäller (eller hör till dolda konton) blir löst.
  for (const [key, x] of active) {
    if (!seen.has(key)) {
      x.resolvedAt = now;
      x.resolvedReason = hidden.has(x.accountId) ? 'Kontot dolt' : 'Villkoret gäller inte längre';
      changed = true;
    }
  }

  // Rensa gammal historik.
  const cutoff = Date.now() - HISTORY_DAYS * 864e5;
  const before = state.alerts.length;
  state.alerts = state.alerts.filter((x) => !x.resolvedAt || Date.parse(x.resolvedAt) > cutoff);
  if (state.alerts.length > MAX_ALERTS) {
    state.alerts.sort((x, y) => Date.parse(y.updatedAt) - Date.parse(x.updatedAt));
    state.alerts = state.alerts.slice(0, MAX_ALERTS);
  }
  if (state.alerts.length !== before) changed = true;
  return changed;
}

module.exports = { evaluate, MIN_DAY };
