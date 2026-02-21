/**
 * Check open positions using 3m bar-close logic (matches analyzePnl backtest):
 * - 3% first target only when a bar closes >= 3%; trail starts from the next bar.
 * - Trail exit only when a bar closes at or below trail (not intrabar low).
 * Run on an interval (e.g. every 15–30s); fetches 3m bars from Kite for each position's symbol.
 *
 * Usage: node scripts/positionManager.js [intervalSeconds]
 *   intervalSeconds  Poll interval (default 15). Use 0 to run once and exit.
 */

const FIRST_TARGET_PCT = 3;
const TRAIL_PCT = 1.5;
const EOD_BAR_TIME = '15:24';

import { getKite } from '../lib/kite.js';
import {
  getOpenPositions,
  loadPositions,
  savePositions,
} from '../lib/positionStore.js';
import { sendAlert } from '../lib/telegram.js';

const DEFAULT_INTERVAL_MS = 15 * 1000;

/** Kite candle date is UTC; convert to IST date and time (HH:MM or HH:MM:SS). */
function toISTDateAndTime(d) {
  if (!(d instanceof Date)) d = new Date(d);
  let h = d.getUTCHours(), min = d.getUTCMinutes(), s = d.getUTCSeconds();
  let day = d.getUTCDate(), month = d.getUTCMonth(), year = d.getUTCFullYear();
  min += 30;
  if (min >= 60) { min -= 60; h += 1; }
  h += 5;
  if (h >= 24) { h -= 24; day += 1; }
  const date = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const time = `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}:${String(s).padStart(2, '0')}`.slice(0, 8);
  return { date, time };
}

