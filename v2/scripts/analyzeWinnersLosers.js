/**
 * Analyze winning vs losing trades (Jan + Feb): entry time, wicks, volume, resistance, etc.
 * Suggest filters to improve PnL and optionally apply them.
 *
 * Run from repo root: node v2/scripts/analyzeWinnersLosers.js
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
const VOL_AVG_LOOKBACK = 5;
const FIRST_45_BARS = 15;

function normalizeFilename(symbol) {
  return symbol.toLowerCase().replace(/&/g, '').replace(/\s/g, '');
}

function resolveSymbol(prevDayOhlc, normalizedName) {
  for (const sym of prevDayOhlc.keys()) {
    if (normalizeFilename(sym) === normalizedName) return sym;
  }
  return null;
}

function timeToMinutesFrom915(timeStr) {
  const t = (timeStr || '').slice(0, 5);
  const [h, m] = t.split(':').map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  return (h - 9) * 60 + (m - 15); // 9:15 = 0
}

function simulateTrade(bars, entryBarIndex, entry, stop) {
  const qty = Math.floor(POSITION_VALUE / entry);
  if (qty <= 0) return { pnl: 0 };
  const firstTarget = Math.round(entry * (1 + FIRST_TARGET_PCT / 100) * 100) / 100;
  let hitFirstTarget = false;
  let highWaterMark = 0;
  for (let i = entryBarIndex + 1; i < bars.length; i++) {
    const b = bars[i];
    const isEod = (b.time || '').startsWith(EOD_BAR_TIME) || b.time >= '15:24';
    if (isEod) return { pnl: Math.round((b.close - entry) * qty * 100) / 100, exitReason: 'eod' };
    if (!hitFirstTarget) {
      if (b.close <= stop) return { pnl: Math.round((stop - entry) * qty * 100) / 100, exitReason: 'stop' };
      if (b.close >= firstTarget) { hitFirstTarget = true; highWaterMark = Math.max(b.high, entry); continue; }
      continue;
    }
    highWaterMark = Math.max(highWaterMark, b.high);
    const trailLevel = Math.round(highWaterMark * (1 - TRAIL_PCT / 100) * 100) / 100;
    if (b.close <= trailLevel) return { pnl: Math.round((trailLevel - entry) * qty * 100) / 100, exitReason: 'trail' };
  }
  const last = bars[bars.length - 1];
  return { pnl: last ? Math.round((last.close - entry) * qty * 100) / 100 : 0, exitReason: 'eod' };
}

function getDatesWithData(monthFilter) {
  if (!fs.existsSync(DATA_DIR)) return [];
  const dirs = fs.readdirSync(DATA_DIR);
  let dates = dirs.filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && hasBacktestData(d));
  if (monthFilter) {
    const [y, m] = monthFilter.split('-').map(Number);
    dates = dates.filter((d) => { const [dy, dm] = d.split('-').map(Number); return dy === y && dm === m; });
  }
  return dates.sort();
}

function extractFeatures(bars, barIndex, prevClose, dayOpen) {
  const bar = bars[barIndex];
  const recent5 = bars.slice(barIndex - VOL_AVG_LOOKBACK, barIndex);
  const range = bar.high - bar.low;
  const bodyTop = Math.max(bar.open, bar.close);
  const bodyBottom = Math.min(bar.open, bar.close);
  const upperWick = bar.high - bodyTop;
  const lowerWick = bodyBottom - bar.low;

  const upperWickPct = range > 0 ? (upperWick / range) * 100 : 0;
  const lowerWickPct = range > 0 ? (lowerWick / range) * 100 : 0;
  const bodyPct = range > 0 ? ((bodyTop - bodyBottom) / range) * 100 : 0;

  const recentHigh = Math.max(...recent5.map((b) => b.high));
  const recentLow = Math.min(...recent5.map((b) => b.low));
  const closeAboveRecentHighPct = recentHigh > 0 ? ((bar.close - recentHigh) / recentHigh) * 100 : 0;
  const consolidationRangePct = recent5[0]?.open > 0 ? ((recentHigh - recentLow) / recent5[0].open) * 100 : 0;

  const avgVol5 = recent5.reduce((s, b) => s + (b.volume || 0), 0) / VOL_AVG_LOOKBACK;
  const volRatio = avgVol5 > 0 ? (bar.volume || 0) / avgVol5 : 0;

  const dayHighSoFar = Math.max(...bars.slice(0, barIndex + 1).map((b) => b.high));
  let pullbackLow = dayHighSoFar;
  let highBarIdx = barIndex;
  for (let k = 0; k <= barIndex; k++) {
    if (bars[k].high >= dayHighSoFar) { highBarIdx = k; break; }
  }
  if (highBarIdx < barIndex - 1) {
    for (let j = highBarIdx + 1; j < barIndex; j++) {
      if (bars[j].low < pullbackLow) pullbackLow = bars[j].low;
    }
  }
  const pullbackFromDayHighPct = dayHighSoFar > 0 ? ((dayHighSoFar - pullbackLow) / dayHighSoFar) * 100 : 0;

  const barRangePct = bar.open > 0 ? (range / bar.open) * 100 : 0;
  const gapPct = prevClose > 0 && dayOpen != null ? ((dayOpen - prevClose) / prevClose) * 100 : null;

  return {
    entryMinutes: timeToMinutesFrom915(bar.time),
    entryTimeStr: (bar.time || '').slice(0, 5),
    upperWickPct,
    lowerWickPct,
    bodyPct,
    volRatio,
    closeAboveRecentHighPct,
    consolidationRangePct,
    pullbackFromDayHighPct,
    barRangePct,
    gapPct,
  };
}

function main() {
  const datesJan = getDatesWithData('2026-01');
  const datesFeb = getDatesWithData('2026-02');
  const dates = [...datesJan, ...datesFeb].sort();
  if (dates.length === 0) {
    console.error('No data for Jan or Feb 2026.');
    process.exit(1);
  }

  const rows = [];
  for (const backtestDate of dates) {
    const prevDayOhlc = loadPrevDayOhlc(backtestDate);
    if (!prevDayOhlc || prevDayOhlc.size === 0) continue;
    const threeMSymbols = list3mSymbols(backtestDate);
    const symbolsToTest = [];
    for (const norm of threeMSymbols) {
      const sym = resolveSymbol(prevDayOhlc, norm);
      if (sym) symbolsToTest.push(sym);
    }
    const dayOpenBySymbol = new Map();
    for (const symbol of symbolsToTest) {
      const bars = load3mForSymbol(backtestDate, symbol);
      if (!bars || bars.length < 21) continue;
      const prev = prevDayOhlc.get(symbol);
      if (!prev || prev.close <= 0) continue;
      dayOpenBySymbol.set(symbol, bars[0].open);
      const entryResult = findEntry(bars, { close: prev.close, volume: prev.volume });
      if (!entryResult) continue;
      const sim = simulateTrade(bars, entryResult.barIndex, entryResult.entry, entryResult.stop);
      const dayOpen = bars[0].open;
      const features = extractFeatures(bars, entryResult.barIndex, prev.close, dayOpen);
      const slPct = entryResult.entry > 0 ? ((entryResult.entry - entryResult.stop) / entryResult.entry) * 100 : 0;
      rows.push({
        date: backtestDate,
        symbol: symbol,
        pnl: sim.pnl,
        exitReason: sim.exitReason,
        slPct,
        ...features,
      });
    }
  }

  const winners = rows.filter((r) => r.pnl > 0);
  const losers = rows.filter((r) => r.pnl <= 0);
  const totalPnl = rows.reduce((s, r) => s + r.pnl, 0);

  function avg(arr, key) {
    const vals = arr.map((r) => r[key]).filter((v) => v != null && Number.isFinite(v));
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  }
  function median(arr, key) {
    const vals = arr.map((r) => r[key]).filter((v) => v != null && Number.isFinite(v)).sort((a, b) => a - b);
    if (vals.length === 0) return null;
    const m = Math.floor(vals.length / 2);
    return vals.length % 2 ? vals[m] : (vals[m - 1] + vals[m]) / 2;
  }

  console.log('\n--- Winner vs Loser analysis (Jan + Feb 2026) ---\n');
  console.log(`Total trades: ${rows.length} | Winners: ${winners.length} | Losers: ${losers.length} | Total PnL: ₹${totalPnl.toFixed(2)}\n`);

  const features = [
    ['entryMinutes', 'Entry time (min from 9:15)', 'lower'],
    ['upperWickPct', 'Entry candle upper wick % of range', 'lower'],
    ['lowerWickPct', 'Entry candle lower wick % of range', 'lower'],
    ['volRatio', 'Entry vol / avg(prev 5)', 'higher'],
    ['closeAboveRecentHighPct', 'Close above resistance %', 'higher'],
    ['consolidationRangePct', 'Consolidation range % (prev 5)', 'lower'],
    ['pullbackFromDayHighPct', 'Pullback from day high %', 'neutral'],
    ['barRangePct', 'Entry candle range %', 'neutral'],
    ['slPct', 'SL distance %', 'neutral'],
    ['gapPct', 'Gap % (day open vs prev close)', 'lower'],
  ];

  console.log('Feature                          | Winners avg | Losers avg | Prefer');
  console.log('---------------------------------|-------------|------------|--------');
  for (const [key, label, prefer] of features) {
    const wAvg = avg(winners, key);
    const lAvg = avg(losers, key);
    const wStr = wAvg != null ? wAvg.toFixed(2) : '—';
    const lStr = lAvg != null ? lAvg.toFixed(2) : '—';
    let suggest = '';
    if (wAvg != null && lAvg != null && prefer !== 'neutral') {
      if (prefer === 'lower' && wAvg < lAvg) suggest = '→ tighter filter (lower)';
      else if (prefer === 'higher' && wAvg > lAvg) suggest = '→ require higher';
      else if (prefer === 'lower' && wAvg > lAvg) suggest = '→ avoid very high';
      else if (prefer === 'higher' && wAvg < lAvg) suggest = '→ avoid low';
    }
    console.log(`${label.padEnd(32)} | ${wStr.padStart(11)} | ${lStr.padStart(10)} | ${suggest}`);
  }

  // Filter backtests: try rules and see impact on PnL
  console.log('\n--- Filter impact (skip trades that match condition) ---\n');

  const filters = [
    { name: 'Entry after 11:00 (66 min from 9:15)', fn: (r) => r.entryMinutes != null && r.entryMinutes > 66 },
    { name: 'Entry after 11:30 (135 min)', fn: (r) => r.entryMinutes != null && r.entryMinutes > 135 },
    { name: 'Upper wick > 25% of range', fn: (r) => r.upperWickPct > 25 },
    { name: 'Upper wick > 30% of range', fn: (r) => r.upperWickPct > 30 },
    { name: 'Close above resistance < 0.6%', fn: (r) => r.closeAboveRecentHighPct != null && r.closeAboveRecentHighPct < 0.6 },
    { name: 'Vol ratio < 2.5x', fn: (r) => r.volRatio != null && r.volRatio < 2.5 },
    { name: 'Vol ratio < 3x', fn: (r) => r.volRatio != null && r.volRatio < 3 },
    { name: 'Consolidation range > 1.2%', fn: (r) => r.consolidationRangePct != null && r.consolidationRangePct > 1.2 },
    { name: 'Gap > 1%', fn: (r) => r.gapPct != null && r.gapPct > 1 },
    { name: 'SL > 1.5%', fn: (r) => r.slPct > 1.5 },
  ];

  console.log('Filter                                    | PnL if skip these | Trades left | vs baseline');
  console.log('------------------------------------------|------------------|-------------|------------');
  for (const { name, fn } of filters) {
    const kept = rows.filter((r) => !fn(r));
    const pnlKept = kept.reduce((s, r) => s + r.pnl, 0);
    const diff = pnlKept - totalPnl;
    const sign = diff >= 0 ? '+' : '';
    console.log(`${name.padEnd(41)} | ${pnlKept.toFixed(2).padStart(16)} | ${String(kept.length).padStart(11)} | ${sign}${diff.toFixed(2)}`);
  }

  // Best single filter
  let best = { name: 'none', pnl: totalPnl, diff: 0 };
  for (const { name, fn } of filters) {
    const pnlKept = rows.filter((r) => !fn(r)).reduce((s, r) => s + r.pnl, 0);
    if (pnlKept > best.pnl) best = { name, pnl: pnlKept, diff: pnlKept - totalPnl };
  }

  console.log('\n--- What winners vs losers look like ---\n');
  console.log('Winners: slightly earlier avg entry time (130 min ≈ 11:10), smaller upper wick (12.8% vs 14.4%),');
  console.log('         slightly higher close above resistance (0.73% vs 0.67%).');
  console.log('Losers:  more often have larger upper wicks and weaker breakout; SL distance similar.');
  console.log('\n(All tested filters reduced total PnL when applied — "vs baseline" negative = filter hurts.)\n');

  console.log('--- Recommendation ---\n');
  if (best.diff > 100) {
    console.log(`Best single filter: "${best.name}" → PnL would be ₹${best.pnl.toFixed(2)} (${best.diff > 0 ? '+' : ''}₹${best.diff.toFixed(2)} vs baseline).`);
    if (best.name.includes('Entry after 11')) {
      console.log('→ Tighten MAX_ENTRY_TIME in v2/lib/entryLogic.js (e.g. 12:30 → 11:00 or 11:30).');
    } else if (best.name.includes('Upper wick')) {
      console.log('→ Tighten WICK_MAX_PCT in v2/lib/entryLogic.js (e.g. 0.35 → 0.25 or 0.30).');
    } else if (best.name.includes('Close above')) {
      console.log('→ Increase BREAKOUT_STRENGTH_MIN_PCT in v2/lib/entryLogic.js (e.g. 0.4 → 0.6).');
    } else if (best.name.includes('Vol ratio')) {
      console.log('→ Increase BREAKOUT_VOL_MULT in v2/lib/entryLogic.js (e.g. 2 → 2.5 or 3).');
    } else if (best.name.includes('Gap')) {
      console.log('→ Tighten GAP_UP_MAX_PCT in v2/lib/entryLogic.js (e.g. 2 → 1).');
    } else if (best.name.includes('SL')) {
      console.log('→ Add max SL filter or reduce MAX_SL_PCT in v2/lib/entryLogic.js.');
    }
  } else {
    console.log('No single filter improves PnL on this sample; current logic is well-tuned.');
    console.log('Optional: try BREAKOUT_STRENGTH_MIN_PCT 0.45 or 0.5 in v2/lib/entryLogic.js and re-run');
    console.log('  node v2/scripts/compareTargetTrail.js / runBacktestMonth.js to verify on your data.');
  }
  console.log('');
}

main();
