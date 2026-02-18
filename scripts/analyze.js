/**
 * Simple analysis: find bars where price is near 20 EMA (pullback zone).
 * Reads from stdin: array of candles with ema20 (pipe from loadCsv | ema, or pass file).
 * Options: --tolerance=0.5 (price within 0.5% of EMA = "near")
 * Usage: node scripts/loadCsv.js data/sample.csv | node scripts/ema.js | node scripts/analyze.js
 *        node scripts/analyze.js --tolerance=0.5 < enriched.json
 */

import fs from 'fs';

const args = process.argv.slice(2);
let tolerancePct = 0.5;
for (const a of args) {
  if (a.startsWith('--tolerance=')) tolerancePct = parseFloat(a.slice(12)) || 0.5;
}

function readInput() {
  const arg = args.find((a) => !a.startsWith('--'));
  if (arg && fs.existsSync(arg)) {
    return JSON.parse(fs.readFileSync(arg, 'utf8'));
  }
  return JSON.parse(fs.readFileSync(0, 'utf8'));
}

function analyze(candles) {
  const results = [];
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const ema = c.ema20;
    if (ema == null || typeof c.close !== 'number') continue;
    const distPct = (Math.abs(c.close - ema) / ema) * 100;
    const undercut = c.low != null && c.low < ema && c.close >= ema;
    if (distPct <= tolerancePct || undercut) {
      results.push({
        index: i,
        date: c.date,
        time: c.time,
        close: c.close,
        ema20: ema,
        distPct: Math.round(distPct * 100) / 100,
        undercut,
      });
    }
  }
  return results;
}

let data = readInput();
let candles = Array.isArray(data) && data[0]?.candles
  ? data[0].candles
  : Array.isArray(data)
    ? data
    : (data?.candles ?? data ?? []);
if (!Array.isArray(candles)) candles = [];

const hits = analyze(candles);
console.log(JSON.stringify({ tolerancePct, count: hits.length, bars: hits }, null, 2));
