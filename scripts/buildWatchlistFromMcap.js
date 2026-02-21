/**
 * Filter NSE symbols by market cap (from NSE market cap file in lakhs).
 * Usage: node scripts/buildWatchlistFromMcap.js [path-to.tsv] [minCr]
 *   path-to.tsv  TSV with Symbol and market cap column (Rs. in lakhs). Default: data/nse_mcap_lakhs.tsv
 *   minCr        Min market cap in Crore (default 900). 900 Cr = 90,000 lakhs.
 * Writes: config/nse_mcap_above_900cr.csv with column tradingsymbol
 */

import fs from 'fs';
import path from 'path';

const defaultPath = path.join(process.cwd(), 'data', 'nse_mcap_lakhs.tsv');
const defaultMinCr = 900;
const outPath = path.join(process.cwd(), 'config', 'nse_mcap_above_900cr.csv');

function main() {
  const filePath = process.argv[2] || defaultPath;
  const minCr = Number(process.argv[3]) || defaultMinCr;
  const minLakhs = minCr * 100; // 1 Cr = 100 lakhs

  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n').trim();
  } catch (e) {
    console.error('Error reading file:', filePath);
    console.error('Save your NSE market cap file (Symbol + mcap in lakhs) as data/nse_mcap_lakhs.tsv');
    process.exit(1);
  }

  const lines = raw.split('\n');
  if (lines.length < 2) {
    console.error('File needs at least a header and one data row.');
    process.exit(1);
  }

  const header = lines[0].split('\t');
  const symbolIdx = header.findIndex((h) => /symbol/i.test(h));
  const mcapIdx = header.findIndex((h) => /lakh|lac|market|capital|average/i.test(h));
  const symCol = symbolIdx >= 0 ? symbolIdx : 0;
  const mcapCol = mcapIdx >= 0 ? mcapIdx : 1;

  const symbols = [];
  for (let i = 1; i < lines.length; i++) {
    const row = lines[i].split('\t');
    const sym = (row[symCol] || '').trim();
    const val = parseFloat(String(row[mcapCol] || '0').replace(/,/g, ''));
    if (sym && Number.isFinite(val) && val >= minLakhs) symbols.push(sym);
  }

  const csv = 'tradingsymbol\n' + symbols.map((s) => s).join('\n');
  fs.writeFileSync(outPath, csv, 'utf8');
  console.error('Wrote', symbols.length, 'symbols (mcap >=', minCr, 'Cr) to', outPath);
}

main();
