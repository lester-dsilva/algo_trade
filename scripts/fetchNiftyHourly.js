/**
 * Fetch an NSE INDEX OHLC series for a date range and save to JSON. Generic over interval.
 * Index token defaults to 256265 (NIFTY 50); Smallcap-100 is 267017. Volume is 0 for indices.
 * Kite caps history per request by interval, so we fetch in chunks sized for the interval.
 *
 * Run: node scripts/fetchNiftyHourly.js [from] [to] [token] [outName] [interval]
 *   e.g. node scripts/fetchNiftyHourly.js 2023-10-01 2026-07-31 267017 smallcap100_3m.json 3minute
 *        node scripts/fetchNiftyHourly.js 2023-10-01 2026-07-31 267017 smallcap100_daily.json day
 * Output: v2/data/<outName>  ->  { token, interval, from, to, candles:[{date,time,open,high,low,close}] }
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getKite } from '../lib/kite.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fromArg = process.argv[2] || '2023-06-01';
const toArg = process.argv[3] || '2026-06-08';
const token = Number(process.argv[4] || 256265);
const outName = process.argv[5] || 'nifty_hourly.json';
const interval = process.argv[6] || '60minute';
const OUT = path.resolve(__dirname, '..', 'v2', 'data', outName);
// Kite per-request history caps: minute≈60d, 3minute≈90d, 60minute≈400d, day≈2000d. Stay safely under.
const CHUNK_DAYS = interval === 'day' ? 1800 : interval === '60minute' ? 300 : interval.endsWith('minute') ? 60 : 300;

const addDays = (d, n) => { const x = new Date(d.getTime()); x.setDate(x.getDate() + n); return x; };
const istDate = (iso) => new Date(iso + 'T00:00:00+05:30');

function candleRow(c) {
  // kite lib returns c.date as a Date (correct instant). Render IST wall-clock.
  const d = c.date instanceof Date ? c.date : new Date(c.date);
  const ist = new Date(d.getTime() + 5.5 * 3600 * 1000);
  const iso = ist.toISOString();
  return {
    date: iso.slice(0, 10),
    time: iso.slice(11, 19),
    open: c.open, high: c.high, low: c.low, close: c.close,
  };
}

async function main() {
  const kc = await getKite();
  console.error(`auth ok, fetching token ${token} ${interval} ${fromArg}..${toArg} (chunk ${CHUNK_DAYS}d)`);

  const start = istDate(fromArg);
  const end = istDate(toArg);
  const all = [];
  let cursor = start;
  while (cursor < end) {
    const chunkTo = addDays(cursor, CHUNK_DAYS) < end ? addDays(cursor, CHUNK_DAYS) : end;
    const from = new Date(cursor.getTime());
    from.setHours(9, 15, 0, 0);
    const to = new Date(chunkTo.getTime());
    to.setHours(15, 30, 0, 0);
    process.stderr.write(`  ${from.toISOString().slice(0,10)} .. ${to.toISOString().slice(0,10)} ... `);
    const candles = await kc.getHistoricalData(token, interval, from, to, false, false);
    console.error(`${candles.length} candles`);
    for (const c of candles) all.push(candleRow(c));
    cursor = addDays(chunkTo, 1);
  }

  // dedupe by date+time, sort
  const seen = new Set();
  const uniq = [];
  for (const r of all.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time))) {
    const k = r.date + 'T' + r.time;
    if (seen.has(k)) continue;
    seen.add(k); uniq.push(r);
  }
  const days = new Set(uniq.map((r) => r.date)).size;
  fs.writeFileSync(OUT, JSON.stringify({ token, interval, from: fromArg, to: toArg, candles: uniq }, null, 2));
  console.error(`\nsaved ${uniq.length} candles across ${days} trading days -> ${OUT}`);
}

main().catch((err) => { console.error('ERROR:', err.message || err); process.exit(1); });
