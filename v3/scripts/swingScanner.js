/**
 * v3 swing scanner: hourly volume breakout checks on watchlist, swing exits.
 *
 * Usage:
 *   node v3/scripts/swingScanner.js --refresh       # refresh watchlist CSV data
 *   node v3/scripts/swingScanner.js --hourly --universe   # scan 900cr+ universe
 *   node v3/scripts/swingScanner.js --exits         # check swing exits on open positions
 *   node v3/scripts/swingScanner.js --daemon        # schedule all tasks (long-running)
 *
 * Env: Kite credentials; optional TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
 *       V3_TRACK_POSITIONS=true to write swing_positions.json (default: Telegram alerts only)
 */

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getKite } from '../../lib/kite.js';
import { sendAlert, isConfigured as telegramConfigured } from '../../lib/telegram.js';
import {
  ROOT,
  V3_UNIVERSE_PATH,
  V3_WATCHLIST_PATH,
  loadWatchlistSymbols,
  findToken,
  buildSymbolTokens,
  ensureV3Dirs,
  normalizeFilename,
} from '../lib/v3Universe.js';
import { loadDailyForSymbol, loadHourlyForSymbol, writeCsv } from '../lib/loadV3Data.js';
import { findHourlyEntryOnDay } from '../lib/hourlyEntryLogic.js';
import { breadthFilterFromEnv, checkBreadthForDate } from '../lib/breadthFilter.js';
import {
  addSwingPosition,
  getOpenSwingPositions,
  getSwingPositionBySymbol,
  closeSwingPosition,
  getSwingPnlSummary,
  SWING_POSITION_VALUE,
} from '../lib/swingPositionStore.js';
import { EXIT_DEFAULTS } from '../lib/swingExitLogic.js';
import { buildTwoHourBars, isTwoHourBelowEma } from '../lib/twoHourBars.js';
import { createStartRateLimiter, runPool, getInstruments } from './fetchV3Data.js';

const SCAN_CONCURRENCY = parseInt(process.env.V3_SCAN_CONCURRENCY || '20', 10);
const SCAN_RPS = parseFloat(process.env.V3_KITE_HISTORICAL_RPS || '10');
/** Minutes after bar close before scan (bar closes :15, scan at :16) */
const SCAN_OFFSET_MIN = parseInt(process.env.V3_SCAN_OFFSET_MIN || '1', 10);
const DAEMON_POLL_MS = parseInt(process.env.V3_DAEMON_POLL_MS || '15000', 10);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const V3_DAILY_DIR = path.join(ROOT, 'v3', 'data', 'daily');
const V3_HOURLY_DIR = path.join(ROOT, 'v3', 'data', 'hourly');
const SIGNAL_CACHE_PATH = path.join(ROOT, 'v3', 'data', 'signal_cache.json');

/** Set V3_TRACK_POSITIONS=true to persist entries/exits in swing_positions.json */
const trackPositions = process.env.V3_TRACK_POSITIONS === 'true';

function loadSignaledToday() {
  try {
    const data = JSON.parse(fs.readFileSync(SIGNAL_CACHE_PATH, 'utf8'));
    if (data.date === todayIST()) return new Set(data.symbols || []);
  } catch (_) {}
  return new Set();
}

function saveSignaledToday(symbols) {
  fs.writeFileSync(
    SIGNAL_CACHE_PATH,
    JSON.stringify({ date: todayIST(), symbols: [...symbols] }, null, 2),
    'utf8'
  );
}

function alreadySignaledToday(symbol) {
  if (trackPositions) return !!getSwingPositionBySymbol(symbol);
  return loadSignaledToday().has(symbol);
}

function getISTClock() {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
  }).formatToParts(new Date());
  const h = parseInt(parts.find((p) => p.type === 'hour').value, 10);
  const m = parseInt(parts.find((p) => p.type === 'minute').value, 10);
  return { h, m, minutes: h * 60 + m };
}

/** NSE hourly bar is complete once its session window has ended. */
function isHourlyBarComplete(bar, nowMin = getISTClock().minutes) {
  const [bh, bm] = bar.time.split(':').map(Number);
  const closeMin = bh === 15 && bm === 15 ? 15 * 60 + 30 : bh * 60 + bm + 60;
  return nowMin >= closeMin;
}

function completedBarsToday(todayBars) {
  return todayBars.filter((b) => isHourlyBarComplete(b));
}

function findEntryOnCompletedBars(todayBars, hourlyBars, dailyBars) {
  const done = completedBarsToday(todayBars);
  if (!done.length) return null;
  return findHourlyEntryOnDay(done, hourlyBars, { dailyBars });
}

