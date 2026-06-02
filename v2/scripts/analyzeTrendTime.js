/**
 * Multi-day TREND + entry-TIME analysis of baseline trades.
 * Reconstructs a daily OHLC series per symbol by unioning prev_day_ohlc.csv across
 * all v2/data date folders, then computes trend context (multi-day returns, position
 * vs 20d high/low, distance from 20d SMA, up-day streak, daily ATR) at each trade,
 * plus fine-grained entry-time buckets. Reports win% / avg-R per bucket.
 *
 * Run from repo root:
 *   node v2/scripts/analyzeTrendTime.js [baselineName] [topN]
 */

import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const DATA_DIR = path.join(ROOT, 'v2', 'data');
const BASELINE_DIR = path.join(DATA_DIR, 'backtest_baselines');

function norm(s) { return s.toLowerCase().replace(/&/g, '').replace(/\s/g, ''); }

/** Build Map<normSymbol, sorted [{date,o,h,l,c,v}]> from all prev_day_ohlc.csv files. */
function buildDailySeries() {
  const folders = fs.readdirSync(DATA_DIR).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  const bySym = new Map();       // normSym -> Map<date, bar>  (dedup by date)
  for (const folder of folders) {
    const file = path.join(DATA_DIR, folder, 'prev_day_ohlc.csv');
    if (!fs.existsSync(file)) continue;
    const raw = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n').trim();
    const lines = raw.split('\n');
    if (lines.length < 2) continue;
    const h = lines[0].toLowerCase().split(',').map((s) => s.trim());
    const ci = { sym: h.indexOf('symbol'), date: h.indexOf('date'), o: h.indexOf('open'), hi: h.indexOf('high'), lo: h.indexOf('low'), c: h.indexOf('close'), v: h.indexOf('volume') };
    for (let i = 1; i < lines.length; i++) {
      const p = lines[i].split(',');
      const sym = p[ci.sym]?.trim(); if (!sym) continue;
      const date = p[ci.date]?.trim(); if (!date) continue;
      const n = norm(sym);
      if (!bySym.has(n)) bySym.set(n, new Map());
      const m = bySym.get(n);
      if (!m.has(date)) m.set(date, {
        date, o: +p[ci.o] || 0, h: +p[ci.hi] || 0, l: +p[ci.lo] || 0, c: +p[ci.c] || 0, v: +p[ci.v] || 0,
      });
    }
  }
  const out = new Map();
  for (const [n, m] of bySym) out.set(n, [...m.values()].sort((a, b) => a.date.localeCompare(b.date)));
  return out;
}

/** Trend features for a trade: uses daily bars strictly BEFORE the trade date. */
function trendFeatures(daily, tradeDate) {
  if (!daily || !daily.length) return null;
  const prior = daily.filter((b) => b.date < tradeDate);
  if (prior.length < 5) return null;
  const last = prior[prior.length - 1];          // = prev day (D-1)
  const closes = prior.map((b) => b.c);
  const ago = (n) => closes.length > n ? closes[closes.length - 1 - n] : null;
  const ret = (n) => { const a = ago(n); return a && a > 0 ? ((last.c - a) / a) * 100 : null; };

  const w20 = prior.slice(-20);
  const hi20 = Math.max(...w20.map((b) => b.h));
  const lo20 = Math.min(...w20.map((b) => b.l));
  const sma20 = w20.reduce((s, b) => s + b.c, 0) / w20.length;
  const sma5 = prior.slice(-5).reduce((s, b) => s + b.c, 0) / Math.min(5, prior.length);

  // up-day streak (consecutive up closes ending D-1)
  let streak = 0;
  for (let i = prior.length - 1; i > 0; i--) { if (prior[i].c > prior[i - 1].c) streak++; else break; }
  let upDays5 = 0;
  for (let i = Math.max(1, prior.length - 5); i < prior.length; i++) if (prior[i].c > prior[i - 1].c) upDays5++;

  const atr10 = prior.slice(-10).reduce((s, b) => s + (b.h - b.l), 0) / Math.min(10, prior.length);
  const atrPct = last.c > 0 ? (atr10 / last.c) * 100 : null;

  return {
    ret1: ret(1), ret3: ret(3), ret5: ret(5), ret10: ret(10), ret20: ret(20),
    pctFrom20dHigh: hi20 > 0 ? ((last.c - hi20) / hi20) * 100 : null,   // 0 = at 20d high, negative = below
    pctAbove20dLow: lo20 > 0 ? ((last.c - lo20) / lo20) * 100 : null,
    distFromSMA20: sma20 > 0 ? ((last.c - sma20) / sma20) * 100 : null,  // extension above/below 20d mean
    sma5vs20: sma20 > 0 ? ((sma5 - sma20) / sma20) * 100 : null,         // short vs long MA (trend slope proxy)
    upDayStreak: streak, upDays5, atrPct,
  };
}

