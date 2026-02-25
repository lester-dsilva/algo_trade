/**
 * Pre-market readiness check — run this every morning before starting liveScanner.
 *
 * Does in order:
 *  1. Validates .env has required keys
 *  2. Checks Kite session is valid (tells you exactly how to fix if not)
 *  3. Checks prev day 3m CSV data exists; auto-fetches if missing
 *  4. Checks data/positions.json has no stale open positions from a previous day
 *  5. Prints a final go/no-go summary
 *
 * Usage:
 *   node scripts/preMarket.js
 *   npm run pre-market
 */

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { execSync, spawn } from 'child_process';
import { getKite } from '../lib/kite.js';

const CWD = process.cwd();

// ── colour helpers (works on Windows terminals) ───────────────────────────────
const G  = (s) => `\x1b[32m${s}\x1b[0m`;   // green
const R  = (s) => `\x1b[31m${s}\x1b[0m`;   // red
const Y  = (s) => `\x1b[33m${s}\x1b[0m`;   // yellow
const B  = (s) => `\x1b[1m${s}\x1b[0m`;    // bold

function ok(msg)   { console.log(` ${G('✔')}  ${msg}`); }
function fail(msg) { console.log(` ${R('✘')}  ${msg}`); }
function warn(msg) { console.log(` ${Y('!')}  ${msg}`); }
function info(msg) { console.log(`    ${msg}`); }

// ── date helpers ──────────────────────────────────────────────────────────────
function todayIST() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

function dateMinusDays(dateStr, n) {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

/** Find most recent data/<YYYY-MM-DD>/ folder before todayStr. */
function findPrevDateFolder(todayStr) {
  try {
    return fs.readdirSync(path.join(CWD, 'data'))
      .filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d) && d < todayStr)
      .sort().reverse()[0] ?? null;
  } catch { return null; }
}

// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  const today = todayIST();
  const dow   = new Date(today + 'T12:00:00Z').getUTCDay();
  const isWeekend = dow === 0 || dow === 6;

  console.log('');
  console.log(B('═══════════════════════════════════════════════'));
  console.log(B(`  Pre-Market Readiness Check  —  ${today}`));
  console.log(B('═══════════════════════════════════════════════'));
  if (isWeekend) {
    warn(`Today is a ${dow === 0 ? 'Sunday' : 'Saturday'} — NSE is closed.`);
    console.log('');
  }
  console.log('');

  let allGood = true;

  // ── 1. .env keys ────────────────────────────────────────────────────────────
  console.log(B('1. Environment (.env)'));
  const requiredEnv = ['KITE_API_KEY', 'KITE_API_SECRET'];
  const optionalEnv = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'GAP_UP_THRESHOLD_PCT', 'MAX_SL_PCT', 'MAX_ENTRY_CANDLE_RANGE_PCT'];
  let envOk = true;
  for (const key of requiredEnv) {
    const val = process.env[key] || process.env[key.toLowerCase()];
    if (val) { ok(`${key} is set`); }
    else      { fail(`${key} is MISSING from .env`); envOk = false; allGood = false; }
  }
  for (const key of optionalEnv) {
    const val = process.env[key];
    if (val) info(`${key} = ${val}`);
    else     info(`${key} not set (optional)`);
  }
  console.log('');

  // ── 2. Kite session ─────────────────────────────────────────────────────────
  console.log(B('2. Kite Session'));
  let kiteOk = false;
  if (!envOk) {
    fail('Skipping — fix .env first');
  } else {
    try {
      const kite = await getKite();
      const profile = await kite.getProfile();
      ok(`Session valid  —  ${profile.user_name} (${profile.email})`);
      kiteOk = true;
    } catch (err) {
      fail('Session INVALID or EXPIRED');
      info(R('Action needed — run these steps:'));
      info('  1.  npm run kite:login');
      info('        → opens a local server, prints a login URL');
      info('  2.  Open the URL in browser and log in to Zerodha');
      info('  3.  Copy KITE_REQUEST_TOKEN=... printed in terminal into .env');
      info('  4.  node scripts/kiteSession.js');
      info('        → exchanges request_token for access_token, saves .kite_session');
      info('  5.  Re-run:  node scripts/preMarket.js');
      allGood = false;
    }
  }
  console.log('');

  // ── 3. Prev day 3m data ─────────────────────────────────────────────────────
  console.log(B('3. Previous Day 3m Data'));
  const prevDateFolder = findPrevDateFolder(today);

  if (!prevDateFolder) {
    fail(`No date folder found in data/ before ${today}`);
    info(Y(`Run: node scripts/fetchPrevDay3m.js`));
    allGood = false;
  } else {
    const prevDayDir  = path.join(CWD, 'data', prevDateFolder);
    const csvCount    = fs.readdirSync(prevDayDir).filter(f => f.endsWith('.csv')).length;
    const watchlistPath = path.join(CWD, 'config', 'nse_mcap_above_900cr.csv');
    const totalSymbols = fs.existsSync(watchlistPath)
      ? fs.readFileSync(watchlistPath, 'utf8').split(/\r?\n/).filter(l => l.trim() && !/tradingsymbol/i.test(l)).length
      : 0;
    const coveragePct = totalSymbols > 0 ? ((csvCount / totalSymbols) * 100).toFixed(0) : '?';

    if (csvCount >= totalSymbols * 0.95) {
      ok(`${prevDateFolder}: ${csvCount}/${totalSymbols} CSVs (${coveragePct}% coverage)`);
    } else if (csvCount > 0) {
      warn(`${prevDateFolder}: only ${csvCount}/${totalSymbols} CSVs (${coveragePct}%) — running fetchPrevDay3m to fill gaps...`);
      console.log('');

      // auto-run fetchPrevDay3m.js for the missing ones
      await new Promise((resolve) => {
        const child = spawn('node', ['scripts/fetchPrevDay3m.js', prevDateFolder], {
          cwd: CWD, stdio: 'inherit',
        });
        child.on('exit', resolve);
      });

      // re-count
      const newCount = fs.readdirSync(prevDayDir).filter(f => f.endsWith('.csv')).length;
      ok(`After fetch: ${newCount}/${totalSymbols} CSVs for ${prevDateFolder}`);
    } else {
      fail(`${prevDateFolder}: 0 CSVs — running fetchPrevDay3m...`);
      console.log('');
      await new Promise((resolve) => {
        const child = spawn('node', ['scripts/fetchPrevDay3m.js', prevDateFolder], {
          cwd: CWD, stdio: 'inherit',
        });
        child.on('exit', (code) => {
          if (code !== 0) allGood = false;
          resolve();
        });
      });
    }
  }
  console.log('');

  // ── 4. Stale open positions ──────────────────────────────────────────────────
  console.log(B('4. Positions File'));
  const posPath = path.join(CWD, 'data', 'positions.json');
  if (!fs.existsSync(posPath)) {
    ok('No positions.json — clean slate');
  } else {
    try {
      const positions = JSON.parse(fs.readFileSync(posPath, 'utf8'));
      const openPos   = positions.filter(p => p.status === 'open');
      const closedPos = positions.filter(p => p.status === 'closed');

      if (openPos.length === 0) {
        ok(`positions.json clean — ${closedPos.length} closed, 0 open`);
      } else {
        // Check if any open positions are from a previous trading day
        const stale = openPos.filter(p => p.entryTime && !p.entryTime.startsWith(today));
        if (stale.length > 0) {
          warn(`${stale.length} STALE open position(s) from a previous day:`);
          for (const p of stale) {
            info(`  #${p.id} ${p.symbol} entered ${p.entryTime} — will be force-closed`);
          }
          // Force close stale positions
          for (const p of openPos) {
            if (p.entryTime && !p.entryTime.startsWith(today)) {
              Object.assign(p, { status: 'closed', exitReason: 'stale_pre_market', exitTime: today + ' 09:14', exitPrice: p.entryPrice, pnl: 0 });
            }
          }
          fs.writeFileSync(posPath, JSON.stringify(positions, null, 2), 'utf8');
          warn(`Stale positions closed. Review positions.json if needed.`);
        } else {
          info(`${openPos.length} open position(s) from today — keeping`);
        }
      }
    } catch {
      warn('positions.json exists but could not be parsed — leaving as-is');
    }
  }
  console.log('');

  // ── 5. Watchlist & config files ──────────────────────────────────────────────
  console.log(B('5. Config Files'));
  const checks = [
    ['config/nse_mcap_above_900cr.csv', 'Watchlist (NSE 900Cr+)'],
    ['.env',                            'Environment config'],
    ['.kite_session',                   'Kite session file'],
  ];
  for (const [relPath, label] of checks) {
    const full = path.join(CWD, relPath);
    if (fs.existsSync(full)) {
      const stat  = fs.statSync(full);
      const ageHr = ((Date.now() - stat.mtimeMs) / 3600000).toFixed(1);
      ok(`${label}  (${relPath})  —  modified ${ageHr}h ago`);
    } else {
      fail(`${label}  (${relPath})  MISSING`);
      allGood = false;
    }
  }
  console.log('');

  // ── Final verdict ────────────────────────────────────────────────────────────
  console.log(B('═══════════════════════════════════════════════'));
  if (allGood) {
    console.log(G(B('  ✔  ALL CHECKS PASSED — ready to run live scanner')));
    console.log('');
    console.log(B('  Start with:'));
    console.log('    npm run live');
    console.log('');
    console.log(B('  Or with custom log path:'));
    console.log('    LOG_PATH=data/live_scanner.log npm run live');
  } else {
    console.log(R(B('  ✘  SOME CHECKS FAILED — fix the issues above before starting')));
  }
  console.log(B('═══════════════════════════════════════════════'));
  console.log('');

  process.exit(allGood ? 0 : 1);
}

main().catch((err) => {
  console.error(R('Fatal: ' + (err?.message ?? String(err))));
  process.exit(1);
});
