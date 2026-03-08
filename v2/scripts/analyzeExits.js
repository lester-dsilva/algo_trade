/**
 * Analyze winning (and all) trades: track max favorable excursion vs actual exit.
 * Use to see if target/trail can be optimized for more returns.
 *
 * Run from repo root: node v2/scripts/analyzeExits.js [YYYY-MM]
 */

import fs from 'fs';
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
const DATA_DIR = path.join(ROOT, 'v2', 'data');

const POSITION_VALUE = 50000;
const FIRST_TARGET_PCT = 3;
const TRAIL_PCT = 1.5;
const EOD_BAR_TIME = '15:24';

function normalizeFilename(symbol) {
  return symbol.toLowerCase().replace(/&/g, '').replace(/\s/g, '');
}

function resolveSymbol(prevDayOhlc, normalizedName) {
  for (const sym of prevDayOhlc.keys()) {
    if (normalizeFilename(sym) === normalizedName) return sym;
  }
  return null;
}

/**
 * Simulate trade with same logic as runBacktest; also return maxHighPct (max favorable % from entry).
 */
function simulateTradeWithMaxHigh(bars, entryBarIndex, entry, stop) {
  const qty = Math.floor(POSITION_VALUE / entry);
  if (qty <= 0) return { exitReason: 'skip', exitPrice: entry, pnl: 0, qty: 0, maxHighPct: 0 };

  const firstTarget = Math.round(entry * (1 + FIRST_TARGET_PCT / 100) * 100) / 100;
  let hitFirstTarget = false;
  let highWaterMark = 0;
  let maxHigh = entry;

  for (let i = entryBarIndex + 1; i < bars.length; i++) {
    const b = bars[i];
    if (b.high > maxHigh) maxHigh = b.high;
    const isEod = (b.time || '').startsWith(EOD_BAR_TIME) || b.time >= '15:24';

    if (isEod) {
      const exitPrice = b.close;
      const pnl = Math.round((exitPrice - entry) * qty * 100) / 100;
      const maxHighPct = entry > 0 ? ((maxHigh - entry) / entry) * 100 : 0;
      return { exitReason: 'eod', exitPrice, pnl, qty, maxHighPct };
    }

    if (!hitFirstTarget) {
      if (b.close <= stop) {
        const pnl = Math.round((stop - entry) * qty * 100) / 100;
        const maxHighPct = entry > 0 ? ((maxHigh - entry) / entry) * 100 : 0;
        return { exitReason: 'stop', exitPrice: stop, pnl, qty, maxHighPct };
      }
      if (b.close >= firstTarget) {
        hitFirstTarget = true;
        highWaterMark = Math.max(b.high, entry);
        continue;
      }
      continue;
    }

    highWaterMark = Math.max(highWaterMark, b.high);
    const trailLevel = Math.round(highWaterMark * (1 - TRAIL_PCT / 100) * 100) / 100;
    if (b.close <= trailLevel) {
      const exitPrice = trailLevel;
      const pnl = Math.round((exitPrice - entry) * qty * 100) / 100;
      const maxHighPct = entry > 0 ? ((maxHigh - entry) / entry) * 100 : 0;
      return { exitReason: 'trail', exitPrice, pnl, qty, maxHighPct };
    }
  }

  const last = bars[bars.length - 1];
  const exitPrice = last ? last.close : entry;
  const pnl = last ? Math.round((exitPrice - entry) * qty * 100) / 100 : 0;
  const maxHighPct = entry > 0 ? ((maxHigh - entry) / entry) * 100 : 0;
  return { exitReason: 'eod', exitPrice, pnl, qty, maxHighPct };
}

function getDatesWithData(monthFilter) {
  if (!fs.existsSync(DATA_DIR)) return [];
  const dirs = fs.readdirSync(DATA_DIR);
  let dates = dirs.filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && hasBacktestData(d));
  if (monthFilter) {
    const [y, m] = monthFilter.split('-').map(Number);
    dates = dates.filter((d) => {
      const [dy, dm] = d.split('-').map(Number);
      return dy === y && dm === m;
    });
  }
  return dates.sort();
}

