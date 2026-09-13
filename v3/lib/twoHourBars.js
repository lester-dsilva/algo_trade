/**
 * Build 2-hour candles from hourly bars (paired within each session).
 * NSE hourly: 09:15, 10:15, …, 15:15 → 2H closes at 10:15, 12:15, 14:15.
 */

import { ema } from './indicators.js';

export function buildTwoHourBars(hourlyBars) {
  const byDate = new Map();
  for (const bar of hourlyBars) {
    if (!byDate.has(bar.date)) byDate.set(bar.date, []);
    byDate.get(bar.date).push(bar);
  }

  const twoH = [];
  for (const date of [...byDate.keys()].sort()) {
    const day = byDate.get(date);
    for (let i = 1; i < day.length; i += 2) {
      const a = day[i - 1];
      const b = day[i];
      const endIdx = hourlyBars.indexOf(b);
      if (endIdx < 0) continue;
      twoH.push({
        date: b.date,
        time: b.time,
        open: a.open,
        high: Math.max(a.high, b.high),
        low: Math.min(a.low, b.low),
        close: b.close,
        volume: (a.volume || 0) + (b.volume || 0),
        endHourlyIndex: endIdx,
      });
    }
  }
  return twoH;
}

/**
 * True when 2H close at endHourlyIndex is >= emaExitBufferPct below EMA(period).
 * @param {Array} twoHBars from buildTwoHourBars
 * @param {number} endHourlyIndex hourly bar index that closes the 2H candle
 * @param {number} period EMA period (default 20)
 * @param {number} bufferPct exit if close is this % below EMA (default 1)
 */
export function isTwoHourBelowEma(twoHBars, endHourlyIndex, period = 20, bufferPct = 1) {
  const idx = twoHBars.findIndex((b) => b.endHourlyIndex === endHourlyIndex);
  if (idx < 0) return false;

  const slice = twoHBars.slice(0, idx + 1);
  const ema20 = ema(slice, 'close', period);
  const e = ema20[idx];
  const close = slice[idx].close;
  if (e == null || !Number.isFinite(close)) return false;

  const threshold = e * (1 - bufferPct / 100);
  return close <= threshold;
}
