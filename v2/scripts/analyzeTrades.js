/**
 * Analyze winning vs losing trades: trace price after entry, see why losers failed, suggest improvements.
 * Run from repo root: node v2/scripts/analyzeTrades.js 2026-02-18
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
const POSITION_VALUE = 50000;
const FIRST_TARGET_PCT = 3;
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

function simulateTrade(bars, entryBarIndex, entry, stop) {
  const qty = Math.floor(POSITION_VALUE / entry);
  if (qty <= 0) return null;
  const firstTarget = Math.round(entry * (1 + FIRST_TARGET_PCT / 100) * 100) / 100;
  let hitFirstTarget = false;
  let highWaterMark = 0;
  for (let i = entryBarIndex + 1; i < bars.length; i++) {
    const b = bars[i];
    const isEod = (b.time || '').startsWith(EOD_BAR_TIME) || b.time >= '15:24';
    if (isEod) {
      return { exitReason: 'eod', exitPrice: b.close, pnl: (b.close - entry) * qty, barExit: i };
    }
    if (!hitFirstTarget) {
      if (b.close <= stop) {
        return { exitReason: 'stop', exitPrice: stop, pnl: (stop - entry) * qty, barExit: i };
      }
      if (b.close >= firstTarget) {
        hitFirstTarget = true;
        highWaterMark = Math.max(b.high, entry);
        continue;
      }
      continue;
    }
    highWaterMark = Math.max(highWaterMark, b.high);
    const trailLevel = Math.round(highWaterMark * (1 - 1.5 / 100) * 100) / 100;
    if (b.close <= trailLevel) {
      return { exitReason: 'trail', exitPrice: trailLevel, pnl: (trailLevel - entry) * qty, barExit: i };
    }
  }
  const last = bars[bars.length - 1];
  const exitPrice = last?.close ?? entry;
  return { exitReason: 'eod', exitPrice, pnl: (exitPrice - entry) * qty, barExit: bars.length - 1 };
}

function analyzeTrade(symbol, bars, entryBarIndex, entry, stop) {
  const entryBar = bars[entryBarIndex];
  const recent5 = bars.slice(entryBarIndex - 5, entryBarIndex);
  const recentHigh = Math.max(...recent5.map((b) => b.high));
  const recentLow = Math.min(...recent5.map((b) => b.low));
  const consolRangePct = recent5[0]?.open > 0 ? ((recentHigh - recentLow) / recent5[0].open) * 100 : 0;
  const slPct = entry > 0 ? ((entry - stop) / entry) * 100 : 0;

  let barsToStop = null;
  let barsToTarget = null;
  let maxHighAfterEntry = entry;
  let minLowAfterEntry = entry;
  for (let i = entryBarIndex + 1; i < bars.length; i++) {
    const b = bars[i];
    if (b.high > maxHighAfterEntry) maxHighAfterEntry = b.high;
    if (b.low < minLowAfterEntry) minLowAfterEntry = b.low;
    if (b.close <= stop && barsToStop === null) barsToStop = i - entryBarIndex;
    if (b.close >= entry * 1.03 && barsToTarget === null) barsToTarget = i - entryBarIndex;
  }

  const firstTarget = entry * 1.03;
  const wouldHitTargetLater = maxHighAfterEntry >= firstTarget;
  const maxRisePct = entry > 0 ? ((maxHighAfterEntry - entry) / entry) * 100 : 0;
  const maxDrawdownPct = entry > 0 ? ((entry - minLowAfterEntry) / entry) * 100 : 0;

  return {
    symbol,
    entry,
    stop,
    entryTime: entryBar?.time,
    slPct,
    consolRangePct,
    barsToStop,
    barsToTarget,
    wouldHitTargetLater,
    maxRisePct,
    maxDrawdownPct,
    minLowAfterEntry,
    maxHighAfterEntry,
  };
}

function main() {
  const dateArg = process.argv.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a)) || '2026-02-18';
  if (!hasBacktestData(dateArg)) {
    console.error('No data for', dateArg);
    process.exit(1);
  }
  const prevDayOhlc = loadPrevDayOhlc(dateArg);
  const threeMSymbols = list3mSymbols(dateArg);
  const symbolsToTest = [];
  for (const norm of threeMSymbols) {
    const sym = resolveSymbol(prevDayOhlc, norm);
    if (sym) symbolsToTest.push(sym);
  }

  const signals = [];
  for (const symbol of symbolsToTest) {
    const bars = load3mForSymbol(dateArg, symbol);
    if (!bars || bars.length < 25) continue;
    const prev = prevDayOhlc.get(symbol);
    if (!prev?.close) continue;
    const entryResult = findEntry(bars, { close: prev.close, volume: prev.volume });
    if (!entryResult) continue;
    const sim = simulateTrade(bars, entryResult.barIndex, entryResult.entry, entryResult.stop);
    if (!sim) continue;
    const analysis = analyzeTrade(symbol, bars, entryResult.barIndex, entryResult.entry, entryResult.stop);
    signals.push({
      symbol,
      ...entryResult,
      ...sim,
      ...analysis,
    });
  }

  const winners = signals.filter((s) => s.pnl > 0);
  const losers = signals.filter((s) => s.pnl <= 0);

  console.log('\n=== LOSING TRADES ANALYSIS ===\n');
  for (const t of losers) {
    console.log(`--- ${t.symbol} (${t.entryTime}) ---`);
    console.log(`  Entry: ${t.entry.toFixed(2)}  Stop: ${t.stop.toFixed(2)}  SL%: ${t.slPct.toFixed(2)}%`);
    console.log(`  Consolidation range (5 bars): ${t.consolRangePct.toFixed(2)}%`);
    console.log(`  Exit: ${t.exitReason} at bar +${t.barExit}  PnL: ${t.pnl.toFixed(2)}`);
    console.log(`  Bars to stop hit: ${t.barsToStop ?? 'N/A'}`);
    console.log(`  After exit - Max high: ${t.maxHighAfterEntry.toFixed(2)} (${t.maxRisePct.toFixed(2)}% above entry)`);
    console.log(`  After exit - Min low: ${t.minLowAfterEntry.toFixed(2)} (${t.maxDrawdownPct.toFixed(2)}% drawdown)`);
    console.log(`  Would have hit 3% target later in day: ${t.wouldHitTargetLater ? 'YES' : 'NO'}`);
    console.log('');
  }

  console.log('\n=== WINNING TRADES (summary) ===\n');
  for (const t of winners) {
    console.log(`${t.symbol} (${t.entryTime}): SL%=${t.slPct.toFixed(2)}%  consol=${t.consolRangePct.toFixed(2)}%  exit=${t.exitReason}  PnL=${t.pnl.toFixed(2)}`);
  }

  const avgSlPctLosers = losers.length ? losers.reduce((s, t) => s + t.slPct, 0) / losers.length : 0;
  const avgSlPctWinners = winners.length ? winners.reduce((s, t) => s + t.slPct, 0) / winners.length : 0;
  const avgConsolLosers = losers.length ? losers.reduce((s, t) => s + t.consolRangePct, 0) / losers.length : 0;
  const avgConsolWinners = winners.length ? winners.reduce((s, t) => s + t.consolRangePct, 0) / winners.length : 0;
  const losersWouldWin = losers.filter((t) => t.wouldHitTargetLater).length;

  console.log('\n=== AGGREGATE ===');
  console.log(`Losers: avg SL% = ${avgSlPctLosers.toFixed(2)}%  avg consolidation range = ${avgConsolLosers.toFixed(2)}%`);
  console.log(`Winners: avg SL% = ${avgSlPctWinners.toFixed(2)}%  avg consolidation range = ${avgConsolWinners.toFixed(2)}%`);
  console.log(`Of ${losers.length} losers, ${losersWouldWin} would have hit 3% target later in the day`);
  console.log('');
}

main();
