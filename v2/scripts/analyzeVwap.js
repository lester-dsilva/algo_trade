/**
 * Intraday VWAP extension R&D: does buying far ABOVE the day's VWAP fade?
 * VWAP anchored at 09:15 (volume-weighted typical price) up to the entry bar; measures how far the
 * entry price sits above it, buckets win%/avg-R, and reports a ceiling's cost split train/test.
 *
 * Run from repo root:  node v2/scripts/analyzeVwap.js [baselineName]   (default: fuck2)
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { load3mForSymbol } from '../lib/loadBacktestData.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const norm = (s) => s.toLowerCase().replace(/&/g, '').replace(/\s/g, '');
const name = process.argv[2] || 'fuck2';
const baseline = JSON.parse(fs.readFileSync(path.join(ROOT, 'v2', 'data', 'backtest_baselines', `${name}.json`), 'utf8'));

const rows = [];
for (const t of baseline.trades || []) {
  const bars = load3mForSymbol(t.date, t.symbol);
  if (!bars || !bars.length) continue;
  const tt = (t.time || '').slice(0, 5);
  const ei = bars.findIndex((b) => (b.time || '').slice(0, 5) === tt);
  if (ei < 0) continue;
  const risk = t.entry - t.stop;
  const r = risk > 0 ? (t.exitPrice - t.entry) / risk : null;
  if (r == null) continue;
  let pv = 0, vv = 0;
  for (let k = 0; k <= ei; k++) { const b = bars[k]; const tp = (b.high + b.low + b.close) / 3; pv += tp * (b.volume || 0); vv += (b.volume || 0); }
  const vwap = vv > 0 ? pv / vv : null;
  rows.push({ symbol: t.symbol, date: t.date, time: tt, r, pnl: t.pnl, distVwap: vwap ? ((t.entry - vwap) / vwap) * 100 : null });
}
console.log(`Baseline ${name}: ${rows.length} trades with VWAP\n`);
for (const x of rows.filter((x) => norm(x.symbol).includes('izmo')))
  console.log(`IZMO ${x.date} ${x.time}  distVWAP=${x.distVwap?.toFixed(1)}%  R=${x.r.toFixed(2)}`);

function bucket(label, key, edges) {
  console.log(`\n${label}:`);
  const v = rows.filter((x) => x[key] != null);
  for (let i = 0; i < edges.length - 1; i++) {
    const lo = edges[i], hi = edges[i + 1];
    const g = v.filter((x) => x[key] >= lo && x[key] < hi);
    if (!g.length) continue;
    const w = g.filter((x) => x.r > 0).length;
    const avgR = g.reduce((s, x) => s + x.r, 0) / g.length;
    const tr = g.reduce((s, x) => s + x.r, 0);
    const loL = lo <= -1e8 ? '-inf' : `${lo}%`, hiL = hi >= 1e8 ? '+inf' : `${hi}%`;
    console.log(`  [${loL},${hiL})`.padEnd(16) + `n=${String(g.length).padStart(4)} win%=${String((100 * w / g.length).toFixed(0)).padStart(3)} avgR=${avgR.toFixed(2)} totalR=${tr.toFixed(0)}`);
  }
}
bucket('ENTRY distance above VWAP', 'distVwap', [-1e9, 1, 2, 3, 4, 5, 6, 8, 1e9]);

const SPLIT = '2025-07';
console.log('\nVWAP ceiling cost (remove trades >= cap), split train/test:');
for (const cap of [3, 4, 5, 6]) {
  for (const [lbl, f] of [['TRAIN', (x) => x.date < SPLIT], ['TEST ', (x) => x.date >= SPLIT]]) {
    const seg = rows.filter(f);
    const rem = seg.filter((x) => x.distVwap >= cap), kept = seg.filter((x) => x.distVwap < cap);
    const remR = rem.reduce((s, x) => s + x.r, 0), keptR = kept.reduce((s, x) => s + x.r, 0);
    const remWin = rem.length ? (100 * rem.filter((x) => x.r > 0).length / rem.length).toFixed(0) : '-';
    console.log(`  cap ${cap}% ${lbl}: remove ${String(rem.length).padStart(3)} (win${String(remWin).padStart(3)}, R${remR.toFixed(0)}) | keep ${String(kept.length).padStart(3)} (R${keptR.toFixed(0)})`);
  }
}
