/**
 * Dashboard API routes. Imports assume server runs from repo root (or routes resolve v2 via ../..).
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { Router } from 'express';
import {
  hasBacktestData,
  loadPrevDayOhlc,
  load3mForSymbol,
  list3mSymbols,
} from '../../v2/lib/loadBacktestData.js';
import { runBacktestForDate } from '../../v2/scripts/runBacktest.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const DATA_DIR = path.join(ROOT, 'v2', 'data');
const BACKTEST_CACHE_DIR = path.join(DATA_DIR, 'backtest_cache');

const TRADING_DAYS_PER_YEAR = 252;

function getBacktestCachePath(month) {
  if (!/^\d{4}-\d{2}$/.test(month)) return null;
  return path.join(BACKTEST_CACHE_DIR, `${month}.json`);
}

function readBacktestCache(month) {
  const file = getBacktestCachePath(month);
  if (!file || !fs.existsSync(file)) return null;
  try {
    const raw = fs.readFileSync(file, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function writeBacktestCache(month, data) {
  const file = getBacktestCachePath(month);
  if (!file) return;
  try {
    if (!fs.existsSync(BACKTEST_CACHE_DIR)) {
      fs.mkdirSync(BACKTEST_CACHE_DIR, { recursive: true });
    }
    fs.writeFileSync(file, JSON.stringify(data), 'utf8');
  } catch (err) {
    console.error('writeBacktestCache:', err.message);
  }
}
const CAPITAL_PER_DAY = 50000;

// In-memory load-month job status
let loadMonthStatus = { running: false, month: null, startedAt: null };

function getDatesWithData(monthFilter) {
  if (!fs.existsSync(DATA_DIR)) return [];
  const dirs = fs.readdirSync(DATA_DIR);
  const dates = dirs.filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && hasBacktestData(d));
  if (monthFilter) {
    const [y, m] = monthFilter.split('-').map(Number);
    return dates.filter((d) => {
      const [dy, dm] = d.split('-').map(Number);
      return dy === y && dm === m;
    });
  }
  return dates.sort();
}

function getWeekdaysInMonth(year, month) {
  const dates = [];
  const lastDay = new Date(year, month, 0).getDate();
  for (let d = 1; d <= lastDay; d++) {
    const date = new Date(year, month - 1, d);
    const dow = date.getDay();
    if (dow >= 1 && dow <= 5) {
      const y = date.getFullYear();
      const m = String(date.getMonth() + 1).padStart(2, '0');
      const day = String(d).padStart(2, '0');
      dates.push(`${y}-${m}-${day}`);
    }
  }
  return dates;
}

function getMonthsWithData() {
  const dates = getDatesWithData(null);
  const set = new Set();
  for (const d of dates) {
    set.add(d.slice(0, 7)); // YYYY-MM
  }
  return [...set].sort().reverse();
}

export const apiRouter = Router();

// GET /api/months — list months that have at least one date with data
apiRouter.get('/months', (req, res) => {
  try {
    const months = getMonthsWithData();
    res.json({ months });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/dates?month=YYYY-MM
apiRouter.get('/dates', (req, res) => {
  const month = req.query.month;
  if (!month || !/^\d{4}-\d{2}$/.test(month)) {
    return res.status(400).json({ error: 'Query month=YYYY-MM required' });
  }
  try {
    const dates = getDatesWithData(month);
    res.json({ month, dates });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/data-status?month=YYYY-MM — weekdays in month + which have data
apiRouter.get('/data-status', (req, res) => {
  const month = req.query.month;
  if (!month || !/^\d{4}-\d{2}$/.test(month)) {
    return res.status(400).json({ error: 'Query month=YYYY-MM required' });
  }
  try {
    const [year, monthNum] = month.split('-').map(Number);
    const weekdays = getWeekdaysInMonth(year, monthNum);
    const datesWithData = getDatesWithData(month);
    const haveData = new Set(datesWithData);
    const status = weekdays.map((d) => ({ date: d, hasData: haveData.has(d) }));
    res.json({ month, weekdays, status, total: weekdays.length, withData: datesWithData.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/load-month — spawn fetchMonth.js, return 202
apiRouter.post('/load-month', (req, res) => {
  const month = req.body?.month;
  if (!month || !/^\d{4}-\d{2}$/.test(month)) {
    return res.status(400).json({ error: 'Body { month: "YYYY-MM" } required' });
  }
  if (loadMonthStatus.running) {
    return res.status(409).json({ error: 'Load already in progress', status: loadMonthStatus });
  }
  loadMonthStatus = { running: true, month, startedAt: new Date().toISOString() };
  const child = spawn('node', ['v2/scripts/fetchMonth.js', month, '--concurrency', '4'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: true,
  });
  child.on('close', (code) => {
    loadMonthStatus = { running: false, month: loadMonthStatus.month, startedAt: loadMonthStatus.startedAt, finished: true, code };
  });
  child.on('error', () => {
    loadMonthStatus = { running: false, month: loadMonthStatus.month, startedAt: loadMonthStatus.startedAt, error: true };
  });
  res.status(202).json({ status: 'started', month });
});

// GET /api/load-month/status
apiRouter.get('/load-month/status', (req, res) => {
  res.json(loadMonthStatus);
});

// GET /api/backtest-month?month=YYYY-MM — return cached result if available
apiRouter.get('/backtest-month', (req, res) => {
  const month = req.query.month;
  if (!month || !/^\d{4}-\d{2}$/.test(month)) {
    return res.status(400).json({ error: 'Query month=YYYY-MM required' });
  }
  const cached = readBacktestCache(month);
  if (!cached) return res.status(404).json({ error: 'No cached backtest for this month' });
  res.json(cached);
});

// Yield to event loop so other requests (e.g. GET backtest-month) can be handled
function yieldToEventLoop() {
  return new Promise((resolve) => setImmediate(resolve));
}

// POST /api/backtest-month — run backtest, save to cache, return result (yields so GET isn't blocked)
apiRouter.post('/backtest-month', async (req, res) => {
  const month = req.body?.month;
  if (!month || !/^\d{4}-\d{2}$/.test(month)) {
    return res.status(400).json({ error: 'Body { month: "YYYY-MM" } required' });
  }
  try {
    const dates = getDatesWithData(month);
    const byDate = [];
    let totalPnl = 0;
    for (const date of dates) {
      await yieldToEventLoop();
      const out = runBacktestForDate(date, { quiet: true });
      if (!out) continue;
      totalPnl += out.totalPnl;
      byDate.push({
        date: out.backtestDate,
        trades: out.trades,
        wins: out.wins,
        losses: out.losses,
        pnl: out.totalPnl,
        results: out.results,
      });
    }
    const result = { month, byDate, totalPnl };
    writeBacktestCache(month, result);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/trades?date=YYYY-MM-DD — use cache for month if available
apiRouter.get('/trades', (req, res) => {
  const date = req.query.date;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'Query date=YYYY-MM-DD required' });
  }
  if (!hasBacktestData(date)) {
    return res.status(404).json({ error: 'No backtest data for this date' });
  }
  try {
    const month = date.slice(0, 7);
    const cached = readBacktestCache(month);
    const dayEntry = cached?.byDate?.find((d) => d.date === date);
    if (dayEntry) {
      return res.json({
        date: dayEntry.date,
        results: dayEntry.results,
        totalPnl: dayEntry.pnl,
        trades: dayEntry.trades,
        wins: dayEntry.wins,
        losses: dayEntry.losses,
      });
    }
    const out = runBacktestForDate(date, { quiet: true });
    if (!out) return res.status(404).json({ error: 'No results' });
    res.json({ date: out.backtestDate, results: out.results, totalPnl: out.totalPnl, trades: out.trades, wins: out.wins, losses: out.losses });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/chart/daily?symbol=SYMBOL&days=20 — fetch last N trading days from Kite (no storage)
apiRouter.get('/chart/daily', async (req, res) => {
  const symbol = (req.query.symbol || '').trim();
  const days = Math.min(40, Math.max(1, parseInt(req.query.days, 10) || 20));
  if (!symbol) {
    return res.status(400).json({ error: 'Query symbol required' });
  }
  try {
    const { getKite } = await import('../../lib/kite.js');
    const kite = await getKite();
    const instruments = await kite.getInstruments('NSE');
    const findToken = (sym) => {
      const s = sym.includes(':') ? sym.split(':')[1] : sym;
      const nse = instruments.filter((i) => i.exchange === 'NSE');
      return (
        nse.find((i) => i.tradingsymbol === s) ||
        nse.find((i) => i.tradingsymbol === s + '-EQ') ||
        nse.find((i) => i.tradingsymbol === s + '-BE')
      )?.instrument_token ?? null;
    };
    const token = findToken(symbol);
    if (!token) {
      return res.status(404).json({ error: `Symbol not found: ${symbol}` });
    }
    function dateMinusDays(dateStr, n) {
      const d = new Date(dateStr + 'T12:00:00Z');
      d.setUTCDate(d.getUTCDate() - n);
      return d.toISOString().slice(0, 10);
    }
    function toISTDate(d) {
      const dt = d instanceof Date ? d : new Date(d);
      let h = dt.getUTCHours(), min = dt.getUTCMinutes();
      let day = dt.getUTCDate(), month = dt.getUTCMonth(), year = dt.getUTCFullYear();
      min += 30;
      if (min >= 60) { min -= 60; h += 1; }
      h += 5;
      if (h >= 24) { h -= 24; day += 1; }
      const daysInMonth = new Date(year, month + 1, 0).getDate();
      if (day > daysInMonth) { day = 1; month += 1; }
      if (month > 11) { month = 0; year += 1; }
      return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
    async function fetchDailyBar(dateStr) {
      const rangeFrom = new Date(`${dateStr}T00:00:00+05:30`);
      const rangeTo = new Date(`${dateStr}T23:59:59+05:30`);
      try {
        const candles = await kite.getHistoricalData(Number(token), 'day', rangeFrom, rangeTo, false, false);
        if (!candles || candles.length === 0) return null;
        const c = candles.find((x) => toISTDate(x.date instanceof Date ? x.date : new Date(x.date)) === dateStr) || candles[candles.length - 1];
        const d = c.date instanceof Date ? c.date : new Date(c.date);
        return {
          date: toISTDate(d),
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
          volume: c.volume ?? 0,
        };
      } catch {
        return null;
      }
    }
    const today = new Date().toISOString().slice(0, 10);
    const bars = [];
    let tried = 0;
    for (let n = 0; bars.length < days && tried < days + 30; n++) {
      const dateStr = dateMinusDays(today, n);
      const dow = new Date(dateStr + 'T12:00:00Z').getUTCDay();
      if (dow === 0 || dow === 6) continue;
      tried++;
      const bar = await fetchDailyBar(dateStr);
      if (bar) bars.push(bar);
    }
    bars.reverse();
    res.json({ symbol, bars });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/chart/3m?date=YYYY-MM-DD&symbol=SYMBOL
apiRouter.get('/chart/3m', (req, res) => {
  const date = req.query.date;
  const symbol = req.query.symbol;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !symbol) {
    return res.status(400).json({ error: 'Query date=YYYY-MM-DD and symbol required' });
  }
  if (!hasBacktestData(date)) {
    return res.status(404).json({ error: 'No backtest data for this date' });
  }
  try {
    const bars = load3mForSymbol(date, symbol.trim());
    if (!bars || bars.length === 0) {
      return res.status(404).json({ error: 'No 3m data for this symbol on this date' });
    }
    const out = runBacktestForDate(date, { quiet: true });
    if (!out) return res.status(404).json({ error: 'No backtest results' });
    const norm = (s) => s.toLowerCase().replace(/&/g, '').replace(/\s/g, '');
    const trade = out.results.find((r) => norm(r.symbol) === norm(symbol));
    const entry = trade
      ? { price: trade.entry, barIndex: trade.barIndex }
      : null;
    const stop = trade ? trade.stop : null;
    const exit = trade
      ? { price: trade.exitPrice, reason: trade.exitReason, barIndex: trade.exitBarIndex }
      : null;
    res.json({ date, symbol: trade?.symbol || symbol.trim(), bars, entry, stop, exit });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/equity-curve?month=YYYY-MM — use backtest cache if available
apiRouter.get('/equity-curve', (req, res) => {
  const month = req.query.month;
  if (!month || !/^\d{4}-\d{2}$/.test(month)) {
    return res.status(400).json({ error: 'Query month=YYYY-MM required' });
  }
  try {
    const cached = readBacktestCache(month);
    if (cached?.byDate?.length) {
      const rows = cached.byDate.map((d) => ({ date: d.date, pnl: d.pnl }));
      const dailyReturns = rows.map((r) => r.pnl / CAPITAL_PER_DAY);
      const meanReturn = dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length;
      const variance =
        dailyReturns.reduce((s, r) => s + (r - meanReturn) ** 2, 0) / (dailyReturns.length - 1) || 0;
      const stdReturn = Math.sqrt(variance);
      const sharpe = stdReturn > 0 ? (meanReturn / stdReturn) * Math.sqrt(TRADING_DAYS_PER_YEAR) : null;
      let cum = 0;
      const points = rows.map((r) => {
        cum += r.pnl;
        return { date: r.date, pnl: r.pnl, cumulativePnl: cum };
      });
      let peak = 0;
      let maxDrawdown = 0;
      for (const p of points) {
        if (p.cumulativePnl > peak) peak = p.cumulativePnl;
        const dd = peak - p.cumulativePnl;
        if (dd > maxDrawdown) maxDrawdown = dd;
      }
      return res.json({ month, sharpe, maxDrawdown, points });
    }
    const dates = getDatesWithData(month);
    if (dates.length === 0) {
      return res.json({ month, sharpe: null, maxDrawdown: 0, points: [] });
    }
    const rows = [];
    for (const backtestDate of dates) {
      const out = runBacktestForDate(backtestDate, { quiet: true });
      if (!out) continue;
      rows.push({ date: backtestDate, pnl: out.totalPnl });
    }
    if (rows.length === 0) {
      return res.json({ month, sharpe: null, maxDrawdown: 0, points: [] });
    }
    const dailyReturns = rows.map((r) => r.pnl / CAPITAL_PER_DAY);
    const meanReturn = dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length;
    const variance =
      dailyReturns.reduce((s, r) => s + (r - meanReturn) ** 2, 0) / (dailyReturns.length - 1) || 0;
    const stdReturn = Math.sqrt(variance);
    const sharpe = stdReturn > 0 ? (meanReturn / stdReturn) * Math.sqrt(TRADING_DAYS_PER_YEAR) : null;
    let cum = 0;
    const points = rows.map((r) => {
      cum += r.pnl;
      return { date: r.date, pnl: r.pnl, cumulativePnl: cum };
    });
    let peak = 0;
    let maxDrawdown = 0;
    for (const p of points) {
      if (p.cumulativePnl > peak) peak = p.cumulativePnl;
      const dd = peak - p.cumulativePnl;
      if (dd > maxDrawdown) maxDrawdown = dd;
    }
    res.json({ month, sharpe, maxDrawdown, points });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
