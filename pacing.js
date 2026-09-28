// Pacingberäkningar på servern. Samma regler som i dashboarden (public/index.html).

const TZ = 'Europe/Stockholm';

function stockholmNow(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', hourCycle: 'h23',
  }).formatToParts(date);
  const g = (t) => Number(parts.find((p) => p.type === t).value);
  return { year: g('year'), month: g('month'), day: g('day'), hour: g('hour'), minute: g('minute') };
}

function monthInfo(date = new Date()) {
  const n = stockholmNow(date);
  const daysInMonth = new Date(n.year, n.month, 0).getDate();
  const elapsedDays = Math.max(0.25, (n.day - 1) + (n.hour + n.minute / 60) / 24);
  const pad = (x) => String(x).padStart(2, '0');
  const key = `${n.year}-${pad(n.month)}`;
  const today = `${key}-${pad(n.day)}`;
  const y = new Date(Date.UTC(n.year, n.month - 1, n.day - 1));
  const yesterday = `${y.getUTCFullYear()}-${pad(y.getUTCMonth() + 1)}-${pad(y.getUTCDate())}`;
  return { ...n, daysInMonth, elapsedDays, key, today, yesterday };
}

function classify(dev) {
  if (dev == null || !isFinite(dev)) return 'none';
  if (dev > 15) return 'over';
  if (dev < -15) return 'under';
  if (Math.abs(dev) > 5) return 'warn';
  return 'ok';
}

function derive(a, m) {
  const autoBudget = (a.dailyBudget || 0) * 30.4;
  const budget = a.monthlyBudget != null ? a.monthlyBudget : autoBudget;
  const forecast = (a.mtdCost / m.elapsedDays) * m.daysInMonth;
  const dev = budget > 0 ? ((forecast - budget) / budget) * 100 : null;
  return { budget, forecast, dev, status: budget > 0 ? classify(dev) : 'none' };
}

module.exports = { monthInfo, derive, classify };
