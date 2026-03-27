/**
 * One Kite session: for each v2/data/YYYY-MM-DD folder with missing 3m files, run the same fetch as fetchBacktestData.js.
 *
 *   node v2/scripts/fillV2DataGaps.js              all dates with gaps
 *   node v2/scripts/fillV2DataGaps.js --dry-run    print plan only
 *   node v2/scripts/fillV2DataGaps.js --from 2025-01-01 --to 2025-12-31
 *   node v2/scripts/fillV2DataGaps.js --from 2024-01-01 --to 2024-12-31 --rps 2
 *   node v2/scripts/fillV2DataGaps.js --limit 5   first 5 dates only (smoke test)
 *
 * When both --from and --to are set, every Mon–Fri in that range is considered (folders are
 * created on first fetch). With only one of them, existing v2/data date dirs are filtered.
 *
 * --rps N  — historical API starts per second (overrides V2_KITE_HISTORICAL_RPS; default 3).
 *
 * Also passes refreshPrevIfIncomplete so thin prev_day_ohlc.csv files are rebuilt.
 */

import 'dotenv/config';
import { getKite } from '../../lib/kite.js';
import { fetchBacktestDataForDate, createStartRateLimiter } from './fetchBacktestData.js';
import {
  V2_DATA_DIR,
  listBacktestDateDirs,
  listMissing3mForDate,
  loadWatchlistSymbols,
  buildSymbolTokens,
  loadInstrumentsFromCache,
} from '../lib/v2Universe.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const INSTRUMENTS_CACHE = path.join(ROOT, 'data', '.cache', 'instruments_nse.json');

async function getInstruments(kite) {
  const cacheFile = INSTRUMENTS_CACHE;
  try {
    if (fs.existsSync(cacheFile)) {
      const age = Date.now() - fs.statSync(cacheFile).mtimeMs;
      if (age < 24 * 60 * 60 * 1000) {
        process.stderr.write('[fillV2DataGaps] instruments: using cache\n');
        return JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      }
    }
  } catch (_) {}
  process.stderr.write('[fillV2DataGaps] instruments: fetching from API...\n');
  const data = await kite.getInstruments('NSE');
  try {
    const dir = path.dirname(cacheFile);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify(data), 'utf8');
  } catch (_) {}
  return data;
}

function argVal(name) {
  const i = process.argv.indexOf(name);
  if (i === -1 || i + 1 >= process.argv.length) return null;
  return process.argv[i + 1];
}

async function main() {
  const dry = process.argv.includes('--dry-run');
  const from = argVal('--from');
  const to = argVal('--to');
  const limitArg = argVal('--limit');
  const limit = limitArg ? parseInt(limitArg, 10) : null;

  const symbols = loadWatchlistSymbols();
  if (symbols.length === 0) {
    console.error('Empty watchlist.');
    process.exit(1);
  }

  let dates = listBacktestDateDirs();
  if (from) dates = dates.filter((d) => d >= from);
  if (to) dates = dates.filter((d) => d <= to);

  let kite;
  let instruments;
  if (dry) {
    instruments = loadInstrumentsFromCache();
    if (!instruments) {
      console.error('Dry-run needs data/.cache/instruments_nse.json (refresh via any Kite fetch).');
      process.exit(1);
    }
  } else {
    console.error('[fillV2DataGaps] Connecting to Kite...');
    kite = await getKite();
    instruments = await getInstruments(kite);
  }
  const symbolTokens = buildSymbolTokens(symbols, instruments);
  console.error(`[fillV2DataGaps] Resolved ${symbolTokens.length} tokens; scanning dates...`);

  const todo = [];
  for (const d of dates) {
    const missing = listMissing3mForDate(d, symbolTokens);
    if (missing.length === 0) continue;
    let have3m = 0;
    const dir3m = path.join(V2_DATA_DIR, d, '3m');
    try {
      if (fs.existsSync(dir3m)) {
        have3m = fs.readdirSync(dir3m).filter((f) => f.endsWith('.csv')).length;
      }
    } catch (_) {}
    todo.push({ date: d, missing: missing.length, have3m });
  }

  // Prefer dates that already have some 3m files (real sessions); holiday folders often have 0 intraday bars for all symbols.
  todo.sort((a, b) => {
    const aPartial = a.have3m > 0 ? 1 : 0;
    const bPartial = b.have3m > 0 ? 1 : 0;
    if (bPartial !== aPartial) return bPartial - aPartial;
    return a.missing - b.missing;
  });

  if (limit != null && !Number.isNaN(limit)) {
    todo.splice(limit);
  }

  console.error(`[fillV2DataGaps] Dates to process: ${todo.length}${dry ? ' (dry-run)' : ''}`);
  for (const t of todo) {
    console.error(`  ${t.date}  missing_3m=${t.missing}  have_3m=${t.have3m}`);
  }

  if (dry || todo.length === 0) {
    process.exit(0);
  }

  const rps = Number(process.env.V2_KITE_HISTORICAL_RPS);
  const historicalRps = Number.isFinite(rps) && rps > 0 ? rps : 3;
  const histRun = createStartRateLimiter(historicalRps);
  console.error(
    `[fillV2DataGaps] Shared historical API limiter: ${historicalRps} calls/sec (V2_KITE_HISTORICAL_RPS)`
  );

  let i = 0;
  for (const { date } of todo) {
    i++;
    console.error(`\n[fillV2DataGaps] === ${i}/${todo.length} ${date} ===`);
    await fetchBacktestDataForDate(date, {
      force: false,
      refreshPrevIfIncomplete: true,
      kite,
      instruments,
      histRun,
    });
  }

  console.error('\n[fillV2DataGaps] All requested dates finished. Re-run: node v2/scripts/auditV2Data.js');
}

main().catch((e) => {
  console.error(e?.message || e);
  process.exit(1);
});
