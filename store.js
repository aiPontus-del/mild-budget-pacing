// Delat tillstånd: månadsbudgetar, dolda konton och larm.
// Lagras i Redis om REDIS_URL finns, annars i DATA_DIR/state.json.
// Hålls i minnet och skrivs igenom vid varje ändring.

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const FILE = path.join(DATA_DIR, 'state.json');
const LEGACY_FILE = path.join(DATA_DIR, 'budgets.json');
const REDIS_KEY = process.env.REDIS_KEY || 'mild-budget-pacing:state';

const redis = process.env.REDIS_URL
  ? new (require('ioredis'))(process.env.REDIS_URL, { maxRetriesPerRequest: 3 })
  : null;
if (redis) redis.on('error', (e) => console.error('[redis]', e.message));

const empty = () => ({ budgets: {}, hidden: [], alerts: [] });
let state = empty();
let writing = Promise.resolve();

function normalize(raw) {
  const s = { ...empty(), ...(raw || {}) };
  if (!Array.isArray(s.hidden)) s.hidden = [];
  if (!Array.isArray(s.alerts)) s.alerts = [];
  if (!s.budgets || typeof s.budgets !== 'object') s.budgets = {};
  return s;
}

async function load() {
  if (redis) {
    const raw = await redis.get(REDIS_KEY);
    state = normalize(raw ? JSON.parse(raw) : null);
    return state;
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  try {
    state = normalize(JSON.parse(fs.readFileSync(FILE, 'utf8')));
  } catch {
    state = empty();
    // Äldre version sparade bara budgetar, i budgets.json.
    try { state.budgets = JSON.parse(fs.readFileSync(LEGACY_FILE, 'utf8')); } catch { /* ingen fil */ }
  }
  return state;
}

// Sparar hela tillståndet. Skrivningar köas så att de inte krockar.
function save() {
  const snapshot = JSON.stringify(state);
  writing = writing.catch(() => {}).then(async () => {
    if (redis) return redis.set(REDIS_KEY, snapshot);
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, snapshot);
    fs.renameSync(tmp, FILE);
  });
  return writing;
}

module.exports = {
  load,
  save,
  get: () => state,
  kind: redis ? 'redis' : 'file',
};
