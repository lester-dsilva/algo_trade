/**
 * Fetch backtest data for a given date: previous-day OHLC (full universe) + 3m OHLC for that day.
 * Data is stored under v2/data/YYYY-MM-DD/ by date.
 *
 * Run from repo root:
 *   node v2/scripts/fetchBacktestData.js 2026-03-05
 *   node v2/scripts/fetchBacktestData.js 2026-03-05 --force
 *   node v2/scripts/fetchBacktestData.js 2026-03-05 --refresh-prev-if-incomplete
 *
 * Previous trading day is derived by probing Kite (D-1, D-2, ... until a day with data); holidays are handled automatically.
 *
 * Output:
 *   v2/data/YYYY-MM-DD/prev_day_ohlc.csv   — symbol,date,open,high,low,close,volume (prev trading day)
 *   v2/data/YYYY-MM-DD/3m/<symbol>.csv     — date,time,open,high,low,close,volume (that day)
 *
 * Full universe = config/nse_mcap_above_900cr.csv (same as live scanner).
 *
 * Env:
 *   V2_KITE_HISTORICAL_RPS — max historical API call *starts* per second (default 3).
 */

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { getKite } from '../../lib/kite.js';
import {
  ROOT,
  V2_DATA_DIR,
  WATCHLIST_PATH,
  loadWatchlistSymbols,
  normalizeFilename,
  findToken,
} from '../lib/v2Universe.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = V2_DATA_DIR;
const CACHE_DIR = path.join(ROOT, 'data', '.cache');

const CONCURRENCY = 8; // parallel tasks; actual starts are spaced by historical RPS limiter
const BATCH_DELAY_MS = 0; // optional extra gap between batches (0 when using RPS limiter)
const RETRY_ATTEMPTS = 3;
const RETRY_BASE_MS = 2000;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Spaces when each historical request *starts* (calls can overlap). Default 3/sec via V2_KITE_HISTORICAL_RPS. */
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

const histRunNoLimit = (fn) => fn();

function log(msg) {
  const ts = new Date().toISOString().slice(11, 19);
  console.error(`[${ts}] ${msg}`);
}

function dateMinusDays(dateStr, n) {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

/** Fallback: previous weekday before the given date (ignores NSE holidays). */
function prevTradingDayFallback(dateStr) {
  let d = dateMinusDays(dateStr, 1);
  for (let i = 0; i < 7; i++) {
    const dow = new Date(d + 'T12:00:00Z').getUTCDay();
    if (dow !== 0 && dow !== 6) return d;
    d = dateMinusDays(d, 1);
  }
  return d;
}

/** Derive previous trading day by probing Kite: try D-1, D-2, ... until we get a day with data (handles holidays). */
async function getPrevTradingDayViaKite(kite, token, backtestDate, histRun = histRunNoLimit) {
  const MAX_DAYS_BACK = 15;
  for (let n = 1; n <= MAX_DAYS_BACK; n++) {
    const candidate = dateMinusDays(backtestDate, n);
    try {
      const bar = await fetchDailyBar(kite, token, candidate, histRun);
      if (bar && bar.date === candidate) {
        return candidate;
      }
    } catch (_) {}
  }
  return prevTradingDayFallback(backtestDate);
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

function fillGaps3m(rows) {
  if (rows.length === 0) return rows;
  const STEP = 3;
  const START = 9 * 60 + 15;
  const END = 15 * 60 + 30;
  const byDate = {};
  for (const r of rows) {
    if (!byDate[r.date]) byDate[r.date] = {};
    byDate[r.date][r.time] = r;
  }
  const filled = [];
  for (const date of Object.keys(byDate).sort()) {
    const map = byDate[date];
    const first = Object.values(map).sort((a, b) => a.time.localeCompare(b.time))[0];
    let lastClose = first ? first.open : 0;
    for (let m = START; m <= END; m += STEP) {
      const h = Math.floor(m / 60);
      const mm = m % 60;
      const time = `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00`;
      const bar = map[time];
      if (bar) {
        filled.push(bar);
        lastClose = bar.close;
      } else {
        filled.push({
          date,
          time,
          open: lastClose,
          high: lastClose,
          low: lastClose,
          close: lastClose,
          volume: 0,
        });
      }
    }
  }
  return filled;
}

async function getInstruments(kite) {
  const cacheFile = path.join(CACHE_DIR, 'instruments_nse.json');
  try {
    if (fs.existsSync(cacheFile)) {
      const age = Date.now() - fs.statSync(cacheFile).mtimeMs;
      if (age < 24 * 60 * 60 * 1000) {
        process.stderr.write('  instruments: using cache\n');
        return JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      }
    }
  } catch (_) {}
  process.stderr.write('  instruments: fetching from API...\n');
  const data = await kite.getInstruments('NSE');
  try {
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify(data), 'utf8');
  } catch (_) {}
  return data;
}

async function fetchDailyBar(kite, token, dateStr, histRun = histRunNoLimit) {
  const rangeFrom = new Date(`${dateStr}T00:00:00+05:30`);
  const rangeTo = new Date(`${dateStr}T23:59:59+05:30`);
  let delay = RETRY_BASE_MS;
  for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
    try {
      const candles = await histRun(() =>
        kite.getHistoricalData(token, 'day', rangeFrom, rangeTo, false, false)
      );
      if (!candles || candles.length === 0) return null;
      const c = candles.find((x) => {
        const { date } = toISTDateAndTime(x.date instanceof Date ? x.date : new Date(x.date));
        return date === dateStr;
      }) || candles[candles.length - 1];
      const d = c.date instanceof Date ? c.date : new Date(c.date);
      const { date } = toISTDateAndTime(d);
      return {
        date,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume ?? 0,
      };
    } catch (err) {
      if (attempt < RETRY_ATTEMPTS) {
        await sleep(delay);
        delay *= 2;
      } else throw err;
    }
  }
  return null;
}

