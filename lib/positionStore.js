/**
 * Paper position store. Persists to data/positions.json.
 *
 * Schema per position:
 *  { id, symbol, side, entryTime, entryPrice, stop, target, status,
 *    signalType, initialStop, qty,
 *    highWaterMark, firstTargetHit,
 *    exitTime?, exitPrice?, pnl?, exitReason? }
 *
 * Exit logic (matches analyzePnl.js):
 *  - Initial SL  : bar.close <= stop (before first target) — avoids wick shakeouts
 *  - First target: bar.close >= entry * 1.03  → switch to trailing mode
 *  - Trail stop  : after first target, trail at 1.5% below running highWaterMark; exit when bar.close <= trail
 *  - EOD         : bar.time >= 15:24 → exit at bar.close
 */

import fs from 'fs';
import path from 'path';

// ── exit logic constants (mirror v2 backtest / analyzePnl) ───────────────────
export const POSITION_VALUE     = 50000;   // ₹ per trade
export const FIRST_TARGET_PCT   = 3;       // % above entry to trigger trail mode
export const TRAIL_PCT          = 1.5;     // % below highWaterMark to exit
export const EOD_BAR_TIME       = '15:24'; // square-off at this bar's close
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_PATH = path.join(process.cwd(), 'data', 'positions.json');
let _path = DEFAULT_PATH;

export function setPositionsPath(p) { _path = p; }
export function getPositionsPath()  { return _path; }

