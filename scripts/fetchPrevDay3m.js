/**
 * Pre-fetch previous day 3m bars for all symbols in config/nse_mcap_above_900cr.csv
 * and store them in data/<date>/<symbol>.csv (same format used by analyzePnl.js).
 *
 * Designed to be run before the live scanner starts (e.g. at 8:30 AM).
 * Skips symbols that already have a CSV for the target date so it is safe to re-run.
 * Handles Kite rate limits via configurable concurrency and per-batch delay with retry.
 *
 * Usage:
 *   node scripts/fetchPrevDay3m.js                — fetch for the previous trading day (auto-detect)
 *   node scripts/fetchPrevDay3m.js 2026-02-24     — fetch for a specific date
 *   node scripts/fetchPrevDay3m.js --force        — re-fetch even if CSV already exists
 *   node scripts/fetchPrevDay3m.js 2026-02-24 --force
 */

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { getKite } from '../lib/kite.js';

const WATCHLIST_PATH = path.join(process.cwd(), 'config', 'nse_mcap_above_900cr.csv');
const DATA_DIR = path.join(process.cwd(), 'data');
const CACHE_DIR = path.join(DATA_DIR, '.cache');

// Rate-limit knobs — conservative defaults to avoid Kite 429s
const CONCURRENCY = 3;           // parallel requests per batch
const BATCH_DELAY_MS = 800;      // pause between batches (ms)
const RETRY_ATTEMPTS = 3;        // total tries per symbol (1 + 2 retries)
const RETRY_BASE_MS = 2000;      // base backoff for retries (doubles each attempt)

