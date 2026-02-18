/**
 * Add simple momentum metrics to candles:
 *   - pctFromOpen: (close - open) / open * 100 for the day so far
 *   - rangePct: (high - low) / open * 100 for that candle
 * Assumes candles are in order (same day or pass openPrice for the day).
 * Usage: pipe from loadCsv (or loadCsv | ema) then into this script.
 */

import fs from 'fs';

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

function addMomentum(candles) {
  let dayOpen = null;
  const out = [];
  for (const c of candles) {
    if (c.open != null && dayOpen === null) dayOpen = c.open;
    const o = c.open || 0;
    const high = c.high || o;
    const low = c.low || o;
    const close = c.close || o;
    const rangePct = o ? ((high - low) / o) * 100 : 0;
    const pctFromOpen = dayOpen ? ((close - dayOpen) / dayOpen) * 100 : 0;
    out.push({
      ...c,
      rangePct: Math.round(rangePct * 100) / 100,
      pctFromOpen: Math.round(pctFromOpen * 100) / 100,
    });
  }
  return out;
}

async function main() {
  const raw = await readStdin();
  let data = JSON.parse(raw || '[]');
  let candles = Array.isArray(data) && data[0]?.candles
    ? data[0].candles
    : Array.isArray(data)
      ? data
      : (data?.candles ?? data ?? []);
  if (!Array.isArray(candles)) candles = [];
  const withMomentum = addMomentum(candles);
  console.log(JSON.stringify(withMomentum, null, 0));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
