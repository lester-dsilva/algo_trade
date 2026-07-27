/**
 * Trace why a symbol did/didn't enter on a date, with full trend+liquidity context and per-bar
 * gate reasons (even when no entry). Run from repo root:
 *   node v2/scripts/whyNoTrade.js 2026-06-01 REDINGTON
 */
import path from 'path';
import { fileURLToPath } from 'url';
import { loadPrevDayOhlc, load3mForSymbol, loadRecentDailyForDate, loadIntradayVolProfile } from '../lib/loadBacktestData.js';
import { findEntry, computeTrendFeatures, isTrendDeadZone, FIRST_HOUR_BAR_COUNT } from '../lib/entryLogic.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const date = process.argv[2] || '2026-06-01';
const symIn = (process.argv[3] || 'REDINGTON').toUpperCase();

const prevMap = loadPrevDayOhlc(date);
let sym = symIn;
if (prevMap && !prevMap.has(sym)) for (const k of prevMap.keys()) if (k.toUpperCase() === symIn) sym = k;
const prev = prevMap?.get(sym);
const bars = load3mForSymbol(date, sym);
if (!prev || !bars || !bars.length) { console.error('missing prev/3m for', sym, date); process.exit(1); }

const daily = loadRecentDailyForDate(date, 40);
const trend = computeTrendFeatures(daily.get(sym));
console.log(`=== ${sym} ${date} ===`);
console.log('prev close/vol:', prev.close, prev.volume);
if (trend) {
  console.log(`trend: ret20=${trend.ret20?.toFixed(1)}%  distSMA20=${trend.distFromSMA20?.toFixed(1)}%  avgTurnover20=₹${Math.round(trend.avgTurnover20/1e5)}L/day`);
  console.log(`  deadZone=${isTrendDeadZone(trend)}  liquidityOK=${trend.avgTurnover20 >= 2e7}`);
} else console.log('trend: (none)');

// VWAP at each bar for context
function vwapAt(i) { let pv=0,vv=0; for (let k=0;k<=i;k++){const b=bars[k];const tp=(b.high+b.low+b.close)/3;pv+=tp*(b.volume||0);vv+=(b.volume||0);} return vv>0?pv/vv:null; }

const usePace = process.argv.includes('--pace');
const volProfile = usePace ? loadIntradayVolProfile() : null;
const res = findEntry(bars, { close: prev.close, volume: prev.volume },
  { trend, debug: true, ...(usePace ? { volMode: 'pace', paceVolMult: 2.7, volProfile } : {}) });
console.log('\nENTRY:', res ? `${(res.time||'').slice(0,5)} @ ${res.entry}` : 'NONE');

const reasons = (res && res.failedBars) || [];
// findEntry only attaches failedBars when an entry is found; re-run forcing full scan via a tiny shim:
if (!res) {
  // call again but capture: monkey not available, so reconstruct reasons by re-deriving with debug + no early return is not possible.
  // Instead, print the bars around 10:48 with VWAP ext so we can reason manually.
}
const byTime = new Map();
for (const { time, reason } of reasons) { if (!byTime.has(time)) byTime.set(time, new Set()); byTime.get(time).add(reason); }

console.log('\nBars 10:30–11:15 (time | O/H/L/C | vol | VWAPext% | gate):');
for (let i = FIRST_HOUR_BAR_COUNT; i < bars.length; i++) {
  const b = bars[i]; const t = (b.time||'').slice(0,5);
  if (t < '10:30' || t > '11:15') continue;
  const vw = vwapAt(i);
  const ext = vw ? ((b.close - vw)/vw*100).toFixed(1) : '—';
  const gate = byTime.has(t) ? [...byTime.get(t)].join('; ') : (res && t === (res.time||'').slice(0,5) ? 'ENTERED' : '(passed pre-gates / not evaluated)');
  console.log(`  ${t} | ${b.open}/${b.high}/${b.low}/${b.close} | v=${b.volume} | ext=${ext}% | ${gate}`);
}
