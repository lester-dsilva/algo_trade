/**
 * Run v2 algo backtest for a date: load prev_day_ohlc + 3m, find entries, simulate exits, print PnL.
 *
 * Run from repo root:
 *   node v2/scripts/runBacktest.js 2026-02-18
 */

import path from 'path';
import { fileURLToPath } from 'url';
import {
  loadPrevDayOhlc,
  load3mForSymbol,
  hasBacktestData,
  list3mSymbols,
} from '../lib/loadBacktestData.js';
import { findEntry } from '../lib/entryLogic.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

// Exit params (match positionStore / analyzePnl)
const POSITION_VALUE = 50000;
const TOTAL_CAPITAL = 300000;   // ₹3 lakh — max concurrent capital
const MAX_TRADES_PER_DAY = Math.floor(TOTAL_CAPITAL / POSITION_VALUE); // 6 trades (50k each)
const FIRST_TARGET_PCT = 3;
const TRAIL_PCT = 1.5;
const EOD_BAR_TIME = '15:24';

function normalizeFilename(symbol) {
  return symbol.toLowerCase().replace(/&/g, '').replace(/\s/g, '');
}

/**
 * Resolve symbol from 3m filename (e.g. "reliance") to a key in prevDayOhlc (e.g. "RELIANCE").
 */
function resolveSymbol(prevDayOhlc, normalizedName) {
  for (const sym of prevDayOhlc.keys()) {
    if (normalizeFilename(sym) === normalizedName) return sym;
  }
  return null;
}

/**
 * Simulate one trade: initial SL, first target % then trail %, EOD at 15:24.
 * bars = full day 3m, entryBarIndex = bar index at which we entered (we enter at that bar's close).
 * Override firstTargetPct / trailPct via opts for comparison runs.
 */
function simulateTrade(bars, entryBarIndex, entry, stop, opts = {}) {
  const firstTargetPct = opts.firstTargetPct ?? FIRST_TARGET_PCT;
  const trailPct = opts.trailPct ?? TRAIL_PCT;
  const qty = Math.floor(POSITION_VALUE / entry);
  if (qty <= 0) return { exitReason: 'skip', exitPrice: entry, pnl: 0, qty: 0, exitBarIndex: entryBarIndex };

  const firstTarget = Math.round(entry * (1 + firstTargetPct / 100) * 100) / 100;
  let hitFirstTarget = false;
  let highWaterMark = 0;

  for (let i = entryBarIndex + 1; i < bars.length; i++) {
    const b = bars[i];
    const isEod = (b.time || '').startsWith(EOD_BAR_TIME) || b.time >= '15:24';

    if (isEod) {
      const exitPrice = b.close;
      return { exitReason: 'eod', exitPrice, pnl: Math.round((exitPrice - entry) * qty * 100) / 100, qty, exitBarIndex: i };
    }

    if (!hitFirstTarget) {
      if (b.close <= stop) {
        return { exitReason: 'stop', exitPrice: stop, pnl: Math.round((stop - entry) * qty * 100) / 100, qty, exitBarIndex: i };
      }
      if (b.close >= firstTarget) {
        hitFirstTarget = true;
        highWaterMark = Math.max(b.high, entry);
        continue;
      }
      continue;
    }

    highWaterMark = Math.max(highWaterMark, b.high);
    const trailLevel = Math.round(highWaterMark * (1 - trailPct / 100) * 100) / 100;
    if (b.close <= trailLevel) {
      return { exitReason: 'trail', exitPrice: trailLevel, pnl: Math.round((trailLevel - entry) * qty * 100) / 100, qty, exitBarIndex: i };
    }
  }

  const last = bars[bars.length - 1];
  const exitPrice = last ? last.close : entry;
  const exitBarIndex = last ? bars.length - 1 : entryBarIndex;
  return { exitReason: 'eod', exitPrice, pnl: last ? Math.round((exitPrice - entry) * qty * 100) / 100 : 0, qty, exitBarIndex };
}

/**
 * Run backtest for one date. Returns { backtestDate, results, totalPnl, trades, wins, losses } or null if no data.
 */