// ─── helpers ──────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/** Return YYYY-MM-DD for N calendar days before dateStr. */
function dateMinusDays(dateStr, n) {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

/** Return today's date in IST as YYYY-MM-DD. */
function todayIST() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

/**
 * Walk backwards from yesterday until we land on a Monday–Friday.
 * Does not account for NSE holidays — pass an explicit date for holiday eves.
 */
function prevTradingDay() {
  let d = dateMinusDays(todayIST(), 1);
  for (let i = 0; i < 7; i++) {
    const dow = new Date(d + 'T12:00:00Z').getUTCDay(); // 0=Sun 6=Sat
    if (dow !== 0 && dow !== 6) return d;
    d = dateMinusDays(d, 1);
  }
  return d;
}

function normalizeFilename(symbol) {
  return symbol.toLowerCase().replace(/&/g, '').replace(/\s/g, '');
}

function loadWatchlistSymbols() {
  const raw = fs.readFileSync(WATCHLIST_PATH, 'utf8').replace(/\r\n/g, '\n').trim();
  const lines = raw.split('\n');
  if (lines.length < 2) return [];
  const symbols = [];
  for (let i = 1; i < lines.length; i++) {
    const sym = (lines[i].split(',')[0] || '').trim();
    if (sym) symbols.push(sym);
  }
  return symbols;
}

function findToken(instruments, tradingsymbol) {
  const sym = tradingsymbol.includes(':') ? tradingsymbol.split(':')[1] : tradingsymbol;
  const nse = instruments.filter(i => i.exchange === 'NSE');
  const row = nse.find(i => i.tradingsymbol === sym)
    || nse.find(i => i.tradingsymbol === sym + '-EQ')
    || nse.find(i => i.tradingsymbol === sym + '-BE');
  return row ? row.instrument_token : null;
}

/** Convert a Kite candle date to IST date + time strings. */
function toISTDateAndTime(d) {
  let h = d.getUTCHours(), min = d.getUTCMinutes(), s = d.getUTCSeconds();
  let day = d.getUTCDate(), month = d.getUTCMonth(), year = d.getUTCFullYear();
  min += 30; if (min >= 60) { min -= 60; h += 1; }
  h += 5;    if (h >= 24)  { h -= 24; day += 1; }
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  if (day > daysInMonth) { day = 1; month += 1; }
  if (month > 11)         { month = 0; year += 1; }
  return {
    date: `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
    time: `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}:${String(s).padStart(2, '0')}`,
  };
}

/** Fill missing 3-minute bars so the grid is continuous (Kite omits zero-volume bars). */
function fillGaps(rows) {
  if (rows.length === 0) return rows;
  const STEP = 3;
  const START = 9 * 60 + 15;   // 09:15
  const END   = 15 * 60 + 30;  // 15:30

  const byDate = {};
  for (const r of rows) {
    if (!byDate[r.date]) byDate[r.date] = {};
    byDate[r.date][r.time] = r;
  }

  const filled = [];
  for (const date of Object.keys(byDate).sort()) {
    const map = byDate[date];
    // Use the first known close as seed for flat-fill
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
        filled.push({ date, time, open: lastClose, high: lastClose, low: lastClose, close: lastClose, volume: 0 });
      }
    }
  }
  return filled;
}

/** Write rows for a single date to data/<date>/<symbol>.csv */
function writeCsv(symbol, date, rows) {
  const dir = path.join(DATA_DIR, date);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, normalizeFilename(symbol) + '.csv');
  const header = 'date,time,open,high,low,close,volume';
  const lines = [header, ...rows.map(r => [r.date, r.time, r.open, r.high, r.low, r.close, r.volume].join(','))];
  fs.writeFileSync(file, lines.join('\n'), 'utf8');
  return file;
}

/** Load NSE instruments from 24-hour disk cache. */
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

/**
 * Fetch 3m bars for `symbol` on `dateStr` with retry + exponential backoff.
 * Returns array of {date,time,open,high,low,close,volume} rows, or null on failure.
 */
async function fetchBars(kite, token, dateStr) {
  const from = `${dateStr} 09:15:00`;
  const to   = `${dateStr} 15:30:00`;
  let delay = RETRY_BASE_MS;
  for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
    try {
      const candles = await kite.getHistoricalData(token, '3minute', from, to, false, false);
      return (candles || []).map(c => {
        const dt = c.date instanceof Date ? c.date : new Date(c.date);
        const { date, time } = toISTDateAndTime(dt);
        return { date, time, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume ?? 0 };
      });
    } catch (err) {
      const msg = err?.message ?? String(err);
      if (attempt < RETRY_ATTEMPTS) {
        process.stderr.write(`    retry ${attempt}/${RETRY_ATTEMPTS - 1} after ${delay}ms (${msg.split('\n')[0]})\n`);
        await sleep(delay);
        delay *= 2;
      } else {
        throw err;
      }
    }
  }
  return null;
}

// ─── main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const dateArg = args.find(a => /^\d{4}-\d{2}-\d{2}$/.test(a));
  const targetDate = dateArg ?? prevTradingDay();

  console.error(`\nfetchPrevDay3m — target date: ${targetDate}${force ? ' (--force)' : ''}`);
  console.error(`Watchlist: ${WATCHLIST_PATH}`);
  console.error(`Output:    ${DATA_DIR}/${targetDate}/<symbol>.csv\n`);

  const symbols = loadWatchlistSymbols();
  if (symbols.length === 0) {
    console.error('No symbols found in watchlist. Exiting.');
    process.exit(1);
  }
  console.error(`Symbols: ${symbols.length}`);

  const kite = await getKite();
  const instruments = await getInstruments(kite);

  // Build symbol → token map; warn about unresolved symbols
  const symbolTokens = [];
  let unresolved = 0;
  for (const sym of symbols) {
    const token = findToken(instruments, sym);
    if (token != null) {
      symbolTokens.push({ symbol: sym, token: Number(token) });
    } else {
      unresolved++;
    }
  }
  if (unresolved > 0) console.error(`  ${unresolved} symbols not found in NSE instruments (will skip)`);
  console.error(`  ${symbolTokens.length} tokens resolved\n`);

  // Filter out already-cached symbols unless --force
  const toFetch = force
    ? symbolTokens
    : symbolTokens.filter(({ symbol }) => {
        const csvPath = path.join(DATA_DIR, targetDate, normalizeFilename(symbol) + '.csv');
        return !fs.existsSync(csvPath);
      });

  const alreadyCached = symbolTokens.length - toFetch.length;
  if (alreadyCached > 0) console.error(`  ${alreadyCached} symbols already cached — skipping (use --force to re-fetch)`);
  console.error(`  ${toFetch.length} symbols to fetch\n`);

  if (toFetch.length === 0) {
    console.error('Nothing to fetch. Done.');
    return;
  }

  let done = 0, skipped = 0, errors = 0;
  const total = toFetch.length;
  const startTime = Date.now();

  for (let i = 0; i < toFetch.length; i += CONCURRENCY) {
    const batch = toFetch.slice(i, i + CONCURRENCY);

    await Promise.all(batch.map(async ({ symbol, token }) => {
      try {
        const rows = await fetchBars(kite, token, targetDate);
        if (!rows || rows.length === 0) {
          // Holiday or no data for this date — write empty marker so we don't keep retrying
          skipped++;
          return;
        }
        const dayRows = rows.filter(r => r.date === targetDate);
        if (dayRows.length === 0) {
          skipped++;
          return;
        }
        const filled = fillGaps(dayRows);
        writeCsv(symbol, targetDate, filled);
        done++;
      } catch (err) {
        errors++;
        const msg = (err?.message ?? String(err)).split('\n')[0];
        console.error(`  [ERROR] ${symbol}: ${msg}`);
      }
    }));

    const batchNum = Math.floor(i / CONCURRENCY) + 1;
    const totalBatches = Math.ceil(toFetch.length / CONCURRENCY);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
    const eta = totalBatches > batchNum
      ? (((Date.now() - startTime) / batchNum) * (totalBatches - batchNum) / 1000).toFixed(0)
      : 0;
    if (batchNum % 10 === 0 || batchNum === totalBatches) {
      console.error(`  batch ${batchNum}/${totalBatches} | done=${done} skipped=${skipped} errors=${errors} | ${elapsed}s elapsed, ~${eta}s left`);
    }

    // Pause between batches to respect rate limits (skip after last batch)
    if (i + CONCURRENCY < toFetch.length) await sleep(BATCH_DELAY_MS);
  }

  const totalSec = ((Date.now() - startTime) / 1000).toFixed(1);
  console.error(`\nDone in ${totalSec}s — fetched: ${done}, no-data/holiday: ${skipped}, errors: ${errors}`);
  if (errors > 0) {
    console.error(`  ${errors} symbols failed — re-run the script to retry them (already-fetched symbols will be skipped)`);
    process.exit(1);
  }
}

main().catch(err => {
  console.error('\nFatal:', err?.message ?? String(err));
  process.exit(1);
});
