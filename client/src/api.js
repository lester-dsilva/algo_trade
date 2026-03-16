const API = '/api';

async function handleRes(r) {
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || r.statusText);
  return data;
}

export async function getMonths() {
  const r = await fetch(`${API}/months`);
  return handleRes(r);
}

export async function getDates(month) {
  const r = await fetch(`${API}/dates?month=${encodeURIComponent(month)}`);
  return handleRes(r);
}

export async function getDataStatus(month) {
  const r = await fetch(`${API}/data-status?month=${encodeURIComponent(month)}`);
  return handleRes(r);
}

export async function getLoadMonthStatus() {
  const r = await fetch(`${API}/load-month/status`);
  return handleRes(r);
}

export async function loadMonth(month) {
  const r = await fetch(`${API}/load-month`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ month }),
  });
  return handleRes(r);
}

export async function getLoadDateStatus() {
  const r = await fetch(`${API}/load-date/status`);
  return handleRes(r);
}

export async function loadDate(date) {
  const r = await fetch(`${API}/load-date`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ date }),
  });
  return handleRes(r);
}

/** GET cached backtest for month; returns null if not cached (404). */
export async function getBacktestMonth(month) {
  const r = await fetch(`${API}/backtest-month?month=${encodeURIComponent(month)}`);
  if (r.status === 404) return null;
  return handleRes(r);
}

export async function backtestMonth(month) {
  const r = await fetch(`${API}/backtest-month`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ month }),
  });
  return handleRes(r);
}

export async function getTrades(date) {
  const r = await fetch(`${API}/trades?date=${encodeURIComponent(date)}`);
  return handleRes(r);
}

export async function getChart3m(date, symbol) {
  const r = await fetch(
    `${API}/chart/3m?date=${encodeURIComponent(date)}&symbol=${encodeURIComponent(symbol)}`
  );
  return handleRes(r);
}

export async function getChartDaily(symbol, days = 20) {
  const r = await fetch(
    `${API}/chart/daily?symbol=${encodeURIComponent(symbol)}&days=${days}`
  );
  return handleRes(r);
}

export async function getEquityCurve(month) {
  const r = await fetch(`${API}/equity-curve?month=${encodeURIComponent(month)}`);
  return handleRes(r);
}

/** GET list of saved baselines (names + metadata). */
export async function getBaselines() {
  const r = await fetch(`${API}/baselines`);
  return handleRes(r);
}

/** GET full baseline by name (byMonth, trades, etc.). */
export async function getBaseline(name) {
  const r = await fetch(`${API}/baselines/${encodeURIComponent(name)}`);
  return handleRes(r);
}

/** DELETE a saved baseline by name. */
export async function deleteBaseline(name) {
  const r = await fetch(`${API}/baselines/${encodeURIComponent(name)}`, { method: 'DELETE' });
  return handleRes(r);
}

/** POST run backtest for all available dates in parallel and save baseline by name. config = optional overrides (dayVolMult, firstTargetPct, etc.). */
export async function runBacktestAllSaveBaseline(name, config = {}) {
  const r = await fetch(`${API}/backtest-all-save-baseline`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: name || 'baseline', config }),
  });
  return handleRes(r);
}
