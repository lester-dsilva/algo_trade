/**
 * Find entries: reversal breakout only (sharp up → pullback to/near 20 EMA → breakout of consolidation).
 * Primary TF = 3m. Optional --ltf=<path> for 1m refinement of entry time.
 *
 * Usage: node scripts/findEntries.js [path] [--ltf=data/xxx_1m.csv]
 */

import fs from 'fs';
import path from 'path';
import {
  toNum,
  groupByDate,
  findMomentumBreakouts,
  refineWith1m,
} from '../lib/entryLogic.js';

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

function main() {
  const args = process.argv.slice(2);
  let filePath = null;
  let ltfPath = null;
  for (const a of args) {
    if (a.startsWith('--ltf=')) ltfPath = a.slice(6).trim() || null;
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

  const reversalBreakouts = findMomentumBreakouts(byDate, sortedDates);

  console.log('\n--- Momentum breakout entries (4% sharp move → structure → volumetric breakout above resistance) ---\n');
  if (reversalBreakouts.length === 0) {
    console.log('None found.\n');
  } else {
    console.log('Date       Time(IST)  Close   Suggested stop');
    console.log('-'.repeat(50));
    for (const r of reversalBreakouts) {
      console.log(
        `${r.date}  ${r.timeIST.padEnd(8)}  ${String(r.close).padStart(6)}  ${String(r.suggestedStop).padStart(8)}`
      );
      if (byDateLtf) {
        const refined = refineWith1m(r.date, r.time, byDateLtf);
        if (refined) {
          console.log(`  Refined (1m): ${refined.date} ${refined.timeIST} close ${refined.close}`);
        }
      }
    }
    console.log('\nEnter at/after 3m bar. SL at Suggested stop (below structure low). Use 1m to refine exact bar.\n');
  }
}

main();
