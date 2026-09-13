/**
 * Hourly entry logic for v3 swing strategy.
 * Momentum volume breakout: close breaks N-bar high on elevated volume.
 */

import { EXIT_DEFAULTS } from './swingExitLogic.js';
import { smaAtEnd } from './indicators.js';
import { SCREEN_DEFAULTS, checkDailySmaAtEntry } from './dailyScreener.js';

export const ENTRY_DEFAULTS = {
  lookbackBars: 12,
  breakoutVolMult: 5,
  volAvgLookback: 60,
  wickMaxPct: 0.3,
  closeInRangeMinPct: 0.65,
  resistanceLookback: 60,
  breakoutStrengthMinPct: 0.2,
  maxEntryCandleRangePct: 7,
  hourlySmaPeriod: 20,
  smaProximityMinPct: SCREEN_DEFAULTS.smaProximityMinPct,
  smaProximityMaxPct: SCREEN_DEFAULTS.smaProximityMaxPct,
  fixedSlPct: EXIT_DEFAULTS.fixedSlPct,
  minHourlyBars: 20,
  entryDayVolLookback: 10,
  /** Full-session target: cumulative day vol vs avg daily baseline. */
  entryDayVolMinMult: 2,
  /** Per completed session hour (09:15 = 1, 10:15 = 2, …) until cap above. */
  entryDayVolHourlyStep: 0.75,
};

function avgVolume(bars, endIdx, lookback) {
  const start = Math.max(0, endIdx - lookback);
  const slice = bars.slice(start, endIdx);
  if (!slice.length) return 0;
  return slice.reduce((s, b) => s + (b.volume || 0), 0) / slice.length;
}

function priorRange(bars, endIdx, lookback) {
  const start = Math.max(0, endIdx - lookback);
  const window = bars.slice(start, endIdx);
  if (window.length < 3) return null;
  const high = Math.max(...window.map((b) => b.high));
  const low = Math.min(...window.map((b) => b.low));
  return { high, low, window };
}

/** Session hour index for entry bar: 09:15 → 1, 10:15 → 2, etc. */
export function sessionHourIndex(hourlyBars, entryDate, entryTime) {
  return (hourlyBars || [])
    .filter((b) => b.date === entryDate && b.time <= entryTime)
    .length;
}

/** Scaled min mult: hour 1 → 0.75×, hour 2 → 1.5×, hour 3+ → capped at entryDayVolMinMult (2×). */
export function entryDayVolMinRequired(hourIndex, opts = {}) {
  const cfg = { ...ENTRY_DEFAULTS, ...opts };
  if (!hourIndex || hourIndex < 1) return cfg.entryDayVolHourlyStep;
  return Math.min(hourIndex * cfg.entryDayVolHourlyStep, cfg.entryDayVolMinMult);
}

/**
 * Entry-day volume at entry time: sum hourly vol from session start through entryTime,
 * vs avg full daily volume over prior N completed days. Threshold ramps by session hour.
 */
export function checkEntryDayVolume(hourlyBars, dailyBars, entryDate, entryTime, opts = {}) {
  const cfg = { ...ENTRY_DEFAULTS, ...opts };
  const completed = (dailyBars || []).filter((b) => b.date < entryDate);
  if (completed.length < cfg.entryDayVolLookback) {
    return { pass: false, reason: 'insufficient_daily_bars', ratio: null, avgDailyVol: null, partialDayVol: null };
  }

  const avgDailyVol =
    completed.slice(-cfg.entryDayVolLookback).reduce((s, b) => s + (b.volume || 0), 0) /
    cfg.entryDayVolLookback;
  const partialDayVol = (hourlyBars || [])
    .filter((b) => b.date === entryDate && b.time <= entryTime)
    .reduce((s, b) => s + (b.volume || 0), 0);

  if (!avgDailyVol || avgDailyVol <= 0) {
    return { pass: false, reason: 'avg_daily_vol_zero', ratio: null, avgDailyVol, partialDayVol };
  }

  const hourIndex = sessionHourIndex(hourlyBars, entryDate, entryTime);
  const minRequired = entryDayVolMinRequired(hourIndex, cfg);
  const ratio = partialDayVol / avgDailyVol;
  const pass = ratio >= minRequired;
  return {
    pass,
    reason: pass ? null : 'entry_day_vol_low',
    ratio: Math.round(ratio * 100) / 100,
    avgDailyVol: Math.round(avgDailyVol),
    partialDayVol,
    minRequired,
    hourIndex,
    lookbackDays: cfg.entryDayVolLookback,
  };
}

/**
 * @param {Array} hourlyBars full hourly series sorted ascending
 * @param {number} barIndex index of candidate breakout bar
 * @param {object} dailyContext { dailyBars }
 * @param {object} opts
 */
