/**
 * v2 entry logic: 3m breakout after 4% move + pullback/consolidation.
 *
 * Conditions:
 * - 4% move up within first 60 min (by ~10:15)
 * - Pullback or consolidation after that; pullback = day high to lowest low after that high (before entry); not more than 4%
 * - Enter on breakout candle (close > recent high)
 * - No entry after 12:30
 * - Day volume at entry >= 3x prev day volume
 * - Gap up <= 2% (day open vs prev close)
 * - Entry candle: no large wicks (each wick <= 35% of range)
 * - Breakout candle volume >= 1.5x avg of previous 5 bars
 * - SL below breakout candle low (with buffer); skip if SL distance > 2% or < min from entry
 * - Breakout close must be meaningfully above recent high (stronger breakout)
 * - Minimum SL distance from entry (avoid ultra-tight stops)
 */

// First 60 min ≈ 9:15 to 10:15 = 20 bars (index 0..19)
const FIRST_45_BARS = 20;
const GAP_UP_MAX_PCT = 2;
const MOVE_UP_MIN_PCT = 4;
const PULLBACK_PCT = 2;       // low must have been at least 2% below high45
const PULLBACK_MAX_FROM_TOP_PCT = 4; // do not take if pullback is more than 4% from day's top
const WICK_MAX_PCT = 0.35;    // each wick at most 35% of candle range
const VOL_AVG_LOOKBACK = 5;
const BREAKOUT_VOL_MULT = 2;
const DAY_VOL_MULT = 2.7;     // day volume >= 2.7x prev day
const CONSOLIDATION_RANGE_PCT = 1.5; // alternative: consolidation = range of last 5 bars < 1.5%
const MAX_ENTRY_TIME = '12:30';      // do not take trades after 12:30 (bar time <= 12:30 allowed)
const MAX_SL_PCT = 2;                // do not take if SL is more than 2% from entry
const MIN_SL_PCT = 0.8;              // do not take if SL is less than 0.8% from entry (avoid ultra-tight)
const STOP_BUFFER_PCT = 0.25;         // place stop 0.25% below breakout candle low
const BREAKOUT_STRENGTH_MIN_PCT = 0.4; // close must be at least 0.4% above recent high

/**
 * @param {Array<{ open, high, low, close, volume, time, date }>} bars - 3m bars for the day (sorted by time)
 * @param {{ close, volume }} prevDay - previous day close and volume
 * @param {{ debug?: boolean }} [opts] - if debug true, result includes failedBars: [{ time, reason }] for bars skipped before first valid entry
 * @returns {{ entry, stop, time, barIndex, date?, failedBars? } | null} - first valid entry or null
 */