/** Scan window: bar closes :15, trigger at :16; last bar (15:15) closes :30, trigger :31 */
function shouldRunHourlyScan(clock = getISTClock()) {
  const { h, m } = clock;
  if (h < 10 || h > 15) return null;

  const regularTrigger = 15 + SCAN_OFFSET_MIN;
  if (m >= regularTrigger && m < regularTrigger + 2) {
    return `${todayIST()}-${String(h).padStart(2, '0')}`;
  }
  if (h === 15 && m >= 30 + SCAN_OFFSET_MIN && m < 30 + SCAN_OFFSET_MIN + 2) {
    return `${todayIST()}-15eod`;
  }
  return null;
}

function todayIST() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

function nowIST() {
  return new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false });
}

function log(msg) {
  console.error(`[${nowIST()}] ${msg}`);
}

function parseArgs(argv) {
  return {
    refresh: argv.includes('--refresh') || argv.includes('--premarket'),
    hourly: argv.includes('--hourly'),
    exits: argv.includes('--exits'),
    daemon: argv.includes('--daemon'),
    universe: argv.includes('--universe'),
  };
}

function loadScanSymbols(opts) {
  const path = opts.universe ? V3_UNIVERSE_PATH : undefined;
  return loadWatchlistSymbols(path);
}

async function refreshSymbolData(kite, symbol, token, histRun) {
  const toDate = todayIST();
  const fromDaily = new Date(toDate);
  fromDaily.setDate(fromDaily.getDate() - 5);
  const fromStr = fromDaily.toISOString().slice(0, 10);

  const from = new Date(`${fromStr}T09:15:00+05:30`);
  const to = new Date(`${toDate}T15:30:00+05:30`);

  const [dailyCandles, hourlyCandles] = await Promise.all([
    histRun(() => kite.getHistoricalData(token, 'day', from, to, false, false)),
    histRun(() => kite.getHistoricalData(token, '60minute', from, to, false, false)),
  ]);

  const toRow = (c, withTime) => {
    const dt = c.date instanceof Date ? c.date : new Date(c.date);
    const ist = new Date(dt.getTime() + 5.5 * 3600 * 1000);
    const iso = ist.toISOString();
    return {
      date: iso.slice(0, 10),
      time: withTime ? iso.slice(11, 19) : '',
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume ?? 0,
    };
  };

  const dailyFile = path.join(V3_DAILY_DIR, normalizeFilename(symbol) + '.csv');
  const hourlyFile = path.join(V3_HOURLY_DIR, normalizeFilename(symbol) + '.csv');

  let existingDaily = loadDailyForSymbol(symbol) || [];
  let existingHourly = loadHourlyForSymbol(symbol) || [];

  const dailyMap = new Map(existingDaily.map((r) => [r.date, r]));
  for (const c of dailyCandles || []) {
    const r = toRow(c, false);
    dailyMap.set(r.date, r);
  }
  const hourlyMap = new Map(existingHourly.map((r) => [r.date + 'T' + r.time, r]));
  for (const c of hourlyCandles || []) {
    const r = toRow(c, true);
    hourlyMap.set(r.date + 'T' + r.time, r);
  }

  writeCsv(dailyFile, [...dailyMap.values()].sort((a, b) => a.date.localeCompare(b.date)));
  writeCsv(hourlyFile, [...hourlyMap.values()].sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time)));
}

export async function runWatchlistRefresh(kite, opts = {}) {
  ensureV3Dirs();
  const symbols = loadScanSymbols(opts);
  log(`Refreshing ${symbols.length} symbols (${SCAN_CONCURRENCY} parallel, ${SCAN_RPS} rps)...`);

  const instruments = await getInstruments(kite);
  const symbolTokens = buildSymbolTokens(symbols, instruments);
  const histRun = createStartRateLimiter(SCAN_RPS);

  let refreshed = 0;
  let failed = 0;
  let done = 0;
  const started = Date.now();

  await runPool(symbolTokens, SCAN_CONCURRENCY, async ({ symbol, token }) => {
    try {
      await refreshSymbolData(kite, symbol, token, histRun);
      refreshed++;
    } catch (err) {
      failed++;
      log(`  refresh fail ${symbol}: ${err.message}`);
    }
    done++;
    if (done % 100 === 0 || done === symbolTokens.length) {
      const elapsed = ((Date.now() - started) / 1000).toFixed(0);
      log(`  progress ${done}/${symbolTokens.length} (${elapsed}s)`);
    }
  });

  log(`Refreshed ${refreshed}/${symbolTokens.length} symbols (${failed} failed, ${((Date.now() - started) / 1000).toFixed(0)}s)`);

  const msg = `v3 Data refresh (${todayIST()})\n${refreshed}/${symbolTokens.length} symbols updated`;
  if (telegramConfigured()) await sendAlert(msg);
  return { refreshed, total: symbolTokens.length };
}

