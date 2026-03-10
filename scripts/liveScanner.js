/**
 * Live scanner: subscribe to symbols from config/nse_mcap_above_900cr.csv,
 * build 3m candles from Kite ticks, run v2 entry logic on each new bar, persist paper positions, send Telegram alerts.
 *
 * v2 logic: 4% move in first 45 min, pullback/consolidation, breakout (2.7x day vol, 2x breakout vol, gap ≤2%, wicks ≤35%).
 * Exits: initial SL below breakout low; 3% first target then 1.5% trail; EOD 15:24. Position size ₹50,000.
 *
 * Usage: node scripts/liveScanner.js
 *
 * Requires: .env with Kite credentials; optional TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, GAP_UP_THRESHOLD_PCT (extra gap skip).
 * Prev day volume: v2/data/YYYY-MM-DD or data/YYYY-MM-DD 3m CSVs (same as backtest). Max 3000 tokens per KiteTicker.
 *
 * Debug logs: LIVE_SCANNER_LOG=0 disables data/live_scanner.log; LOG_PATH overrides path.
 * Volume debug: each bar flush is logged to data/volume_debug.log (symbol, time, volume, volumeSource, firstCumVol, lastCumVol, sumQuantity). Set LIVE_SCANNER_LOG_VOLUME=0 to disable; LOG_VOLUME_PATH to override path. Heartbeat includes volume_debug: { cumulative_diff, sum_quantity } counts.
 */

import fs from 'fs';
import path from 'path';
import { getKite } from '../lib/kite.js';
import { KiteTicker } from 'kiteconnect';
import { createCandleBuilder } from '../lib/candleBuilder.js';
import { findEntry } from '../v2/lib/entryLogic.js';
import { addPosition, processBar, getTotalPnl, eodSweep, POSITION_VALUE } from '../lib/positionStore.js';
import { sendAlert, isConfigured as telegramConfigured } from '../lib/telegram.js';

const WATCHLIST_PATH = path.join(process.cwd(), 'config', 'nse_mcap_above_900cr.csv');
const MAX_TOKENS = 3000;

/** File log for debugging when away during market hours. Logs to data/live_scanner.log by default. Set LIVE_SCANNER_LOG=0 to disable, or LOG_PATH for custom path. */
const LOG_ENABLED = process.env.LIVE_SCANNER_LOG !== '0' && process.env.LIVE_SCANNER_LOG !== 'false';
const LOG_PATH = process.env.LOG_PATH
  ? path.resolve(process.cwd(), process.env.LOG_PATH)
  : path.join(process.cwd(), 'data', 'live_scanner.log');

/** Volume debug log: one line per bar flush (symbol, time, volume, cumulative_diff vs sum_quantity). Set LIVE_SCANNER_LOG_VOLUME=0 to disable. */
const LOG_VOLUME_ENABLED = process.env.LIVE_SCANNER_LOG_VOLUME !== '0' && process.env.LIVE_SCANNER_LOG_VOLUME !== 'false';
const LOG_VOLUME_PATH = process.env.LOG_VOLUME_PATH
  ? path.resolve(process.cwd(), process.env.LOG_VOLUME_PATH)
  : path.join(process.cwd(), 'data', 'volume_debug.log');

function logToFile(event, detail = '') {
  if (!LOG_ENABLED) return;
  const ts = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false });
  const line = `${ts}\t${event}\t${typeof detail === 'string' ? detail : JSON.stringify(detail)}\n`;
  try {
    const dir = path.dirname(LOG_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(LOG_PATH, line, 'utf8');
  } catch (_) {}
}

function logVolumeFlush(info) {
  if (!LOG_VOLUME_ENABLED) return;
  const ts = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false });
  const line = `${ts}\tbar_volume\t${JSON.stringify(info)}\n`;
  try {
    const dir = path.dirname(LOG_VOLUME_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(LOG_VOLUME_PATH, line, 'utf8');
  } catch (_) {}
}

