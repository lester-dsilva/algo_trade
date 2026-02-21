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
import { addPosition } from '../lib/positionStore.js';
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
  const sym = tradingsymbol.includes(':') ? tradingsymbol.split(':')[1] : tradingsymbol;
  const row = instruments.find((i) => i.exchange === 'NSE' && i.tradingsymbol === sym);
  return row ? row.instrument_token : null;
}

function computeTarget(entryPrice, stop) {
  const risk = entryPrice - stop;
  return Math.round((entryPrice + 2 * risk) * 100) / 100;
}

async function main() {
  const symbols = loadWatchlistSymbols();
  if (symbols.length === 0) {
    console.error('No symbols in', WATCHLIST_PATH);
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
  const CONCURRENCY = 15;
  const symbolsForPrevDay = [...symbolToToken.keys()];
  const totalBatches = Math.ceil(symbolsForPrevDay.length / CONCURRENCY);
  console.error('Loading prev day (close + volume) for', symbolsForPrevDay.length, 'symbols (' + totalBatches, 'batches)...');
  const d = new Date();
  d.setDate(d.getDate() - 1);
  const yesterday = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const dayFrom = new Date(yesterday);
  const dayTo = new Date(yesterday);
  for (let i = 0; i < symbolsForPrevDay.length; i += CONCURRENCY) {
    const chunk = symbolsForPrevDay.slice(i, i + CONCURRENCY);
    await Promise.all(
      chunk.map(async (symbol) => {
        try {
          const token = symbolToToken.get(symbol);
          const candles = await kite.getHistoricalData(token, 'day', dayFrom, dayTo, false, false);
          if (candles && candles.length > 0) {
            const c = candles[candles.length - 1];
            prevCloseBySymbol.set(symbol, c.close);
            // Yesterday's full-day volume (same unit as our 3m bar volumes) for filter: entry only when today's vol so far > this
            prevDayVolumeBySymbol.set(symbol, c.volume ?? 0);
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
  console.error('Prev day done; volume for', prevDayVolumeBySymbol.size, 'symbols (used for filter: Daily Vol > 1 day ago Vol)');

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

  const builder = createCandleBuilder((bar) => {
    const { symbol, date, time, open, high, low, close, volume } = bar;
    barsClosedCount++;
    const now = Date.now();
    if (now - lastHeartbeat >= 5 * 60 * 1000) {
      lastHeartbeat = now;
      const symCount = seriesBySymbol.size;
      const msg = `bars=${barsClosedCount} symbols=${symCount} ticks=${tickCount}`;
      console.error(`[heartbeat] ${new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' })} IST | ${msg}`);
      logToFile('heartbeat', msg);
    }
    let series = seriesBySymbol.get(symbol);
    if (!series) {
      series = {};
      seriesBySymbol.set(symbol, series);
    }
    if (!series[date]) series[date] = [];
    const candle = { date, time, open, high, low, close, volume };
    series[date].push(candle);

    const byDate = { [date]: series[date] };
    const sortedDates = [date];
    const maxEntryCandleRangePct = process.env.MAX_ENTRY_CANDLE_RANGE_PCT != null ? parseFloat(process.env.MAX_ENTRY_CANDLE_RANGE_PCT) : 1.5;
    const maxSlPct = process.env.MAX_SL_PCT != null ? parseFloat(process.env.MAX_SL_PCT) : 2;
    const maxPullbackPct = process.env.MAX_PULLBACK_PCT != null ? parseFloat(process.env.MAX_PULLBACK_PCT) : 5;
    const maxConsolidationRangePct = process.env.MAX_CONSOLIDATION_RANGE_PCT != null ? parseFloat(process.env.MAX_CONSOLIDATION_RANGE_PCT) : 2;
    const opts = {
      lookback: 15, maxRangePct: 2, tolerancePct: 1, sharpMovePct: 4, pullbackNearPct: 2, maxPerDay: 2,
      maxGapUpPct: gapUpThresholdPct ?? undefined, maxEntryCandleRangePct, maxSlPct, maxPullbackPct, maxConsolidationRangePct,
      getPrevDayVolume: () => prevDayVolumeBySymbol.get(symbol) ?? null,
    };
    const { breakouts, pullbacks, reversalBreakouts } = runEntryLogic(byDate, sortedDates, opts);

    const minVolRatio = process.env.MIN_VOLUME_RATIO != null ? parseFloat(process.env.MIN_VOLUME_RATIO) : null;
    const toEmit = [];
    for (const r of reversalBreakouts) {
      if (r.time !== time) continue;
      if (gapUpThresholdPct != null && Number.isFinite(gapUpThresholdPct)) {
        const prevClose = prevCloseBySymbol.get(symbol);
        const dayBars = seriesBySymbol.get(symbol)?.[date];
        const dayOpen = dayBars && dayBars.length > 0 ? dayBars[0].open : null;
        if (prevClose != null && prevClose > 0 && dayOpen != null && dayOpen > prevClose) {
          const gapPct = ((dayOpen - prevClose) / prevClose) * 100;
          if (gapPct >= gapUpThresholdPct) {
            const reason = `gap ${gapPct.toFixed(1)}% >= ${gapUpThresholdPct}%`;
            console.error(`[skip] ${symbol} reversal breakout skipped: ${reason}`);
            logToFile('skip', { symbol, date, time, reason });
            continue;
          }
        }
      }
      if (minVolRatio != null && Number.isFinite(minVolRatio)) {
        const consAvg = r.consolidationAvgVolume ?? 0;
        const ratio = consAvg > 0 ? (r.entryBarVolume ?? 0) / consAvg : 0;
        if (ratio < minVolRatio) {
          const reason = `volume ratio ${ratio.toFixed(2)} < ${minVolRatio}`;
          console.error(`[skip] ${symbol} reversal breakout skipped: ${reason}`);
          logToFile('skip', { symbol, date, time, reason });
          continue;
        }
      }
      toEmit.push({ type: 'REVERSAL_BREAKOUT', ...r });
    }

    for (const sig of toEmit) {
      const key = `${symbol}|${date}|${sig.type}|${time}`;
      if (signaled.has(key)) continue;
      signaled.add(key);

      const entryPrice = sig.suggestedEntry ?? sig.close;
      const stop = sig.suggestedStop ?? (sig.ema20 != null ? Math.round(sig.ema20 * 0.995 * 100) / 100 : entryPrice * 0.99);
      const target = computeTarget(entryPrice, stop);
      addPosition({
        symbol,
        side: 'long',
        entryTime: `${date} ${time}`,
        entryPrice,
        stop,
        target,
        signalType: sig.type,
      });
      const msg = `${symbol} ${sig.type} @ ${time} – Entry ${entryPrice}, SL ${stop}, Target ${target}`;
      console.error('[SIGNAL]', msg);
      logToFile('signal', { symbol, date, time, entry: entryPrice, stop, target });
      sendAlert(msg);
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
    const reason = err?.message ?? err ?? '(no reason)';
    console.error('Disconnected', reason);
    logToFile('disconnect', reason);
  });
  ticker.on('error', (err) => {
    console.error('Ticker error', err);
    logToFile('error', err?.message ?? String(err));
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
