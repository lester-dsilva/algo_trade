/**
 * Load / verify the backtest PREREQUISITE data up to a given date.
 *
 * Prereqs = the market-regime index files the smallcap gates need, rebuilt from scratch each run:
 *   - v2/data/smallcap100_daily.json   (Smallcap-100 official daily closes; token 267017)
 *   - v2/data/smallcap100_3m.json      (Smallcap-100 3-minute bars; token 267017)
 * These are NOT the per-stock OHLC/3m folders (v2/data/YYYY-MM-DD/) — those are loaded separately
 * (dashboard month/date loaders). This script refreshes the index files, verifies the regime maps
 * resolve through the target date, then AUDITS which stock-data day folders are still missing so you
 * know what to load next. It never fetches per-stock data.
 *
 * Usage:  node v2/scripts/loadPrereqData.js <YYYY-MM-DD>
 *   e.g.  node v2/scripts/loadPrereqData.js 2026-08-21
 * Run from repo root.
 */

import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const DATA_DIR = path.join(ROOT, 'v2', 'data');
const HISTORY_START = '2023-10-01'; // smallcap index history anchor (rebuilt in full each run)
const SMALLCAP_TOKEN = '267017';

function fail(msg) {
  console.error(`\n✖ ${msg}`);
  process.exit(1);
}

// ---- args -----------------------------------------------------------------
const target = (process.argv[2] || '').trim();
if (!/^\d{4}-\d{2}-\d{2}$/.test(target)) {
  fail('Pass a target date: node v2/scripts/loadPrereqData.js <YYYY-MM-DD>');
}

// ---- kite session freshness ----------------------------------------------
// The fetch needs a valid access token. Tokens are day-scoped, so warn (don't block) if the saved
// session was not created on the target date's IST day — a stale token makes the fetch fail at auth.
function checkSession() {
  const f = path.join(ROOT, '.kite_session');
  if (!fs.existsSync(f)) return console.warn('⚠ no .kite_session found — fetch will fail if not logged in (npm run kite:login).');
  try {
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    const loginDay = (j.login_time || '').slice(0, 10); // stored as ISO
    console.error(`kite session login_time: ${j.login_time || 'unknown'}`);
    if (loginDay && loginDay !== target) {
      console.warn(`⚠ session was created ${loginDay}, target is ${target}. If the fetch 401s, re-run: npm run kite:login`);
    }
  } catch {
    console.warn('⚠ .kite_session unparseable — re-login if the fetch fails at auth.');
  }
}

// ---- fetch one index file (reuses scripts/fetchNiftyHourly.js) ------------
function fetchIndex(outName, interval) {
  console.error(`\n▶ fetching ${outName} (${interval}) ${HISTORY_START}..${target}`);
  const r = spawnSync(
    'node',
    ['scripts/fetchNiftyHourly.js', HISTORY_START, target, SMALLCAP_TOKEN, outName, interval],
    { cwd: ROOT, stdio: 'inherit' }
  );
  if (r.status !== 0) fail(`fetch failed for ${outName} (exit ${r.status}). Check kite login and retry.`);
}

// ---- verify regime maps resolve through target ----------------------------
async function verify() {
  // import after fetch so the fresh files are read
  const { loadSmallcapRegime, loadSmallcapDailyTrend } = await import('../lib/loadBacktestData.js');
  const regime = loadSmallcapRegime();
  const daily = loadSmallcapDailyTrend();
  if (!regime || !daily) fail('regime/daily map failed to build after fetch — index JSON missing or malformed.');
  const regimeLast = [...regime.keys()].sort().at(-1);
  const dailyLast = [...daily.keys()].sort().at(-1);
  console.error(`\nregime last date: ${regimeLast}   daily-trend last date: ${dailyLast}`);
  if (regimeLast > target || dailyLast > target) fail('map contains dates after target — unexpected.');
  // the last available trading day should be at/just-before target (weekends/holidays => strictly before)
  const lastRow = daily.get(dailyLast);
  console.error(`last daily-trend row (${dailyLast}): ${JSON.stringify(lastRow)}`);
  const bars = regime.get(regimeLast)?.bars?.length ?? 0;
  if (bars < 100) console.warn(`⚠ only ${bars} intraday bars on ${regimeLast} (expected ~125) — partial trading day?`);
  return { regimeLast, dailyLast };
}

// ---- audit per-stock day folders in range --------------------------------
// Authoritative trading-day list = dates present in the smallcap 3m index (it trades every session).
// A stock day folder is "ready" when it has a 3m/ dir with at least one csv (matches hasBacktestData).
function auditStockFolders(rangeStart) {
  const idx = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'smallcap100_3m.json'), 'utf8'));
  const tradingDays = [...new Set(idx.candles.map((c) => c.date))].sort().filter((d) => d >= rangeStart && d <= target);
  const missing = [];
  for (const d of tradingDays) {
    const dir = path.join(DATA_DIR, d, '3m');
    const ready = fs.existsSync(dir) && fs.readdirSync(dir).some((f) => f.endsWith('.csv'));
    if (!ready) missing.push(d);
  }
  return { tradingDays, missing };
}

// ---- main -----------------------------------------------------------------
checkSession();
fetchIndex('smallcap100_daily.json', 'day');
fetchIndex('smallcap100_3m.json', '3minute');
const { dailyLast } = await verify();

// audit stock folders over the last ~2 months up to target (enough to surface recent gaps)
const auditStart = (() => {
  const d = new Date(target + 'T00:00:00Z');
  d.setUTCMonth(d.getUTCMonth() - 2);
  return d.toISOString().slice(0, 10);
})();
const { tradingDays, missing } = auditStockFolders(auditStart);

console.error('\n────────────────────────────────────────');
console.error(`✓ PREREQ (smallcap regime) data ready through ${dailyLast}`);
console.error(`  stock-folder audit ${auditStart}..${target}: ${tradingDays.length - missing.length}/${tradingDays.length} trading days have 3m data`);
if (missing.length) {
  console.error(`  ⚠ ${missing.length} stock-data day folders still MISSING (load these yourself via the dashboard):`);
  console.error('    ' + missing.join(' '));
} else {
  console.error('  ✓ all stock-data day folders in range are present');
}
console.error('────────────────────────────────────────');