async function fetch3mBars(kite, token, dateStr, histRun = histRunNoLimit) {
  const from = `${dateStr} 09:15:00`;
  const to = `${dateStr} 15:30:00`;
  let delay = RETRY_BASE_MS;
  for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
    try {
      const candles = await histRun(() =>
        kite.getHistoricalData(token, '3minute', from, to, false, false)
      );
      const rows = (candles || []).map((c) => {
        const dt = c.date instanceof Date ? c.date : new Date(c.date);
        const { date, time } = toISTDateAndTime(dt);
        return {
          date,
          time,
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
          volume: c.volume ?? 0,
        };
      });
      return rows;
    } catch (err) {
      if (attempt < RETRY_ATTEMPTS) {
        await sleep(delay);
        delay *= 2;
      } else throw err;
    }
  }
  return null;
}

function writePrevDayOhlc(dateDir, prevDate, rows) {
  if (!fs.existsSync(dateDir)) fs.mkdirSync(dateDir, { recursive: true });
  const file = path.join(dateDir, 'prev_day_ohlc.csv');
  const header = 'symbol,date,open,high,low,close,volume';
  const lines = [
    header,
    ...rows.map((r) => [r.symbol, r.date, r.open, r.high, r.low, r.close, r.volume].join(',')),
  ];
  fs.writeFileSync(file, lines.join('\n'), 'utf8');
  return file;
}

function write3mCsv(dateDir, symbol, dateStr, rows) {
  const dir = path.join(dateDir, '3m');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, normalizeFilename(symbol) + '.csv');
  const header = 'date,time,open,high,low,close,volume';
  const lines = [
    header,
    ...rows.map((r) => [r.date, r.time, r.open, r.high, r.low, r.close, r.volume].join(',')),
  ];
  fs.writeFileSync(file, lines.join('\n'), 'utf8');
  return file;
}

function countPrevCsvRows(prevDayPath) {
  if (!fs.existsSync(prevDayPath)) return 0;
  const lines = fs.readFileSync(prevDayPath, 'utf8').replace(/\r\n/g, '\n').trim().split('\n');
  return Math.max(0, lines.length - 1);
}

/**
 * @param {string} backtestDate - YYYY-MM-DD
 * @param [options] Optional histRun from fillV2DataGaps keeps one rate limit across many dates.
 *        If kite + instruments are passed, skips connect (for batch gap-fill).
 */
