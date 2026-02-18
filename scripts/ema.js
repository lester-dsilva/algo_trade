/**
 * Compute EMA(period) for a series of candles (close).
 * Reads JSON from stdin (array of { open, high, low, close }) or from file.
 * Usage: node scripts/ema.js [period]   (default: 20)
 *        node scripts/loadCsv.js data/sample.csv | node scripts/ema.js 20
 */

import fs from 'fs';

const period = Math.max(1, parseInt(process.argv[2], 10) || 20);
const multiplier = 2 / (period + 1);

function ema(candles, key = 'close') {
  const out = [];
  let prev = null;
  for (let i = 0; i < candles.length; i++) {
    const value = candles[i][key];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      out.push(null);
      continue;
    }
    if (prev == null) {
      if (i < period - 1) {
        out.push(null);
        continue;
      }
      // first EMA = SMA of first `period` values
      let sum = 0;
      for (let j = 0; j < period; j++) sum += candles[j][key];
      prev = sum / period;
    } else {
      prev = (value - prev) * multiplier + prev;
    }
    out.push(Math.round(prev * 1e4) / 1e4);
  }
  return out;
}

function readInput() {
  const arg = process.argv[2];
  if (arg && !/^\d+$/.test(arg)) {
    return JSON.parse(fs.readFileSync(arg, 'utf8'));
  }
  return JSON.parse(fs.readFileSync(0, 'utf8'));
}

// Support array of candles, { file, candles } from loadCsv, or [ { file, candles } ]
let data = readInput();
let candles = Array.isArray(data) && data[0]?.candles
  ? data[0].candles
  : Array.isArray(data)
    ? data
    : (data?.candles ?? data ?? []);
if (!Array.isArray(candles)) candles = [];

const emaValues = ema(candles);
const withEma = candles.map((c, i) => ({ ...c, ema20: emaValues[i] ?? null }));

console.log(JSON.stringify(withEma, null, 0));
