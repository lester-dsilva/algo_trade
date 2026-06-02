/**
 * Analyze baseline winners: recompute entry-bar features from 3m data and
 * compare biggest winners vs the rest. Looks for commonality in volume, time,
 * candle strength, pattern (pullback vs consolidation), trend, etc.
 *
 * Run from repo root:
 *   node v2/scripts/analyzeWinnerFeatures.js [baselineName] [topN]
 */

import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { loadPrevDayOhlc, load3mForSymbol } from '../lib/loadBacktestData.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const BASELINE_DIR = path.join(ROOT, 'v2', 'data', 'backtest_baselines');

const FIRST_HOUR_BAR_COUNT = 20;
const VOL_AVG_LOOKBACK = 5;

function norm(s) { return s.toLowerCase().replace(/&/g, '').replace(/\s/g, ''); }

function resolveSymbol(prevDayOhlc, symbol) {
  if (prevDayOhlc.has(symbol)) return symbol;
  const n = norm(symbol);
  for (const k of prevDayOhlc.keys()) if (norm(k) === n) return k;
  return null;
}

/** Recompute the context features at the entry bar for one trade. */
function featuresForTrade(t) {
  const bars = load3mForSymbol(t.date, t.symbol);
  if (!bars || bars.length < FIRST_HOUR_BAR_COUNT + 1) return null;
  const prevOhlc = loadPrevDayOhlc(t.date);
  const sym = prevOhlc ? resolveSymbol(prevOhlc, t.symbol) : null;
  const prev = sym ? prevOhlc.get(sym) : null;

  // find entry bar by time (HH:MM)
  const t5 = (t.time || '').slice(0, 5);
  let i = bars.findIndex((b) => (b.time || '').slice(0, 5) === t5);
  if (i < 0) return null;
  const bar = bars[i];

  const dayOpen = bars[0].open;
  const prevClose = prev?.close ?? null;
  const prevVol = prev?.volume ?? 0;

  // gap
  const gapPct = prevClose > 0 ? ((dayOpen - prevClose) / prevClose) * 100 : null;

  // first-hour move
  const firstHourHigh = Math.max(...bars.slice(0, FIRST_HOUR_BAR_COUNT).map((b) => b.high));
  const firstHourMovePct = dayOpen > 0 ? ((firstHourHigh - dayOpen) / dayOpen) * 100 : null;

  // day move at entry (open->entry close)
  const dayMovePct = dayOpen > 0 ? ((bar.close - dayOpen) / dayOpen) * 100 : null;

  // cumulative day volume multiple vs prev day full
  const cumVol = bars.slice(0, i + 1).reduce((s, b) => s + (b.volume || 0), 0);
  const dayVolMult = prevVol > 0 ? cumVol / prevVol : null;

  // breakout bar relative volume vs avg prev 5
  const recent5 = bars.slice(i - VOL_AVG_LOOKBACK, i);
  const avgVol5 = recent5.reduce((s, b) => s + (b.volume || 0), 0) / VOL_AVG_LOOKBACK;
  const breakoutRelVol = avgVol5 > 0 ? (bar.volume || 0) / avgVol5 : null;

  // breakout strength above recent 5-bar high
  const recentHigh = Math.max(...recent5.map((b) => b.high));
  const recentLow = Math.min(...recent5.map((b) => b.low));
  const breakoutStrengthPct = recentHigh > 0 ? ((bar.close - recentHigh) / recentHigh) * 100 : null;

  // consolidation tightness (last 5 bars range as % of open)
  const consRangePct = recent5[0]?.open > 0 ? ((recentHigh - recentLow) / recent5[0].open) * 100 : null;

  // candle structure
  const range = bar.high - bar.low;
  const body = bar.close - bar.open;
  const bodyPct = range > 0 ? (body / range) * 100 : null;          // body as % of range
  const upperWick = bar.high - Math.max(bar.open, bar.close);
  const lowerWick = Math.min(bar.open, bar.close) - bar.low;
  const upperWickPct = range > 0 ? (upperWick / range) * 100 : null;
  const lowerWickPct = range > 0 ? (lowerWick / range) * 100 : null;
  const candleRangePct = bar.open > 0 ? (range / bar.open) * 100 : null; // bar range as % (volatility of entry bar)

  // pullback depth from day high (pattern: deep pullback vs shallow/consolidation)
  // measure the day high BEFORE the entry bar — the entry bar is always a fresh high by construction
  const beforeBars = bars.slice(0, i);
  const dayHighBefore = beforeBars.length ? Math.max(...beforeBars.map((b) => b.high)) : bar.high;
  let highBarIdx = 0;
  for (let k = 0; k < i; k++) { if (bars[k].high >= dayHighBefore) { highBarIdx = k; break; } }
  let pullbackLow = dayHighBefore;
  for (let j = highBarIdx + 1; j < i; j++) if (bars[j].low < pullbackLow) pullbackLow = bars[j].low;
  const pullbackFromHighPct = dayHighBefore > 0 ? ((dayHighBefore - pullbackLow) / dayHighBefore) * 100 : null;

  // bars from day high to entry (how long the base was)
  const baseLengthBars = i - highBarIdx;

  // pattern classification (mirror entryLogic): consolidation if last-5 range <= 2%
  const isConsolidation = consRangePct != null && consRangePct <= 2;

  // prev-day trend: where did prev day close vs its open/range, and 3-day momentum proxy
  const prevDayChangePct = prev && prev.open > 0 ? ((prev.close - prev.open) / prev.open) * 100 : null;
  const prevDayRangePos = prev && prev.high > prev.low
    ? ((prev.close - prev.low) / (prev.high - prev.low)) * 100 : null; // close position in prev day range

  // two-bar combined up move (over-extension)
  const prevBar = i > 0 ? bars[i - 1] : null;
  const prevUpPct = prevBar && prevBar.open > 0 ? Math.max(0, ((prevBar.close - prevBar.open) / prevBar.open) * 100) : 0;
  const currUpPct = bar.open > 0 ? Math.max(0, ((bar.close - bar.open) / bar.open) * 100) : 0;
  const twoBarUpPct = prevUpPct + currUpPct;

  // entry price bucket (liquidity proxy)
  const entryPrice = t.entry;

  // outcome
  const risk = t.entry - t.stop;
  const r = risk > 0 ? (t.exitPrice - t.entry) / risk : null;
  const retPct = t.entry > 0 ? ((t.exitPrice - t.entry) / t.entry) * 100 : null;

  return {
    date: t.date, symbol: t.symbol, time: t5, seqIndex: t.seqIndex,
    pnl: t.pnl, r, retPct, exitReason: t.exitReason,
    entryPrice,
    gapPct, firstHourMovePct, dayMovePct,
    dayVolMult, breakoutRelVol, breakoutStrengthPct,
    consRangePct, isConsolidation, pullbackFromHighPct, baseLengthBars,
    bodyPct, upperWickPct, lowerWickPct, candleRangePct,
    prevDayChangePct, prevDayRangePos, twoBarUpPct,
    minsFromOpen: (() => { const [h, m] = t5.split(':').map(Number); return (h * 60 + m) - (9 * 60 + 15); })(),
  };
}