function bucketReport(label, rows, key, edges, d = 1) {
  console.log(`\n  ${label}:`);
  for (let b = 0; b < edges.length - 1; b++) {
    const lo = edges[b], hi = edges[b + 1];
    const grp = rows.filter((x) => x[key] != null && x[key] >= lo && x[key] < hi);
    if (!grp.length) continue;
    const wins = grp.filter((x) => x.r > 0).length;
    const avgR = grp.reduce((s, x) => s + x.r, 0) / grp.length;
    const loL = lo <= -1e8 ? '-inf' : lo.toFixed(d).replace(/\.0$/, '');
    const hiL = hi >= 1e8 ? '+inf' : hi.toFixed(d).replace(/\.0$/, '');
    console.log(`    [${loL},${hiL})`.padEnd(18) + `n=${String(grp.length).padStart(4)}  win%=${String((100 * wins / grp.length).toFixed(0)).padStart(3)}  avgR=${avgR.toFixed(2)}`);
  }
}

function timeBucketReport(rows) {
  console.log('\n  Entry time (IST):');
  const edges = ['09:15', '10:15', '10:45', '11:15', '11:45', '12:15', '12:31'];
  for (let b = 0; b < edges.length - 1; b++) {
    const lo = edges[b], hi = edges[b + 1];
    const grp = rows.filter((x) => x.time >= lo && x.time < hi);
    if (!grp.length) continue;
    const wins = grp.filter((x) => x.r > 0).length;
    const avgR = grp.reduce((s, x) => s + x.r, 0) / grp.length;
    const totR = grp.reduce((s, x) => s + x.r, 0);
    console.log(`    ${lo}-${hi}`.padEnd(16) + `n=${String(grp.length).padStart(4)}  win%=${String((100 * wins / grp.length).toFixed(0)).padStart(3)}  avgR=${avgR.toFixed(2)}  totalR=${totR.toFixed(0)}`);
  }
}

function main() {
  const name = process.argv[2] || 'baseline';
  const topN = parseInt(process.argv[3] || '120', 10);
  const baseline = JSON.parse(fs.readFileSync(path.join(BASELINE_DIR, `${name}.json`), 'utf8'));
  const trades = baseline.trades || [];
  console.error('Building daily series from prev_day_ohlc across folders...');
  const daily = buildDailySeries();
  console.error(`Daily series for ${daily.size} symbols. Computing trend features for ${trades.length} trades...`);

  const rows = [];
  for (const t of trades) {
    const risk = t.entry - t.stop;
    const r = risk > 0 ? (t.exitPrice - t.entry) / risk : null;
    if (r == null) continue;
    const tf = trendFeatures(daily.get(norm(t.symbol)), t.date);
    rows.push({ ...t, r, time: (t.time || '').slice(0, 5), ...(tf || {}) });
  }
  const withTrend = rows.filter((x) => x.ret5 != null);
  console.error(`${withTrend.length}/${rows.length} trades have trend data.\n`);

  // winners vs rest summary
  const sorted = [...rows].sort((a, b) => b.r - a.r);
  const winners = sorted.slice(0, topN);
  const rest = sorted.slice(topN);
  const stat = (arr, k) => { const v = arr.map((x) => x[k]).filter((x) => x != null && Number.isFinite(x)).sort((a, b) => a - b); return v.length ? { med: v[Math.floor(v.length / 2)], mean: v.reduce((a, b) => a + b, 0) / v.length } : null; };
  const cmp = (label, k) => {
    const w = stat(winners, k), r = stat(rest, k);
    if (!w || !r) return;
    console.log(`  ${label.padEnd(24)} WIN med=${w.med.toFixed(1).padStart(7)} mean=${w.mean.toFixed(1).padStart(7)}   REST med=${r.med.toFixed(1).padStart(7)} mean=${r.mean.toFixed(1).padStart(7)}`);
  };
  console.log(`=== Winners (top ${topN} by R) vs rest — TREND ===`);
  cmp('5-day return %', 'ret5');
  cmp('10-day return %', 'ret10');
  cmp('20-day return %', 'ret20');
  cmp('% from 20d high', 'pctFrom20dHigh');
  cmp('% above 20d low', 'pctAbove20dLow');
  cmp('dist from 20d SMA %', 'distFromSMA20');
  cmp('SMA5 vs SMA20 %', 'sma5vs20');
  cmp('up-day streak', 'upDayStreak');
  cmp('up days (last 5)', 'upDays5');
  cmp('daily ATR %', 'atrPct');

  console.log('\n=== Win% / avg-R by bucket (all trades with trend) ===');
  bucketReport('5-day return % (pre-entry momentum)', withTrend, 'ret5', [-1e9, -5, 0, 5, 10, 20, 1e9]);
  bucketReport('20-day return %', withTrend, 'ret20', [-1e9, -10, 0, 10, 25, 50, 1e9]);
  bucketReport('% from 20-day high (0=at high)', withTrend, 'pctFrom20dHigh', [-1e9, -15, -8, -4, -1, 0.5, 1e9]);
  bucketReport('dist from 20d SMA % (extension)', withTrend, 'distFromSMA20', [-1e9, -5, 0, 5, 12, 25, 1e9]);
  bucketReport('SMA5 vs SMA20 % (trend slope)', withTrend, 'sma5vs20', [-1e9, -3, 0, 3, 8, 1e9]);
  bucketReport('up-day streak into entry', withTrend, 'upDayStreak', [0, 1, 2, 3, 4, 1e9], 0);
  bucketReport('daily ATR % (volatility)', withTrend, 'atrPct', [0, 2, 3, 4, 6, 1e9]);

  console.log('\n=== Entry TIME ===');
  timeBucketReport(rows);
}

main();
