/**
 * Fetch and cache daily + hourly OHLCV for v3 swing strategy.
 *
 * Run from repo root:
 *   node v3/scripts/fetchV3Data.js --symbol INOXINDIA
 *   node v3/scripts/fetchV3Data.js --all
 *   node v3/scripts/fetchV3Data.js --symbol INOXINDIA --force
 *
 * Output:
 *   v3/data/daily/<symbol>.csv   (220+ days)
 *   v3/data/hourly/<symbol>.csv  (90 days of 60minute bars)
 */

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getKite } from '../../lib/kite.js';
import {
  ROOT,
  V3_DAILY_DIR,
  V3_HOURLY_DIR,
  V3_UNIVERSE_PATH,
  WATCHLIST_PATH,
  loadWatchlistSymbols,
  findToken,
  buildSymbolTokens,
  ensureV3Dirs,
  normalizeFilename,
} from '../lib/v3Universe.js';
import { writeCsv } from '../lib/loadV3Data.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(ROOT, 'data', '.cache');

const DAILY_LOOKBACK_DAYS = parseInt(process.env.V3_DAILY_LOOKBACK_DAYS || '400', 10);
const HOURLY_LOOKBACK_DAYS = parseInt(process.env.V3_HOURLY_LOOKBACK_DAYS || '400', 10);
const CHUNK_DAYS_HOURLY = 300;
const CONCURRENCY = parseInt(process.env.V3_FETCH_CONCURRENCY || '16', 10);
const RETRY_ATTEMPTS = 3;
const RETRY_BASE_MS = 2000;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export function createStartRateLimiter(callsPerSecond) {
  const gapMs = 1000 / Math.max(0.01, callsPerSecond);
  let slotChain = Promise.resolve();
  let nextStartTime = 0;
  return function histRun(fn) {
    const slotWait = slotChain.then(async () => {
      const now = Date.now();
      const wait = Math.max(0, nextStartTime - now);
      if (wait > 0) await sleep(wait);
      nextStartTime = Date.now() + gapMs;
    });
    slotChain = slotWait.catch(() => {});
    return slotWait.then(() => fn());
  };
}

