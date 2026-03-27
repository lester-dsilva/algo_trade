/**
 * Audit v2/data: for each YYYY-MM-DD folder, compare 3m + prev_day coverage vs watchlist (token-resolved).
 *
 *   node v2/scripts/auditV2Data.js
 *   node v2/scripts/auditV2Data.js --write-csv   writes v2/data/v2_missing_3m_pairs.csv
 *   node v2/scripts/auditV2Data.js --write-json  writes v2/data/v2_data_audit.json
 *
 * Uses data/.cache/instruments_nse.json when present so "expected" = symbols that fetchBacktestData would request.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  V2_DATA_DIR,
  WATCHLIST_PATH,
  loadWatchlistSymbols,
  buildSymbolTokens,
  loadInstrumentsFromCache,
  listBacktestDateDirs,
  countPrevDayRows,
  listMissing3mForDate,
} from '../lib/v2Universe.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function main() {
  const args = process.argv.slice(2);
  const writeCsv = args.includes('--write-csv');
  const writeJson = args.includes('--write-json');

  const symbols = loadWatchlistSymbols();
  const instruments = loadInstrumentsFromCache();
  if (!instruments || !Array.isArray(instruments)) {
    console.error(
      'No instruments cache at data/.cache/instruments_nse.json — run fetchBacktestData once (or any Kite script) to create it, then re-run audit.'
    );
    process.exit(1);
  }

  const symbolTokens = buildSymbolTokens(symbols, instruments);
  const unresolved = symbols.filter((s) => !symbolTokens.some((t) => t.symbol === s));

  const dateDirs = listBacktestDateDirs();
  const byDate = [];
  const csvLines = ['date,symbol'];
  let totalPairs = 0;

  for (const d of dateDirs) {
    const missing = listMissing3mForDate(d, symbolTokens);
    const prevRows = countPrevDayRows(d);
    const threeMDir = path.join(V2_DATA_DIR, d, '3m');
    let have3m = 0;
    if (fs.existsSync(threeMDir)) {
      have3m = fs.readdirSync(threeMDir).filter((f) => f.endsWith('.csv')).length;
    }
    if (missing.length > 0) {
      totalPairs += missing.length;
      byDate.push({
        date: d,
        missing3mCount: missing.length,
        have3mFiles: have3m,
        prevDayRows: prevRows,
        prevLooksIncomplete: symbolTokens.length > 0 && prevRows < Math.floor(symbolTokens.length * 0.92),
        missingSymbols: missing,
      });
      for (const sym of missing) csvLines.push(`${d},${sym}`);
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    watchlistPath: WATCHLIST_PATH,
    watchlistSymbolCount: symbols.length,
    resolvedTokenCount: symbolTokens.length,
    unresolvedFromWatchlist: unresolved,
    unresolvedCount: unresolved.length,
    dateFolderCount: dateDirs.length,
    datesWithMissing3m: byDate.length,
    missingDateSymbolPairs: totalPairs,
    byDate,
  };

  console.log('Watchlist symbols:', symbols.length);
  console.log('Resolved NSE tokens (expected 3m files per date):', symbolTokens.length);
  console.log('Unresolved CSV symbols (no token, fetch skips):', unresolved.length);
  console.log('Date folders:', dateDirs.length);
  console.log('Dates with any missing 3m:', byDate.length);
  console.log('Total missing (date,symbol) pairs:', totalPairs);
  const badPrev = byDate.filter((x) => x.prevLooksIncomplete).length;
  console.log('Dates with missing 3m AND prev_day row count < 92% of resolved:', badPrev);

  if (writeJson) {
    const out = path.join(V2_DATA_DIR, 'v2_data_audit.json');
    fs.writeFileSync(out, JSON.stringify(report, null, 2), 'utf8');
    console.log('Wrote', out);
  }

  if (writeCsv) {
    const out = path.join(V2_DATA_DIR, 'v2_missing_3m_pairs.csv');
    fs.writeFileSync(out, csvLines.join('\n'), 'utf8');
    console.log('Wrote', out, `(${csvLines.length - 1} data rows)`);
  }

  if (!writeCsv && !writeJson && totalPairs > 0) {
    console.log('\nTip: node v2/scripts/auditV2Data.js --write-csv --write-json');
    console.log('Fill:  node v2/scripts/fillV2DataGaps.js   (needs .env Kite; long run)');
  }
}

main();