/** Return IST time string "HH:MM" for the last closed 3m bar (market 09:15–15:30, 3m grid). */
function getLastClosed3mBarTimeIST() {
  const now = new Date();
  const utcMs = now.getTime();
  const istMs = utcMs + (5 * 60 + 30) * 60 * 1000;
  const ist = new Date(istMs);
  const totalMins = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  const marketStart = 9 * 60 + 15;
  const marketEnd = 15 * 60 + 27; // last 3m bar start
  if (totalMins < marketStart + 3) return null; // no bar closed yet
  const lastClosed = Math.min(marketEnd, marketStart + Math.floor((totalMins - 3 - marketStart) / 3) * 3);
  const h = Math.floor(lastClosed / 60);
  const m = lastClosed % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function findInstrumentToken(instruments, symbol) {
  const sym = symbol.includes(':') ? symbol.split(':')[1] : symbol;
  const row = instruments.find((i) => i.exchange === 'NSE' && i.tradingsymbol === sym);
  return row ? row.instrument_token : null;
}

/** Fetch 3m bars for one day and return rows { date, time, open, high, low, close } in IST, sorted by time. */
async function fetch3mBarsForDay(kite, instrumentToken, dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  // NSE market 09:15–15:30 IST = 03:45–10:00 UTC
  const from = new Date(Date.UTC(y, m - 1, d, 3, 45));
  const to = new Date(Date.UTC(y, m - 1, d, 10, 0));
  let candles;
  try {
    candles = await kite.getHistoricalData(instrumentToken, '3minute', from, to, false, false);
  } catch (err) {
    console.error('getHistoricalData failed for', dateStr, err?.message || err);
    return [];
  }
  if (!candles || candles.length === 0) return [];
  const rows = candles.map((c) => {
    const { date, time } = toISTDateAndTime(c.date);
    return { date, time: time.slice(0, 5), open: c.open, high: c.high, low: c.low, close: c.close };
  });
  return rows.filter((r) => r.date === dateStr).sort((a, b) => (a.time || '').localeCompare(b.time || ''));
}

/**
 * Run backtest-style state machine on bars from entryBarIndex+1 to lastBarIndex.
 * Uses position.firstTargetHit and position.highWaterMark; updates position in-place and returns { exit, exitPrice, pnl } or null.
 */
function evaluateBars(position, dayBars, entryBarIndex, lastBarIndex) {
  const entry = position.entryPrice;
  const stop = position.initialStop ?? position.stop;
  const firstTarget = Math.round(entry * (1 + FIRST_TARGET_PCT / 100) * 100) / 100;
  let hitFirstTarget = position.firstTargetHit === true;
  let highWaterMark = position.highWaterMark != null ? position.highWaterMark : 0;

  for (let i = entryBarIndex + 1; i <= lastBarIndex; i++) {
    const b = dayBars[i];
    if (!hitFirstTarget && b.low <= stop) {
      return { exit: 'stopped_out', exitPrice: stop, pnl: (stop - entry) * (position.side === 'short' ? -1 : 1) };
    }
    if (!hitFirstTarget && b.close >= firstTarget) {
      hitFirstTarget = true;
      if ((b.time || '').startsWith(EOD_BAR_TIME) || (b.time || '') >= '15:24') {
        return { exit: 'eod', exitPrice: b.close, pnl: (b.close - entry) * (position.side === 'short' ? -1 : 1) };
      }
      continue;
    }
    if (hitFirstTarget) {
      highWaterMark = Math.max(highWaterMark, b.high);
      const trailExit = Math.round(highWaterMark * (1 - TRAIL_PCT / 100) * 100) / 100;
      if (b.close <= trailExit) {
        return { exit: 'stopped_out', exitPrice: trailExit, pnl: (trailExit - entry) * (position.side === 'short' ? -1 : 1) };
      }
    }
    if ((b.time || '').startsWith(EOD_BAR_TIME) || (b.time || '') >= '15:24') {
      return { exit: 'eod', exitPrice: b.close, pnl: (b.close - entry) * (position.side === 'short' ? -1 : 1) };
    }
  }

  // No exit; persist updated state
  position.firstTargetHit = hitFirstTarget;
  position.highWaterMark = highWaterMark;
  return null;
}

async function checkPositions(kite, instruments) {
  const open = getOpenPositions();
  if (open.length === 0) return;

  const lastClosedTime = getLastClosed3mBarTimeIST();
  if (!lastClosedTime) return;

  const positions = loadPositions();
  let changed = false;

  for (const pos of open) {
    const idx = positions.findIndex((p) => p.id === pos.id);
    if (idx < 0) continue;

    const token = findInstrumentToken(instruments, pos.symbol);
    if (token == null) continue;

    const entryTime = pos.entryTime || '';
    const [entryDate, entryTimePart] = entryTime.split(/\s+/);
    if (!entryDate) continue;

    const bars = await fetch3mBarsForDay(kite, token, entryDate);
    if (bars.length === 0) continue;

    const dayBars = bars.filter((b) => (b.time || '').localeCompare(lastClosedTime) <= 0);
    if (dayBars.length === 0) continue;

    const timeMatch = (t) => (b) => (b.time || '').slice(0, 5) === (entryTimePart || '').slice(0, 5) || (b.time || '') === entryTimePart;
    let entryIdx = dayBars.findIndex(timeMatch(entryTimePart));
    if (entryIdx < 0) entryIdx = dayBars.findIndex((b) => (b.time || '').localeCompare(entryTimePart || '') >= 0);
    if (entryIdx < 0) continue;

    const result = evaluateBars(positions[idx], dayBars, entryIdx, dayBars.length - 1);

    if (result) {
      const now = new Date();
      const exitTime = now.toISOString().slice(0, 19).replace('T', ' ');
      positions[idx].status = result.exit;
      positions[idx].exitTime = exitTime;
      positions[idx].exitPrice = result.exitPrice;
      positions[idx].pnl = Math.round(result.pnl * 100) / 100;
      changed = true;
      const msg = `${pos.symbol} ${result.exit} @ ${result.exitPrice} – PnL ${positions[idx].pnl}`;
      console.error('[POSITION]', msg);
      sendAlert(msg);
    } else {
      if (positions[idx].firstTargetHit !== pos.firstTargetHit || positions[idx].highWaterMark !== pos.highWaterMark) {
        changed = true;
      }
    }
  }

  if (changed) savePositions(positions);
}

async function main() {
  const intervalSec = parseInt(process.argv[2], 10);
  const intervalMs = Number.isFinite(intervalSec) && intervalSec >= 0
    ? (intervalSec === 0 ? 0 : intervalSec * 1000)
    : DEFAULT_INTERVAL_MS;

  const kite = await getKite();
  let instruments;
  try {
    instruments = await kite.getInstruments('NSE');
  } catch (err) {
    console.error('getInstruments failed:', err?.message || err);
    process.exit(1);
  }

  if (intervalMs === 0) {
    await checkPositions(kite, instruments);
    return;
  }

  console.error('Position manager (bar-close logic) every', intervalMs / 1000, 's. Ctrl+C to stop.');
  await checkPositions(kite, instruments);
  setInterval(() => checkPositions(kite, instruments), intervalMs);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
