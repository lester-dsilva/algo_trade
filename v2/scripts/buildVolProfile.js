/**
 * Build a market-wide intraday cumulative-volume profile f(T) = average fraction of a symbol-day's
 * total volume completed by clock-time T, averaged equally across all symbol-days in v2/data.
 * Persists to v2/data/intraday_vol_profile.json. Run: node v2/scripts/buildVolProfile.js
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { load3mForSymbol, list3mSymbols } from '../lib/loadBacktestData.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '../..', 'v2', 'data');
const OUT = path.join(DATA_DIR, 'intraday_vol_profile.json');

const dates = fs.readdirSync(DATA_DIR).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
const sumFrac = new Map(); // time -> sum of (cum/total)
const cnt = new Map();     // time -> count of symbol-days reaching that time
let symbolDays = 0;

for (const date of dates) {
  for (const sym of list3mSymbols(date)) {
    const bars = load3mForSymbol(date, sym);
    if (!bars || bars.length < 25) continue;
    const total = bars.reduce((s, b) => s + (b.volume || 0), 0);
    if (total <= 0) continue;
    symbolDays++;
    let cum = 0;
    for (const b of bars) {
      cum += b.volume || 0;
      const t = (b.time || '').slice(0, 5);
      if (!t) continue;
      sumFrac.set(t, (sumFrac.get(t) || 0) + cum / total);
      cnt.set(t, (cnt.get(t) || 0) + 1);
    }
  }
}

const times = [...cnt.keys()].sort();
const profile = {};
for (const t of times) profile[t] = sumFrac.get(t) / cnt.get(t);

fs.writeFileSync(OUT, JSON.stringify({ builtFrom: `${dates.length} dates, ${symbolDays} symbol-days`, profile }, null, 2));
console.log(`Built from ${symbolDays} symbol-days across ${dates.length} dates -> ${OUT}\n`);
console.log('Time  | avg cum fraction of day volume');
for (const t of times) {
  if (['09:15','09:30','09:45','10:00','10:15','10:30','10:45','10:48','11:00','11:30','12:00','12:30','13:00','14:00','15:00','15:15','15:24'].includes(t))
    console.log(`  ${t} | ${(profile[t] * 100).toFixed(1)}%  ${'#'.repeat(Math.round(profile[t] * 40))}`);
}
