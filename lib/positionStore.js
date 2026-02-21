/**
 * Paper (and later real) position store. Persists to data/positions.json.
 * Schema: array of { id, symbol, side, entryTime, entryPrice, stop, target, status, exitTime?, exitPrice?, pnl?, signalType?, initialStop?, highWaterMark?, firstTargetHit? }
 * initialStop = stop at entry. highWaterMark = max bar high since 3% close (for trail). firstTargetHit = true once a bar closed >= 3%.
 */

import fs from 'fs';
import path from 'path';

const DEFAULT_PATH = path.join(process.cwd(), 'data', 'positions.json');

let _path = DEFAULT_PATH;

export function setPositionsPath(p) {
  _path = p;
}

export function getPositionsPath() {
  return _path;
}

export function loadPositions() {
  try {
    const raw = fs.readFileSync(_path, 'utf8');
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

export function savePositions(positions) {
  const dir = path.dirname(_path);
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(_path, JSON.stringify(positions, null, 2), 'utf8');
  } catch (err) {
    throw new Error('Failed to save positions: ' + (err?.message || err));
  }
}

function nextId(positions) {
  const ids = positions.map((p) => p.id).filter((n) => typeof n === 'number');
  return ids.length ? Math.max(...ids) + 1 : 1;
}

/**
 * Add a new open position. Returns the created position with id.
 * @param {{ symbol, side, entryTime, entryPrice, stop, target, signalType? }} fields
 */
export function addPosition(fields) {
  const positions = loadPositions();
  const id = nextId(positions);
  const position = {
    id,
    symbol: fields.symbol,
    side: fields.side || 'long',
    entryTime: fields.entryTime,
    entryPrice: fields.entryPrice,
    stop: fields.stop,
    target: fields.target,
    status: 'open',
    signalType: fields.signalType || null,
    initialStop: fields.stop,
    highWaterMark: fields.entryPrice ?? fields.stop,
    firstTargetHit: false,
  };
  positions.push(position);
  savePositions(positions);
  return position;
}

/**
 * Update position by id: set status, exitTime, exitPrice, pnl.
 */
export function updatePosition(id, updates) {
  const positions = loadPositions();
  const i = positions.findIndex((p) => p.id === id);
  if (i < 0) return null;
  Object.assign(positions[i], updates);
  savePositions(positions);
  return positions[i];
}

export function getOpenPositions() {
  return loadPositions().filter((p) => p.status === 'open');
}

export function getPositionById(id) {
  return loadPositions().find((p) => p.id === id);
}