/** Return date string N calendar days before dateStr (YYYY-MM-DD). */
function dateMinusDays(dateStr, days) {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/** Return YYYY-MM-DD in IST from a Kite day-candle (API timestamps are exchange/IST). */
function candleDateStr(c) {
  if (!c || c.date == null) return '';
  const d = c.date instanceof Date ? c.date : new Date(c.date);
  return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

/** Ms until 9:20 AM IST (defer today open fetch so day candle is stable). Returns 0 if already past. */
function msUntil920Ist() {
  const todayIST = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const target = new Date(`${todayIST}T09:20:00+05:30`);
  const ms = target.getTime() - Date.now();
  return ms > 0 ? ms : 0;
}

/** Run async fn; on failure retry up to maxRetries times with exponential backoff (baseDelayMs * 2^attempt). */
async function withExponentialBackoff(fn, maxRetries = 4, baseDelayMs = 1000) {
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (attempt < maxRetries) {
        const delay = baseDelayMs * Math.pow(2, attempt);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}

function loadWatchlistSymbols() {
  const raw = fs.readFileSync(WATCHLIST_PATH, 'utf8').replace(/\r\n/g, '\n').trim();
  const lines = raw.split('\n');
  if (lines.length < 2) return [];
  const header = lines[0].toLowerCase();
  const symCol = header.includes('tradingsymbol') ? 0 : 0;
  const symbols = [];
  for (let i = 1; i < lines.length; i++) {
    const row = lines[i].split(',');
    const sym = (row[symCol] || '').trim();
    if (sym) symbols.push(sym);
  }
  return symbols;
}

function findInstrumentToken(instruments, tradingsymbol) {
  const sym = (tradingsymbol.includes(':') ? tradingsymbol.split(':')[1] : tradingsymbol).trim();
  if (!sym) return null;
  const nse = instruments.filter((i) => i.exchange === 'NSE');
  const trySym = (s) => nse.find((i) => i.tradingsymbol === s || i.tradingsymbol.toUpperCase() === s.toUpperCase());
  const row = trySym(sym) || trySym(`${sym}-EQ`) || trySym(`${sym}-BE`);
  return row ? row.instrument_token : null;
}

/** Normalize symbol to lowercase CSV filename (matches v2 / analyzePnl). */
function normalizeSymbolFilename(symbol) {
  return symbol.toLowerCase().replace(/&/g, '').replace(/\s/g, '');
}

/** Find the most recent date folder before todayStr. Prefers v2/data, then data/. Returns { folder, baseDir } or null. */
function findPrevDateFolder(todayStr) {
  const cwd = process.cwd();
  for (const baseDir of [path.join(cwd, 'v2', 'data'), path.join(cwd, 'data')]) {
    try {
      if (!fs.existsSync(baseDir)) continue;
      const dirs = fs.readdirSync(baseDir)
        .filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d) && d < todayStr)
        .sort()
        .reverse();
      if (dirs.length > 0) return { folder: dirs[0], baseDir };
    } catch { /* skip */ }
  }
  return null;
}

/**
 * Load ALL 3m candles for symbol. Tries v2/data/<date>/3m/<symbol>.csv then data/<date>/<symbol>.csv.
 * prevInfo = { folder, baseDir } from findPrevDateFolder.
 */
function loadPrevDayAllBars(symbol, prevInfo) {
  if (!prevInfo) return [];
  const file = normalizeSymbolFilename(symbol) + '.csv';
  const isV2 = prevInfo.baseDir.includes('v2');
  const csvPath = isV2
    ? path.join(prevInfo.baseDir, prevInfo.folder, '3m', file)
    : path.join(prevInfo.baseDir, prevInfo.folder, file);
  try {
    if (!fs.existsSync(csvPath)) return [];
    const lines = fs.readFileSync(csvPath, 'utf8').replace(/^\uFEFF/, '').trim().split(/\r?\n/);
    if (lines.length < 2) return [];
    const header = lines[0].toLowerCase().split(',').map(s => s.trim());
    const rows = [];
    for (let li = 1; li < lines.length; li++) {
      const vals = lines[li].split(',');
      const r = {};
      header.forEach((h, j) => { r[h] = (vals[j] ?? '').trim(); });
      const o = parseFloat(r.open), h2 = parseFloat(r.high), l = parseFloat(r.low), c = parseFloat(r.close), v = parseFloat(r.volume);
      if (!r.date || !Number.isFinite(o) || o === 0) continue;
      rows.push({ date: r.date, time: r.time, open: o, high: h2, low: l, close: c, volume: Number.isFinite(v) ? v : 0 });
    }
    return rows;
  } catch { return []; }
}

/** Last nBars of prev day 3m (for any legacy use). */
function loadPrevDayTailBars(symbol, prevInfo, nBars = 25) {
  const all = loadPrevDayAllBars(symbol, prevInfo);
  return all.slice(-nBars);
}

async function main() {
  logToFile('start', 'script started');
  const symbols = loadWatchlistSymbols();
  if (symbols.length === 0) {
    console.error('No symbols in', WATCHLIST_PATH);
    logToFile('exit', 'no symbols in watchlist');
    process.exit(1);
  }

  const kite = await getKite();
  const instruments = await kite.getInstruments('NSE');

  const tokenToSymbol = new Map();
  const tokens = [];
  for (const sym of symbols) {
    if (tokens.length >= MAX_TOKENS) break;
    const rawToken = findInstrumentToken(instruments, sym);
    if (rawToken != null) {
      const token = Number(rawToken);
      tokens.push(token);
      tokenToSymbol.set(token, sym);
    }
  }
  console.error('Subscribing to', tokens.length, 'instruments (max', MAX_TOKENS + ')');
  logToFile('start', { tokens: tokens.length, watchlist: WATCHLIST_PATH });
  logToFile('start', { volume_debug: LOG_VOLUME_ENABLED, volume_debug_path: LOG_VOLUME_PATH });

  const symbolToToken = new Map();
  for (const [token, sym] of tokenToSymbol) symbolToToken.set(sym, token);

  const gapUpThresholdPct = process.env.GAP_UP_THRESHOLD_PCT != null ? parseFloat(process.env.GAP_UP_THRESHOLD_PCT) : null;
  const prevCloseBySymbol = new Map();
  const prevDayVolumeBySymbol = new Map();   // from daily OHLCV API only (prev day volume)
  const dayOpenBySymbol = new Map();
  const CONCURRENCY = 15;
  const symbolsForPrevDay = [...symbolToToken.keys()];
  const totalBatches = Math.ceil(symbolsForPrevDay.length / CONCURRENCY);
  const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const rangeFromStr = dateMinusDays(todayStr, 7);
  const dayFrom = new Date(`${rangeFromStr}T00:00:00+05:30`);
  const dayTo = new Date(`${todayStr}T23:59:59+05:30`);
  // Same as analyzePnl: prev day from daily API only; 3m only for current day (built from ticks below).
  const missingVolumeReasons = new Map(); // symbol -> reason string (only when volume not set)
  console.error('Prev day (close + volume) from daily API only, range', rangeFromStr, '→', todayStr, '|', symbolsForPrevDay.length, 'symbols');
  for (let i = 0; i < symbolsForPrevDay.length; i += CONCURRENCY) {
    const chunk = symbolsForPrevDay.slice(i, i + CONCURRENCY);
    await Promise.all(
      chunk.map(async (symbol) => {
        let set = false;
        try {
          const token = symbolToToken.get(symbol);
          const candles = await kite.getHistoricalData(token, 'day', dayFrom, dayTo, false, false);
          if (candles && candles.length > 0) {
            for (const c of candles) {
              const d = candleDateStr(c);
              if (d < todayStr) {
                prevCloseBySymbol.set(symbol, c.close);
                prevDayVolumeBySymbol.set(symbol, c.volume ?? 0);
                set = true;
              }
            }
          }
          if (!set) {
            const reason = (!candles || candles.length === 0) ? 'no_candles' : 'no_prev_day_in_range';
            missingVolumeReasons.set(symbol, reason);
          }
        } catch (e) {
          missingVolumeReasons.set(symbol, 'api_error: ' + (e && e.message ? e.message : String(e)));
        }
      })
    );
    const batchNum = Math.floor(i / CONCURRENCY) + 1;
    if (batchNum % 20 === 0 || batchNum === totalBatches) {
      console.error('Prev day progress:', batchNum, '/', totalBatches, '| prev close:', prevCloseBySymbol.size, '| prev volume:', prevDayVolumeBySymbol.size);
    }
  }
  // Fix #1: retry once for any symbols that failed the daily volume fetch
  const missingVol = symbolsForPrevDay.filter(s => !prevDayVolumeBySymbol.has(s));
  if (missingVol.length > 0) {
    console.error(`Daily volume missing for ${missingVol.length} symbols — retrying in 2s...`);
    await new Promise(r => setTimeout(r, 2000));
    for (let i = 0; i < missingVol.length; i += CONCURRENCY) {
      const chunk = missingVol.slice(i, i + CONCURRENCY);
      await Promise.all(chunk.map(async (symbol) => {
        let set = false;
        try {
          const token = symbolToToken.get(symbol);
          const candles = await kite.getHistoricalData(token, 'day', dayFrom, dayTo, false, false);
          if (candles && candles.length > 0) {
            for (const c of candles) {
              const d = candleDateStr(c);
              if (d < todayStr) {
                prevCloseBySymbol.set(symbol, c.close);
                prevDayVolumeBySymbol.set(symbol, c.volume ?? 0);
                set = true;
              }
            }
          }
          if (!set) {
            const reason = (!candles || candles.length === 0) ? 'no_candles' : 'no_prev_day_in_range';
            missingVolumeReasons.set(symbol, reason);
          }
        } catch (e) {
          missingVolumeReasons.set(symbol, 'api_error: ' + (e && e.message ? e.message : String(e)));
        }
      }));
    }
    const stillMissing = missingVol.filter(s => !prevDayVolumeBySymbol.has(s));
    console.error(`After retry: ${prevDayVolumeBySymbol.size} symbols have daily volume; still missing: ${stillMissing.length}`);
    // Log reasons for missing daily volume (for still-missing, use latest reason from map)
    const reasonCounts = new Map();
    for (const s of stillMissing.length ? stillMissing : missingVol) {
      const r = missingVolumeReasons.get(s) || 'unknown';
      reasonCounts.set(r, (reasonCounts.get(r) || 0) + 1);
    }
    if (reasonCounts.size > 0) {
      console.error('Missing daily volume — reasons:');
      for (const [reason, count] of [...reasonCounts.entries()].sort((a, b) => b[1] - a[1])) {
        console.error('  ', count, '×', reason);
      }
      const missingList = stillMissing.length ? stillMissing : missingVol;
      const list = missingList.slice(0, 50);
      console.error('  Symbols (up to 50):', list.join(', '), list.length < missingList.length ? '...' : '');
    }
  }
  console.error('Prev day daily OHLCV done:', prevDayVolumeBySymbol.size, '/', symbolsForPrevDay.length, 'symbols have volume.');

  if (prevCloseBySymbol.size === 0) {
    console.error('Fatal: No previous day close data from API. Cannot run v2 scanner.');
    logToFile('fatal', 'no_prev_day_close');
    process.exit(1);
  }

  // Prev day volume for v2 filter (2.7x): strictly daily OHLC volume only (no 3m override).
  console.error('Prev day volume: daily OHLC only (no 3m override).');

  const todayFrom = new Date(`${todayStr}T00:00:00+05:30`);
  const todayTo = new Date(`${todayStr}T23:59:59+05:30`);
  const fetchTodayOpen = async () => {
    const MAX_RETRIES = 4;
    const BASE_DELAY_MS = 1000;
    console.error('Loading today open (daily only) for gap filter:', symbolsForPrevDay.length, 'symbols (retry with exponential backoff)');
    for (let i = 0; i < symbolsForPrevDay.length; i += CONCURRENCY) {
      const chunk = symbolsForPrevDay.slice(i, i + CONCURRENCY);
      await Promise.all(
        chunk.map(async (symbol) => {
          try {
            await withExponentialBackoff(async () => {
              const token = symbolToToken.get(symbol);
              const candles = await kite.getHistoricalData(token, 'day', todayFrom, todayTo, false, false);
              if (candles && candles.length > 0) {
                dayOpenBySymbol.set(symbol, candles[0].open);
                return;
              }
              throw new Error('No candles');
            }, MAX_RETRIES, BASE_DELAY_MS);
          } catch {
            // will be reported after all batches
          }
        })
      );
    }
    const failedSymbols = symbolsForPrevDay.filter((s) => !dayOpenBySymbol.has(s));
    console.error('Today open loaded:', dayOpenBySymbol.size, 'symbols (daily only; gap = prev close vs today open)');
    if (failedSymbols.length > 0) {
      const list = failedSymbols.length <= 30 ? failedSymbols.join(', ') : `${failedSymbols.slice(0, 30).join(', ')} ... +${failedSymbols.length - 30} more`;
      console.error('Today open fetch failed after retries for', failedSymbols.length, 'symbols:', list);
      logToFile('today_open_failed', { count: failedSymbols.length, symbols: failedSymbols });
      // Reasons: Kite returns no day candle for today yet, rate limit, or symbol suspended/delisted
      await sendAlert(`Today open could not be fetched for ${failedSymbols.length} symbols (gap filter may skip them): ${list}`);
    }
  };

  const delayMs = msUntil920Ist();
  if (delayMs > 0) {
    console.error('Today open deferred to 9:20 IST (in', Math.round(delayMs / 1000), 's)');
    setTimeout(() => { fetchTodayOpen().catch((e) => console.error('fetchTodayOpen failed', e?.message)); }, delayMs);
  } else {
    await fetchTodayOpen();
  }

  const sessionPath = path.join(process.cwd(), '.kite_session');
  const session = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
  const apiKey = process.env.KITE_API_KEY || process.env.api_key || process.env.API_KEY;
  if (!apiKey || !session.access_token) {
    console.error('Missing KITE_API_KEY or no session. Run kite:login and set .env');
    process.exit(1);
  }

  const seriesBySymbol = new Map();
  const signaled = new Set();
  let barsClosedCount = 0;
  let lastHeartbeat = 0;
  let tickCount = 0;
  let volumeDebugCumulative = 0;
  let volumeDebugSum = 0;

  // ── helpers ────────────────────────────────────────────────────────────────
  function pnlStr(pnl) {
    return pnl >= 0 ? `+₹${pnl.toFixed(2)}` : `-₹${Math.abs(pnl).toFixed(2)}`;
  }

  function logSummary(label) {
    const t = getTotalPnl();
    const msg = `${label} | realized=${pnlStr(t.realizedPnl)} | closed=${t.closedCount}(${t.wins}W/${t.losses}L) open=${t.openCount}`;
    console.error(msg);
    logToFile('summary', { label, ...t });
  }

  // ── EOD sweep at 15:30 IST ─────────────────────────────────────────────────
  const todayISTForEod = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const eodSweepAt = new Date(`${todayISTForEod}T15:30:00+05:30`);
  const msToEod = eodSweepAt.getTime() - Date.now();
  if (msToEod > 0) {
    setTimeout(() => {
      const swept = eodSweep(todayISTForEod);
      if (swept.length > 0) {
        console.error(`[EOD_SWEEP] Force-closed ${swept.length} positions that had no 15:24 bar`);
        for (const p of swept) {
          console.error(`  ${p.symbol} #${p.id} → eod_sweep @ ${p.exitPrice} | P&L ${pnlStr(p.pnl)}`);
          logToFile('exit', { symbol: p.symbol, date: todayISTForEod, time: '15:30', id: p.id, reason: 'eod_sweep', exitPrice: p.exitPrice, qty: p.qty, pnl: p.pnl });
        }
        logSummary('EOD_SWEEP');
      }
    }, msToEod);
  }

  // ── bar-close callback ─────────────────────────────────────────────────────
  const builder = createCandleBuilder(
    (bar) => {
    const { symbol, date, time, open, high, low, close, volume } = bar;
    barsClosedCount++;

    // ── heartbeat every 5 min ──
    const now = Date.now();
    if (now - lastHeartbeat >= 5 * 60 * 1000) {
      lastHeartbeat = now;
      const t = getTotalPnl();
      const symCount = seriesBySymbol.size;
      const msg = `bars=${barsClosedCount} symbols=${symCount} ticks=${tickCount} | realized=${pnlStr(t.realizedPnl)} closed=${t.closedCount} open=${t.openCount}`;
      console.error(`[heartbeat] ${new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' })} IST | ${msg}`);
      logToFile('heartbeat', {
        bars: barsClosedCount,
        symbols: symCount,
        ticks: tickCount,
        volume_debug: { cumulative_diff: volumeDebugCumulative, sum_quantity: volumeDebugSum },
        ...t,
      });
    }

    // ── grow today's bar series ──
    let series = seriesBySymbol.get(symbol);
    if (!series) { series = {}; seriesBySymbol.set(symbol, series); }
    if (!series[date]) series[date] = [];
    series[date].push({ date, time, open, high, low, close, volume });

    // log every bar to file — only for symbols that HAVE/HAD a position today (keeps log focused)
    logToFile('bar', { symbol, date, time, open, high, low, close, volume });

    // ── STEP 1: process exits for existing open positions ──────────────────
    const exitResults = processBar(bar);
    for (const r of exitResults) {
      const pos = r.position;
      switch (r.action) {
        case 'exit_initial_sl': {
          const msg = `[EXIT] ${symbol} #${pos.id} INITIAL_SL @ ${time} | bar.low=${low} <= SL=${r.exitPrice} | qty=${r.qty} | P&L ${pnlStr(r.pnl)}`;
          console.error(msg);
          logToFile('exit', { symbol, date, time, id: pos.id, reason: 'initial_sl', barLow: low, exitPrice: r.exitPrice, qty: r.qty, pnl: r.pnl });
          logSummary('after_exit');
          sendAlert(`EXIT ${symbol} #${pos.id} SL hit @ ${r.exitPrice} | P&L ${pnlStr(r.pnl)}`);
          break;
        }
        case 'exit_trail': {
          const msg = `[EXIT] ${symbol} #${pos.id} TRAIL_STOP @ ${time} | close=${close} <= trail=${r.trailLevel} (hwm=${r.hwm}) | qty=${r.qty} | P&L ${pnlStr(r.pnl)}`;
          console.error(msg);
          logToFile('exit', { symbol, date, time, id: pos.id, reason: 'trail_stop', close, trailLevel: r.trailLevel, hwm: r.hwm, exitPrice: r.exitPrice, qty: r.qty, pnl: r.pnl });
          logSummary('after_exit');
          sendAlert(`EXIT ${symbol} #${pos.id} trail stop @ ${r.exitPrice} | P&L ${pnlStr(r.pnl)}`);
          break;
        }
        case 'exit_eod': {
          const msg = `[EXIT] ${symbol} #${pos.id} EOD @ ${time} | close=${close} | qty=${r.qty} | P&L ${pnlStr(r.pnl)}`;
          console.error(msg);
          logToFile('exit', { symbol, date, time, id: pos.id, reason: 'eod', exitPrice: r.exitPrice, qty: r.qty, pnl: r.pnl });
          logSummary('after_eod_exit');
          sendAlert(`EXIT ${symbol} #${pos.id} EOD @ ${r.exitPrice} | P&L ${pnlStr(r.pnl)}`);
          break;
        }
        case 'first_target_hit': {
          const msg = `[TARGET] ${symbol} #${pos.id} 3% TARGET HIT @ ${time} | close=${close} >= ${r.firstTargetPrice} | unrealized=${pnlStr(r.unrealizedPnl)} | trailing from hwm=${r.hwm}`;
          console.error(msg);
          logToFile('first_target', { symbol, date, time, id: pos.id, close, firstTargetPrice: r.firstTargetPrice, unrealizedPnl: r.unrealizedPnl, hwm: r.hwm });
          sendAlert(`TARGET ${symbol} #${pos.id} 3% hit @ ${close} — now trailing`);
          break;
        }
        case 'hold_trail':
          logToFile('position_bar', { symbol, date, time, id: pos.id, mode: 'trail', close, high, hwm: r.hwm, trailLevel: r.trailLevel, unrealizedPnl: r.unrealizedPnl, qty: r.qty });
          break;
        case 'hold':
          logToFile('position_bar', { symbol, date, time, id: pos.id, mode: 'initial', close, high, low, stop: r.stop, firstTargetPrice: r.firstTargetPrice, unrealizedPnl: r.unrealizedPnl, qty: r.qty });
          break;
      }
    }

    // ── STEP 2: v2 entry logic (4% move + pullback/breakout, 2.7x vol, gap ≤2%, 3% target then 1.5% trail)
    const todayBars = series[date] || [];
    const prevClose = prevCloseBySymbol.get(symbol) ?? null;
    const prevVol = prevDayVolumeBySymbol.get(symbol) ?? 0;
    const prevDay = prevClose != null && prevClose > 0 ? { close: prevClose, volume: prevVol } : null;
    let skipEntry = false;
    if (prevDay && gapUpThresholdPct != null && Number.isFinite(gapUpThresholdPct)) {
      const dayOpen = dayOpenBySymbol.get(symbol);
      if (dayOpen != null && prevClose > 0 && dayOpen > prevClose) {
        const gapPct = ((dayOpen - prevClose) / prevClose) * 100;
        if (gapPct >= gapUpThresholdPct) {
          logToFile('skip', { symbol, date, time, reason: `gap_override_${gapPct.toFixed(1)}pct >= ${gapUpThresholdPct}pct` });
          skipEntry = true;
        }
      }
    }
    if (!skipEntry && prevDay && todayBars.length >= 21) {
      const result = findEntry(todayBars, prevDay);
      const resultTime5 = (result?.time || '').slice(0, 5);
      const barTime5 = (time || '').slice(0, 5);
      if (result && resultTime5 === barTime5) {
        const key = `${symbol}|${date}|v2_breakout|${time}`;
        if (!signaled.has(key)) {
          signaled.add(key);

          const entryPrice = result.entry;
          const stop = result.stop;
          const firstTargetPrice = Math.round(entryPrice * 1.03 * 100) / 100;
          const slPct = entryPrice > 0 ? ((entryPrice - stop) / entryPrice * 100).toFixed(2) : '?';
          const qty = Math.floor(POSITION_VALUE / entryPrice);
          const cumVol = todayBars.reduce((s, b) => s + (b.volume ?? 0), 0);

          const pos = addPosition({
            symbol,
            side: 'long',
            entryTime: `${date} ${time}`,
            entryPrice,
            stop,
            target: firstTargetPrice,
            signalType: 'v2_breakout',
          });

          const msg = `[ENTRY] ${symbol} #${pos.id} @ ${time} | entry=${entryPrice} SL=${stop} (${slPct}%) 3%→trail | qty=${qty} | cumVol=${cumVol}`;
          console.error(msg);
          logToFile('entry', { symbol, date, time, id: pos.id, entry: entryPrice, stop, target: firstTargetPrice, slPct: parseFloat(slPct), qty, cumVol });
          if (!telegramConfigured()) {
            logToFile('telegram_skip', { reason: 'not_configured', symbol, time, msg: 'Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env' });
          }
          sendAlert(`ENTRY ${symbol} #${pos.id} @ ${time} | entry=${entryPrice} SL=${stop} 3%→trail`);
        }
      } else if (result && resultTime5 !== barTime5) {
        logToFile('entry_bar_mismatch', { symbol, date, entryBarTime: resultTime5, currentBarTime: barTime5, reason: 'Alert only when current bar is the entry bar' });
      }
    }
  }, {
    onVolumeFlush(info) {
      if (info.volumeSource === 'cumulative_diff') volumeDebugCumulative++;
      else volumeDebugSum++;
      logVolumeFlush(info);
    },
  });

  const ticker = new KiteTicker({
    api_key: apiKey,
    access_token: session.access_token,
  });

  ticker.on('ticks', (ticks) => {
    tickCount += ticks.length;
    for (const t of ticks) {
      const token = typeof t.instrument_token === 'number' ? t.instrument_token : Number(t.instrument_token);
      const symbol = tokenToSymbol.get(token);
      if (!symbol) continue;
      const ts = t.exchange_timestamp || t.last_trade_time;
      const when = ts instanceof Date ? ts : (typeof ts === 'string' ? new Date(ts) : new Date());
      builder.addTick(token, symbol, t.last_price || 0, t.last_traded_quantity || 0, when, t.volume);
    }
  });

  ticker.on('connect', () => {
    ticker.subscribe(tokens);
    ticker.setMode(ticker.modeFull, tokens);
    const msg = `subscribed to ${tokens.length} tokens`;
    console.error('Connected. Building 3m bars; signals will be logged and sent to Telegram if configured.');
    if (LOG_VOLUME_ENABLED) {
      console.error('Volume debug: logging each bar flush (volume, cumulative_diff vs sum_quantity) to', LOG_VOLUME_PATH);
    }
    if (!telegramConfigured()) {
      console.error('Telegram not configured — no alerts will be sent. Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env');
      logToFile('telegram', 'not_configured');
    }
    logToFile('connect', msg);
  });

  ticker.on('disconnect', (err) => {
    let reason = '(no reason)';
    if (err && typeof err === 'object') {
      if (err.code != null) reason = `code ${err.code}`;
      if (err.reason && String(err.reason).trim()) reason += ` ${err.reason}`.trim();
      else if (err.message) reason = err.message;
    } else if (err != null) reason = String(err);
    console.error('Disconnected', reason, '(will reconnect if possible)');
    logToFile('disconnect', reason);
  });
  ticker.on('error', (err) => {
    const msg = err?.message ?? (err && typeof err === 'object' ? `code ${err.code ?? ''} ${err.reason ?? ''}`.trim() : String(err));
    console.error('Ticker error', msg);
    logToFile('error', msg || (err?.message ?? String(err)));
  });
  ticker.on('noreconnect', () => {
    console.error('Ticker gave up reconnecting.');
    logToFile('noreconnect', 'gave up reconnecting');
  });

  ticker.connect();
}

main().catch((err) => {
  console.error(err);
  logToFile('fatal', err?.message ?? String(err));
  process.exit(1);
});
