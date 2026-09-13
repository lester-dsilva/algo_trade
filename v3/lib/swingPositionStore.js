/**
 * Swing position store for v3. Persists to data/swing_positions.json.
 * Positions persist across days until exit logic fires.
 */

import fs from 'fs';
import path from 'path';

export const SWING_POSITION_VALUE = 50000;

const DEFAULT_PATH = path.join(process.cwd(), 'data', 'swing_positions.json');
let _path = DEFAULT_PATH;

export function setSwingPositionsPath(p) { _path = p; }
export function getSwingPositionsPath() { return _path; }

export function loadSwingPositions() {
  try {
    const data = JSON.parse(fs.readFileSync(_path, 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

export function saveSwingPositions(positions) {
  const dir = path.dirname(_path);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(_path, JSON.stringify(positions, null, 2), 'utf8');
}

function nextId(positions) {
  const ids = positions.map((p) => p.id).filter((n) => typeof n === 'number');
  return ids.length ? Math.max(...ids) + 1 : 1;
}

export function addSwingPosition(fields) {
  const positions = loadSwingPositions();
  const id = nextId(positions);
  const qty = Math.floor((fields.positionValue ?? SWING_POSITION_VALUE) / fields.entryPrice);
  const position = {
    id,
    symbol: fields.symbol,
    side: 'long',
    entryTime: fields.entryTime,
    entryPrice: fields.entryPrice,
    stop: fields.stop,
    target: fields.target,
    trailStop: null,
    status: 'open',
    signalType: fields.signalType || 'hourly_vol_breakout',
    qty,
    trailActive: false,
    exitTime: null,
    exitPrice: null,
    exitReason: null,
    holdDays: 0,
    pnl: null,
  };
  positions.push(position);
  saveSwingPositions(positions);
  return position;
}

export function getOpenSwingPositions() {
  return loadSwingPositions().filter((p) => p.status === 'open');
}

export function getSwingPositionBySymbol(symbol) {
  return loadSwingPositions().find((p) => p.symbol === symbol && p.status === 'open');
}

export function closeSwingPosition(id, updates) {
  const positions = loadSwingPositions();
  const i = positions.findIndex((p) => p.id === id);
  if (i < 0) return null;
  Object.assign(positions[i], { status: 'closed', ...updates });
  saveSwingPositions(positions);
  return positions[i];
}

export function updateSwingPosition(id, updates) {
  const positions = loadSwingPositions();
  const i = positions.findIndex((p) => p.id === id);
  if (i < 0) return null;
  Object.assign(positions[i], updates);
  saveSwingPositions(positions);
  return positions[i];
}

export function getSwingPnlSummary() {
  const positions = loadSwingPositions();
  const closed = positions.filter((p) => p.status === 'closed');
  const open = positions.filter((p) => p.status === 'open');
  const realizedPnl = closed.reduce((s, p) => s + (p.pnl || 0), 0);
  return {
    realizedPnl: Math.round(realizedPnl * 100) / 100,
    closedCount: closed.length,
    openCount: open.length,
    wins: closed.filter((p) => (p.pnl || 0) > 0).length,
    losses: closed.filter((p) => (p.pnl || 0) <= 0).length,
  };
}