function main() {
  const args = process.argv.slice(2);
  const monthArg = args.find((a) => /^\d{4}-\d{2}$/.test(a));

  const dates = getDatesWithData(monthArg || null);
  if (dates.length === 0) {
    console.error(monthArg ? `No data for ${monthArg}.` : 'No backtest data in v2/data.');
    process.exit(1);
  }

  const allTrades = [];
  for (const backtestDate of dates) {
    const prevDayOhlc = loadPrevDayOhlc(backtestDate);
    if (!prevDayOhlc || prevDayOhlc.size === 0) continue;
    const threeMSymbols = list3mSymbols(backtestDate);
    const symbolsToTest = [];
    for (const norm of threeMSymbols) {
      const sym = resolveSymbol(prevDayOhlc, norm);
      if (sym) symbolsToTest.push(sym);
    }
    for (const symbol of symbolsToTest) {
      const bars = load3mForSymbol(backtestDate, symbol);
      if (!bars || bars.length < 20) continue;
      const prev = prevDayOhlc.get(symbol);
      if (!prev || prev.close <= 0) continue;
      const entryResult = findEntry(bars, { close: prev.close, volume: prev.volume });
      if (!entryResult) continue;
      const sim = simulateTradeWithMaxHigh(bars, entryResult.barIndex, entryResult.entry, entryResult.stop);
      const actualPct = entryResult.entry > 0 ? ((sim.exitPrice - entryResult.entry) / entryResult.entry) * 100 : 0;
      const leftOnTable = sim.maxHighPct - actualPct;
      allTrades.push({
        date: backtestDate,
        symbol,
        exitReason: sim.exitReason,
        actualPct,
        maxHighPct: sim.maxHighPct,
        leftOnTable,
        pnl: sim.pnl,
      });
    }
  }

  const winners = allTrades.filter((t) => t.pnl > 0);
  const byReason = (arr) => {
    const trail = arr.filter((t) => t.exitReason === 'trail');
    const eod = arr.filter((t) => t.exitReason === 'eod');
    const stop = arr.filter((t) => t.exitReason === 'stop');
    return { trail, eod, stop };
  };

  console.log('\n--- Exit analysis (current: 3% target, 1.5% trail, EOD 15:24) ---\n');
  console.log(`Total trades: ${allTrades.length} | Winners: ${winners.length} | Losers: ${allTrades.length - winners.length}\n`);

  console.log('--- WINNING TRADES ---');
  const wTrail = byReason(winners).trail;
  const wEod = byReason(winners).eod;
  const wStop = byReason(winners).stop;

  function stats(label, list) {
    if (list.length === 0) {
      console.log(`${label}: n=0\n`);
      return;
    }
    const avgActual = list.reduce((s, t) => s + t.actualPct, 0) / list.length;
    const avgMax = list.reduce((s, t) => s + t.maxHighPct, 0) / list.length;
    const avgLeft = list.reduce((s, t) => s + t.leftOnTable, 0) / list.length;
    const totalPnl = list.reduce((s, t) => s + t.pnl, 0);
    console.log(`${label}: n=${list.length} | avg actual return ${avgActual.toFixed(2)}% | avg max high ${avgMax.toFixed(2)}% | avg left on table ${avgLeft.toFixed(2)}% | total PnL ${totalPnl.toFixed(0)}`);
    console.log('');
  }

  stats('  Trail exits (hit 3% then trailed out)', wTrail);
  stats('  EOD exits', wEod);
  stats('  Stop exits (losers; for reference)', byReason(allTrades.filter((t) => t.pnl <= 0)).stop);

  const allWinnersLeft = winners.reduce((s, t) => s + t.leftOnTable, 0) / (winners.length || 1);
  const trailWinnersLeft = wTrail.length ? wTrail.reduce((s, t) => s + t.leftOnTable, 0) / wTrail.length : 0;
  const eodWinnersLeft = wEod.length ? wEod.reduce((s, t) => s + t.leftOnTable, 0) / wEod.length : 0;

  console.log('--- INTERPRETATION ---');
  console.log(`Winners on average left ${allWinnersLeft.toFixed(2)}% on the table (price went higher than our exit).`);
  if (wTrail.length > 0) {
    console.log(`Trail winners: avg ${trailWinnersLeft.toFixed(2)}% left on table — if high, consider higher first target (e.g. 4%) or looser trail (e.g. 1.2%).`);
  }
  if (wEod.length > 0) {
    console.log(`EOD winners: avg ${eodWinnersLeft.toFixed(2)}% left on table — if high, price ran into close; could try trailing earlier (e.g. 2.5% target) to lock more.`);
  }

  console.log('\n--- RECOMMENDATION ---');
  if (trailWinnersLeft > 1.5 && wTrail.length >= 3) {
    console.log('Trail exits are giving back a lot. Try: FIRST_TARGET 4%, TRAIL 1.2% (let winners run more, trail looser).');
  } else if (trailWinnersLeft > 0.8) {
    console.log('Modest room to improve: consider FIRST_TARGET 3.5% or TRAIL 1.2%.');
  } else {
    console.log('Current 3% / 1.5% trail is capturing most of the move; only minor tweaks (e.g. 3.5% target) if any.');
  }
  console.log('');
}

main();
