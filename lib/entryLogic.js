/**
 * Entry detection logic: triangle breakout, pullback to 20 EMA, reversal breakout.
 * Input: byDate (date -> candles), sortedDates; optional flatCandles for breakouts.
 * Used by findEntries.js (CLI) and liveScanner.js (live).
 */

function toNum(v) {
  const n = parseFloat(String(v).replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

function formatTime(timeStr) {
  return (timeStr || '').slice(0, 5) || '--:--';
}

function groupByDate(rows) {
  const byDate = {};
  for (const r of rows) {
    const d = (r.date || '').trim();
    if (!d) continue;
    const o = toNum(r.open), h = toNum(r.high), l = toNum(r.low), c = toNum(r.close), v = toNum(r.volume);
    if (!byDate[d]) byDate[d] = [];
    byDate[d].push({ ...r, date: d, time: (r.time || '').trim(), open: o, high: h, low: l, close: c, volume: v });
  }
  return byDate;
}

function ema(candles, key = 'close', period = 20) {
  const mult = 2 / (period + 1);
  const out = [];
  let prev = null;
  for (let i = 0; i < candles.length; i++) {
    const v = candles[i][key];
    if (typeof v !== 'number' || !Number.isFinite(v)) { out.push(null); continue; }
    if (prev == null) {
      if (i < period - 1) { out.push(null); continue; }
      let sum = 0;
      for (let j = 0; j < period; j++) sum += candles[j][key];
      prev = sum / period;
    } else {
      prev = (v - prev) * mult + prev;
    }
    out.push(prev);
  }
  return out;
}

function findBreakoutsOnePerDay(flatCandles, lookback, maxRangePct) {
  const results = [];
  const seenDate = new Set();
  for (let i = lookback; i < flatCandles.length; i++) {
    const window = flatCandles.slice(i - lookback, i);
    const high = Math.max(...window.map((b) => b.high));
    const low = Math.min(...window.map((b) => b.low));
    const mid = (high + low) / 2;
    const rangePct = mid > 0 ? ((high - low) / mid) * 100 : 0;
    if (rangePct > maxRangePct) continue;

    const bar = flatCandles[i];
    if (bar.close <= high) continue;
    if (seenDate.has(bar.date)) continue;
    seenDate.add(bar.date);

    results.push({
      type: 'BREAKOUT',
      date: bar.date,
      time: bar.time,
      timeIST: formatTime(bar.time),
      consolidationHigh: Math.round(high * 100) / 100,
      consolidationLow: Math.round(low * 100) / 100,
      rangePct: Math.round(rangePct * 100) / 100,
      breakoutClose: bar.close,
      suggestedEntry: Math.round(high * 100) / 100,
      suggestedStop: Math.round((low - 0.005 * low) * 100) / 100,
      riskPerShare: Math.round((high - low) * 100) / 100,
    });
  }
  return results;
}

function findPullbacks(byDate, tolerancePct, maxPerDay = 2) {
  const entries = [];
  for (const date of Object.keys(byDate).sort()) {
    const candles = byDate[date];
    const ema20 = ema(candles, 'close', 20);
    const dayOpen = candles[0].open;
    let highSoFar = dayOpen;
    let count = 0;

    for (let i = 0; i < candles.length && count < maxPerDay; i++) {
      const c = candles[i];
      const e = ema20[i];
      if (e == null || c.close <= 0) continue;
      highSoFar = Math.max(highSoFar, c.high);
      const moveFromOpenPct = ((highSoFar - dayOpen) / dayOpen) * 100;
      const distPct = (Math.abs(c.close - e) / e) * 100;
      const undercut = c.low < e && c.close >= e;
      const nearEMA = distPct <= tolerancePct;

      if ((nearEMA || undercut) && moveFromOpenPct >= 0.5 && i >= 20) {
        entries.push({
          type: 'PULLBACK',
          date,
          time: c.time,
          timeIST: formatTime(c.time),
          close: c.close,
          ema20: Math.round(e * 100) / 100,
          distPct: Math.round(distPct * 100) / 100,
          undercut,
          moveFromOpenPct: Math.round(moveFromOpenPct * 100) / 100,
        });
        count++;
      }
    }
  }
  return entries;
}

function findReversalBreakouts(byDate, sortedDates, sharpMovePct = 4, pullbackNearPct = 2, maxGapUpPct = null, maxEntryCandleRangePct = 1.5, maxSlPct = 2, getPrevDayVolume = null, maxPullbackPct = 5, maxConsolidationRangePct = 2, getPrevDayCloseDaily = null, getDayOpenDaily = null, onSkip = null) {
  const skip = (reason) => { if (typeof onSkip === 'function') onSkip(reason); };
  const RECENT_BARS = 5;           // rolling window for recent consolidation high/low and SL
  const MAX_CONS_RUN_BARS = 20;    // ~60 min on 3m — if no breakout by then, skip stock for the day
  const results = [];
  for (let di = 0; di < sortedDates.length; di++) {
    const date = sortedDates[di];
    const candles = byDate[date];
    if (!candles || candles.length < 21) {
      skip('fewer_than_21_bars');
      continue;
    }

    const dayOpen = candles[0].open;
    if (maxGapUpPct != null && Number.isFinite(maxGapUpPct)) {
      const prevClose = typeof getPrevDayCloseDaily === 'function' ? getPrevDayCloseDaily() : (di > 0 && byDate[sortedDates[di - 1]]?.length > 0 ? byDate[sortedDates[di - 1]][byDate[sortedDates[di - 1]].length - 1].close : null);
      const dayOpenForGap = typeof getDayOpenDaily === 'function' ? getDayOpenDaily() : dayOpen;
      if (prevClose != null && prevClose > 0 && dayOpenForGap != null && dayOpenForGap > prevClose) {
        const gapUpPct = ((dayOpenForGap - prevClose) / prevClose) * 100;
        if (gapUpPct >= maxGapUpPct) {
          skip(`gap_filter_${gapUpPct.toFixed(1)}pct`);
          continue;
        }
      }
    }
    // Seed EMA20 with prev day tail candles if available so EMA is accurate from bar 0 of today
    const prevDayCandles = di > 0 ? (byDate[sortedDates[di - 1]] || []) : [];
    const ema20 = prevDayCandles.length > 0
      ? ema([...prevDayCandles, ...candles], 'close', 20).slice(prevDayCandles.length)
      : ema(candles, 'close', 20);
    let dayLowSoFar = candles[0].low;

    let iSharp = -1;
    let highSoFar = dayOpen;
    const sharpMoveWindowBars = 60; // was 30: allow 4% move to occur by mid-morning (e.g. BLUEJET 11:21)
    for (let i = 0; i < Math.min(sharpMoveWindowBars, candles.length); i++) {
      highSoFar = Math.max(highSoFar, candles[i].high);
      if (dayOpen > 0 && (highSoFar - dayOpen) / dayOpen >= sharpMovePct / 100) {
        iSharp = i;
        break;
      }
    }
    if (iSharp < 0) {
      skip('no_sharp_move_4pct');
      continue;
    }

    let pullbackStart = -1;
    let consHigh = -Infinity;
    let consLow = Infinity;
    let consHighsRecent = [];   // Fix #1: rolling window of last RECENT_BARS highs
    let consLowsRecent = [];    // used for SL and consolidation range
    let consVolumeSum = 0;

    // Start consolidation tracking only after the sharp move bar — pre-move ranging should not pollute consLow/consHigh.
    for (let i = Math.max(20, iSharp); i < candles.length; i++) {
      const c = candles[i];
      const e = ema20[i];
      if (e == null || e <= 0) continue;
      dayLowSoFar = Math.min(dayLowSoFar, c.low);

      const distPct = Math.abs(c.close - e) / e * 100;
      const touchesEma = c.low <= e * (1 + pullbackNearPct / 100) && c.high >= e * (1 - pullbackNearPct / 100);
      const nearEma = distPct <= pullbackNearPct || touchesEma;

      let runLen = pullbackStart >= 0 ? i - pullbackStart : 0;

      // Fix #3: if consolidation runs >20 bars with no breakout, the setup is stale — skip for the day
      if (runLen > MAX_CONS_RUN_BARS) {
        skip(`cons_too_long_${runLen}bars_no_breakout`);
        break;
      }

      // Fix #1: use recent consolidation high as breakout gate — close must be clearly above it
      const consHighRecent = consHighsRecent.length > 0 ? Math.max(...consHighsRecent) : consHigh;

      if (runLen >= 2 && c.close > consHighRecent && c.close > e) {
        const t = (c.time || '').slice(0, 8);

        // Fix #5: stale consolidation — recent range must be at the current price level
        const CONS_NEAR_ENTRY_PCT = 1.5;
        if (consHighsRecent.length > 0 && c.open > 0 && consHighRecent < c.open * (1 - CONS_NEAR_ENTRY_PCT / 100)) {
          skip(`cons_stale_${consHighRecent.toFixed(2)}_open_${c.open.toFixed(2)}@${t}`);
          continue;
        }

        // Overhead resistance: if the full consolidation run had higher bars than the recent
        // 5-bar range, those earlier bars create a supply wall above the entry — skip.
        // (only enforced once we have a full RECENT_BARS window to compare against)
        if (consHighsRecent.length >= RECENT_BARS && consHigh > consHighRecent * 1.005) {
          skip(`overhead_${consHigh.toFixed(2)}_vs_recent_${consHighRecent.toFixed(2)}@${t}`);
          continue;
        }

        // Entry bar must be green (close > open) — don't enter on a red candle
        if (c.close <= c.open) { skip(`red_candle@${t}`); continue; }

        // Fix #4: entry bar must have a real body — not a doji or pin bar
        const barRange = c.high - c.low;
        const body = c.close - c.open;
        if (barRange > 0 && body / barRange < 0.4) { skip(`doji_${(body / barRange * 100).toFixed(0)}pct@${t}`); continue; }

        // Upper wick filter: large upper wick = selling pressure at highs = weak breakout
        const upperWick = c.high - c.close;
        if (barRange > 0 && upperWick / barRange > 0.4) { skip(`upper_wick_${(upperWick / barRange * 100).toFixed(0)}pct@${t}`); continue; }

        // Skip if entry candle range > threshold (SL would be too wide)
        if (maxEntryCandleRangePct != null && Number.isFinite(maxEntryCandleRangePct) && c.open > 0) {
          const entryBarRangePct = ((c.high - c.low) / c.open) * 100;
          if (entryBarRangePct > maxEntryCandleRangePct) { skip(`entry_bar_range_${entryBarRangePct.toFixed(1)}pct@${t}`); continue; }
        }

        // Fix #2: SL from min low of last RECENT_BARS before entry (not entire consLow)
        const lookback = Math.max(0, i - RECENT_BARS);
        const lastBars = candles.slice(lookback, i);
        const stopFromLow = lastBars.length > 0 ? Math.min(...lastBars.map((b) => b.low)) : consLow;
        const suggestedStop = Math.round((stopFromLow - 0.005 * stopFromLow) * 100) / 100;
        if (maxSlPct != null && Number.isFinite(maxSlPct) && c.close > 0 && suggestedStop < c.close) {
          const slPct = ((c.close - suggestedStop) / c.close) * 100;
          if (slPct > maxSlPct) { skip(`sl_pct_${slPct.toFixed(1)}@${t}`); continue; }
        }

        // Entry only when today's cumulative volume AT ENTRY TIME already exceeds previous trading day's FULL volume.
        const dayVolumeSoFar = candles.slice(0, i + 1).reduce((s, b) => s + (b.volume ?? 0), 0);
        const prevDayFullVolume = typeof getPrevDayVolume === 'function' ? getPrevDayVolume() : (di > 0 ? (byDate[sortedDates[di - 1]] || []).reduce((s, b) => s + (b.volume ?? 0), 0) : null);
        if (prevDayFullVolume == null || prevDayFullVolume <= 0 || !(dayVolumeSoFar > prevDayFullVolume)) {
          skip(prevDayFullVolume == null || prevDayFullVolume <= 0 ? `volume_no_prev@${t}` : `volume_filter@${t}`);
          continue;
        }

        const moveHigh = pullbackStart > 0 ? Math.max(...candles.slice(0, pullbackStart).map((b) => b.high)) : highSoFar;
        let moveHighBarIndex = pullbackStart - 1;
        for (let j = pullbackStart - 1; j >= 0; j--) {
          if (candles[j].high >= moveHigh - 0.001) {
            moveHighBarIndex = j;
            break;
          }
        }
        const pullbackLow = moveHighBarIndex + 1 <= i ? Math.min(...candles.slice(moveHighBarIndex + 1, i + 1).map((b) => b.low)) : consLow;
        const pullbackPct = moveHigh > 0 ? ((moveHigh - pullbackLow) / moveHigh) * 100 : 0;
        if (maxPullbackPct != null && Number.isFinite(maxPullbackPct) && pullbackPct > maxPullbackPct) { skip(`pullback_${pullbackPct.toFixed(1)}pct@${t}`); continue; }

        // Consolidation range uses recent highs/lows when available
        const consLowRecent = consLowsRecent.length > 0 ? Math.min(...consLowsRecent) : consLow;
        const consolidationRangePct = consHighRecent > 0 ? ((consHighRecent - consLowRecent) / consHighRecent) * 100 : 0;
        if (maxConsolidationRangePct != null && Number.isFinite(maxConsolidationRangePct) && consolidationRangePct > maxConsolidationRangePct) { skip(`consolidation_range_${consolidationRangePct.toFixed(1)}pct@${t}`); continue; }

        const consolidationAvgVolume = runLen > 0 ? consVolumeSum / runLen : 0;
        results.push({
          type: 'REVERSAL_BREAKOUT',
          date,
          time: c.time,
          timeIST: formatTime(c.time),
          close: Math.round(c.close * 100) / 100,
          ema20: Math.round(e * 100) / 100,
          consHigh: Math.round(consHighRecent * 100) / 100,
          suggestedStop,
          entryBarVolume: c.volume ?? 0,
          consolidationAvgVolume: Math.round(consolidationAvgVolume),
        });
        break;
      }

      if (nearEma) {
        if (pullbackStart < 0) pullbackStart = i;
        consHigh = Math.max(consHigh, c.high);
        consLow = Math.min(consLow, c.low);
        // Fix #1/#2: maintain rolling window of recent highs and lows
        consHighsRecent.push(c.high);
        consLowsRecent.push(c.low);
        if (consHighsRecent.length > RECENT_BARS) consHighsRecent.shift();
        if (consLowsRecent.length > RECENT_BARS) consLowsRecent.shift();
        consVolumeSum += c.volume ?? 0;
      } else if (pullbackStart >= 0) {
        pullbackStart = -1;
        consHigh = -Infinity;
        consLow = Infinity;
        consHighsRecent = [];
        consLowsRecent = [];
        consVolumeSum = 0;
      }
    }
  }
  return results;
}

function timeToMins(timeStr) {
  const parts = (timeStr || '').split(':').map(Number);
  return (parts[0] || 0) * 60 + (parts[1] || 0) + (parts[2] || 0) / 60;
}

function refineWith1m(date, time3m, byDateLtf) {
  if (!byDateLtf || !byDateLtf[date]) return null;
  const candles = byDateLtf[date];
  const ema20 = ema(candles, 'close', 20);
  const startMins = timeToMins(time3m);
  const endMins = startMins + 3;

  for (let i = 0; i < candles.length; i++) {
    const bar = candles[i];
    const barMins = timeToMins(bar.time);
    if (barMins < startMins || barMins >= endMins) continue;
    if (ema20[i] == null || bar.close <= ema20[i]) continue;
    return {
      date: bar.date,
      time: bar.time,
      timeIST: formatTime(bar.time),
      close: Math.round(bar.close * 100) / 100,
    };
  }
  return null;
}

/**
 * Run all entry detectors. Options: lookback, maxRangePct, tolerancePct, sharpMovePct, pullbackNearPct, maxPerDay, maxGapUpPct, maxEntryCandleRangePct.
 */
function runEntryLogic(byDate, sortedDates, options = {}) {
  const lookback = options.lookback ?? 15;
  const maxRangePct = options.maxRangePct ?? 2;
  const tolerancePct = options.tolerancePct ?? 1;
  const sharpMovePct = options.sharpMovePct ?? 4;
  const pullbackNearPct = options.pullbackNearPct ?? 2;
  const maxPerDay = options.maxPerDay ?? 2;
  const maxGapUpPct = options.maxGapUpPct ?? null;
  const maxEntryCandleRangePct = options.maxEntryCandleRangePct ?? 1.5;
  const maxSlPct = options.maxSlPct ?? 2;
  const getPrevDayVolume = options.getPrevDayVolume ?? null;
  const maxPullbackPct = options.maxPullbackPct ?? 5;
  const maxConsolidationRangePct = options.maxConsolidationRangePct ?? 2;
  const getPrevDayCloseDaily = options.getPrevDayCloseDaily ?? null;
  const getDayOpenDaily = options.getDayOpenDaily ?? null;
  const onSkip = options.onSkip ?? null;

  const flatCandles = sortedDates.flatMap((d) => byDate[d] || []);
  const breakouts = findBreakoutsOnePerDay(flatCandles, lookback, maxRangePct);
  const pullbacks = findPullbacks(byDate, tolerancePct, maxPerDay);
  const reversalBreakouts = findReversalBreakouts(byDate, sortedDates, sharpMovePct, pullbackNearPct, maxGapUpPct, maxEntryCandleRangePct, maxSlPct, getPrevDayVolume, maxPullbackPct, maxConsolidationRangePct, getPrevDayCloseDaily, getDayOpenDaily, onSkip);

  return { breakouts, pullbacks, reversalBreakouts };
}

export {
  toNum,
  formatTime,
  groupByDate,
  ema,
  findBreakoutsOnePerDay,
  findPullbacks,
  findReversalBreakouts,
  timeToMins,
  refineWith1m,
  runEntryLogic,
};