export function findEntry(bars, prevDay, opts = {}) {
  const debug = !!opts.debug;
  const failedBars = debug ? [] : null;

  function skip(reason) {
    if (debug && bar) failedBars.push({ time: (bar.time || '').slice(0, 5), reason });
  }

  if (!bars || bars.length < FIRST_45_BARS + VOL_AVG_LOOKBACK + 1) return null;
  const dayOpen = bars[0].open;
  const prevClose = prevDay.close;
  const prevVol = prevDay.volume || 0;

  // Gap: day open must not be more than 2% above prev close
  const gapPct = prevClose > 0 ? ((dayOpen - prevClose) / prevClose) * 100 : 0;
  if (gapPct > GAP_UP_MAX_PCT) return null;

  const first45 = bars.slice(0, FIRST_45_BARS);
  const high45 = Math.max(...first45.map((b) => b.high));
  const movePct = dayOpen > 0 ? ((high45 - dayOpen) / dayOpen) * 100 : 0;
  if (movePct < MOVE_UP_MIN_PCT) return null;

  let bar;
  // From bar 15 onward, look for pullback then breakout
  for (let i = FIRST_45_BARS + VOL_AVG_LOOKBACK; i < bars.length; i++) {
    bar = bars[i];
    const barTime = (bar.time || '').slice(0, 5);
    if (barTime > MAX_ENTRY_TIME) { skip('after 12:30'); continue; }

    const cumVol = bars.slice(0, i + 1).reduce((s, b) => s + (b.volume || 0), 0);
    if (prevVol > 0 && cumVol < DAY_VOL_MULT * prevVol) { skip(`day vol ${(cumVol / prevVol).toFixed(1)}x < ${DAY_VOL_MULT}x`); continue; }

    // Day's high so far (up to and including this bar) and the first bar where it was made
    const dayHighSoFar = Math.max(...bars.slice(0, i + 1).map((b) => b.high));
    let highBarIdx = i;
    for (let k = 0; k <= i; k++) {
      if (bars[k].high >= dayHighSoFar) {
        highBarIdx = k;
        break;
      }
    }
    // Pullback = lowest low after the day-high bar and before entry bar. Skip if that pullback > 4%
    let pullbackLow = dayHighSoFar;
    if (highBarIdx < i - 1) {
      for (let j = highBarIdx + 1; j < i; j++) {
        if (bars[j].low < pullbackLow) pullbackLow = bars[j].low;
      }
      const pullbackPct = dayHighSoFar > 0 ? ((dayHighSoFar - pullbackLow) / dayHighSoFar) * 100 : 0;
      if (pullbackPct > PULLBACK_MAX_FROM_TOP_PCT) { skip(`pullback from high ${pullbackPct.toFixed(1)}% > 4%`); continue; }
    }
    // Pullback: at some point between 15 and i, low was at least PULLBACK_PCT below high45
    let hasPullback = false;
    for (let j = FIRST_45_BARS; j < i; j++) {
      if (bars[j].low <= high45 * (1 - PULLBACK_PCT / 100)) {
        hasPullback = true;
        break;
      }
    }

    // Consolidation: range of last 5 bars before current < CONSOLIDATION_RANGE_PCT of price
    const recent5 = bars.slice(i - VOL_AVG_LOOKBACK, i);
    const recentHigh = Math.max(...recent5.map((b) => b.high));
    const recentLow = Math.min(...recent5.map((b) => b.low));
    const rangePct = recent5[0]?.open > 0 ? ((recentHigh - recentLow) / recent5[0].open) * 100 : 100;
    const hasConsolidation = rangePct <= CONSOLIDATION_RANGE_PCT;
    if (!hasPullback && !hasConsolidation) { skip('no pullback and no consolidation'); continue; }

    // Breakout: close meaningfully above recent high (stronger breakout) and bullish candle
    const breakoutAbovePct = recentHigh > 0 ? ((bar.close - recentHigh) / recentHigh) * 100 : 0;
    if (breakoutAbovePct < BREAKOUT_STRENGTH_MIN_PCT) { skip(`breakout strength ${breakoutAbovePct.toFixed(2)}% < 0.4%`); continue; }
    if (bar.close <= bar.open) { skip('bearish candle'); continue; }

    // No large wicks
    const range = bar.high - bar.low;
    if (range <= 0) { skip('zero range'); continue; }
    const bodyTop = Math.max(bar.open, bar.close);
    const bodyBottom = Math.min(bar.open, bar.close);
    const upperWick = bar.high - bodyTop;
    const lowerWick = bodyBottom - bar.low;
    if (upperWick / range > WICK_MAX_PCT || lowerWick / range > WICK_MAX_PCT) { skip('large wick'); continue; }

    // Breakout candle volume >= 2x avg of previous 5
    const avgVol5 = recent5.reduce((s, b) => s + (b.volume || 0), 0) / VOL_AVG_LOOKBACK;
    if (avgVol5 > 0 && (bar.volume || 0) < BREAKOUT_VOL_MULT * avgVol5) { skip(`vol ${((bar.volume || 0) / avgVol5).toFixed(1)}x < ${BREAKOUT_VOL_MULT}x`); continue; }

    const entry = bar.close;
    const stopRaw = bar.low * (1 - STOP_BUFFER_PCT / 100);
    const stop = Math.round(stopRaw * 100) / 100;
    const slPct = entry > 0 ? ((entry - stop) / entry) * 100 : 0;
    if (slPct > MAX_SL_PCT) { skip(`SL ${slPct.toFixed(2)}% > 2%`); continue; }
    if (slPct < MIN_SL_PCT) { skip(`SL ${slPct.toFixed(2)}% < 0.8%`); continue; }

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