export function loadPositions() {
  try {
    const data = JSON.parse(fs.readFileSync(_path, 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch { return []; }
}

export function savePositions(positions) {
  const dir = path.dirname(_path);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(_path, JSON.stringify(positions, null, 2), 'utf8');
}

function nextId(positions) {
  const ids = positions.map(p => p.id).filter(n => typeof n === 'number');
  return ids.length ? Math.max(...ids) + 1 : 1;
}

// ── CRUD ─────────────────────────────────────────────────────────────────────

/**
 * Add a new open position. Returns the created position.
 * qty is calculated here and stored so exit P&L is always consistent.
 */
export function addPosition(fields) {
  const positions = loadPositions();
  const id = nextId(positions);
  const qty = Math.floor(POSITION_VALUE / fields.entryPrice);
  const position = {
    id,
    symbol:          fields.symbol,
    side:            fields.side || 'long',
    entryTime:       fields.entryTime,
    entryPrice:      fields.entryPrice,
    stop:            fields.stop,
    target:          fields.target,
    status:          'open',
    signalType:      fields.signalType || null,
    qty,
    initialStop:     fields.stop,
    highWaterMark:   0,          // starts at 0; updated from bar.high once trail mode begins
    firstTargetHit:  false,
  };
  positions.push(position);
  savePositions(positions);
  return position;
}

export function updatePosition(id, updates) {
  const positions = loadPositions();
  const i = positions.findIndex(p => p.id === id);
  if (i < 0) return null;
  Object.assign(positions[i], updates);
  savePositions(positions);
  return positions[i];
}

export function getOpenPositions()   { return loadPositions().filter(p => p.status === 'open'); }
export function getPositionById(id)  { return loadPositions().find(p => p.id === id); }

// ── EXIT ENGINE ───────────────────────────────────────────────────────────────

/**
 * Process a closed 3m bar against ALL open positions for bar.symbol.
 *
 * Returns array of result objects — one per matching open position:
 *  { position, action, qty, exitPrice?, pnl?, unrealizedPnl?, hwm?, trailLevel? }
 *
 * action values:
 *  'hold'             – holding, before first target
 *  'first_target_hit' – this bar's close >= +3%; switching to trail
 *  'hold_trail'       – in trail mode, not stopped yet
 *  'exit_initial_sl'  – bar.low <= stop (before first target)
 *  'exit_trail'       – bar.close <= trail level (after first target)
 *  'exit_eod'         – bar.time >= 15:24 square-off
 */
export function processBar(bar) {
  const { symbol, date, time, high, low, close } = bar;
  const positions = loadPositions();
  const results = [];
  let changed = false;

  for (let i = 0; i < positions.length; i++) {
    const pos = positions[i];
    if (pos.symbol !== symbol || pos.status !== 'open') continue;

    const { entryPrice, stop, qty } = pos;
    const firstTargetPrice = Math.round(entryPrice * (1 + FIRST_TARGET_PCT / 100) * 100) / 100;
    const isEod = time >= EOD_BAR_TIME;

    // ── EOD square-off ────────────────────────────────────────────────────
    if (isEod) {
      const exitPrice = close;
      const pnl = Math.round((exitPrice - entryPrice) * qty * 100) / 100;
      Object.assign(positions[i], {
        status: 'closed', exitTime: `${date} ${time}`,
        exitPrice, pnl, exitReason: 'eod',
      });
      changed = true;
      results.push({ position: positions[i], action: 'exit_eod', exitPrice, pnl, qty });
      continue;
    }

    // ── before first target ───────────────────────────────────────────────
    if (!pos.firstTargetHit) {
      // initial SL: exit only when bar closes at or below stop (avoids wick shakeouts)
      if (close <= stop) {
        const exitPrice = stop;
        const pnl = Math.round((exitPrice - entryPrice) * qty * 100) / 100;
        Object.assign(positions[i], {
          status: 'closed', exitTime: `${date} ${time}`,
          exitPrice, pnl, exitReason: 'initial_sl',
        });
        changed = true;
        results.push({ position: positions[i], action: 'exit_initial_sl', exitPrice, pnl, qty });
        continue;
      }

      // first target hit this bar
      if (close >= firstTargetPrice) {
        const hwm = Math.max(high, entryPrice); // seed hwm from this bar's high
        Object.assign(positions[i], { firstTargetHit: true, highWaterMark: hwm });
        changed = true;
        const unrealizedPnl = Math.round((close - entryPrice) * qty * 100) / 100;
        results.push({ position: positions[i], action: 'first_target_hit', close, unrealizedPnl, qty, hwm, firstTargetPrice });
        continue;
      }

      // still holding — no state change needed
      const unrealizedPnl = Math.round((close - entryPrice) * qty * 100) / 100;
      results.push({ position: positions[i], action: 'hold', close, unrealizedPnl, qty, stop, firstTargetPrice });
      continue;
    }

    // ── trail mode (after first target) ──────────────────────────────────
    const hwm = Math.max(pos.highWaterMark, high);
    const trailLevel = Math.round(hwm * (1 - TRAIL_PCT / 100) * 100) / 100;

    if (close <= trailLevel) {
      const exitPrice = trailLevel;
      const pnl = Math.round((exitPrice - entryPrice) * qty * 100) / 100;
      Object.assign(positions[i], {
        status: 'closed', exitTime: `${date} ${time}`,
        exitPrice, pnl, exitReason: 'trail_stop',
        highWaterMark: hwm,
      });
      changed = true;
      results.push({ position: positions[i], action: 'exit_trail', exitPrice, pnl, qty, hwm, trailLevel });
      continue;
    }

    // still in trail — update hwm
    Object.assign(positions[i], { highWaterMark: hwm });
    changed = true;
    const unrealizedPnl = Math.round((close - entryPrice) * qty * 100) / 100;
    results.push({ position: positions[i], action: 'hold_trail', close, unrealizedPnl, qty, hwm, trailLevel });
  }

  if (changed) savePositions(positions);
  return results;
}

// ── SUMMARY ───────────────────────────────────────────────────────────────────

/** Running P&L summary across all positions today. */
export function getTotalPnl() {
  const positions = loadPositions();
  const closed = positions.filter(p => p.status === 'closed');
  const open   = positions.filter(p => p.status === 'open');
  const realizedPnl = closed.reduce((s, p) => s + (p.pnl || 0), 0);
  return {
    realizedPnl:  Math.round(realizedPnl * 100) / 100,
    closedCount:  closed.length,
    openCount:    open.length,
    totalTrades:  positions.length,
    wins:         closed.filter(p => (p.pnl || 0) > 0).length,
    losses:       closed.filter(p => (p.pnl || 0) <= 0).length,
  };
}

/**
 * EOD sweep: force-close any positions that are still open at time >= 15:24.
 * Call this from a 15:30 timer in case a symbol had no ticks at EOD.
 * Returns array of force-closed positions.
 */
export function eodSweep(dateStr, closeTime = EOD_BAR_TIME) {
  const positions = loadPositions();
  const swept = [];
  let changed = false;
  for (let i = 0; i < positions.length; i++) {
    if (positions[i].status !== 'open') continue;
    // Use last known close as exit if we don't have a bar (rough approximation)
    const exitPrice = positions[i].highWaterMark > 0
      ? positions[i].entryPrice  // fallback: no loss/gain (we don't have close)
      : positions[i].entryPrice;
    const qty = positions[i].qty;
    const pnl = Math.round((exitPrice - positions[i].entryPrice) * qty * 100) / 100;
    Object.assign(positions[i], {
      status: 'closed', exitTime: `${dateStr} ${closeTime}`,
      exitPrice, pnl, exitReason: 'eod_sweep',
    });
    swept.push(positions[i]);
    changed = true;
  }
  if (changed) savePositions(positions);
  return swept;
}