/** @deprecated use runWatchlistRefresh */
export const runPremarketScreen = runWatchlistRefresh;

export async function runHourlyCheck(kite, opts = {}) {
  const symbols = loadScanSymbols(opts);
  if (!symbols.length) {
    log('Symbol list empty — check watchlist or --universe');
    return [];
  }

  const breadthOpts = breadthFilterFromEnv();
  const breadthSymbols = loadWatchlistSymbols(V3_WATCHLIST_PATH);
  if (breadthOpts.enabled) {
    const breadth = checkBreadthForDate(breadthSymbols, todayIST(), breadthOpts);
    if (!breadth.pass) {
      const pct = breadth.pctDisplay ?? '?';
      const min = Math.round(breadth.minPct * 100);
      log(`Breadth gate: ${pct}% above 20d SMA (need ${min}%) — skipping entry scan`);
      return [];
    }
    log(`Breadth gate: ${breadth.pctDisplay}% above 20d SMA (${breadth.above}/${breadth.total}) — entries allowed`);
  }

  const prioritySet = opts.universe ? new Set(loadWatchlistSymbols(V3_WATCHLIST_PATH)) : null;

  log(`Hourly check on ${symbols.length} symbols (${SCAN_CONCURRENCY} parallel, ${SCAN_RPS} rps, ${trackPositions ? 'tracking positions' : 'alerts only'})`);
  const instruments = await getInstruments(kite);
  const histRun = createStartRateLimiter(SCAN_RPS);
  const signaledToday = loadSignaledToday();
  const signals = [];
  let done = 0;
  let failed = 0;
  const started = Date.now();

  const tokenMap = new Map();
  for (const sym of symbols) {
    const token = findToken(instruments, sym);
    if (token != null) tokenMap.set(sym, Number(token));
  }

  let work = symbols.filter((sym) => !alreadySignaledToday(sym) && tokenMap.has(sym));
  if (prioritySet?.size) {
    const priority = work.filter((s) => prioritySet.has(s));
    const rest = work.filter((s) => !prioritySet.has(s));
    work = [...priority, ...rest];
    log(`Watchlist priority: ${priority.length} first, then ${rest.length} universe`);
  }

  async function scanSymbol(symbol) {
    const token = tokenMap.get(symbol);
    await refreshSymbolData(kite, symbol, token, histRun);

    const dailyBars = loadDailyForSymbol(symbol);
    const hourlyBars = loadHourlyForSymbol(symbol);
    if (!dailyBars?.length || !hourlyBars?.length) return null;

    const today = todayIST();
    const todayBars = hourlyBars.filter((b) => b.date === today);
    if (!todayBars.length) return null;

    const entry = findEntryOnCompletedBars(todayBars, hourlyBars, dailyBars);
    if (!entry) return null;

    let pos = null;
    if (trackPositions) {
      pos = addSwingPosition({
        symbol,
        entryTime: `${entry.date} ${entry.time}`,
        entryPrice: entry.entryPrice,
        stop: entry.stop,
        target: entry.target,
        signalType: entry.signalType,
        positionValue: SWING_POSITION_VALUE,
      });
    } else {
      signaledToday.add(symbol);
    }

    const result = { symbol, entry, position: pos };
    signals.push(result);
    const alert = [
      trackPositions ? `v3 HOURLY ENTRY: ${symbol}` : `v3 SIGNAL (no position): ${symbol}`,
      `Price: ₹${entry.entryPrice}`,
      `Stop: ₹${entry.stop} (-${EXIT_DEFAULTS.fixedSlPct}%)`,
      `Target: ₹${entry.target} (+${EXIT_DEFAULTS.fixedTargetPct}%)`,
      `Vol ratio: ${entry.breakoutVolRatio}x`,
      `Time: ${entry.date} ${entry.time}`,
    ].join('\n');
    log(alert);
    if (telegramConfigured()) await sendAlert(alert);
    return result;
  }

  await runPool(work, SCAN_CONCURRENCY, async (symbol) => {
    try {
      await scanSymbol(symbol);
    } catch (err) {
      failed++;
      log(`  scan fail ${symbol}: ${err.message}`);
    } finally {
      done++;
      if (done % 100 === 0 || done === work.length) {
        const elapsed = ((Date.now() - started) / 1000).toFixed(0);
        log(`  progress ${done}/${work.length} (${elapsed}s, ${signals.length} signals)`);
      }
    }
  });

  if (!trackPositions && signaledToday.size) {
    saveSignaledToday(signaledToday);
  }

  log(`Hourly done: ${signals.length} signals, ${failed} failed, ${((Date.now() - started) / 1000).toFixed(0)}s`);
  return signals;
}