export function runBacktestForDate(backtestDate, opts = {}) {
  const { quiet = false, firstTargetPct, trailPct } = opts;
  const simOpts = {};
  if (firstTargetPct != null) simOpts.firstTargetPct = firstTargetPct;
  if (trailPct != null) simOpts.trailPct = trailPct;
  if (!hasBacktestData(backtestDate)) return null;

  const prevDayOhlc = loadPrevDayOhlc(backtestDate);
  if (!prevDayOhlc || prevDayOhlc.size === 0) return null;

  const threeMSymbols = list3mSymbols(backtestDate);
  const symbolsToTest = [];
  for (const norm of threeMSymbols) {
    const sym = resolveSymbol(prevDayOhlc, norm);
    if (sym) symbolsToTest.push(sym);
  }

  if (!quiet) console.error(`Backtest ${backtestDate} | ${symbolsToTest.length} symbols (with prev + 3m)\n`);

  const signals = [];
  for (let i = 0; i < symbolsToTest.length; i++) {
    const symbol = symbolsToTest[i];
    const bars = load3mForSymbol(backtestDate, symbol);
    if (!bars || bars.length < 20) continue;
    const prev = prevDayOhlc.get(symbol);
    if (!prev || prev.close <= 0) continue;

    const entryResult = findEntry(bars, { close: prev.close, volume: prev.volume });
    if (!entryResult) continue;

    signals.push({
      symbol,
      date: entryResult.date,
      time: entryResult.time,
      entry: entryResult.entry,
      stop: entryResult.stop,
      barIndex: entryResult.barIndex,
    });
    if (!quiet && (i + 1) % 200 === 0) console.error(`  scanned ${i + 1}/${symbolsToTest.length}...`);
  }

  if (!quiet) console.error(`Entries: ${signals.length}\n`);

  const results = [];
  for (const sig of signals) {
    const bars = load3mForSymbol(backtestDate, sig.symbol);
    const sim = simulateTrade(bars, sig.barIndex, sig.entry, sig.stop, simOpts);
    results.push({
      symbol: sig.symbol,
      time: sig.time,
      entry: sig.entry,
      stop: sig.stop,
      exitReason: sim.exitReason,
      exitPrice: sim.exitPrice,
      pnl: sim.pnl,
      qty: sim.qty,
      exitBarIndex: sim.exitBarIndex,
      barIndex: sig.barIndex,
    });
  }

  // Capital constraint: only first MAX_TRADES_PER_DAY by time (₹50k each, total ₹3L)
  const capped = results
    .slice()
    .sort((a, b) => (a.time || '').localeCompare(b.time || ''))
    .slice(0, MAX_TRADES_PER_DAY);

  const totalPnl = capped.reduce((s, r) => s + r.pnl, 0);
  const wins = capped.filter((r) => r.pnl > 0).length;
  const losses = capped.filter((r) => r.pnl <= 0).length;

  return { backtestDate, results: capped, totalPnl, trades: capped.length, wins, losses };
}

function main() {
  const args = process.argv.slice(2);
  const dateArg = args.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));
  if (!dateArg) {
    console.error('Usage: node v2/scripts/runBacktest.js YYYY-MM-DD');
    process.exit(1);
  }

  if (!hasBacktestData(dateArg)) {
    console.error(`No backtest data for ${dateArg}. Run: node v2/scripts/fetchBacktestData.js ${dateArg}`);
    process.exit(1);
  }

  const out = runBacktestForDate(dateArg, { quiet: false });
  if (!out) {
    console.error('No prev_day_ohlc.csv or empty.');
    process.exit(1);
  }

  const { backtestDate, results, totalPnl, trades, wins, losses } = out;
  console.log('--- v2 Backtest Results ---');
  console.log(`Date: ${backtestDate}`);
  console.log(`Trades: ${trades} | Wins: ${wins} | Losses: ${losses}`);
  console.log(`Total PnL: ${totalPnl.toFixed(2)}`);
  console.log('');
  console.log('Symbol       | Time  | Entry    | Exit     | ExitReason | PnL');
  console.log('-------------|-------|----------|----------|------------|--------');
  for (const r of results) {
    console.log(
      `${r.symbol.padEnd(12)} | ${(r.time || '').slice(0, 5)} | ${r.entry.toFixed(2).padStart(8)} | ${(r.exitPrice ?? 0).toFixed(2).padStart(8)} | ${(r.exitReason || '').padEnd(10)} | ${r.pnl.toFixed(2)}`
    );
  }
  console.log('');
  console.log(`Total PnL: ${totalPnl.toFixed(2)}`);
}

const isMain = process.argv[1] && path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);
if (isMain) main();
