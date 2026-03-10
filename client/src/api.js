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
