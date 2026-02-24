/**
 * Standalone script to debug why daily/3m data is missing for specific symbols.
 * Fetches daily candles (7-day range) and optionally 3m for prev+date, prints raw API response and derived values.
 *
 * Usage (from project root):
 *   node scripts/checkSymbolData.js <date> <symbol1> [symbol2] ...
 *   node scripts/checkSymbolData.js 2026-02-18 E2E IZMO SCHNEIDER
 *   node scripts/checkSymbolData.js 2026-02-18 --watchlist data/watchlists/2026-02-18/watchlist.txt
 *
 * Requires .env with Kite credentials; uses same session as other scripts.
 */

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { getKite } from '../lib/kite.js';

const RANGE_DAYS = 7;

function dateMinusDays(dateStr, days) {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/** YYYY-MM-DD in IST from a Kite day-candle */
function candleDateStr(c) {
  if (!c || c.date == null) return '';
  const d = c.date instanceof Date ? c.date : new Date(c.date);
  return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

/** Find token: try exact, then -EQ, then -BE (NSE). Returns { token, tradingsymbol } or { candidates }. */
function findToken(instruments, symbol) {
  const sym = (symbol || '').includes(':') ? symbol.split(':')[1].trim() : (symbol || '').trim();
  if (!sym) return null;
  const nse = instruments.filter((i) => i.exchange === 'NSE');
  const trySym = (s) => nse.find((i) => i.tradingsymbol === s || i.tradingsymbol.toUpperCase() === s.toUpperCase());
  let row = trySym(sym) || trySym(`${sym}-EQ`) || trySym(`${sym}-BE`);
  if (row) return { token: row.instrument_token, tradingsymbol: row.tradingsymbol };
  const candidates = nse.filter((i) => i.tradingsymbol.toUpperCase().startsWith(sym.toUpperCase()) || i.tradingsymbol.toUpperCase().includes(sym.toUpperCase())).slice(0, 5).map((i) => i.tradingsymbol);
  return { token: null, tradingsymbol: null, candidates };
}

async function main() {
  const args = process.argv.slice(2).filter(Boolean);
  if (args.length < 2) {
    console.error('Usage: node scripts/checkSymbolData.js <date> <symbol1> [symbol2] ...');
    console.error('   or: node scripts/checkSymbolData.js <date> --watchlist <path>');
    process.exit(1);
  }

  const forDate = args[0];
  let symbols = [];
  const watchlistIdx = args.indexOf('--watchlist');
  if (watchlistIdx >= 0 && args[watchlistIdx + 1]) {
    const p = path.resolve(process.cwd(), args[watchlistIdx + 1]);
    if (!fs.existsSync(p)) {
      console.error('Watchlist file not found:', p);
      process.exit(1);
    }
    symbols = fs.readFileSync(p, 'utf8').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  } else {
    symbols = args.slice(1);
  }

  const dayRangeFrom = dateMinusDays(forDate, RANGE_DAYS);
  console.log('Date (forDate):', forDate);
  console.log('Daily range:', dayRangeFrom, 'to', forDate);
  console.log('Symbols:', symbols.join(', '));
  console.log('');

  const kite = await getKite();
  const instruments = await kite.getInstruments('NSE');
  const delayMs = parseInt(process.env.LOAD_DELAY_MS, 10) || 1000;

  for (let i = 0; i < symbols.length; i++) {
    const symbol = symbols[i];
    if (i > 0) await new Promise((r) => setTimeout(r, delayMs));

    const found = findToken(instruments, symbol);
    const token = found && found.token != null ? found.token : null;
    if (!token) {
      console.log(`\n--- ${symbol} ---`);
      console.log('  Instrument: NOT FOUND on NSE (exact, -EQ, case-insensitive)');
      if (found?.candidates?.length) console.log('  Did you mean?:', found.candidates.join(', '));
      continue;
    }

    console.log(`\n--- ${symbol} (token: ${token}, tradingsymbol: ${found.tradingsymbol}) ---`);

    try {
      const rangeFrom = new Date(`${dayRangeFrom}T00:00:00+05:30`);
      const rangeTo = new Date(`${forDate}T23:59:59+05:30`);
      const dayCandles = await kite.getHistoricalData(token, 'day', rangeFrom, rangeTo, false, false);

      if (!dayCandles || dayCandles.length === 0) {
        console.log('  Daily candles: 0 (API returned empty)');
        continue;
      }

      console.log('  Daily candles count:', dayCandles.length);
      let prevDayCloseDaily = null;
      let dayOpenDaily = null;
      let prevTradingDate = null;

      for (let j = 0; j < dayCandles.length; j++) {
        const c = dayCandles[j];
        const d = candleDateStr(c);
        const rawDate = c.date;
        if (j === 0) console.log('  Raw date sample (first candle):', rawDate, typeof rawDate);
        console.log(`    [${j}] parsedDate=${d} open=${c.open} high=${c.high} low=${c.low} close=${c.close} volume=${c.volume ?? 'n/a'}`);
        if (d === forDate) {
          dayOpenDaily = c.open;
        }
        if (d && d < forDate) {
          prevDayCloseDaily = c.close;
          prevTradingDate = d;
        }
      }

      console.log('  Derived: prevDayCloseDaily =', prevDayCloseDaily, '| dayOpenDaily =', dayOpenDaily, '| prevTradingDate =', prevTradingDate);
      if (prevDayCloseDaily == null) console.log('  --> No previous trading day close (reason: no candle with parsed date < forDate)');
      if (dayOpenDaily == null && dayCandles.some((c) => candleDateStr(c) === forDate)) console.log('  --> Today open missing despite having a candle for forDate (check parsing)');
    } catch (err) {
      console.log('  Daily fetch error:', err.message || String(err));
    }
  }

  console.log('\nDone.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
