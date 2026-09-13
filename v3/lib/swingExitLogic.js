/**
 * Swing exit logic for v3 — fixed SL/target, 2H EMA exit.
 */

import { buildTwoHourBars, isTwoHourBelowEma } from './twoHourBars.js';

export const EXIT_DEFAULTS = {
  fixedSlPct: 2.5,
  fixedTargetPct: 10,
  emaPeriod: 20,
  emaExitBufferPct: 1,
  maxHoldDays: 30,
  positionValue: 50000,
};

function tradingDaysBetween(startDate, endDate, dailyBars) {
  const dates = dailyBars
    .map((b) => b.date)
    .filter((d) => d >= startDate && d <= endDate);
  return new Set(dates).size;
}

/**
 * Simulate a swing trade from entry bar forward.
 */
export function simulateSwingTrade(entry, hourlyBars, dailyBars, opts = {}) {
  const cfg = { ...EXIT_DEFAULTS, ...opts };
  const entryPrice = entry.entryPrice;
  const qty = Math.floor(cfg.positionValue / entryPrice);
  if (qty <= 0) {
    return { exitReason: 'skip', exitPrice: entryPrice, pnl: 0, qty: 0, holdDays: 0 };
  }

  const stop = Math.round(entryPrice * (1 - cfg.fixedSlPct / 100) * 100) / 100;
  const target = Math.round(entryPrice * (1 + cfg.fixedTargetPct / 100) * 100) / 100;

  const startIdx = entry.barIndex ?? hourlyBars.findIndex(
    (b) => b.date === entry.date && b.time === entry.time
  );
  if (startIdx < 0) {
    return { exitReason: 'skip', exitPrice: entryPrice, pnl: 0, qty: 0, holdDays: 0 };
  }

  const twoHBars = buildTwoHourBars(hourlyBars);
  let exitTime = null;
  let exitPrice = null;
  let exitReason = null;
  let exitDate = null;

  for (let i = startIdx + 1; i < hourlyBars.length; i++) {
    const bar = hourlyBars[i];
    const holdDays = tradingDaysBetween(entry.date, bar.date, dailyBars);

    if (holdDays > cfg.maxHoldDays) {
      exitTime = `${bar.date} ${bar.time}`;
      exitDate = bar.date;
      exitPrice = bar.close;
      exitReason = 'max_hold';
      break;
    }

    if (bar.high >= target) {
      exitTime = `${bar.date} ${bar.time}`;
      exitDate = bar.date;
      exitPrice = target;
      exitReason = 'target';
      break;
    }

    if (bar.low <= stop) {
      exitTime = `${bar.date} ${bar.time}`;
      exitDate = bar.date;
      exitPrice = stop;
      exitReason = 'stop';
      break;
    }

    if (isTwoHourBelowEma(twoHBars, i, cfg.emaPeriod, cfg.emaExitBufferPct)) {
      const twoH = twoHBars.find((b) => b.endHourlyIndex === i);
      exitTime = `${bar.date} ${bar.time}`;
      exitDate = bar.date;
      exitPrice = twoH?.close ?? bar.close;
      exitReason = 'ema_exit';
      break;
    }
  }

  if (!exitReason) {
    const last = hourlyBars[hourlyBars.length - 1];
    exitTime = `${last.date} ${last.time}`;
    exitDate = last.date;
    exitPrice = last.close;
    exitReason = 'end_of_data';
  }

  const holdDays = tradingDaysBetween(entry.date, exitDate, dailyBars);
  const pnl = Math.round((exitPrice - entryPrice) * qty * 100) / 100;
  const risk = entryPrice - stop;
  const rMultiple = risk > 0 ? Math.round(((exitPrice - entryPrice) / risk) * 100) / 100 : 0;

  return {
    exitTime,
    exitDate,
    exitPrice: Math.round(exitPrice * 100) / 100,
    exitReason,
    pnl,
    qty,
    holdDays,
    rMultiple,
    stop,
    target,
  };
}
