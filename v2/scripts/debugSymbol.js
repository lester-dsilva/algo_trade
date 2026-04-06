/**
 * Debug why a symbol did/didn't get a trade on a date. Run from repo root:
 *   node v2/scripts/debugSymbol.js 2026-03-05 LTFOODS
 */

import path from 'path';
import { fileURLToPath } from 'url';
import { loadPrevDayOhlc, load3mForSymbol } from '../lib/loadBacktestData.js';
import {
  findEntry,
  FIRST_HOUR_BAR_COUNT,
  GAP_UP_MAX_PCT,
  DAY_VOL_MULT,
  SESSION_LENGTH_MINUTES,
  elapsedSessionMinutesFromBarTime,
} from '../lib/entryLogic.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const dateArg = args.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a)) || '2026-03-05';
const symbol = args.find((a) => !/^\d{4}-\d{2}-\d{2}$/.test(a) && !a.startsWith('-')) || 'LTFOODS';

const prevDayOhlc = loadPrevDayOhlc(dateArg);
if (!prevDayOhlc) {
  console.error('No prev_day_ohlc for', dateArg);
  process.exit(1);
}

let sym = symbol.toUpperCase();
if (!prevDayOhlc.has(sym)) {
  for (const k of prevDayOhlc.keys()) {
    if (k.toUpperCase() === sym) {
      sym = k;
      break;
    }
  }
}
if (!prevDayOhlc.has(sym)) {
  console.error('Symbol', symbol, 'not in prev_day_ohlc');
  process.exit(1);
}

const prev = prevDayOhlc.get(sym);
const bars = load3mForSymbol(dateArg, sym);
if (!bars || bars.length < 25) {
  console.error('No or insufficient 3m data for', sym);
  process.exit(1);
}

const dayOpen = bars[0].open;
const firstHourBars = bars.slice(0, FIRST_HOUR_BAR_COUNT);
const firstHourHigh = Math.max(...firstHourBars.map((b) => b.high));
const movePct = dayOpen > 0 ? ((firstHourHigh - dayOpen) / dayOpen) * 100 : 0;
const gapPct = prev.close > 0 ? ((dayOpen - prev.close) / prev.close) * 100 : 0;

console.log('===', sym, dateArg, '===\n');
console.log('Prev day: close=', prev.close, 'vol=', prev.volume);
console.log('Day open:', dayOpen);
console.log('Gap% (open vs prev close):', gapPct.toFixed(2), gapPct > GAP_UP_MAX_PCT ? `FAIL (>${GAP_UP_MAX_PCT}%)` : 'ok');
console.log('First-hour high (60m,', FIRST_HOUR_BAR_COUNT, 'bars):', firstHourHigh, '| Move% from open:', movePct.toFixed(2), movePct < 4 ? 'FAIL (<4%)' : 'ok');
console.log('');

const withWhy = process.argv.includes('--why');
const result = findEntry(bars, prev, withWhy ? { debug: true } : {});
if (result) {
  console.log('ENTRY FOUND:', result);
  if (result.failedBars && result.failedBars.length) {
    console.log('\nWhy earlier bars did not qualify (first entry was at ' + (result.time || '').slice(0, 5) + '):');
    const byTime = new Map();
    for (const { time, reason } of result.failedBars) {
      const key = time;
      if (!byTime.has(key)) byTime.set(key, []);
      byTime.get(key).push(reason);
    }
    for (const [t, reasons] of byTime) {
      const uniq = [...new Set(reasons)];
      console.log('  ' + t + ': ' + uniq.join('; '));
    }
  }
  process.exit(0);
}

console.log('No entry. Scanning bars for first failure...\n');
const VOL_AVG_LOOKBACK = 5;
const MAX_ENTRY_TIME = '12:30';
const PULLBACK_PCT = 2;
const PULLBACK_MAX_FROM_TOP_PCT = 4;
const CONSOLIDATION_RANGE_PCT = 1.5;
const BREAKOUT_STRENGTH_MIN_PCT = 0.4;
const BREAKOUT_VOL_MULT = 1.5;
const WICK_MAX_PCT = 0.35;
const MAX_SL_PCT = 2;
const MIN_SL_PCT = 0.8;
const STOP_BUFFER_PCT = 0.25;

