/**
 * Quick filter-tuning script.
 * Reads existing 3m CSVs for all 6 backtest dates, runs findMomentumBreakouts
 * with the current .env settings, then shows how each additional filter
 * (MIN_VOLUME_RATIO, MAX_CONSOLIDATION_RANGE_PCT, earlier time cutoff)
 * would change trade counts and simulated PnL.
 *
 * Usage: node scripts/tuneFilters.js
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { findMomentumBreakouts } from '../lib/entryLogic.js';

const require = createRequire(import.meta.url);

const DATES = ['2026-02-18','2026-02-19','2026-02-20','2026-02-24','2026-02-25','2026-02-26'];
const PREV_DATES = {
  '2026-02-18': '2026-02-17',
  '2026-02-19': '2026-02-18',
  '2026-02-20': '2026-02-19',
  '2026-02-24': '2026-02-23',
  '2026-02-25': '2026-02-24',
  '2026-02-26': '2026-02-25',
};
const DATA_DIR = path.join(process.cwd(), 'data');
const BASELINES_DIR = path.join(DATA_DIR, 'baselines');
const POSITION_VALUE = 30000;
const FIRST_TARGET_PCT = 3;
const TRAIL_PCT = 1.5;
const EOD_BAR_TIME = '15:25';

function normalizeSymbol(sym) {
  return sym.replace(/[^A-Z0-9]/gi, '').toUpperCase();
}

function loadCSV(dateFolder, symbol) {
  const file = normalizeSymbol(symbol) + '.csv';
  const p = path.join(DATA_DIR, dateFolder, file);
  if (!fs.existsSync(p)) return [];
  const lines = fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '').trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const hdr = lines[0].split(',').map(s => s.trim().toLowerCase());
  return lines.slice(1).map(l => {
    const v = l.split(','); const r = {};
    hdr.forEach((h, i) => r[h] = (v[i] || '').trim());
    const o = parseFloat(r.open), h2 = parseFloat(r.high), lo = parseFloat(r.low), c = parseFloat(r.close), vol = parseFloat(r.volume);
    if (!r.date || !Number.isFinite(o) || o === 0) return null;
    return { date: r.date, time: r.time, open: o, high: h2, low: lo, close: c, volume: Number.isFinite(vol) ? vol : 0 };
  }).filter(Boolean);
}

function simulateTrade(signal, todayCandles) {
  const { entry, stop } = signal;
  const qty = Math.floor(POSITION_VALUE / entry);
  if (qty <= 0) return { exitReason: 'skip', exitPrice: entry, pnl: 0 };
  const firstTarget = entry * (1 + FIRST_TARGET_PCT / 100);
  const dayCandles = todayCandles.filter(c => c.date === signal.date).sort((a, b) => a.time.localeCompare(b.time));
  let idx = dayCandles.findIndex(c => c.time.slice(0, 5) === signal.time.slice(0, 5));
  if (idx < 0) idx = dayCandles.findIndex(c => c.time >= signal.time);
  if (idx < 0) return { exitReason: 'no_bar', exitPrice: entry, pnl: 0 };
  let hitTarget = false, hwm = 0;
  for (let i = idx + 1; i < dayCandles.length; i++) {
    const b = dayCandles[i];
    if (!hitTarget && b.low <= stop) return { exitReason: 'stop', exitPrice: stop, pnl: (stop - entry) * qty };
    if (!hitTarget && b.close >= firstTarget) {
      hitTarget = true;
      if (b.time >= '15:24') return { exitReason: 'eod', exitPrice: b.close, pnl: (b.close - entry) * qty };
      continue;
    }
    if (hitTarget) {
      hwm = Math.max(hwm, b.high);
      const trail = hwm * (1 - TRAIL_PCT / 100);
      if (b.close <= trail) return { exitReason: 'stop', exitPrice: trail, pnl: (trail - entry) * qty };
    }
    if (b.time >= '15:24') return { exitReason: 'eod', exitPrice: b.close, pnl: (b.close - entry) * qty };
  }
  const last = dayCandles[dayCandles.length - 1];
  return { exitReason: 'eod', exitPrice: last ? last.close : entry, pnl: last ? (last.close - entry) * qty : 0 };
}

// Load watchlist
const watchlistPath = path.join(process.cwd(), 'config', 'nse_mcap_above_900cr.csv');
const symbols = fs.readFileSync(watchlistPath, 'utf8').trim().split(/\r?\n/).map(l => l.split(',')[0].trim()).filter(Boolean).filter(s => s !== 'Symbol' && s !== 'symbol');

// Read env config (same as analyzePnl.js)
const maxGapUpPct = process.env.GAP_UP_THRESHOLD_PCT != null ? parseFloat(process.env.GAP_UP_THRESHOLD_PCT) : null;
const maxEntryCandleRangePct = process.env.MAX_ENTRY_CANDLE_RANGE_PCT != null ? parseFloat(process.env.MAX_ENTRY_CANDLE_RANGE_PCT) : 1.5;
const maxSlPct = process.env.MAX_SL_PCT != null ? parseFloat(process.env.MAX_SL_PCT) : 2;
const maxPullbackPct = process.env.MAX_PULLBACK_PCT != null ? parseFloat(process.env.MAX_PULLBACK_PCT) : 5;
const maxConsolidationRangePct = process.env.MAX_CONSOLIDATION_RANGE_PCT != null ? parseFloat(process.env.MAX_CONSOLIDATION_RANGE_PCT) : 2;
const maxEntryTime = process.env.MAX_ENTRY_TIME ?? null;

console.error('Config: maxSlPct='+maxSlPct+' maxEntryTime='+maxEntryTime+' maxConsRange='+maxConsolidationRangePct);
console.error('Scanning '+symbols.length+' symbols × '+DATES.length+' dates ...\n');

// Collect all signals across all dates
const allSignals = [];

for (const forDate of DATES) {
  const prevDate = PREV_DATES[forDate];
  let found = 0;
  for (const symbol of symbols) {
    const todayBars = loadCSV(forDate, symbol);
    const prevBars = prevDate ? loadCSV(prevDate, symbol) : [];
    if (todayBars.length < 5) continue;

    const byDate = prevBars.length > 0
      ? { [prevDate]: prevBars, [forDate]: todayBars }
      : { [forDate]: todayBars };
    const sortedDates = prevBars.length > 0 ? [prevDate, forDate] : [forDate];

    // prev day 3m volume sum (same as liveScanner/analyzePnl)
    const prevDayVol = prevBars.reduce((s, b) => s + (b.volume || 0), 0);

    const entries = findMomentumBreakouts(byDate, sortedDates, {
      sharpMovePct: 4,
      maxSlPct,
      getPrevDayVolume: () => prevDayVol > 0 ? prevDayVol : null,
      maxEntryTime,
      maxGapUpPct,
      maxEntryCandleRangePct,
      structureBars: 7,
      maxConsolidationRangePct,
      minBreakoutVolumeRatio: 2,
      stopBelowStructurePct: 0.2,
    });

    for (const e of entries) {
      if (e.date !== forDate) continue;
      const slPct = e.close > 0 ? (e.close - e.suggestedStop) / e.close * 100 : 0;
      const volRatio = e.consolidationAvgVolume > 0 ? e.entryBarVolume / e.consolidationAvgVolume : 0;
      const sim = simulateTrade(
        { symbol, date: e.date, time: e.time, entry: e.close, stop: e.suggestedStop, target: e.close * (1 + FIRST_TARGET_PCT / 100) },
        todayBars.concat(prevBars)
      );
      allSignals.push({
        symbol, date: forDate,
        time: (e.time || '').slice(0, 5),
        entry: e.close,
        stop: e.suggestedStop,
        slPct: +slPct.toFixed(2),
        volRatio: +volRatio.toFixed(2),
        consRange: +(e.consHigh && e.suggestedStop ? ((e.consHigh - e.suggestedStop) / e.consHigh * 100) : 0).toFixed(2),
        pnl: +sim.pnl.toFixed(2),
        exitReason: sim.exitReason,
      });
      found++;
    }
  }
  console.error(forDate+': '+found+' signals');
}

console.error('');

// Show baseline
function runFilter(signals, label, filterFn) {
  const kept = signals.filter(filterFn);
  const byDate = {};
  for (const d of DATES) byDate[d] = kept.filter(s => s.date === d).length;
  const maxDay = Math.max(...Object.values(byDate));
  const avgDay = kept.length / DATES.length;
  const net = kept.reduce((s, t) => s + t.pnl, 0);
  const w = kept.filter(t => t.pnl > 0).length;
  const wr = kept.length ? (w / kept.length * 100).toFixed(0) : 0;
  const perDay = DATES.map(d => byDate[d]).join('/');
  console.log(label.padEnd(50) + '| n='+String(kept.length).padStart(3)+' avg='+avgDay.toFixed(1)+' max='+maxDay+' WR='+wr+'% net=Rs'+net.toFixed(0)+' ['+perDay+']');
}

console.log('\n=== FILTER TUNING (per-day trade counts: '+DATES.map(d=>d.slice(5)).join('/')+') ===\n');
runFilter(allSignals, 'BASELINE (current .env)', () => true);
runFilter(allSignals, 'volRatio >= 1.5', s => s.volRatio >= 1.5);
runFilter(allSignals, 'volRatio >= 2.0', s => s.volRatio >= 2.0);
runFilter(allSignals, 'volRatio >= 2.5', s => s.volRatio >= 2.5);
runFilter(allSignals, 'volRatio >= 3.0', s => s.volRatio >= 3.0);
runFilter(allSignals, 'maxEntryTime 11:00', s => { const [h,m]=s.time.split(':').map(Number); return h*60+m < 11*60; });
runFilter(allSignals, 'maxEntryTime 10:57', s => { const [h,m]=s.time.split(':').map(Number); return h*60+m < 10*60+57; });
runFilter(allSignals, 'slPct < 1.25%', s => s.slPct < 1.25);
runFilter(allSignals, 'volRatio >= 1.5 + time < 11:00', s => s.volRatio >= 1.5 && s.time < '11:00');
runFilter(allSignals, 'volRatio >= 2.0 + time < 11:30', s => s.volRatio >= 2.0 && s.time < '11:30');
runFilter(allSignals, 'volRatio >= 1.5 + slPct < 1.5%', s => s.volRatio >= 1.5 && s.slPct < 1.5);
runFilter(allSignals, 'volRatio >= 2.0 + slPct < 1.5%', s => s.volRatio >= 2.0 && s.slPct < 1.5);
runFilter(allSignals, 'volRatio >= 1.5 + slPct < 1.25%', s => s.volRatio >= 1.5 && s.slPct < 1.25);
runFilter(allSignals, 'volRatio >= 2.0 + time < 11:00 + slPct < 1.5%', s => s.volRatio >= 2.0 && s.time < '11:00' && s.slPct < 1.5);

// Show volRatio distribution for all signals
console.log('\n=== VOLUME RATIO DISTRIBUTION ===');
const ratBuckets = [0, 0.5, 1, 1.5, 2, 2.5, 3, 5, 999];
for (let i = 0; i < ratBuckets.length - 1; i++) {
  const lo = ratBuckets[i], hi = ratBuckets[i+1];
  const g = allSignals.filter(s => s.volRatio >= lo && s.volRatio < hi);
  if (!g.length) continue;
  const w = g.filter(s => s.pnl > 0).length;
  const net = g.reduce((s, t) => s + t.pnl, 0);
  console.log('  volRatio '+lo+'-'+hi+': '+g.length+' trades | WR '+(w/g.length*100).toFixed(0)+'% | net Rs'+net.toFixed(0));
}

// Per-day breakdown for best filter (volRatio >= 2.0)
console.log('\n=== PER-DAY P&L (volRatio >= 2.0) ===');
const best = allSignals.filter(s => s.volRatio >= 2.0);
for (const d of DATES) {
  const day = best.filter(s => s.date === d);
  const net = day.reduce((s,t) => s+t.pnl, 0);
  const w = day.filter(t => t.pnl > 0).length;
  console.log('  '+d+': '+day.length+' trades | '+w+' wins | net Rs'+net.toFixed(0));
  day.sort((a,b)=>b.pnl-a.pnl).forEach(t => {
    const tag = t.pnl >= 0 ? '+' : '';
    console.log('    '+t.symbol.padEnd(14)+t.time+' SL:'+t.slPct+'% volR:'+t.volRatio+' '+tag+'Rs'+t.pnl.toFixed(0));
  });
}
console.log('  TOTAL: '+best.length+' trades | net Rs'+best.reduce((s,t)=>s+t.pnl,0).toFixed(0));

// Best combo: top signals per day by volRatio
console.log('\n=== TOP-N BY VOLUME RATIO PER DAY ===');
for (const N of [3, 4, 5]) {
  const kept = [];
  for (const d of DATES) {
    const day = allSignals.filter(s => s.date === d).sort((a, b) => b.volRatio - a.volRatio).slice(0, N);
    kept.push(...day);
  }
  const net = kept.reduce((s, t) => s + t.pnl, 0);
  const w = kept.filter(t => t.pnl > 0).length;
  console.log('  Top '+N+'/day by volRatio: '+kept.length+' trades | WR '+(w/kept.length*100).toFixed(0)+'% | net Rs'+net.toFixed(0));
}