function stats(arr) {
  const v = arr.filter((x) => x != null && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return { n: 0 };
  const sum = v.reduce((a, b) => a + b, 0);
  const q = (p) => v[Math.min(v.length - 1, Math.floor(p * v.length))];
  return { n: v.length, mean: sum / v.length, med: q(0.5), p25: q(0.25), p75: q(0.75), min: v[0], max: v[v.length - 1] };
}

function fmt(s, d = 2) {
  if (!s || !s.n) return '   n/a';
  return `mean=${s.mean.toFixed(d)}  med=${s.med.toFixed(d)}  [p25=${s.p25.toFixed(d)} p75=${s.p75.toFixed(d)}]`;
}

function compareBlock(label, key, winners, rest, d = 2) {
  const w = stats(winners.map((x) => x[key]));
  const r = stats(rest.map((x) => x[key]));
  console.log(`  ${label.padEnd(26)} WIN ${fmt(w, d)}`);
  console.log(`  ${''.padEnd(26)} REST ${fmt(r, d)}`);
}

function main() {
  const name = process.argv[2] || 'baseline';
  const topN = parseInt(process.argv[3] || '100', 10);
  const file = path.join(BASELINE_DIR, `${name}.json`);
  if (!fs.existsSync(file)) { console.error('No baseline:', file); process.exit(1); }
  const baseline = JSON.parse(fs.readFileSync(file, 'utf8'));
  const trades = baseline.trades || [];
  console.error(`Baseline ${name}: ${trades.length} trades. Extracting features...`);

  const feats = [];
  let miss = 0;
  for (let k = 0; k < trades.length; k++) {
    const f = featuresForTrade(trades[k]);
    if (f) feats.push(f); else miss++;
    if ((k + 1) % 200 === 0) console.error(`  ${k + 1}/${trades.length}`);
  }
  console.error(`Features for ${feats.length} trades (${miss} missing data).\n`);

  // Rank by R-multiple (price-independent winner quality), fallback to pnl
  const withR = feats.filter((f) => f.r != null);
  withR.sort((a, b) => b.r - a.r);

  const winners = withR.slice(0, topN);
  const restAll = withR.slice(topN);
  const losers = withR.filter((f) => f.r <= 0);

  const winR = stats(winners.map((x) => x.r));
  const allR = stats(withR.map((x) => x.r));
  console.log(`=== Top ${topN} winners by R vs rest (${withR.length} total, ${losers.length} losers) ===`);
  console.log(`Winner R: ${fmt(winR)}  | cutoff R >= ${winners[winners.length - 1].r.toFixed(2)}`);
  console.log(`All    R: ${fmt(allR)}\n`);

  console.log('VOLUME');
  compareBlock('Day vol multiple (xPrev)', 'dayVolMult', winners, restAll);
  compareBlock('Breakout bar rel-vol', 'breakoutRelVol', winners, restAll);
  console.log('\nTIME');
  compareBlock('Mins from open', 'minsFromOpen', winners, restAll, 0);
  console.log('\nMOVE / TREND');
  compareBlock('First-hour move %', 'firstHourMovePct', winners, restAll);
  compareBlock('Day move @ entry %', 'dayMovePct', winners, restAll);
  compareBlock('Gap up %', 'gapPct', winners, restAll);
  compareBlock('Prev day change %', 'prevDayChangePct', winners, restAll);
  compareBlock('Prev day close-in-range %', 'prevDayRangePos', winners, restAll, 0);
  compareBlock('2-bar combined up %', 'twoBarUpPct', winners, restAll);
  console.log('\nCANDLE STRENGTH (entry bar)');
  compareBlock('Breakout strength %', 'breakoutStrengthPct', winners, restAll);
  compareBlock('Body % of range', 'bodyPct', winners, restAll, 0);
  compareBlock('Upper wick % of range', 'upperWickPct', winners, restAll, 0);
  compareBlock('Lower wick % of range', 'lowerWickPct', winners, restAll, 0);
  compareBlock('Entry bar range %', 'candleRangePct', winners, restAll);
  console.log('\nPATTERN / BASE');
  compareBlock('Consolidation range %', 'consRangePct', winners, restAll);
  compareBlock('Pullback from high %', 'pullbackFromHighPct', winners, restAll);
  compareBlock('Base length (bars)', 'baseLengthBars', winners, restAll, 0);
  const wCons = winners.filter((x) => x.isConsolidation).length;
  const rCons = restAll.filter((x) => x.isConsolidation).length;
  console.log(`  ${'Consolidation pattern %'.padEnd(26)} WIN ${(100 * wCons / winners.length).toFixed(0)}%   REST ${(100 * rCons / restAll.length).toFixed(0)}%`);

  console.log('\nOTHER');
  compareBlock('Entry price (₹)', 'entryPrice', winners, restAll, 0);
  compareBlock('Seq index (order in day)', 'seqIndex', winners, restAll, 1);

  // exit reason mix among winners
  const exitMix = {};
  for (const w of winners) exitMix[w.exitReason] = (exitMix[w.exitReason] || 0) + 1;
  console.log('\nWinner exit reasons:', JSON.stringify(exitMix));

  // time-of-day win rate buckets
  console.log('\n=== Win-rate & avg-R by feature bucket (all trades) ===');
  bucketReport('Mins from open', withR, 'minsFromOpen', [0, 30, 60, 90, 120, 180, 999]);
  bucketReport('Day vol multiple', withR, 'dayVolMult', [0, 3, 4, 6, 9, 15, 1e9]);
  bucketReport('Breakout rel-vol', withR, 'breakoutRelVol', [0, 1.5, 2.5, 4, 7, 1e9]);
  bucketReport('Day move @ entry %', withR, 'dayMovePct', [0, 4, 5, 6, 8, 11, 1e9]);
  bucketReport('Breakout strength %', withR, 'breakoutStrengthPct', [0, 0.5, 0.8, 1.2, 2, 1e9]);
  bucketReport('Body % of range', withR, 'bodyPct', [0, 50, 65, 80, 90, 101]);

  // dump winners CSV for manual eyeballing
  const csv = ['date,symbol,time,r,retPct,pnl,exitReason,dayVolMult,breakoutRelVol,breakoutStrengthPct,firstHourMovePct,dayMovePct,gapPct,bodyPct,consRangePct,pullbackFromHighPct,prevDayChangePct,minsFromOpen,seqIndex'];
  for (const w of winners) {
    csv.push([w.date, w.symbol, w.time, w.r?.toFixed(2), w.retPct?.toFixed(2), w.pnl, w.exitReason,
      w.dayVolMult?.toFixed(2), w.breakoutRelVol?.toFixed(2), w.breakoutStrengthPct?.toFixed(2),
      w.firstHourMovePct?.toFixed(2), w.dayMovePct?.toFixed(2), w.gapPct?.toFixed(2), w.bodyPct?.toFixed(0),
      w.consRangePct?.toFixed(2), w.pullbackFromHighPct?.toFixed(2), w.prevDayChangePct?.toFixed(2),
      w.minsFromOpen, w.seqIndex].join(','));
  }
  const out = path.join(ROOT, 'v2', 'data', `winners_${name}.csv`);
  fs.writeFileSync(out, csv.join('\n'));
  console.log(`\nWinners CSV → ${out}`);
}

function bucketReport(label, all, key, edges) {
  console.log(`\n  ${label}:`);
  for (let b = 0; b < edges.length - 1; b++) {
    const lo = edges[b], hi = edges[b + 1];
    const grp = all.filter((x) => x[key] != null && x[key] >= lo && x[key] < hi);
    if (!grp.length) continue;
    const wins = grp.filter((x) => x.r > 0).length;
    const avgR = grp.reduce((s, x) => s + x.r, 0) / grp.length;
    const hiLabel = hi >= 1e8 ? '+' : `-${hi}`;
    console.log(`    [${lo}${hiLabel}]`.padEnd(14) + `n=${String(grp.length).padStart(4)}  win%=${String((100 * wins / grp.length).toFixed(0)).padStart(3)}  avgR=${avgR.toFixed(2)}`);
  }
}

main();
