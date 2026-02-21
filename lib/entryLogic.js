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

function findReversalBreakouts(byDate, sortedDates, sharpMovePct = 4, pullbackNearPct = 2, maxGapUpPct = null, maxEntryCandleRangePct = 1.5, maxSlPct = 2, getPrevDayVolume = null, maxPullbackPct = 5, maxConsolidationRangePct = 2) {
  const results = [];
  for (let di = 0; di < sortedDates.length; di++) {
    const date = sortedDates[di];
    const candles = byDate[date];
    if (!candles || candles.length < 21) continue;

    const dayOpen = candles[0].open;
    if (maxGapUpPct != null && Number.isFinite(maxGapUpPct) && di > 0) {
      const prevDate = sortedDates[di - 1];
      const prevCandles = byDate[prevDate];
      if (prevCandles && prevCandles.length > 0) {
        const prevClose = prevCandles[prevCandles.length - 1].close;
        if (prevClose > 0 && dayOpen > prevClose) {
          const gapUpPct = ((dayOpen - prevClose) / prevClose) * 100;
          if (gapUpPct >= maxGapUpPct) continue;
        }
      }
    }
    const ema20 = ema(candles, 'close', 20);
    let dayLowSoFar = candles[0].low;

    let iSharp = -1;
    let highSoFar = dayOpen;
    for (let i = 0; i < Math.min(30, candles.length); i++) {
      highSoFar = Math.max(highSoFar, candles[i].high);
      if (dayOpen > 0 && (highSoFar - dayOpen) / dayOpen >= sharpMovePct / 100) {
        iSharp = i;
        break;
      }
    }
    if (iSharp < 0) continue;

    let pullbackStart = -1;
    let consHigh = -Infinity;
    let consLow = Infinity;
    let consVolumeSum = 0;

    for (let i = 20; i < candles.length; i++) {
      const c = candles[i];
      const e = ema20[i];
      if (e == null || e <= 0) continue;
      dayLowSoFar = Math.min(dayLowSoFar, c.low);

      const distPct = Math.abs(c.close - e) / e * 100;
      const touchesEma = c.low <= e * (1 + pullbackNearPct / 100) && c.high >= e * (1 - pullbackNearPct / 100);
      const nearEma = distPct <= pullbackNearPct || touchesEma;

      const runLen = pullbackStart >= 0 ? i - pullbackStart : 0;
      if (runLen >= 2 && c.close > consHigh && c.close > e) {
        // Skip if entry candle range > threshold (SL would be too wide)
        if (maxEntryCandleRangePct != null && Number.isFinite(maxEntryCandleRangePct) && c.open > 0) {
          const entryBarRangePct = ((c.high - c.low) / c.open) * 100;
          if (entryBarRangePct > maxEntryCandleRangePct) continue;
        }
        // SL slightly below consolidation low only (not day low — day low can be from open and invalidate the setup)
        const suggestedStop = Math.round((consLow - 0.005 * consLow) * 100) / 100;
        if (maxSlPct != null && Number.isFinite(maxSlPct) && c.close > 0 && suggestedStop < c.close) {
          const slPct = ((c.close - suggestedStop) / c.close) * 100;
          if (slPct > maxSlPct) continue;
        }
        // Entry only when today's cumulative volume AT ENTRY TIME already exceeds previous trading day's FULL volume.
        const dayVolumeSoFar = candles.slice(0, i + 1).reduce((s, b) => s + (b.volume ?? 0), 0);
        const prevDayFullVolume = typeof getPrevDayVolume === 'function' ? getPrevDayVolume() : (di > 0 ? (byDate[sortedDates[di - 1]] || []).reduce((s, b) => s + (b.volume ?? 0), 0) : null);
        if (prevDayFullVolume == null || prevDayFullVolume <= 0 || !(dayVolumeSoFar > prevDayFullVolume)) continue;
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
        if (maxPullbackPct != null && Number.isFinite(maxPullbackPct) && pullbackPct > maxPullbackPct) continue;
        const consolidationRangePct = consHigh > 0 ? ((consHigh - consLow) / consHigh) * 100 : 0;
        if (maxConsolidationRangePct != null && Number.isFinite(maxConsolidationRangePct) && consolidationRangePct > maxConsolidationRangePct) continue;
        const consolidationAvgVolume = runLen > 0 ? consVolumeSum / runLen : 0;
        results.push({
          type: 'REVERSAL_BREAKOUT',
          date,
          time: c.time,
          timeIST: formatTime(c.time),
          close: Math.round(c.close * 100) / 100,
          ema20: Math.round(e * 100) / 100,
          consHigh: Math.round(consHigh * 100) / 100,
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
        consVolumeSum += c.volume ?? 0;
      } else if (pullbackStart >= 0) {
        pullbackStart = -1;
        consHigh = -Infinity;
        consLow = Infinity;
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

  const flatCandles = sortedDates.flatMap((d) => byDate[d] || []);
  const breakouts = findBreakoutsOnePerDay(flatCandles, lookback, maxRangePct);
  const pullbacks = findPullbacks(byDate, tolerancePct, maxPerDay);
  const reversalBreakouts = findReversalBreakouts(byDate, sortedDates, sharpMovePct, pullbackNearPct, maxGapUpPct, maxEntryCandleRangePct, maxSlPct, getPrevDayVolume, maxPullbackPct, maxConsolidationRangePct);

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