export async function runExitCheck() {
  if (!trackPositions) {
    log('Alerts-only mode — skipping exit check (no positions tracked)');
    return [];
  }

  const open = getOpenSwingPositions();
  if (!open.length) {
    log('No open swing positions');
    return [];
  }

  const closed = [];
  for (const pos of open) {
    const dailyBars = loadDailyForSymbol(pos.symbol);
    const hourlyBars = loadHourlyForSymbol(pos.symbol);
    if (!dailyBars?.length || !hourlyBars?.length) continue;

    const lastHourly = hourlyBars[hourlyBars.length - 1];
    const lastIdx = hourlyBars.length - 1;
    const stop = pos.stop ?? pos.entryPrice * (1 - EXIT_DEFAULTS.fixedSlPct / 100);
    const target = pos.target ?? pos.entryPrice * (1 + EXIT_DEFAULTS.fixedTargetPct / 100);
    const twoH = buildTwoHourBars(hourlyBars);

    let exitReason = null;
    let exitPrice = null;

    if (lastHourly.high >= target) {
      exitReason = 'target';
      exitPrice = target;
    } else if (lastHourly.low <= stop) {
      exitReason = 'stop';
      exitPrice = stop;
    } else if (isTwoHourBelowEma(twoH, lastIdx, EXIT_DEFAULTS.emaPeriod, EXIT_DEFAULTS.emaExitBufferPct)) {
      exitReason = 'ema_exit';
      exitPrice = twoH.find((b) => b.endHourlyIndex === lastIdx)?.close ?? lastHourly.close;
    }

    if (!exitReason) continue;

    const pnl = Math.round((exitPrice - pos.entryPrice) * pos.qty * 100) / 100;
    const entryDate = pos.entryTime.split(' ')[0];
    const holdDays = new Set(
      dailyBars.filter((b) => b.date >= entryDate && b.date <= lastHourly.date).map((b) => b.date)
    ).size;

    const updated = closeSwingPosition(pos.id, {
      exitTime: `${lastHourly.date} ${lastHourly.time}`,
      exitPrice,
      exitReason,
      pnl,
      holdDays,
    });
    closed.push(updated);

    const alert = [
      `v3 EXIT: ${pos.symbol}`,
      `Reason: ${exitReason}`,
      `Exit: ₹${exitPrice}`,
      `PnL: ₹${pnl}`,
      `Hold: ${holdDays}d`,
    ].join('\n');
    log(alert);
    if (telegramConfigured()) await sendAlert(alert);
  }

  const summary = getSwingPnlSummary();
  log(`Exit check done. Closed ${closed.length}. Summary: ${JSON.stringify(summary)}`);
  return closed;
}

function scheduleDaemon(kite, opts) {
  let lastHourlyRunKey = null;

  const runAt = async (label, fn) => {
    try {
      await fn();
    } catch (err) {
      log(`${label} error: ${err.message}`);
    }
  };

  const checkSchedule = () => {
    const clock = getISTClock();
    const { h, m } = clock;
    const day = new Date().toLocaleDateString('en-US', { timeZone: 'Asia/Kolkata', weekday: 'short' });
    if (day === 'Sat' || day === 'Sun') return;

    if (h === 8 && m >= 45 && m < 50) runAt('refresh', () => runWatchlistRefresh(kite, opts));

    const hourlyKey = shouldRunHourlyScan(clock);
    if (hourlyKey && hourlyKey !== lastHourlyRunKey) {
      lastHourlyRunKey = hourlyKey;
      runAt('hourly', () => runHourlyCheck(kite, opts));
    }

    if (h === 15 && m >= 35 && m < 40) runAt('exits', () => runExitCheck());
  };

  const label = opts.universe ? '900cr+ universe' : 'watchlist';
  log(`v3 daemon (${label}) — scan at :${15 + SCAN_OFFSET_MIN} after each bar close, poll ${DAEMON_POLL_MS / 1000}s`);
  setInterval(checkSchedule, DAEMON_POLL_MS);
  checkSchedule();
}

async function main() {
  const opts = parseArgs(process.argv);
  const kite = await getKite();

  if (opts.refresh) await runWatchlistRefresh(kite, opts);
  else if (opts.hourly) await runHourlyCheck(kite, opts);
  else if (opts.exits) await runExitCheck();
  else if (opts.daemon) scheduleDaemon(kite, opts);
  else {
    console.error('Usage: node v3/scripts/swingScanner.js --refresh | --hourly | --exits | --daemon [--universe]');
    process.exit(1);
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  main().catch((err) => {
    console.error('ERROR:', err.message || err);
    process.exit(1);
  });
}