function toISTDateAndTime(d) {
  const dt = d instanceof Date ? d : new Date(d);
  let h = dt.getUTCHours(),
    min = dt.getUTCMinutes(),
    s = dt.getUTCSeconds();
  let day = dt.getUTCDate(),
    month = dt.getUTCMonth(),
    year = dt.getUTCFullYear();
  min += 30;
  if (min >= 60) {
    min -= 60;
    h += 1;
  }
  h += 5;
  if (h >= 24) {
    h -= 24;
    day += 1;
  }
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  if (day > daysInMonth) {
    day = 1;
    month += 1;
  }
  if (month > 11) {
    month = 0;
    year += 1;
  }
  return {
    date: `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
    time: `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}:${String(s).padStart(2, '0')}`,
  };
}

function dateMinusDays(dateStr, n) {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

function todayIST() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

function log(msg) {
  const ts = new Date().toISOString().slice(11, 19);
  console.error(`[${ts}] ${msg}`);
}

export async function getInstruments(kite) {
  const cacheFile = path.join(CACHE_DIR, 'instruments_nse.json');
  try {
    if (fs.existsSync(cacheFile)) {
      const age = Date.now() - fs.statSync(cacheFile).mtimeMs;
      if (age < 24 * 60 * 60 * 1000) {
        return JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      }
    }
  } catch (_) {}
  const data = await kite.getInstruments('NSE');
  try {
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify(data), 'utf8');
  } catch (_) {}
  return data;
}

async function fetchCandles(kite, token, interval, fromDate, toDate, histRun) {
  let delay = RETRY_BASE_MS;
  for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
    try {
      const from = new Date(`${fromDate}T09:15:00+05:30`);
      const to = new Date(`${toDate}T15:30:00+05:30`);
      const candles = await histRun(() =>
        kite.getHistoricalData(token, interval, from, to, false, false)
      );
      return (candles || []).map((c) => {
        const dt = c.date instanceof Date ? c.date : new Date(c.date);
        const { date, time } = toISTDateAndTime(dt);
        return {
          date,
          time: interval === 'day' ? '' : time,
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
          volume: c.volume ?? 0,
        };
      });
    } catch (err) {
      if (attempt < RETRY_ATTEMPTS) {
        await sleep(delay);
        delay *= 2;
      } else throw err;
    }
  }
  return [];
}

async function fetchDailyRange(kite, token, fromDate, toDate, histRun) {
  const rows = await fetchCandles(kite, token, 'day', fromDate, toDate, histRun);
  const seen = new Set();
  const uniq = [];
  for (const r of rows.sort((a, b) => a.date.localeCompare(b.date))) {
    if (seen.has(r.date)) continue;
    seen.add(r.date);
    uniq.push(r);
  }
  return uniq;
}

async function fetchHourlyRange(kite, token, fromDate, toDate, histRun) {
  const all = [];
  let cursor = fromDate;
  while (cursor <= toDate) {
    const cursorMs = new Date(cursor + 'T12:00:00Z').getTime();
    const endMs = cursorMs + CHUNK_DAYS_HOURLY * 86400000;
    const chunkToDate = new Date(endMs).toISOString().slice(0, 10);
    const actualTo = chunkToDate > toDate ? toDate : chunkToDate;
    const rows = await fetchCandles(kite, token, '60minute', cursor, actualTo, histRun);
    all.push(...rows);
    if (actualTo >= toDate) break;
    cursor = dateMinusDays(actualTo, -1);
  }
  const seen = new Set();
  const uniq = [];
  for (const r of all.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time))) {
    const k = r.date + 'T' + r.time;
    if (seen.has(k)) continue;
    seen.add(k);
    uniq.push(r);
  }
  return uniq;
}

export async function fetchSymbol(kite, { symbol, token }, histRun, force) {
  const dailyFile = path.join(V3_DAILY_DIR, normalizeFilename(symbol) + '.csv');
  const hourlyFile = path.join(V3_HOURLY_DIR, normalizeFilename(symbol) + '.csv');
  const toDate = todayIST();
  const dailyFrom = dateMinusDays(toDate, DAILY_LOOKBACK_DAYS);
  const hourlyFrom = dateMinusDays(toDate, HOURLY_LOOKBACK_DAYS);

  if (!force && fs.existsSync(dailyFile) && fs.existsSync(hourlyFile)) {
    return { symbol, skipped: true };
  }

  const [daily, hourly] = await Promise.all([
    fetchDailyRange(kite, token, dailyFrom, toDate, histRun),
    fetchHourlyRange(kite, token, hourlyFrom, toDate, histRun),
  ]);

  if (daily.length) writeCsv(dailyFile, daily);
  if (hourly.length) writeCsv(hourlyFile, hourly);

  return { symbol, daily: daily.length, hourly: hourly.length, skipped: false };
}

async function runPool(items, concurrency, fn) {
  const results = [];
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}

export { runPool };

function parseArgs(argv) {
  const opts = { symbol: null, all: false, force: false, universe: false };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--symbol' && argv[i + 1]) opts.symbol = argv[++i].toUpperCase();
    else if (argv[i] === '--all') opts.all = true;
    else if (argv[i] === '--force') opts.force = true;
    else if (argv[i] === '--universe') opts.universe = true;
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv);
  ensureV3Dirs();

  const kite = await getKite();
  const instruments = await getInstruments(kite);
  const rps = parseFloat(process.env.V3_KITE_HISTORICAL_RPS || '10');
  const histRun = createStartRateLimiter(rps);

  let symbols;
  if (opts.symbol) symbols = [opts.symbol];
  else if (opts.all) symbols = loadWatchlistSymbols(opts.universe ? V3_UNIVERSE_PATH : undefined);
  else {
    console.error('Usage: node v3/scripts/fetchV3Data.js --symbol INOXINDIA | --all [--universe] [--force]');
    process.exit(1);
  }

  const symbolTokens = buildSymbolTokens(symbols, instruments);
  log(`Fetching v3 data for ${symbolTokens.length} symbols (daily ${DAILY_LOOKBACK_DAYS}d, hourly ${HOURLY_LOOKBACK_DAYS}d)`);

  let ok = 0;
  let skip = 0;
  let fail = 0;

  await runPool(symbolTokens, CONCURRENCY, async (st) => {
    try {
      const res = await fetchSymbol(kite, st, histRun, opts.force);
      if (res.skipped) {
        skip++;
        log(`  skip ${st.symbol} (cached)`);
      } else {
        ok++;
        log(`  ok ${st.symbol}: daily=${res.daily} hourly=${res.hourly}`);
      }
    } catch (err) {
      fail++;
      log(`  FAIL ${st.symbol}: ${err.message || err}`);
    }
  });

  log(`Done: ${ok} fetched, ${skip} skipped, ${fail} failed`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  main().catch((err) => {
    console.error('ERROR:', err.message || err);
    process.exit(1);
  });
}
