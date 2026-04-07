/**
 * v2 entry logic: 3m breakout after 4% move + pullback/consolidation.
 *
 * Conditions:
 * - 4% move up within first 60 min: bars 0..19 (20 × 3m from 09:15; see FIRST_HOUR_BAR_COUNT)
 * - Pullback or consolidation after that; pullback ≥1% from first-hour high (or consolidation = last 5 bars range ≤2%); pullback from day high not more than 4%
 * - Enter on breakout candle only; breakout candle must close above day's high (so far)
 * - No entry after 12:30
 * - Day volume: cumulative vs prev day — linear ramp to dayVolMult× by maxEntryTime (default 2.7× by 12:30), or flat if dayVolRamp is false
 * - Gap up <= 3% (day open vs prev close; GAP_UP_MAX_PCT)
 * - Entry candle: no large wicks (each wick <= 35% of range)
 * - Breakout candle volume >= 1.1x avg of previous 5 bars
 * - Fixed 1.5% SL below entry (always)
 * - Breakout close must be meaningfully above recent high (stronger breakout)
 */

/** First hour of session in 3m bars: 20 × 3m = 60 min from market open (09:15). */
export const FIRST_HOUR_BAR_COUNT = 20;

export const GAP_UP_MAX_PCT = 3;
const MOVE_UP_MIN_PCT = 4;
const PULLBACK_PCT = 1;       // low must have been at least 1% below first-hour high (allows mild pullbacks like 10:12–10:39)
const PULLBACK_MAX_FROM_TOP_PCT = 4; // do not take if pullback is more than 4% from day's top
const WICK_MAX_PCT = 0.35;    // each wick at most 35% of candle range
const VOL_AVG_LOOKBACK = 5;
const BREAKOUT_VOL_MULT = 1.1; // allow breakouts with ≥1.1x avg(prev 5) so consolidation-breakout bars like 10:42 qualify
const DAY_VOL_MULT = 2.7;     // terminal multiple vs prev day at maxEntryTime when dayVolRamp is true
/** When true (default), required cumulative vol vs prev day ramps linearly from bar 1 to dayVolMult× by maxEntryTime. */
const DAY_VOL_RAMP_DEFAULT = true;
const CONSOLIDATION_RANGE_PCT = 2;   // consolidation = range of last 5 bars <= 2% (includes 10:12–10:39 style)
export const MAX_ENTRY_TIME = '12:30';      // do not take trades after 12:30 (bar time <= 12:30 allowed)
const FIXED_SL_PCT = 1.5;             // fixed SL 1.5% below entry
const MAX_DAY_MOVE_PCT = 14;          // skip entries if day move from open > 14% at entry
const BREAKOUT_STRENGTH_MIN_PCT = 0.4; // close must be at least 0.4% above recent high
const TWO_BAR_COMBINED_UP_MAX_PCT = 9; // skip if previous+current bar up% sum is too stretched

/**
 * Count 3m bars in `bars` whose time is <= maxEntryTime (HH:MM). Used as ramp denominator.
 * @param {Array<{ time?: string }>} bars
 * @param {string} [maxEntryTime]
 * @returns {number} at least 1
 */
export function countBarsUpToMaxEntryTime(bars, maxEntryTime = MAX_ENTRY_TIME) {
  const t = (maxEntryTime || MAX_ENTRY_TIME).slice(0, 5);
  let n = 0;
  for (const b of bars) {
    if ((b.time || '').slice(0, 5) <= t) n++;
  }
  return Math.max(1, n);
}

/**
 * Required cumulative volume vs previous day at bar index `barIndexZeroBased` (ramp or flat).
 * @param {number} prevVol
 * @param {number} barIndexZeroBased
 * @param {number} totalBarsToMaxEntry
 * @param {number} dayVolMult
 * @param {boolean} [dayVolRamp]
 */
export function getDayVolRequiredCumulativeVolume(prevVol, barIndexZeroBased, totalBarsToMaxEntry, dayVolMult, dayVolRamp = DAY_VOL_RAMP_DEFAULT) {
  if (prevVol <= 0) return 0;
  const denom = Math.max(1, totalBarsToMaxEntry);
  const requiredMult = dayVolRamp !== false
    ? dayVolMult * Math.min(1, (barIndexZeroBased + 1) / denom)
    : dayVolMult;
  return requiredMult * prevVol;
}

/**
 * Default config keys that can be overridden via opts (e.g. when creating a baseline).
 */
