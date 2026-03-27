/**
 * Universe scan: list every day in the lookback where same-session open→close gain
 * is at least --threshold %, using Kite daily candles.
 *
 * Definition: openToClosePct = (close - open) / open * 100  (not vs previous close).
 *
 *   node v2/scripts/analyzeOpenToCloseSurge.js
 *   node v2/scripts/analyzeOpenToCloseSurge.js --years 3 --threshold 15
 *   node v2/scripts/analyzeOpenToCloseSurge.js --out v2/data/analysis_open_to_close_15pct.csv
 *   node v2/scripts/analyzeOpenToCloseSurge.js --max-symbols 50   # smoke test
 *
 * Needs valid Kite session (.kite_session / .env). ~1 API call per symbol; default 250ms spacing.
 */

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getKite } from '../../lib/kite.js';
import { ROOT, loadWatchlistSymbols, findToken } from '../lib/v2Universe.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(ROOT, 'data', '.cache');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function toISTDateString(d) {
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
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function argVal(name) {
  const i = process.argv.indexOf(name);
  if (i === -1 || i + 1 >= process.argv.length) return null;
  return process.argv[i + 1];
}

async function getInstruments(kite) {
  const cacheFile = path.join(CACHE_DIR, 'instruments_nse.json');
  try {
    if (fs.existsSync(cacheFile)) {
      const age = Date.now() - fs.statSync(cacheFile).mtimeMs;
      if (age < 24 * 60 * 60 * 1000) {
        process.stderr.write('instruments: using cache\n');
        return JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      }
    }
  } catch (_) {}
  process.stderr.write('instruments: fetching from API…\n');
  const data = await kite.getInstruments('NSE');
  try {
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify(data), 'utf8');
  } catch (_) {}
  return data;
}

async function fetchDailyRange(kite, token, from, to, retries = 3) {
  let delay = 1500;
  for (let a = 1; a <= retries; a++) {
    try {
      const candles = await kite.getHistoricalData(token, 'day', from, to, false, false);
      return candles || [];
    } catch (e) {
      if (a < retries) {
        await sleep(delay);
        delay *= 2;
      } else throw e;
    }
  }
  return [];
}

async function main() {
  const years = Math.max(0.25, parseFloat(argVal('--years') || '3') || 3);
  const threshold = Math.max(0, parseFloat(argVal('--threshold') || '15') || 15);
  const delayMs = Math.max(0, parseInt(argVal('--delay-ms') || '250', 10) || 250);
  const outRel = argVal('--out') || path.join(ROOT, 'v2', 'data', `analysis_open_to_close_ge${threshold}pct.csv`);
  const outPath = path.isAbsolute(outRel) ? outRel : path.join(ROOT, outRel);
  const maxSymArg = argVal('--max-symbols');
  const maxSymbols = maxSymArg != null ? parseInt(maxSymArg, 10) : null;

  const to = new Date();
  const from = new Date(to);
  from.setFullYear(from.getFullYear() - years);

  process.stderr.write(
    `Universe: config/nse_mcap_above_900cr.csv | lookback: ${from.toISOString().slice(0, 10)} → ${to.toISOString().slice(0, 10)} (~${years}y)\n`
  );
  process.stderr.write(`Rule: (close - open) / open * 100 >= ${threshold}%\n`);
  process.stderr.write(`Output: ${outPath}\n\n`);

  let symbols = loadWatchlistSymbols();
  if (symbols.length === 0) {
    console.error('No symbols in watchlist.');
    process.exit(1);
  }
  if (maxSymbols != null && !Number.isNaN(maxSymbols) && maxSymbols > 0) {
    symbols = symbols.slice(0, maxSymbols);
    process.stderr.write(`--max-symbols ${maxSymbols} (truncated list)\n`);
  }

  const kite = await getKite();
  const instruments = await getInstruments(kite);

  const hits = [];
  let resolved = 0,
    errors = 0,
    idx = 0;

  for (const symbol of symbols) {
    idx++;
    const token = findToken(instruments, symbol);
    if (token == null) continue;
    resolved++;

    try {
      const candles = await fetchDailyRange(kite, Number(token), from, to);
      for (const c of candles) {
        const open = Number(c.open);
        const close = Number(c.close);
        if (!open || open <= 0 || !Number.isFinite(close)) continue;
        const pct = ((close - open) / open) * 100;
        if (pct >= threshold) {
          const d = c.date instanceof Date ? c.date : new Date(c.date);
          const dateStr = toISTDateString(d);
          hits.push({
            symbol,
            date: dateStr,
            open,
            close,
            openToClosePct: Math.round(pct * 100) / 100,
            volume: c.volume ?? 0,
          });
        }
      }
    } catch (e) {
      errors++;
      process.stderr.write(`  [err] ${symbol}: ${(e?.message || e).split('\n')[0]}\n`);
    }

    if (idx % 100 === 0 || idx === symbols.length) {
      process.stderr.write(`  progress ${idx}/${symbols.length} symbols | hits so far: ${hits.length} rows | errs: ${errors}\n`);
    }
    if (delayMs > 0 && idx < symbols.length) await sleep(delayMs);
  }

  hits.sort((a, b) => b.openToClosePct - a.openToClosePct);

  const header = 'symbol,date,open,close,openToClosePct,volume';
  const lines = [header, ...hits.map((r) => [r.symbol, r.date, r.open, r.close, r.openToClosePct, r.volume].join(','))];
  fs.writeFileSync(outPath, lines.join('\n'), 'utf8');

  const uniqueSyms = new Set(hits.map((h) => h.symbol));
  process.stderr.write(`\nDone. Symbols with ≥1 qualifying day: ${uniqueSyms.size} / ${resolved} resolved tokens\n`);
  process.stderr.write(`Total qualifying (symbol,day) rows: ${hits.length}\n`);
  process.stderr.write(`Wrote ${outPath}\n`);
}

main().catch((e) => {
  console.error(e?.message || e);
  process.exit(1);
});
