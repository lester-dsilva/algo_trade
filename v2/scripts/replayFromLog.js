/**
 * Replay a symbol's bars from live_scanner.log and run findEntry to see why entry was or wasn't triggered.
 * Usage: node v2/scripts/replayFromLog.js [logPath] [date] [symbol]
 * Default: data/live_scanner.log 2026-03-09 APOLLOPIPE
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadPrevDayOhlc } from '../lib/loadBacktestData.js';
import {
  findEntry,
  FIRST_HOUR_BAR_COUNT,
  GAP_UP_MAX_PCT,
  ENTRY_DEFAULTS,
  countBarsUpToMaxEntryTime,
  getDayVolRequiredCumulativeVolume,
} from '../lib/entryLogic.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

function parseLogForBars(logPath, dateStr, symbol) {
  const raw = fs.readFileSync(logPath, 'utf8');
  const lines = raw.split('\n');
  const bars = [];
  for (const line of lines) {
    const tab = line.indexOf('\t');
    if (tab === -1) continue;
    const event = line.slice(tab + 1).split('\t')[0];
    if (event !== 'bar') continue;
    let jsonStr = line.slice(tab + 1 + event.length + 1);
    if (!jsonStr.startsWith('{')) continue;
    try {
      const o = JSON.parse(jsonStr);
      if (o.symbol === symbol && (o.date === dateStr || String(o.date).startsWith(dateStr))) {
        bars.push({
          date: o.date,
          time: o.time || '',
          open: Number(o.open) || 0,
          high: Number(o.high) || 0,
          low: Number(o.low) || 0,
          close: Number(o.close) || 0,
          volume: Number(o.volume) || 0,
        });
      }
    } catch (_) {}
  }
  bars.sort((a, b) => (a.time || '').localeCompare(b.time || ''));
  return bars;
}

const logPath = process.argv[2] || path.join(ROOT, 'data', 'live_scanner.log');
const dateArg = process.argv[3] || '2026-03-09';
const symbol = process.argv[4] || 'APOLLOPIPE';

if (!fs.existsSync(logPath)) {
  console.error('Log file not found:', logPath);
  process.exit(1);
}

const bars = parseLogForBars(logPath, dateArg, symbol);
console.log('Replay from log:', logPath);
console.log('Symbol:', symbol, '| Date:', dateArg, '| Bars from log:', bars.length);

if (bars.length < 21) {
  console.error('Not enough bars (need at least 21). First bar time:', bars[0]?.time, 'Last:', bars[bars.length - 1]?.time);
  process.exit(1);
}

const prevDayOhlc = loadPrevDayOhlc(dateArg);
if (!prevDayOhlc) {
  console.error('No prev_day_ohlc for', dateArg);
  process.exit(1);
}
let sym = symbol;
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
const prevDay = { close: prev.close, volume: prev.volume || 0 };
console.log('Prev day: close=', prev.close, 'vol=', prev.volume);

const dayOpen = bars[0].open;
const firstHourBars = bars.slice(0, FIRST_HOUR_BAR_COUNT);
const firstHourHigh = Math.max(...firstHourBars.map((b) => b.high));
const movePct = dayOpen > 0 ? ((firstHourHigh - dayOpen) / dayOpen) * 100 : 0;
const gapPct = prev.close > 0 ? ((dayOpen - prev.close) / prev.close) * 100 : 0;
console.log('Day open (first bar):', dayOpen);
console.log('Gap% (open vs prev close):', gapPct.toFixed(2), gapPct > GAP_UP_MAX_PCT ? `FAIL (>${GAP_UP_MAX_PCT}%)` : 'ok');
console.log('First-hour high (60m,', FIRST_HOUR_BAR_COUNT, 'bars):', firstHourHigh, '| Move% from open:', movePct.toFixed(2), movePct < 4 ? 'FAIL (<4%)' : 'ok');
console.log('');

const result = findEntry(bars, prevDay, { debug: true });
if (result) {
  console.log('ENTRY WOULD HAVE TRIGGERED:', result);
  if (result.failedBars && result.failedBars.length) {
    console.log('\nEarlier bars that failed (first entry at', (result.time || '').slice(0, 5) + '):');
    const byTime = new Map();
    for (const { time, reason } of result.failedBars) {
      if (!byTime.has(time)) byTime.set(time, []);
      byTime.get(time).push(reason);
    }
    for (const [t, reasons] of byTime) {
      console.log('  ' + t + ': ' + [...new Set(reasons)].join('; '));
    }
  }
  process.exit(0);
}

console.log('findEntry returned NULL on live bars. Checking why each bar failed up to 12:21...\n');
const VOL_AVG_LOOKBACK = 5;
const MAX_ENTRY_TIME = ENTRY_DEFAULTS.maxEntryTime;
const totalBarsToMaxEntry = countBarsUpToMaxEntryTime(bars, MAX_ENTRY_TIME);
const PULLBACK_MAX_FROM_TOP_PCT = 4;
const PULLBACK_PCT = 2;
const CONSOLIDATION_RANGE_PCT = 1.5;
const BREAKOUT_STRENGTH_MIN_PCT = 0.4;
const BREAKOUT_VOL_MULT = 2;
const WICK_MAX_PCT = 0.35;
const MAX_SL_PCT = 2;
const MIN_SL_PCT = 0.8;
const STOP_BUFFER_PCT = 0.25;

if (gapPct > GAP_UP_MAX_PCT) {
  console.log('ROOT CAUSE: Gap', gapPct.toFixed(2), '% >', GAP_UP_MAX_PCT, '% — entry logic never runs.');
  process.exit(0);
}
if (movePct < 4) {
  console.log('ROOT CAUSE: Move from open', movePct.toFixed(2), '% < 4% in first 60m — entry logic never runs.');
  process.exit(0);
}

const targetTime = '12:21';
let foundBar = null;
for (let i = FIRST_HOUR_BAR_COUNT + VOL_AVG_LOOKBACK; i < bars.length; i++) {
  const bar = bars[i];
  const barTime = (bar.time || '').slice(0, 5);
  if (barTime > MAX_ENTRY_TIME) continue;
  const cumVol = bars.slice(0, i + 1).reduce((s, b) => s + (b.volume || 0), 0);
  const dayVolRequired = getDayVolRequiredCumulativeVolume(
    prevDay.volume,
    i,
    totalBarsToMaxEntry,
    ENTRY_DEFAULTS.dayVolMult,
    ENTRY_DEFAULTS.dayVolRamp,
  );
  if (prevDay.volume > 0 && cumVol < dayVolRequired) {
    if (barTime === targetTime) {
      const needMult = (dayVolRequired / prevDay.volume).toFixed(2);
      console.log(
        'BAR 12:21 FAILED: day vol',
        (cumVol / prevDay.volume).toFixed(1),
        'x <',
        needMult,
        'x ramp (need',
        Math.ceil(dayVolRequired),
        'cum vol, had',
        cumVol,
        ')',
      );
      foundBar = true;
    }
    continue;
  }
  const dayHighSoFar = Math.max(...bars.slice(0, i + 1).map((b) => b.high));
  let highBarIdx = i;
  for (let k = 0; k <= i; k++) {
    if (bars[k].high >= dayHighSoFar) {
      highBarIdx = k;
      break;
    }
  }
  let pullbackLow = dayHighSoFar;
  if (highBarIdx < i - 1) {
    for (let j = highBarIdx + 1; j < i; j++) {
      if (bars[j].low < pullbackLow) pullbackLow = bars[j].low;
    }
    const pullbackPct = dayHighSoFar > 0 ? ((dayHighSoFar - pullbackLow) / dayHighSoFar) * 100 : 0;
    if (pullbackPct > PULLBACK_MAX_FROM_TOP_PCT) {
      if (barTime === targetTime) {
        console.log('BAR 12:21 FAILED: pullback from high', pullbackPct.toFixed(1), '% > 4%');
        foundBar = true;
      }
      continue;
    }
  }
  let hasPullback = false;
  for (let j = FIRST_HOUR_BAR_COUNT; j < i; j++) {
    if (bars[j].low <= firstHourHigh * (1 - PULLBACK_PCT / 100)) {
      hasPullback = true;
      break;
    }
  }
  const recent5 = bars.slice(i - VOL_AVG_LOOKBACK, i);
  const recentHigh = Math.max(...recent5.map((b) => b.high));
  const recentLow = Math.min(...recent5.map((b) => b.low));
  const rangePct = recent5[0]?.open > 0 ? ((recentHigh - recentLow) / recent5[0].open) * 100 : 100;
  const hasConsol = rangePct <= CONSOLIDATION_RANGE_PCT;
  if (!hasPullback && !hasConsol) {
    if (barTime === targetTime) {
      console.log('BAR 12:21 FAILED: no pullback and no consolidation (recent 5 range', rangePct.toFixed(2), '%)');
      foundBar = true;
    }
    continue;
  }
  const breakoutAbovePct = recentHigh > 0 ? ((bar.close - recentHigh) / recentHigh) * 100 : 0;
  if (breakoutAbovePct < BREAKOUT_STRENGTH_MIN_PCT) {
    if (barTime === targetTime) {
      console.log('BAR 12:21 FAILED: breakout strength', breakoutAbovePct.toFixed(2), '% < 0.4% (close', bar.close, 'recentHigh', recentHigh, ')');
      foundBar = true;
    }
    continue;
  }
  if (bar.close <= bar.open) {
    if (barTime === targetTime) {
      console.log('BAR 12:21 FAILED: bearish candle');
      foundBar = true;
    }
    continue;
  }
  const range = bar.high - bar.low;
  if (range <= 0) continue;
  const bodyTop = Math.max(bar.open, bar.close);
  const bodyBottom = Math.min(bar.open, bar.close);
  const upperWick = bar.high - bodyTop;
  const lowerWick = bodyBottom - bar.low;
  if (upperWick / range > WICK_MAX_PCT || lowerWick / range > WICK_MAX_PCT) {
    if (barTime === targetTime) {
      console.log('BAR 12:21 FAILED: large wick (upper', (upperWick / range * 100).toFixed(1), '% lower', (lowerWick / range * 100).toFixed(1), '% of range)');
      foundBar = true;
    }
    continue;
  }
  const avgVol5 = recent5.reduce((s, b) => s + (b.volume || 0), 0) / VOL_AVG_LOOKBACK;
  if (avgVol5 > 0 && (bar.volume || 0) < BREAKOUT_VOL_MULT * avgVol5) {
    if (barTime === targetTime) {
      console.log('BAR 12:21 FAILED: vol', ((bar.volume || 0) / avgVol5).toFixed(1), 'x <', BREAKOUT_VOL_MULT, 'x (bar vol', bar.volume, 'avg5', avgVol5.toFixed(0), ')');
      foundBar = true;
    }
    continue;
  }
  const entry = bar.close;
  const stopRaw = bar.low * (1 - STOP_BUFFER_PCT / 100);
  const stop = Math.round(stopRaw * 100) / 100;
  const slPct = entry > 0 ? ((entry - stop) / entry) * 100 : 0;
  if (slPct > MAX_SL_PCT) {
    if (barTime === targetTime) {
      console.log('BAR 12:21 FAILED: SL', slPct.toFixed(2), '% > 2%');
      foundBar = true;
    }
    continue;
  }
  if (slPct < MIN_SL_PCT) {
    if (barTime === targetTime) {
      console.log('BAR 12:21 FAILED: SL', slPct.toFixed(2), '% < 0.8%');
      foundBar = true;
    }
    continue;
  }
  console.log('BAR', barTime, 'WOULD HAVE PASSED (no failure).');
  if (barTime === targetTime) foundBar = true;
}

if (!foundBar) {
  const has1221 = bars.some((b) => (b.time || '').slice(0, 5) === '12:21');
  if (!has1221) console.log('No 12:21 bar in log for', symbol, dateArg);
  else console.log('12:21 bar was not in the scanned range or logic bug.');
}
console.log('\nDone.');