export const ENTRY_DEFAULTS = {
  gapUpMaxPct: GAP_UP_MAX_PCT,
  moveUpMinPct: MOVE_UP_MIN_PCT,
  pullbackPct: PULLBACK_PCT,
  pullbackMaxFromTopPct: PULLBACK_MAX_FROM_TOP_PCT,
  wickMaxPct: WICK_MAX_PCT,
  consolidationRangePct: CONSOLIDATION_RANGE_PCT,
  maxEntryTime: MAX_ENTRY_TIME,
  fixedSlPct: FIXED_SL_PCT,
  maxDayMovePct: MAX_DAY_MOVE_PCT,
  breakoutStrengthMinPct: BREAKOUT_STRENGTH_MIN_PCT,
  dayVolMult: DAY_VOL_MULT,
  dayVolRamp: DAY_VOL_RAMP_DEFAULT,
  breakoutVolMult: BREAKOUT_VOL_MULT,
  twoBarCombinedUpMaxPct: TWO_BAR_COMBINED_UP_MAX_PCT,
};

/**
 * @param {Array<{ open, high, low, close, volume, time, date }>} bars - 3m bars for the day (sorted by time)
 * @param {{ close, volume }} prevDay - previous day close and volume
 * @param {{ debug?: boolean, ...ENTRY_DEFAULTS }} [opts] - debug and optional overrides for entry params
 * @returns {{ entry, stop, time, barIndex, date?, failedBars? } | null} - first valid entry or null
 */
