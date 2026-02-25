/**
 * Live scanner: subscribe to symbols from config/nse_mcap_above_900cr.csv,
 * build 3m candles from Kite ticks, run entry logic on each new bar, persist paper positions, send Telegram alerts.
 *
 * Usage: node scripts/liveScanner.js
 *
 * Requires: .env with Kite credentials; optional TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID.
 * Symbol list: config/nse_mcap_above_900cr.csv (tradingsymbol column). Max 3000 tokens per KiteTicker connection.
 */

import fs from 'fs';
import path from 'path';
import { getKite } from '../lib/kite.js';
import { KiteTicker } from 'kiteconnect';
import { createCandleBuilder } from '../lib/candleBuilder.js';
import { runEntryLogic } from '../lib/entryLogic.js';
import { addPosition, processBar, getTotalPnl, eodSweep, POSITION_VALUE } from '../lib/positionStore.js';
import { sendAlert } from '../lib/telegram.js';

const WATCHLIST_PATH = path.join(process.cwd(), 'config', 'nse_mcap_above_900cr.csv');
const MAX_TOKENS = 3000;

/** File log for debugging when away during market hours. Logs to data/live_scanner.log by default. Set LIVE_SCANNER_LOG=0 to disable, or LOG_PATH for custom path. */
const LOG_ENABLED = process.env.LIVE_SCANNER_LOG !== '0' && process.env.LIVE_SCANNER_LOG !== 'false';
const LOG_PATH = process.env.LOG_PATH
  ? path.resolve(process.cwd(), process.env.LOG_PATH)
  : path.join(process.cwd(), 'data', 'live_scanner.log');

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

function computeTarget(entryPrice, stop) {
  const risk = entryPrice - stop;
  return Math.round((entryPrice + 2 * risk) * 100) / 100;
}

/** Normalize symbol to lowercase CSV filename (matches analyzePnl convention). */
function normalizeSymbolFilename(symbol) {
  return symbol.toLowerCase().replace(/&/g, '').replace(/\s/g, '');
}

/** Find the most recent date folder in data/ that is before todayStr (YYYY-MM-DD). */
function findPrevDateFolder(todayStr) {
  const dataDir = path.join(process.cwd(), 'data');
  try {
    const dirs = fs.readdirSync(dataDir)
      .filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d) && d < todayStr)
      .sort()
      .reverse();
    return dirs.length > 0 ? dirs[0] : null;
  } catch { return null; }
}

/**
 * Load the last nBars 3m candles for symbol from data/<prevDateFolder>/<symbol>.csv.
 * Returns [] if file not found or on any error.
 */