export async function fetchBacktestDataForDate(backtestDate, options = {}) {
  const force = Boolean(options.force);
  const refreshPrevIfIncomplete = Boolean(options.refreshPrevIfIncomplete);
  const dateDir = path.join(DATA_DIR, backtestDate);

  log(`fetchBacktestData — backtest date: ${backtestDate}${force ? ' --force' : ''}`);
  log(`Watchlist: ${WATCHLIST_PATH}`);
  log(`Output:    ${dateDir}`);
  log('');

  const symbols = loadWatchlistSymbols();
  if (symbols.length === 0) {
    log('No symbols in full universe. Exiting.');
    throw new Error('empty universe');
  }
  log(`Full universe: ${symbols.length} symbols`);

  let kite = options.kite;
  let instruments = options.instruments;
  if (!kite || !instruments) {
    log('Connecting to Kite...');
    kite = await getKite();
    log('Kite connected.');
    log('Loading instruments...');
    instruments = await getInstruments(kite);
    log('Instruments loaded.');
  }

  const symbolTokens = [];
  for (const sym of symbols) {
    const token = findToken(instruments, sym);
    if (token != null) symbolTokens.push({ symbol: sym, token: Number(token) });
  }
  log(`Resolved: ${symbolTokens.length} tokens`);

  const rps = Number(process.env.V2_KITE_HISTORICAL_RPS);
  const historicalRps = Number.isFinite(rps) && rps > 0 ? rps : 3;
  const histRun =
    typeof options.histRun === 'function' ? options.histRun : createStartRateLimiter(historicalRps);
  if (typeof options.histRun !== 'function') {
    log(`Historical API rate limit: ${historicalRps} calls/sec (set V2_KITE_HISTORICAL_RPS to change)`);
  }

  log('Deriving previous trading day via Kite (D-1, D-2, ... until data found)...');
  const prevDate = await getPrevTradingDayViaKite(kite, symbolTokens[0].token, backtestDate, histRun);
  log(`Previous trading day: ${prevDate}`);
  log('');

  // ─── 1. Previous day OHLC ───────────────────────────────────────────────────
  const prevDayPath = path.join(dateDir, 'prev_day_ohlc.csv');
  const prevRowsExisting = countPrevCsvRows(prevDayPath);
  const prevLooksIncomplete =
    refreshPrevIfIncomplete &&
    fs.existsSync(prevDayPath) &&
    symbolTokens.length > 0 &&
    prevRowsExisting < Math.floor(symbolTokens.length * 0.92);

  let skipPrev = !force && fs.existsSync(prevDayPath) && !prevLooksIncomplete;
  if (prevLooksIncomplete) {
    log(`Phase 1/2: prev_day_ohlc.csv looks incomplete (${prevRowsExisting}/${symbolTokens.length} rows) — re-fetching`);
  }
  if (skipPrev) {
    log('Phase 1/2: prev_day_ohlc.csv already exists — skipping (use --force to re-fetch)');
  } else {
    const totalBatchesPrev = Math.ceil(symbolTokens.length / CONCURRENCY);
    log(`Phase 1/2: Fetching previous day OHLC (${symbolTokens.length} symbols, ${totalBatchesPrev} batches)...`);
    const prevRows = [];
    let done = 0,
      errs = 0;
    const startPrev = Date.now();
    for (let i = 0; i < symbolTokens.length; i += CONCURRENCY) {
      const batchNum = Math.floor(i / CONCURRENCY) + 1;
      if (batchNum === 1) log('  Sending first batch of daily API requests...');
      const batch = symbolTokens.slice(i, i + CONCURRENCY);
      await Promise.all(
        batch.map(async ({ symbol, token }) => {
          try {
            const bar = await fetchDailyBar(kite, token, prevDate, histRun);
            if (bar)
              prevRows.push({
                symbol,
                date: bar.date,
                open: bar.open,
                high: bar.high,
                low: bar.low,
                close: bar.close,
                volume: bar.volume,
              });
            done++;
          } catch (e) {
            errs++;
            log(`  [prev] ${symbol}: ${(e?.message || e).split('\n')[0]}`);
          }
        })
      );
      const elapsed = ((Date.now() - startPrev) / 1000).toFixed(0);
      const eta = batchNum < totalBatchesPrev ? ((Date.now() - startPrev) / batchNum) * (totalBatchesPrev - batchNum) / 1000 : 0;
      const etaStr = eta > 0 ? ` ~${Math.ceil(eta)}s left` : '';
      if (batchNum === 1 || batchNum % 20 === 0 || batchNum === totalBatchesPrev) {
        log(`  [prev] batch ${batchNum}/${totalBatchesPrev} | done=${done} errs=${errs} | ${elapsed}s${etaStr}`);
      }
      if (i + CONCURRENCY < symbolTokens.length) await sleep(BATCH_DELAY_MS);
    }
    writePrevDayOhlc(dateDir, prevDate, prevRows);
    log(`  Phase 1 done: prev_day_ohlc.csv — ${prevRows.length} symbols (errors: ${errs}) in ${((Date.now() - startPrev) / 1000).toFixed(0)}s`);
  }
  log('');

  // ─── 2. 3m OHLC for backtest date ───────────────────────────────────────────
  const threeMDir = path.join(dateDir, '3m');
  const toFetch3m = force
    ? symbolTokens
    : symbolTokens.filter(({ symbol }) => {
        const p = path.join(threeMDir, normalizeFilename(symbol) + '.csv');
        return !fs.existsSync(p);
      });
  if (toFetch3m.length === 0) {
    log('Phase 2/2: 3m data already present — skipping (use --force to re-fetch)');
  } else {
    const totalBatches3m = Math.ceil(toFetch3m.length / CONCURRENCY);
    log(`Phase 2/2: Fetching 3m bars for ${backtestDate} (${toFetch3m.length} symbols, ${totalBatches3m} batches)...`);
    let done = 0,
      skipped = 0,
      errs = 0;
    const start3m = Date.now();
    for (let i = 0; i < toFetch3m.length; i += CONCURRENCY) {
      const batchNum = Math.floor(i / CONCURRENCY) + 1;
      if (batchNum === 1) log('  Sending first batch of 3m API requests...');
      const batch = toFetch3m.slice(i, i + CONCURRENCY);
      await Promise.all(
        batch.map(async ({ symbol, token }) => {
          try {
            const rows = await fetch3mBars(kite, token, backtestDate, histRun);
            if (!rows || rows.length === 0) {
              skipped++;
              return;
            }
            const dayRows = rows.filter((r) => r.date === backtestDate);
            if (dayRows.length === 0) {
              skipped++;
              return;
            }
            const filled = fillGaps3m(dayRows);
            write3mCsv(dateDir, symbol, backtestDate, filled);
            done++;
          } catch (e) {
            errs++;
            log(`  [3m] ${symbol}: ${(e?.message || e).split('\n')[0]}`);
          }
        })
      );
      const elapsed = ((Date.now() - start3m) / 1000).toFixed(0);
      const eta = batchNum < totalBatches3m ? ((Date.now() - start3m) / batchNum) * (totalBatches3m - batchNum) / 1000 : 0;
      const etaStr = eta > 0 ? ` ~${Math.ceil(eta)}s left` : '';
      if (batchNum === 1 || batchNum % 20 === 0 || batchNum === totalBatches3m) {
        log(`  [3m] batch ${batchNum}/${totalBatches3m} | done=${done} skipped=${skipped} errs=${errs} | ${elapsed}s${etaStr}`);
      }
      if (i + CONCURRENCY < toFetch3m.length) await sleep(BATCH_DELAY_MS);
    }
    log(`  Phase 2 done: 3m wrote ${done} symbols, no-data: ${skipped}, errors: ${errs} in ${((Date.now() - start3m) / 1000).toFixed(0)}s`);
  }

  log('');
  log('Done.');
}

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const refreshPrevIfIncomplete = args.includes('--refresh-prev-if-incomplete');
  const dateArg = args.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));
  if (!dateArg) {
    console.error(
      'Usage: node v2/scripts/fetchBacktestData.js YYYY-MM-DD [--force] [--refresh-prev-if-incomplete]'
    );
    process.exit(1);
  }
  await fetchBacktestDataForDate(dateArg, { force, refreshPrevIfIncomplete });
}

const isCli =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isCli) {
  main().catch((err) => {
    console.error('\nFatal:', err?.message ?? String(err));
    process.exit(1);
  });
}