export function findEntry(bars, prevDay, opts = {}) {
  const debug = !!opts.debug;
  const failedBars = debug ? [] : null;

  const gapUpMaxPct = opts.gapUpMaxPct ?? GAP_UP_MAX_PCT;
  const moveUpMinPct = opts.moveUpMinPct ?? MOVE_UP_MIN_PCT;
  const pullbackPct = opts.pullbackPct ?? PULLBACK_PCT;
  const pullbackMaxFromTopPct = opts.pullbackMaxFromTopPct ?? PULLBACK_MAX_FROM_TOP_PCT;
  const wickMaxPct = opts.wickMaxPct ?? WICK_MAX_PCT;
  const consolidationRangePct = opts.consolidationRangePct ?? CONSOLIDATION_RANGE_PCT;
  const maxEntryTime = opts.maxEntryTime ?? MAX_ENTRY_TIME;
  const fixedSlPct = opts.fixedSlPct ?? FIXED_SL_PCT;
  const maxDayMovePct = opts.maxDayMovePct ?? MAX_DAY_MOVE_PCT;
  const breakoutStrengthMinPct = opts.breakoutStrengthMinPct ?? BREAKOUT_STRENGTH_MIN_PCT;
  const dayVolMult = opts.dayVolMult ?? DAY_VOL_MULT;
  const dayVolRamp = opts.dayVolRamp !== undefined ? opts.dayVolRamp : DAY_VOL_RAMP_DEFAULT;
  const breakoutVolMult = opts.breakoutVolMult ?? BREAKOUT_VOL_MULT;
  const twoBarCombinedUpMaxPct = opts.twoBarCombinedUpMaxPct ?? TWO_BAR_COMBINED_UP_MAX_PCT;

  function skip(reason) {
    if (debug && bar) failedBars.push({ time: (bar.time || '').slice(0, 5), reason });
  }

  if (!bars || bars.length < FIRST_HOUR_BAR_COUNT + 1) return null;
  const dayOpen = bars[0].open;
  const prevClose = prevDay.close;
  const prevVol = prevDay.volume || 0;

  const gapPct = prevClose > 0 ? ((dayOpen - prevClose) / prevClose) * 100 : 0;
  if (gapPct > gapUpMaxPct) return null;

  const firstHourBars = bars.slice(0, FIRST_HOUR_BAR_COUNT);
  const firstHourHigh = Math.max(...firstHourBars.map((b) => b.high));
  const movePct = dayOpen > 0 ? ((firstHourHigh - dayOpen) / dayOpen) * 100 : 0;
  if (movePct < moveUpMinPct) return null;

  const totalBarsToMaxEntry = countBarsUpToMaxEntryTime(bars, maxEntryTime);

  let bar;
  for (let i = FIRST_HOUR_BAR_COUNT; i < bars.length; i++) {
    bar = bars[i];
    const barTime = (bar.time || '').slice(0, 5);
    if (barTime > maxEntryTime) { skip(`after ${maxEntryTime}`); continue; }

    const dayMovePct = dayOpen > 0 ? ((bar.close - dayOpen) / dayOpen) * 100 : 0;
    if (dayMovePct > maxDayMovePct) { skip(`day move ${dayMovePct.toFixed(1)}% > ${maxDayMovePct}%`); continue; }

    const cumVol = bars.slice(0, i + 1).reduce((s, b) => s + (b.volume || 0), 0);
    const dayVolRequired = getDayVolRequiredCumulativeVolume(prevVol, i, totalBarsToMaxEntry, dayVolMult, dayVolRamp);
    if (prevVol > 0 && cumVol < dayVolRequired) {
      const multNow = dayVolRequired / prevVol;
      skip(
        dayVolRamp
          ? `day vol ${(cumVol / prevVol).toFixed(1)}x < ${multNow.toFixed(2)}x (ramp to ${dayVolMult}x by ${maxEntryTime})`
          : `day vol ${(cumVol / prevVol).toFixed(1)}x < ${dayVolMult}x`,
      );
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
      const pullbackPctFromHigh = dayHighSoFar > 0 ? ((dayHighSoFar - pullbackLow) / dayHighSoFar) * 100 : 0;
      if (pullbackPctFromHigh > pullbackMaxFromTopPct) { skip(`pullback from high ${pullbackPctFromHigh.toFixed(1)}% > ${pullbackMaxFromTopPct}%`); continue; }
    }
    let hasPullback = false;
    for (let j = FIRST_HOUR_BAR_COUNT; j < i; j++) {
      if (bars[j].low <= firstHourHigh * (1 - pullbackPct / 100)) {
        hasPullback = true;
        break;
      }
    }

    const recent5 = bars.slice(i - VOL_AVG_LOOKBACK, i);
    const recentHigh = Math.max(...recent5.map((b) => b.high));
    const recentLow = Math.min(...recent5.map((b) => b.low));
    const rangePct = recent5[0]?.open > 0 ? ((recentHigh - recentLow) / recent5[0].open) * 100 : 100;
    const hasConsolidation = rangePct <= consolidationRangePct;
    if (!hasPullback && !hasConsolidation) { skip('no pullback and no consolidation'); continue; }

    const breakoutAbovePct = recentHigh > 0 ? ((bar.close - recentHigh) / recentHigh) * 100 : 0;
    if (breakoutAbovePct < breakoutStrengthMinPct) { skip(`breakout strength ${breakoutAbovePct.toFixed(2)}% < ${breakoutStrengthMinPct}%`); continue; }
    if (bar.close <= bar.open) { skip('bearish candle'); continue; }

    const dayHighBeforeBar = i > 0 ? Math.max(...bars.slice(0, i).map((b) => b.high)) : bar.high;
    if (bar.close <= dayHighBeforeBar) { skip(`close ${bar.close} not above day high ${dayHighBeforeBar}`); continue; }

    const range = bar.high - bar.low;
    if (range <= 0) { skip('zero range'); continue; }
    const bodyTop = Math.max(bar.open, bar.close);
    const bodyBottom = Math.min(bar.open, bar.close);
    const upperWick = bar.high - bodyTop;
    const lowerWick = bodyBottom - bar.low;
    if (upperWick / range > wickMaxPct || lowerWick / range > wickMaxPct) { skip('large wick'); continue; }

    const avgVol5 = recent5.reduce((s, b) => s + (b.volume || 0), 0) / VOL_AVG_LOOKBACK;
    if (avgVol5 > 0 && (bar.volume || 0) < breakoutVolMult * avgVol5) { skip(`vol ${((bar.volume || 0) / avgVol5).toFixed(1)}x < ${breakoutVolMult}x`); continue; }

    const prevBar = i > 0 ? bars[i - 1] : null;
    const prevUpPct = prevBar && prevBar.open > 0
      ? Math.max(0, ((prevBar.close - prevBar.open) / prevBar.open) * 100)
      : 0;
    const currUpPct = bar.open > 0
      ? Math.max(0, ((bar.close - bar.open) / bar.open) * 100)
      : 0;
    const twoBarCombinedUpPct = prevUpPct + currUpPct;
    if (twoBarCombinedUpPct > twoBarCombinedUpMaxPct) {
      skip(`2-bar up ${twoBarCombinedUpPct.toFixed(2)}% > ${twoBarCombinedUpMaxPct}%`);
      continue;
    }

    const entry = bar.close;
    const stop = Math.round(entry * (1 - fixedSlPct / 100) * 100) / 100;

    const result = {
      entry,
      stop,
      time: bar.time,
      barIndex: i,
      date: bar.date,
    };
    if (debug && failedBars.length) result.failedBars = failedBars;
    return result;
  }
  return null;
}