function loadPrevDayTailBars(symbol, prevDateFolder, nBars = 25) {
  const file = normalizeSymbolFilename(symbol) + '.csv';
  const csvPath = path.join(process.cwd(), 'data', prevDateFolder, file);
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
    return rows.slice(-nBars);
  } catch { return []; }
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

  const symbolToToken = new Map();
  for (const [token, sym] of tokenToSymbol) symbolToToken.set(sym, token);

  const gapUpThresholdPct = process.env.GAP_UP_THRESHOLD_PCT != null ? parseFloat(process.env.GAP_UP_THRESHOLD_PCT) : null;
  const prevCloseBySymbol = new Map();
  const prevDayVolumeBySymbol = new Map();
  const prevDayTailBySymbol = new Map();
  const dayOpenBySymbol = new Map();
  const CONCURRENCY = 15;
  const symbolsForPrevDay = [...symbolToToken.keys()];
  const totalBatches = Math.ceil(symbolsForPrevDay.length / CONCURRENCY);
  const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const rangeFromStr = dateMinusDays(todayStr, 7);
  const dayFrom = new Date(`${rangeFromStr}T00:00:00+05:30`);
  const dayTo = new Date(`${todayStr}T23:59:59+05:30`);
  // Same as analyzePnl: prev day from daily API only; 3m only for current day (built from ticks below).
  console.error('Prev day (close + volume) from daily API only, range', rangeFromStr, '→', todayStr, '|', symbolsForPrevDay.length, 'symbols');
  for (let i = 0; i < symbolsForPrevDay.length; i += CONCURRENCY) {
    const chunk = symbolsForPrevDay.slice(i, i + CONCURRENCY);
    await Promise.all(
      chunk.map(async (symbol) => {
        try {
          const token = symbolToToken.get(symbol);
          const candles = await kite.getHistoricalData(token, 'day', dayFrom, dayTo, false, false);
          if (candles && candles.length > 0) {
            for (const c of candles) {
              const d = candleDateStr(c);
              if (d < todayStr) {
                prevCloseBySymbol.set(symbol, c.close);
                prevDayVolumeBySymbol.set(symbol, c.volume ?? 0);
              }
            }
          }
        } catch {
          // skip
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
        try {
          const token = symbolToToken.get(symbol);
          const candles = await kite.getHistoricalData(token, 'day', dayFrom, dayTo, false, false);
          if (candles && candles.length > 0) {
            for (const c of candles) {
              const d = candleDateStr(c);
              if (d < todayStr) {
                prevCloseBySymbol.set(symbol, c.close);
                prevDayVolumeBySymbol.set(symbol, c.volume ?? 0);
              }
            }
          }
        } catch { /* skip */ }
      }));
    }
    const stillMissing = missingVol.filter(s => !prevDayVolumeBySymbol.has(s));
    console.error(`After retry: ${prevDayVolumeBySymbol.size} symbols have daily volume; still missing: ${stillMissing.length}`);
  }
  console.error('Prev day daily OHLCV done:', prevDayVolumeBySymbol.size, '/', symbolsForPrevDay.length, 'symbols have volume.');

  // Fix #2: load prev day 3m tail bars from local CSV cache so EMA20 is seeded from bar 0 of today
  const prevDateFolder = findPrevDateFolder(todayStr);
  if (prevDateFolder) {
    console.error(`Loading prev day 3m tails from ${prevDateFolder} for EMA seeding...`);
    let tailCount = 0;
    for (const symbol of symbolsForPrevDay) {
      const tail = loadPrevDayTailBars(symbol, prevDateFolder);
      if (tail.length > 0) { prevDayTailBySymbol.set(symbol, tail); tailCount++; }
    }
    console.error(`Prev day 3m tails loaded: ${tailCount}/${symbolsForPrevDay.length} symbols (${prevDateFolder})`);
  } else {
    console.error('No prev day date folder found in data/ — EMA will be seeded from today bars only');
  }

  const todayFrom = new Date(`${todayStr}T00:00:00+05:30`);
  const todayTo = new Date(`${todayStr}T23:59:59+05:30`);
  const fetchTodayOpen = async () => {
    console.error('Loading today open (daily only) for gap filter:', symbolsForPrevDay.length, 'symbols');
    for (let i = 0; i < symbolsForPrevDay.length; i += CONCURRENCY) {
      const chunk = symbolsForPrevDay.slice(i, i + CONCURRENCY);
      await Promise.all(
        chunk.map(async (symbol) => {
          try {
            const token = symbolToToken.get(symbol);
            const candles = await kite.getHistoricalData(token, 'day', todayFrom, todayTo, false, false);
            if (candles && candles.length > 0) dayOpenBySymbol.set(symbol, candles[0].open);
          } catch {
            // skip
          }
        })
      );
    }
    console.error('Today open loaded:', dayOpenBySymbol.size, 'symbols (daily only; gap = prev close vs today open)');
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
  const builder = createCandleBuilder((bar) => {
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
      logToFile('heartbeat', { bars: barsClosedCount, symbols: symCount, ticks: tickCount, ...t });
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

    // ── STEP 2: look for new entries ───────────────────────────────────────
    const prevTail = prevDayTailBySymbol.get(symbol);
    const prevDate = prevTail && prevTail.length > 0 ? prevTail[0].date : null;
    const byDate = prevDate ? { [prevDate]: prevTail, [date]: series[date] } : { [date]: series[date] };
    const sortedDates = prevDate ? [prevDate, date] : [date];

    const maxEntryCandleRangePct = process.env.MAX_ENTRY_CANDLE_RANGE_PCT != null ? parseFloat(process.env.MAX_ENTRY_CANDLE_RANGE_PCT) : 1.5;
    const maxSlPct               = process.env.MAX_SL_PCT != null               ? parseFloat(process.env.MAX_SL_PCT)               : 2;
    const maxPullbackPct         = process.env.MAX_PULLBACK_PCT != null         ? parseFloat(process.env.MAX_PULLBACK_PCT)         : 5;
    const maxConsolidationRangePct = process.env.MAX_CONSOLIDATION_RANGE_PCT != null ? parseFloat(process.env.MAX_CONSOLIDATION_RANGE_PCT) : 2;
    const minVolRatio            = process.env.MIN_VOLUME_RATIO != null         ? parseFloat(process.env.MIN_VOLUME_RATIO)         : null;

    // collect internal filter skips — logged to file for EOD debug
    const skipReasons = [];
    const onSkip = (reason) => skipReasons.push(reason);

    const opts = {
      lookback: 15, maxRangePct: 2, tolerancePct: 1, sharpMovePct: 4, pullbackNearPct: 2, maxPerDay: 2,
      maxGapUpPct: gapUpThresholdPct ?? undefined,
      maxEntryCandleRangePct, maxSlPct, maxPullbackPct, maxConsolidationRangePct,
      getPrevDayVolume: () => {
        const v = prevDayVolumeBySymbol.get(symbol);
        if (v != null) return v;
        const tail = prevDayTailBySymbol.get(symbol);
        return tail && tail.length > 0 ? tail.reduce((s, b) => s + (b.volume ?? 0), 0) : null;
      },
      getPrevDayCloseDaily: () => prevCloseBySymbol.get(symbol) ?? null,
      getDayOpenDaily:      () => dayOpenBySymbol.get(symbol) ?? null,
      onSkip,
    };

    const { reversalBreakouts } = runEntryLogic(byDate, sortedDates, opts);

    // log internal skips to file (only when at least one was generated this bar)
    if (skipReasons.length > 0) {
      logToFile('skip_internal', { symbol, date, time, reasons: skipReasons });
    }

    const toEmit = [];
    for (const r of reversalBreakouts) {
      if (r.time !== time) continue;

      // ── external gap filter ──
      if (gapUpThresholdPct != null && Number.isFinite(gapUpThresholdPct)) {
        const dayOpen = dayOpenBySymbol.get(symbol);
        if (dayOpen == null) {
          const reason = 'today_open_not_loaded';
          logToFile('skip', { symbol, date, time, reason });
          continue;
        }
        const prevClose = prevCloseBySymbol.get(symbol);
        if (prevClose != null && prevClose > 0 && dayOpen > prevClose) {
          const gapPct = ((dayOpen - prevClose) / prevClose) * 100;
          if (gapPct >= gapUpThresholdPct) {
            const reason = `gap_filter_${gapPct.toFixed(1)}pct >= ${gapUpThresholdPct}pct`;
            console.error(`[skip] ${symbol} @ ${time} | ${reason}`);
            logToFile('skip', { symbol, date, time, reason, gapPct, gapUpThresholdPct });
            continue;
          }
        }
      }

      // ── external volume ratio filter ──
      if (minVolRatio != null && Number.isFinite(minVolRatio)) {
        const consAvg = r.consolidationAvgVolume ?? 0;
        const ratio = consAvg > 0 ? (r.entryBarVolume ?? 0) / consAvg : 0;
        if (ratio < minVolRatio) {
          const reason = `vol_ratio_${ratio.toFixed(2)} < ${minVolRatio}`;
          console.error(`[skip] ${symbol} @ ${time} | ${reason}`);
          logToFile('skip', { symbol, date, time, reason, volRatio: ratio, minVolRatio });
          continue;
        }
      }

      toEmit.push({ type: 'REVERSAL_BREAKOUT', ...r });
    }

    // ── emit signals ──
    for (const sig of toEmit) {
      const key = `${symbol}|${date}|${sig.type}|${time}`;
      if (signaled.has(key)) continue;
      signaled.add(key);

      const entryPrice = sig.suggestedEntry ?? sig.close;
      const stop       = sig.suggestedStop  ?? (sig.ema20 != null ? Math.round(sig.ema20 * 0.995 * 100) / 100 : entryPrice * 0.99);
      const target     = computeTarget(entryPrice, stop);
      const slPct      = entryPrice > 0 ? ((entryPrice - stop) / entryPrice * 100).toFixed(2) : '?';
      const qty        = Math.floor(POSITION_VALUE / entryPrice);
      const prevVol    = prevDayVolumeBySymbol.get(symbol) ?? null;
      const cumVol     = series[date].reduce((s, b) => s + (b.volume ?? 0), 0);

      const pos = addPosition({ symbol, side: 'long', entryTime: `${date} ${time}`, entryPrice, stop, target, signalType: sig.type });

      const msg = `[ENTRY] ${symbol} #${pos.id} @ ${time} | entry=${entryPrice} SL=${stop} (${slPct}%) target=${target} | qty=${qty} | cumVol=${cumVol} prevDayVol=${prevVol ?? 'n/a'}`;
      console.error(msg);
      logToFile('entry', { symbol, date, time, id: pos.id, entry: entryPrice, stop, target, slPct: parseFloat(slPct), qty, cumVol, prevDayVol: prevVol });
      sendAlert(`ENTRY ${symbol} #${pos.id} @ ${time} | entry=${entryPrice} SL=${stop} target=${target}`);
    }
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
      builder.addTick(token, symbol, t.last_price || 0, t.last_traded_quantity || 0, when);
    }
  });

  ticker.on('connect', () => {
    ticker.subscribe(tokens);
    ticker.setMode(ticker.modeFull, tokens);
    const msg = `subscribed to ${tokens.length} tokens`;
    console.error('Connected. Building 3m bars; signals will be logged and sent to Telegram if configured.');
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