export function checkHourlyEntryAtBar(hourlyBars, barIndex, dailyContext = {}, opts = {}) {
  const cfg = { ...ENTRY_DEFAULTS, ...opts };
  const bar = hourlyBars[barIndex];
  if (!bar) return null;
  if (barIndex < cfg.minHourlyBars) return null;

  const range = priorRange(hourlyBars, barIndex, cfg.lookbackBars);
  if (!range) return null;

  if (bar.close <= range.high) return null;
  if (bar.close <= bar.open) return null;

  const barRange = bar.high - bar.low;
  if (barRange <= 0) return null;
  const candleRangePct = (barRange / bar.close) * 100;
  if (candleRangePct > cfg.maxEntryCandleRangePct) return null;
  const upperWick = bar.high - Math.max(bar.open, bar.close);
  if (upperWick / barRange > cfg.wickMaxPct) return null;

  const closePosition = (bar.close - bar.low) / barRange;
  if (closePosition < cfg.closeInRangeMinPct) return null;

  const resWindow = hourlyBars.slice(Math.max(0, barIndex - cfg.resistanceLookback), barIndex);
  if (resWindow.length >= 10) {
    const resistanceHigh = Math.max(...resWindow.map((b) => b.high));
    if (bar.close <= resistanceHigh) return null;
  }

  const strengthPct = ((bar.close - range.high) / range.high) * 100;
  if (strengthPct < cfg.breakoutStrengthMinPct) return null;

  const avgVol = avgVolume(hourlyBars, barIndex, cfg.volAvgLookback);
  if (avgVol > 0 && bar.volume < avgVol * cfg.breakoutVolMult) return null;

  const hourlyCloses = hourlyBars.slice(0, barIndex + 1).map((b) => b.close);
  const hourlySma = smaAtEnd(hourlyCloses, cfg.hourlySmaPeriod);
  if (hourlySma == null) return null;
  const distFromHourlySma = ((bar.close - hourlySma) / hourlySma) * 100;
  if (distFromHourlySma < cfg.smaProximityMinPct) return null;
  if (distFromHourlySma > cfg.smaProximityMaxPct) return null;

  const dailySma = checkDailySmaAtEntry(dailyContext.dailyBars, bar.date, bar.close, {
    smaProximityMinPct: cfg.smaProximityMinPct,
    smaProximityMaxPct: cfg.smaProximityMaxPct,
  });
  if (!dailySma.pass) return null;

  const entryDayVol = checkEntryDayVolume(
    hourlyBars,
    dailyContext.dailyBars,
    bar.date,
    bar.time,
    cfg
  );
  if (!entryDayVol.pass) return null;

  const stop = Math.round(bar.close * (1 - cfg.fixedSlPct / 100) * 100) / 100;
  const target = Math.round(bar.close * (1 + EXIT_DEFAULTS.fixedTargetPct / 100) * 100) / 100;

  return {
    date: bar.date,
    time: bar.time,
    entryPrice: bar.close,
    stop,
    target,
    rangeHigh: range.high,
    rangeLow: range.low,
    barIndex,
    signalType: 'hourly_vol_breakout',
    breakoutVolRatio: avgVol > 0 ? Math.round((bar.volume / avgVol) * 100) / 100 : null,
    candleRangePct: Math.round(candleRangePct * 100) / 100,
    distFromHourlySMA20: Math.round(distFromHourlySma * 100) / 100,
    distFromDailySMA20: Math.round(dailySma.distFromSMA20 * 100) / 100,
    dailySMA20: Math.round(dailySma.sma20 * 100) / 100,
    hourlySMA20: Math.round(hourlySma * 100) / 100,
    breakoutStrengthPct: Math.round(strengthPct * 100) / 100,
    entryDayVolRatio: entryDayVol.ratio,
  };
}

export function findHourlyEntryOnDay(dayBars, fullHourlyBars, dailyContext = {}, opts = {}) {
  if (!dayBars?.length) return null;
  for (const bar of dayBars) {
    const barIndex = fullHourlyBars.indexOf(bar);
    if (barIndex < 0) continue;
    const entry = checkHourlyEntryAtBar(fullHourlyBars, barIndex, dailyContext, opts);
    if (entry) return entry;
  }
  return null;
}

export function findHourlyEntries(hourlyBars, dailyBars, opts = {}) {
  const entries = [];
  const seenDates = new Set();
  const dates = [...new Set(hourlyBars.map((b) => b.date))].sort();

  for (const date of dates) {
    if (seenDates.has(date)) continue;

    const dayBars = hourlyBars.filter((b) => b.date === date);
    const entry = findHourlyEntryOnDay(dayBars, hourlyBars, { dailyBars }, opts);
    if (entry) {
      entries.push(entry);
      seenDates.add(date);
    }
  }
  return entries;
}
