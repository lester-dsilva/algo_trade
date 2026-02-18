/**
 * Find entries: (1) Triangle/consolidation breakout, (2) Pullback to 20 EMA, (3) Reversal breakout.
 * Primary TF = 3m. Optional --ltf=<path> for 1m refinement of entry time.
 *
 * Usage: node scripts/findEntries.js [path] [--tolerance=1] [--lookback=15] [--maxRangePct=2] [--ltf=data/xxx_1m.csv]
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

// CSV from kiteOHLC is in IST (market time). Show time as HH:MM.
function formatTime(timeStr) {
  return (timeStr || '').slice(0, 5) || '--:--';
}

function groupByDate(rows) {
  const byDate = {};
  for (const r of rows) {
    const d = (r.date || '').trim();
    if (!d) continue;
    const o = toNum(r.open), h = toNum(r.high), l = toNum(r.low), c = toNum(r.close), v = toNum(r.volume);
    if (!byDate[d]) byDate[d] = [];
    byDate[d].push({ ...r, date: d, time: (r.time || '').trim(), open: o, high: h, low: l, close: c, volume: v });
  }
  return byDate;
}

function ema(candles, key = 'close', period = 20) {
  const mult = 2 / (period + 1);
  const out = [];
  let prev = null;
  for (let i = 0; i < candles.length; i++) {
    const v = candles[i][key];
    if (typeof v !== 'number' || !Number.isFinite(v)) { out.push(null); continue; }
    if (prev == null) {
      if (i < period - 1) { out.push(null); continue; }
      let sum = 0;
      for (let j = 0; j < period; j++) sum += candles[j][key];
      prev = sum / period;
    } else {
      prev = (v - prev) * mult + prev;
    }
    out.push(prev);
  }
  return out;
}

// ---- Breakout: consolidation then first close above consolidation high ----
function findBreakoutsOnePerDay(flatCandles, lookback, maxRangePct) {
  const results = [];
  const seenDate = new Set();
  for (let i = lookback; i < flatCandles.length; i++) {
    const window = flatCandles.slice(i - lookback, i);
    const high = Math.max(...window.map((b) => b.high));
    const low = Math.min(...window.map((b) => b.low));
    const mid = (high + low) / 2;
    const rangePct = mid > 0 ? ((high - low) / mid) * 100 : 0;
    if (rangePct > maxRangePct) continue;

    const bar = flatCandles[i];
    if (bar.close <= high) continue;
    if (seenDate.has(bar.date)) continue;
    seenDate.add(bar.date);

    results.push({
      type: 'BREAKOUT',
      date: bar.date,
      time: bar.time,
      timeIST: formatTime(bar.time),
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

// ---- Pullback: near or undercut of 20 EMA after momentum (max 2 per day to keep output small) ----
function findPullbacks(byDate, tolerancePct, maxPerDay = 2) {
  const entries = [];
  for (const date of Object.keys(byDate).sort()) {
    const candles = byDate[date];
    const ema20 = ema(candles, 'close', 20);
    const dayOpen = candles[0].open;
    let highSoFar = dayOpen;
    let count = 0;

    for (let i = 0; i < candles.length && count < maxPerDay; i++) {
      const c = candles[i];
      const e = ema20[i];
      if (e == null || c.close <= 0) continue;
      highSoFar = Math.max(highSoFar, c.high);
      const moveFromOpenPct = ((highSoFar - dayOpen) / dayOpen) * 100;
      const distPct = (Math.abs(c.close - e) / e) * 100;
      const undercut = c.low < e && c.close >= e;
      const nearEMA = distPct <= tolerancePct;

      if ((nearEMA || undercut) && moveFromOpenPct >= 0.5 && i >= 20) {
        entries.push({
          type: 'PULLBACK',
          date,
          time: c.time,
          timeIST: formatTime(c.time),
          close: c.close,
          ema20: Math.round(e * 100) / 100,
          distPct: Math.round(distPct * 100) / 100,
          undercut,
          moveFromOpenPct: Math.round(moveFromOpenPct * 100) / 100,
        });
        count++;
      }
    }
  }
  return entries;
}

// ---- Reversal breakout: sharp up move → pullback into/near 20 EMA → enter on breakout of pullback consolidation ----
function findReversalBreakouts(byDate, sortedDates, sharpMovePct = 4, pullbackNearPct = 2) {
  const results = [];
  for (const date of sortedDates) {
    const candles = byDate[date];
    if (!candles || candles.length < 21) continue;

    const dayOpen = candles[0].open;
    const ema20 = ema(candles, 'close', 20);
    let dayLowSoFar = candles[0].low;

    // 1) Sharp up move after open (within first 30 bars)
    let iSharp = -1;
    let highSoFar = dayOpen;
    for (let i = 0; i < Math.min(30, candles.length); i++) {
      highSoFar = Math.max(highSoFar, candles[i].high);
      if (dayOpen > 0 && (highSoFar - dayOpen) / dayOpen >= sharpMovePct / 100) {
        iSharp = i;
        break;
      }
    }
    if (iSharp < 0) continue;

    // 2) Pullback into or near 20 EMA: run of bars where price is near EMA; then entry = first close above consolidation high
    let pullbackStart = -1;
    let consHigh = -Infinity;
    let consLow = Infinity;

    for (let i = 20; i < candles.length; i++) {
      const c = candles[i];
      const e = ema20[i];
      if (e == null || e <= 0) continue;
      dayLowSoFar = Math.min(dayLowSoFar, c.low);

      const distPct = Math.abs(c.close - e) / e * 100;
      const touchesEma = c.low <= e * (1 + pullbackNearPct / 100) && c.high >= e * (1 - pullbackNearPct / 100);
      const nearEma = distPct <= pullbackNearPct || touchesEma;

      // Entry: first bar that closes above pullback consolidation high AND above 20 EMA (need at least 2 bars in pullback)
      const runLen = pullbackStart >= 0 ? i - pullbackStart : 0;
      if (runLen >= 2 && c.close > consHigh && c.close > e) {
        const suggestedStop = Math.round((Math.min(consLow, dayLowSoFar) - 0.005 * consLow) * 100) / 100;
        results.push({
          type: 'REVERSAL_BREAKOUT',
          date,
          time: c.time,
          timeIST: formatTime(c.time),
          close: Math.round(c.close * 100) / 100,
          ema20: Math.round(e * 100) / 100,
          consHigh: Math.round(consHigh * 100) / 100,
          suggestedStop,
        });
        break;
      }

      if (nearEma) {
        if (pullbackStart < 0) pullbackStart = i;
        consHigh = Math.max(consHigh, c.high);
        consLow = Math.min(consLow, c.low);
      } else if (pullbackStart >= 0) {
        pullbackStart = -1;
        consHigh = -Infinity;
        consLow = Infinity;
      }
    }
  }
  return results;
}

// ---- 1m refinement: first 1m bar in 3m window where close > EMA20 ----
function timeToMins(timeStr) {
  const parts = (timeStr || '').split(':').map(Number);
  return (parts[0] || 0) * 60 + (parts[1] || 0) + (parts[2] || 0) / 60;
}

function refineWith1m(date, time3m, byDateLtf) {
  if (!byDateLtf || !byDateLtf[date]) return null;
  const candles = byDateLtf[date];
  const ema20 = ema(candles, 'close', 20);
  const startMins = timeToMins(time3m);
  const endMins = startMins + 3;

  for (let i = 0; i < candles.length; i++) {
    const bar = candles[i];
    const barMins = timeToMins(bar.time);
    if (barMins < startMins || barMins >= endMins) continue;
    if (ema20[i] == null || bar.close <= ema20[i]) continue;
    return {
      date: bar.date,
      time: bar.time,
      timeIST: formatTime(bar.time),
      close: Math.round(bar.close * 100) / 100,
    };
  }
  return null;
}

function main() {
  const args = process.argv.slice(2);
  let tolerancePct = 1;
  let lookback = 15;
  let maxRangePct = 2;
  let filePath = null;
  let ltfPath = null;
  for (const a of args) {
    if (a.startsWith('--tolerance=')) tolerancePct = parseFloat(a.slice(12)) || 1;
    else if (a.startsWith('--lookback=')) lookback = parseInt(a.slice(11), 10) || 15;
    else if (a.startsWith('--maxRangePct=')) maxRangePct = parseFloat(a.slice(14)) || 2;
    else if (a.startsWith('--ltf=')) ltfPath = a.slice(6).trim() || null;
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

  let byDateLtf = null;
  if (ltfPath) {
    const ltfContent = fs.readFileSync(path.isAbsolute(ltfPath) ? ltfPath : path.join(process.cwd(), ltfPath), 'utf8');
    const ltfRows = parseCsv(ltfContent);
    const ltfNormalized = ltfRows.map((r) => ({
      date: (r.date || '').trim(),
      time: (r.time || '').trim(),
      open: toNum(r.open),
      high: toNum(r.high),
      low: toNum(r.low),
      close: toNum(r.close),
      volume: toNum(r.volume),
    })).filter((r) => r.date && r.open > 0);
    byDateLtf = groupByDate(ltfNormalized);
  }

  const breakouts = findBreakoutsOnePerDay(flatCandles, lookback, maxRangePct);
  const pullbacks = findPullbacks(byDate, tolerancePct);
  const reversalBreakouts = findReversalBreakouts(byDate, sortedDates);

  // ---- Section 1: Triangle breakout ----
  console.log('\n--- 1) Triangle / consolidation breakout (entry on break, stop below pattern) ---');
  console.log('Params: lookback=' + lookback + ', maxRangePct=' + maxRangePct + '%\n');
  if (breakouts.length === 0) {
    console.log('None found. Try --maxRangePct=2.5 or --lookback=12\n');
  } else {
    console.log('Date       Time(IST)  Consol High  Consol Low  Entry@    Stop below   Risk/shr');
    console.log('-'.repeat(72));
    for (const b of breakouts) {
      console.log(
        `${b.date}  ${b.timeIST.padEnd(8)}  ${String(b.consolidationHigh).padStart(10)}  ${String(b.consolidationLow).padStart(10)}  ${String(b.suggestedEntry).padStart(8)}  ${String(b.suggestedStop).padStart(10)}  ${String(b.riskPerShare).padStart(8)}`
      );
    }
    console.log('\nEnter when close > Consol High. SL at Stop below (below pattern), not at round numbers.\n');
  }

  // ---- Section 2: Pullback to EMA ----
  console.log('--- 2) Pullback to / undercut of 20 EMA (after momentum) ---');
  console.log('Params: tolerance=' + tolerancePct + '%\n');
  if (pullbacks.length === 0) {
    console.log('None found. Try --tolerance=2\n');
  } else {
    console.log('Date       Time(IST)  Close   EMA(20)  Dist%   Under cut?  Move from open%');
    console.log('-'.repeat(70));
    for (const e of pullbacks) {
      console.log(
        `${e.date}  ${e.timeIST.padEnd(8)}  ${String(e.close).padStart(6)}  ${String(e.ema20).padStart(6)}  ${String(e.distPct).padStart(5)}%  ${e.undercut ? 'Yes' : 'No'}          ${e.moveFromOpenPct}%`
      );
    }
    console.log('\nEnter around time at/near Close. SL below pullback low or below EMA.\n');
  }

  // ---- Section 3: Reversal breakout (sharp up → pullback to/near 20 EMA → breakout of consolidation) ----
  console.log('--- 3) Reversal breakout (sharp up → pullback to/near 20 EMA → breakout of consolidation) ---\n');
  if (reversalBreakouts.length === 0) {
    console.log('None found (need sharp up move, pullback to/near 20 EMA, then breakout of consolidation).\n');
  } else {
    console.log('Date       Time(IST)  Close   EMA(20)  ConsHigh  Suggested stop');
    console.log('-'.repeat(65));
    for (const r of reversalBreakouts) {
      console.log(
        `${r.date}  ${r.timeIST.padEnd(8)}  ${String(r.close).padStart(6)}  ${String(r.ema20).padStart(6)}  ${String(r.consHigh ?? '').padStart(7)}  ${String(r.suggestedStop).padStart(8)}`
      );
      if (byDateLtf) {
        const refined = refineWith1m(r.date, r.time, byDateLtf);
        if (refined) {
          console.log(`  Refined (1m): ${refined.date} ${refined.timeIST} close ${refined.close}`);
        }
      }
    }
    console.log('\nEnter at/after 3m bar. SL at Suggested stop (below bar/day low). Use 1m to refine exact bar.\n');
  }
}

main();
