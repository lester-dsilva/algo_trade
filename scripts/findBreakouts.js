/**
 * Triangle / consolidation breakout detector.
 * Finds: consolidation (narrow range over N bars), then first close above consolidation high.
 * Entry = on breakout (or first bar that closes above); Stop = below consolidation low (pattern-based).
 * This avoids placing SL at round numbers like 313 — SL is below the pattern that broke.
 *
 * Usage: node scripts/findBreakouts.js [path] [--lookback=15] [--maxRangePct=2]
 */

import fs from 'fs';
import path from 'path';

function parseCsv(content) {
  const raw = content.replace(/^\uFEFF/, '').trim();
  const lines = raw.split(/\r?\n/);
  if (lines.length < 2) return [];
  const header = lines[0].toLowerCase().split(',').map((c) => c.trim());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split(',');
    const row = {};
    header.forEach((h, j) => { row[h] = values[j] !== undefined ? values[j].trim() : ''; });
    rows.push(row);
  }
  return rows;
}

function toNum(v) {
  const n = parseFloat(String(v).replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

function toIST(utcTime) {
  const [h, m, s] = (utcTime + '').split(':').map(Number);
  const utcMins = (h || 0) * 60 + (m || 0) + (s || 0) / 60;
  const istMins = utcMins + 5 * 60 + 30;
  const ih = Math.floor(istMins / 60) % 24;
  const im = Math.floor(istMins % 60);
  return `${String(ih).padStart(2, '0')}:${String(im).padStart(2, '0')}`;
}

function groupByDate(rows) {
  const byDate = {};
  for (const r of rows) {
    const d = (r.date || '').trim();
    if (!d) continue;
    const o = toNum(r.open), h = toNum(r.high), l = toNum(r.low), c = toNum(r.close), v = toNum(r.volume);
    if (!byDate[d]) byDate[d] = [];
    byDate[d].push({ date: d, time: (r.time || '').trim(), open: o, high: h, low: l, close: c, volume: v });
  }
  return byDate;
}

/**
 * Find consolidation then breakout. Scan full series so consolidation can span prior day (e.g. Day 9 afternoon → Day 10 open).
 * Consolidation = last `lookback` bars have range (maxHigh - minLow) <= maxRangePct% of midpoint.
 * Breakout = first bar where close > consolidation high (with optional min move from open for gap-ups).
 */
function findBreakouts(candles, lookback = 15, maxRangePct = 2) {
  const results = [];
  const seenDate = new Set();
  for (let i = lookback; i < candles.length; i++) {
    const window = candles.slice(i - lookback, i);
    const high = Math.max(...window.map((b) => b.high));
    const low = Math.min(...window.map((b) => b.low));
    const mid = (high + low) / 2;
    const rangePct = mid > 0 ? ((high - low) / mid) * 100 : 0;
    if (rangePct > maxRangePct) continue;

    const bar = candles[i];
    if (bar.close <= high) continue;

    const onePerDay = seenDate.has(bar.date);
    seenDate.add(bar.date);

    results.push({
      date: bar.date,
      time: bar.time,
      timeIST: toIST(bar.time),
      consolidationHigh: Math.round(high * 100) / 100,
      consolidationLow: Math.round(low * 100) / 100,
      rangePct: Math.round(rangePct * 100) / 100,
      breakoutClose: bar.close,
      suggestedEntry: Math.round(high * 100) / 100,
      suggestedStop: Math.round((low - 0.005 * low) * 100) / 100,
      riskPerShare: Math.round((high - low) * 100) / 100,
    });
  }
  return results;
}

function main() {
  const args = process.argv.slice(2);
  let lookback = 15;
  let maxRangePct = 2;
  let filePath = null;
  for (const a of args) {
    if (a.startsWith('--lookback=')) lookback = parseInt(a.slice(11), 10) || 15;
    else if (a.startsWith('--maxRangePct=')) maxRangePct = parseFloat(a.slice(14)) || 2;
    else if (!a.startsWith('--')) filePath = a;
  }

  const content = filePath
    ? fs.readFileSync(path.isAbsolute(filePath) ? filePath : path.join(process.cwd(), filePath), 'utf8')
    : fs.readFileSync(0, 'utf8');
  const rows = parseCsv(content);
  const normalized = rows.map((r) => ({
    date: (r.date || '').trim(),
    time: (r.time || '').trim(),
    open: toNum(r.open),
    high: toNum(r.high),
    low: toNum(r.low),
    close: toNum(r.close),
    volume: toNum(r.volume),
  })).filter((r) => r.date && r.open > 0);

  const byDate = groupByDate(normalized);
  const sortedDates = Object.keys(byDate).sort();
  const flatCandles = sortedDates.flatMap((d) => byDate[d]);
  const all = findBreakouts(flatCandles, lookback, maxRangePct);
  const onePerDay = [];
  const seen = new Set();
  for (const b of all) {
    if (seen.has(b.date)) continue;
    seen.add(b.date);
    onePerDay.push(b);
  }

  console.log('\n--- Triangle / consolidation breakout (entry on break, stop below pattern) ---\n');
  console.log('Params: lookback=' + lookback + ' bars, maxRangePct=' + maxRangePct + '%\n');
  if (all.length === 0) {
    console.log('No breakouts found. Try --maxRangePct=2.5 or --lookback=12\n');
    return;
  }
  console.log('Date       Time(IST)  Consol High  Consol Low  Entry@    Stop below   Risk/shr');
  console.log('-'.repeat(72));
  for (const b of onePerDay) {
    console.log(
      `${b.date}  ${b.timeIST.padEnd(8)}  ${String(b.consolidationHigh).padStart(10)}  ${String(b.consolidationLow).padStart(10)}  ${String(b.suggestedEntry).padStart(8)}  ${String(b.suggestedStop).padStart(10)}  ${String(b.riskPerShare).padStart(8)}`
    );
  }
  console.log('\nUse: Enter when price closes above Consol High (or on next bar). SL at Suggested Stop (below pattern), not at round numbers.\n');
}

main();