let foundCandidates = 0;
for (let i = FIRST_HOUR_BAR_COUNT + VOL_AVG_LOOKBACK; i < Math.min(bars.length, 80); i++) {
  const bar = bars[i];
  const barTime = (bar.time || '').slice(0, 5);
  if (barTime > MAX_ENTRY_TIME) continue;
  const cumVol = bars.slice(0, i + 1).reduce((s, b) => s + (b.volume || 0), 0);
  const elapsedM = elapsedSessionMinutesFromBarTime(bar.time);
  if (elapsedM == null) continue;
  const expectedPrev = (prev.volume || 0) * (elapsedM / SESSION_LENGTH_MINUTES);
  if (prev.volume > 0 && expectedPrev > 0 && cumVol < DAY_VOL_MULT * expectedPrev) continue;
  let hasPullback = false;
  let pullbackZoneLow = Infinity;
  for (let j = FIRST_HOUR_BAR_COUNT; j < i; j++) {
    if (bars[j].low < pullbackZoneLow) pullbackZoneLow = bars[j].low;
    if (bars[j].low <= firstHourHigh * (1 - PULLBACK_PCT / 100)) hasPullback = true;
  }
  if (pullbackZoneLow < firstHourHigh * (1 - PULLBACK_MAX_FROM_TOP_PCT / 100)) continue;
  const recent5 = bars.slice(i - VOL_AVG_LOOKBACK, i);
  const recentHigh = Math.max(...recent5.map((b) => b.high));
  const recentLow = Math.min(...recent5.map((b) => b.low));
  const rangePct = recent5[0]?.open > 0 ? ((recentHigh - recentLow) / recent5[0].open) * 100 : 100;
  const hasConsol = rangePct <= CONSOLIDATION_RANGE_PCT;
  if (!hasPullback && !hasConsol) continue;
  const breakoutAbovePct = recentHigh > 0 ? ((bar.close - recentHigh) / recentHigh) * 100 : 0;
  if (breakoutAbovePct < BREAKOUT_STRENGTH_MIN_PCT) {
    if (foundCandidates < 3) console.log(bar.time, 'breakout strength', breakoutAbovePct.toFixed(2), '% < 0.4%');
    foundCandidates++;
    continue;
  }
  if (bar.close <= bar.open) continue;
  const range = bar.high - bar.low;
  if (range <= 0) continue;
  const bodyTop = Math.max(bar.open, bar.close);
  const bodyBottom = Math.min(bar.open, bar.close);
  const upperWick = bar.high - bodyTop;
  const lowerWick = bodyBottom - bar.low;
  if (upperWick / range > WICK_MAX_PCT || lowerWick / range > WICK_MAX_PCT) continue;
  const avgVol5 = recent5.reduce((s, b) => s + (b.volume || 0), 0) / VOL_AVG_LOOKBACK;
  if (avgVol5 > 0 && (bar.volume || 0) < BREAKOUT_VOL_MULT * avgVol5) continue;
  const entry = bar.close;
  const stopRaw = recentLow * (1 - STOP_BUFFER_PCT / 100);
  const stop = Math.round(stopRaw * 100) / 100;
  const slPct = entry > 0 ? ((entry - stop) / entry) * 100 : 0;
  if (slPct > MAX_SL_PCT) {
    console.log(bar.time, 'SL% too wide:', slPct.toFixed(2));
    continue;
  }
  if (slPct < MIN_SL_PCT) {
    console.log(bar.time, 'SL% too tight:', slPct.toFixed(2), '< 0.8%');
    continue;
  }
  console.log(bar.time, 'WOULD ENTER but findEntry returned null - check logic');
}

if (foundCandidates === 0 && gapPct <= GAP_UP_MAX_PCT && movePct >= 4) {
  console.log('Possible causes: no bar had both pullback/consol + strong breakout; or all failed wick/volume/SL.');
}
console.log('\nDone.');
