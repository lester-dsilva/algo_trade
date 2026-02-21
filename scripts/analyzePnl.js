/**
 * Parse live_scanner.log for "signal" entries, fetch 3m data, simulate P&L:
 * - Position size: ₹30,000 per entry (qty = floor(30000/entry))
 * - First target: 3% above entry (trigger only; we don't exit there). Then trail: exit when price falls 1.5% from the high since 3% was hit.
 * - Exit: initial stop (before 3%), or 1.5% trail from high (after 3%), or EOD square-off at 15:25
 *
 * Usage:
 *   node scripts/analyzePnl.js [logPath]           — P&L from log (no volume filter)
 *   node scripts/analyzePnl.js 2026-02-20          — P&L from entry logic for that date (with Daily Vol > prev day filter)
 *   node scripts/analyzePnl.js --today             — same but use today's date (IST)
 */

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { groupByDate, findReversalBreakouts } from '../lib/entryLogic.js';

const DATA_DIR = path.join(process.cwd(), 'data');
const BASELINES_DIR = path.join(DATA_DIR, 'baselines');
const DEFAULT_LOG = path.join(DATA_DIR, 'live_scanner.log');
const POSITION_VALUE = 30000;
const EOD_BAR_TIME = '15:24'; // square off at 3:25 PM → use 15:24 bar close

function computeTarget(entryPrice, stop) {
  const risk = entryPrice - stop;
  return Math.round((entryPrice + 2 * risk) * 100) / 100;
}

function getTodayIST() {
  const d = new Date();
  const str = d.toLocaleString('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' });
  const [y, m, day] = str.split('-');
  return `${y}-${m}-${day}`;
}

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

function toNum(v) {
  const n = parseFloat(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
}

function normalizeFilename(symbol) {
  return symbol.toLowerCase().replace(/&/g, '').replace(/\s/g, '');
}

function dateRange(fromStr, toStr) {
  const out = [];
  const [y1, m1, d1] = fromStr.split('-').map(Number);
  const [y2, m2, d2] = toStr.split('-').map(Number);
  const cur = new Date(y1, m1 - 1, d1);
  const end = new Date(y2, m2 - 1, d2);
  while (cur <= end) {
    const y = cur.getFullYear();
    const m = cur.getMonth() + 1;
    const d = cur.getDate();
    out.push(`${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
    cur.setDate(cur.getDate() + 1);
  }
  return out;
}

/** Parse live_scanner.log; return array of { symbol, date, time, entry, stop, target } */
function parseSignalsFromLog(logPath) {
  if (!fs.existsSync(logPath)) return [];
  const text = fs.readFileSync(logPath, 'utf8');
  const signals = [];
  for (const line of text.split(/\r?\n/)) {
    const parts = line.split('\t');
    if (parts.length < 3 || parts[1] !== 'signal') continue;
    try {
      const d = JSON.parse(parts[2]);
      if (d.symbol && d.entry != null && d.stop != null && d.target != null) {
        signals.push({
          symbol: d.symbol,
          date: d.date || '',
          time: (d.time || '').slice(0, 8),
          entry: toNum(d.entry),
          stop: toNum(d.stop),
          target: toNum(d.target),
        });
      }
    } catch (_) {}
  }
  return signals;
}

function loadOrFetch(symbol, from, to, forceReload = false) {
  const file = normalizeFilename(symbol) + '.csv';

  const tryLoadFromDateFolders = () => {
    const dates = dateRange(from, to);
    const rows = [];
    for (const d of dates) {
      const p = path.join(DATA_DIR, d, file);
      if (!fs.existsSync(p)) return null;
      const content = fs.readFileSync(p, 'utf8');
      const parsed = parseCsv(content);
      for (const r of parsed) {
        const date = (r.date || '').trim();
        if (!date || !(toNum(r.open) > 0)) continue;
        rows.push({
          date,
          time: (r.time || '').trim().slice(0, 8),
          open: toNum(r.open),
          high: toNum(r.high),
          low: toNum(r.low),
          close: toNum(r.close),
          volume: toNum(r.volume),
        });
      }
    }
    return rows;
  };

  if (!forceReload) {
    const fromFolders = tryLoadFromDateFolders();
    if (fromFolders && fromFolders.length > 0) return fromFolders;
  }

  const tmpDir = path.join(DATA_DIR, '.tmp');
  const tmpPath = path.join(tmpDir, file);
  try {
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
    execSync(
      `node scripts/kiteOHLC.js NSE:${symbol.replace(/\s/g, '')} 3minute ${from} ${to} "${tmpPath}"`,
      { cwd: process.cwd(), stdio: 'pipe' }
    );
  } catch (e) {
    const msg = (e.stderr && e.stderr.toString()) || e.stdout?.toString() || e.message || String(e);
    console.error(`[${symbol}] fetch failed: ${msg.trim().split(/\r?\n/)[0]}`);
    return null;
  }
  if (!fs.existsSync(tmpPath)) return null;

  const content = fs.readFileSync(tmpPath, 'utf8');
  try { fs.unlinkSync(tmpPath); } catch (_) {}
  const rows = parseCsv(content);
  const normalized = rows.map((r) => ({
    date: (r.date || '').trim(),
    time: (r.time || '').trim().slice(0, 8),
    open: toNum(r.open),
    high: toNum(r.high),
    low: toNum(r.low),
    close: toNum(r.close),
    volume: toNum(r.volume),
  })).filter((r) => r.date && r.open > 0);

  writeCsvByDate(symbol, normalized);
  return normalized;
}

function writeCsvByDate(symbol, rows) {
  if (!rows || rows.length === 0) return;
  const byDate = {};
  for (const r of rows) {
    const d = r.date || '';
    if (!d) continue;
    if (!byDate[d]) byDate[d] = [];
    byDate[d].push(r);
  }
  const base = normalizeFilename(symbol) + '.csv';
  const header = 'date,time,open,high,low,close,volume';
  for (const date of Object.keys(byDate)) {
    const dir = path.join(DATA_DIR, date);
    try {
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const lines = [header, ...byDate[date].map((r) => [r.date, r.time, r.open, r.high, r.low, r.close, r.volume ?? 0].join(','))];
      fs.writeFileSync(path.join(dir, base), lines.join('\n'), 'utf8');
    } catch (_) {}
  }
}

const FIRST_TARGET_PCT = 3;
const TRAIL_PCT = 1.5;

/**
 * Simulate one trade: first target 3% when bar closes >= 3%; then trail (1.5% from high) from the next bar only.
 * We wait for the candle to close before starting the trail so we don't exit in the same bar that hit 3%.
 * Trail exit is triggered only when a bar closes at or below the trail level (not on intrabar low), so we don't
 * assume a fill at a level that may never have traded.
 * Returns { exitReason: 'stop'|'eod', exitPrice, pnl, qty }.
 */
function simulateTrade(signal, candles) {
  const { symbol, date, time, entry, stop, target } = signal;
  const dayCandles = candles.filter((c) => c.date === date).sort((a, b) => (a.time || '').localeCompare(b.time || ''));
  const qty = Math.floor(POSITION_VALUE / entry);
  if (qty <= 0) return { exitReason: 'skip', exitPrice: entry, pnl: 0, qty: 0 };

  const firstTarget = Math.round(entry * (1 + FIRST_TARGET_PCT / 100) * 100) / 100;
  const timeMatch = (t) => (c) => (c.time || '').slice(0, 5) === (t || '').slice(0, 5) || c.time === t;
  let idx = dayCandles.findIndex(timeMatch(time));
  if (idx < 0) idx = dayCandles.findIndex((c) => (c.time || '').localeCompare(time) >= 0);
  if (idx < 0) return { exitReason: 'no_bar', exitPrice: entry, pnl: 0, qty };

  let hitFirstTarget = false;
  let highWaterMark = 0;
  for (let i = idx + 1; i < dayCandles.length; i++) {
    const b = dayCandles[i];
    if (!hitFirstTarget && b.low <= stop) return { exitReason: 'stop', exitPrice: stop, pnl: (stop - entry) * qty, qty };
    if (!hitFirstTarget && b.close >= firstTarget) {
      hitFirstTarget = true;
      if ((b.time || '').startsWith(EOD_BAR_TIME) || b.time >= '15:24') {
        return { exitReason: 'eod', exitPrice: b.close, pnl: (b.close - entry) * qty, qty };
      }
      continue;
    }
    if (hitFirstTarget) {
      highWaterMark = Math.max(highWaterMark, b.high);
      const trailExit = Math.round(highWaterMark * (1 - TRAIL_PCT / 100) * 100) / 100;
      if (b.close <= trailExit) return { exitReason: 'stop', exitPrice: trailExit, pnl: (trailExit - entry) * qty, qty };
    }
    if ((b.time || '').startsWith(EOD_BAR_TIME) || b.time >= '15:24') {
      return { exitReason: 'eod', exitPrice: b.close, pnl: (b.close - entry) * qty, qty };
    }
  }
  const last = dayCandles[dayCandles.length - 1];
  return { exitReason: 'eod', exitPrice: last ? last.close : entry, pnl: last ? (last.close - entry) * qty : 0, qty };
}

/** Load watchlist symbols. If customPath is set, load from that file; else use reward list if useRewardWatchlist, else watchlist_23.txt if present, else watchlist_reward.txt */
function loadWatchlistSymbols(useRewardWatchlist = false, customPath = null) {
  if (customPath) {
    const p = path.isAbsolute(customPath) ? customPath : path.join(process.cwd(), customPath);
    if (fs.existsSync(p)) {
      const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      if (lines.length > 0) return lines;
    }
    return [];
  }
  const p23 = path.join(DATA_DIR, 'watchlist_23.txt');
  const pReward = path.join(DATA_DIR, 'watchlist_reward.txt');
  if (useRewardWatchlist && fs.existsSync(pReward)) {
    const lines = fs.readFileSync(pReward, 'utf8').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    if (lines.length > 0) return lines;
  }
  if (!useRewardWatchlist && fs.existsSync(p23)) {
    const lines = fs.readFileSync(p23, 'utf8').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    if (lines.length > 0) return lines;
  }
  if (fs.existsSync(pReward)) {
    const lines = fs.readFileSync(pReward, 'utf8').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    if (lines.length > 0) return lines;
  }
  return [];
}

/** Get signals from entry logic for a given date (with Daily Vol > prev day filter). Needs 3m data for prevDay and date. */
async function getSignalsFromEntryLogic(forDate, symbols, forceReload = false) {
  const prevDate = new Date(forDate);
  prevDate.setDate(prevDate.getDate() - 1);
  const prevStr = prevDate.toISOString().slice(0, 10);
  const from = prevStr;
  const to = forDate;
  const maxGapUpPct = process.env.GAP_UP_THRESHOLD_PCT != null ? parseFloat(process.env.GAP_UP_THRESHOLD_PCT) : null;
  const maxEntryCandleRangePct = process.env.MAX_ENTRY_CANDLE_RANGE_PCT != null ? parseFloat(process.env.MAX_ENTRY_CANDLE_RANGE_PCT) : 1.5;
  const maxSlPct = process.env.MAX_SL_PCT != null ? parseFloat(process.env.MAX_SL_PCT) : 2;
  const maxPullbackPct = process.env.MAX_PULLBACK_PCT != null ? parseFloat(process.env.MAX_PULLBACK_PCT) : 5;
  const maxConsolidationRangePct = process.env.MAX_CONSOLIDATION_RANGE_PCT != null ? parseFloat(process.env.MAX_CONSOLIDATION_RANGE_PCT) : 2;
  const fetchDelayMs = parseInt(process.env.LOAD_DELAY_MS, 10) || 2000;
  let lastFetchTime = 0;
  const signals = [];
  for (const symbol of symbols) {
    const csvPath = path.join(DATA_DIR, normalizeFilename(symbol) + '.csv');
    const needFetch = !fs.existsSync(csvPath) || forceReload;
    if (needFetch && lastFetchTime > 0) {
      const elapsed = Date.now() - lastFetchTime;
      if (elapsed < fetchDelayMs) await new Promise((r) => setTimeout(r, fetchDelayMs - elapsed));
      lastFetchTime = Date.now();
    } else if (needFetch) lastFetchTime = Date.now();
    const rows = loadOrFetch(symbol, from, to, forceReload);
    if (!rows || rows.length === 0) continue;
    const byDate = groupByDate(rows);
    const sortedDates = Object.keys(byDate).sort();
    if (!sortedDates.includes(forDate)) continue;
    const entries = findReversalBreakouts(byDate, sortedDates, 4, 2, maxGapUpPct, maxEntryCandleRangePct, maxSlPct, null, maxPullbackPct, maxConsolidationRangePct);
    const minVolRatio = process.env.MIN_VOLUME_RATIO != null ? parseFloat(process.env.MIN_VOLUME_RATIO) : null;
    for (const e of entries) {
      if (e.date !== forDate) continue;
      if (minVolRatio != null && Number.isFinite(minVolRatio)) {
        const consAvg = e.consolidationAvgVolume ?? 0;
        const ratio = consAvg > 0 ? (e.entryBarVolume ?? 0) / consAvg : 0;
        if (ratio < minVolRatio) continue;
      }
      const entryPrice = e.close;
      const stop = e.suggestedStop ?? entryPrice * 0.99;
      const target = computeTarget(entryPrice, stop);
      signals.push({
        symbol,
        date: e.date,
        time: (e.time || '').slice(0, 8),
        entry: entryPrice,
        stop,
        target,
      });
    }
  }
  return signals;
}

function runPnl(signals, from, to, sourceLabel) {
  console.error(`${sourceLabel}`);
  console.error(`Position value: ₹${POSITION_VALUE} per entry | First target 3% then trail 1.5% | EOD 15:25\n`);

  const results = [];
  const skipped = [];

  for (const sig of signals) {
    const candles = loadOrFetch(sig.symbol, from, to);
    if (!candles || candles.length === 0) {
      skipped.push(sig.symbol);
      results.push({ ...sig, exitReason: 'no_data', exitPrice: sig.entry, pnl: 0, qty: 0 });
      continue;
    }
    const sim = simulateTrade(sig, candles);
    results.push({
      symbol: sig.symbol,
      date: sig.date,
      time: sig.time,
      entry: sig.entry,
      stop: sig.stop,
      target: sig.target,
      qty: sim.qty,
      exitReason: sim.exitReason,
      exitPrice: sim.exitPrice,
      pnl: Math.round(sim.pnl * 100) / 100,
    });
  }

  const totalPnl = results.reduce((s, r) => s + r.pnl, 0);
  const totalCapitalDeployed = results.reduce((s, r) => s + (r.entry * r.qty || 0), 0);
  const byStop = results.filter((r) => r.exitReason === 'stop');
  const byTarget = results.filter((r) => r.exitReason === 'target');
  const byEod = results.filter((r) => r.exitReason === 'eod');
  const noData = results.filter((r) => r.exitReason === 'no_data' || r.exitReason === 'no_bar');

  console.log('Symbol        Date       Time   Entry     Stop     Target   Qty  Exit    ExitPrice    P&L');
  console.log('-'.repeat(95));
  for (const r of results) {
    console.log(
      `${String(r.symbol).padEnd(13)} ${r.date}  ${String(r.time).padEnd(6)} ${String(r.entry).padStart(8)} ${String(r.stop).padStart(8)} ${String(r.target).padStart(8)} ${String(r.qty).padStart(4)} ${String(r.exitReason).padEnd(6)} ${String(r.exitPrice.toFixed(2)).padStart(10)} ${r.pnl >= 0 ? ' ' : ''}${r.pnl.toFixed(2)}`
    );
  }
  console.log('-'.repeat(95));
  console.log(`Total trades: ${results.length}  |  Stop: ${byStop.length}  Target: ${byTarget.length}  EOD: ${byEod.length}  No data: ${noData.length}`);
  console.log(`\nTotal capital deployed: ₹${totalCapitalDeployed.toFixed(2)}`);
  console.log(`Total P&L: ₹${totalPnl.toFixed(2)}`);
  if (skipped.length) console.error('\nSkipped (no 3m data):', skipped.join(', '));

  return {
    results,
    totalPnl,
    totalCapitalDeployed,
    counts: { total: results.length, stop: byStop.length, target: byTarget.length, eod: byEod.length, noData: noData.length },
  };
}

function saveBaseline(forDate, symbols, summary) {
  const dir = path.join(BASELINES_DIR, forDate);
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'watchlist.txt'),
      symbols.filter(Boolean).join('\n') + (symbols.length ? '\n' : ''),
      'utf8'
    );
    fs.writeFileSync(
      path.join(dir, 'pnl.json'),
      JSON.stringify(
        {
          date: forDate,
          runAt: new Date().toISOString(),
          totalPnl: summary.totalPnl,
          totalCapitalDeployed: summary.totalCapitalDeployed,
          counts: summary.counts,
          trades: summary.results,
        },
        null,
        2
      ),
      'utf8'
    );
    console.error(`\nBaseline saved: ${path.join(dir, 'watchlist.txt')} + pnl.json`);
  } catch (e) {
    console.error('Failed to save baseline:', e?.message || e);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const useToday = args.includes('--today');
  const dateArg = args.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));
  const logPath = args.find((a) => a.endsWith('.log') || (!a.startsWith('--') && !/^\d{4}-\d{2}-\d{2}$/.test(a) && a.length > 3));

  let signals;
  let from;
  let to;
  let sourceLabel;
  let symbols = null;
  let forDate = dateArg || (useToday ? getTodayIST() : null);

  if (useToday || dateArg) {
    forDate = useToday ? getTodayIST() : dateArg;
    const useReward = args.includes('--reward');
    const loadOnly = args.includes('--load-only');
    const watchlistIdx = args.indexOf('--watchlist');
    const customWatchlist = watchlistIdx >= 0 && args[watchlistIdx + 1] ? args[watchlistIdx + 1] : null;
    symbols = loadWatchlistSymbols(useReward, customWatchlist);
    if (symbols.length === 0) {
      console.error('No symbols in watchlist (use --watchlist path, or data/watchlist_23.txt / data/watchlist_reward.txt)');
      process.exit(1);
    }
    const prevDate = new Date(forDate);
    prevDate.setDate(prevDate.getDate() - 1);
    from = prevDate.toISOString().slice(0, 10);
    to = forDate;

    if (loadOnly) {
      const loadDelayMs = parseInt(process.env.LOAD_DELAY_MS, 10) || 2000;
      console.error(`Loading 3m data for ${symbols.length} symbols | ${from} to ${to}`);
      console.error(`Data directory: ${DATA_DIR}  (delay ${loadDelayMs}ms between symbols to avoid rate limit)\n`);
      for (let i = 0; i < symbols.length; i++) {
        const symbol = symbols[i];
        if (i > 0) await new Promise((r) => setTimeout(r, loadDelayMs));
        const rows = loadOrFetch(symbol, from, to, false);
        const file = normalizeFilename(symbol) + '.csv';
        const csvPath = path.join(DATA_DIR, file);
        const rowsCount = rows ? rows.length : 0;
        const hasDate = rows && rows.some((r) => (r.date || '').trim() === to);
        console.log(`${symbol.padEnd(14)} → ${csvPath}  (${rowsCount} rows, has ${to}: ${hasDate ? 'yes' : 'no'})`);
      }
      console.error('\nDone. Run without --load-only to run P&L analysis.');
      return;
    }

    const watchlistLabel = customWatchlist ? ` (${path.basename(customWatchlist)})` : useReward ? ' (watchlist_reward)' : '';
    console.error(`Entry logic (with Daily Vol > prev day filter) for ${forDate} | ${symbols.length} symbols${watchlistLabel}`);
    signals = await getSignalsFromEntryLogic(forDate, symbols, false);
    if (signals.length === 0) {
      console.error('No entries found for', forDate, '(after volume filter).');
      process.exit(1);
    }
    sourceLabel = `Signals from entry logic for ${forDate} (${signals.length} entries, Daily Vol > prev day)`;
  } else {
    const log = logPath || DEFAULT_LOG;
    signals = parseSignalsFromLog(log);
    if (signals.length === 0) {
      console.error('No signal lines found in', log);
      process.exit(1);
    }
    const dates = [...new Set(signals.map((s) => s.date))].filter(Boolean).sort();
    from = dates[0] || '2026-02-20';
    to = dates[dates.length - 1] || from;
    sourceLabel = `Parsed ${signals.length} signals from ${log} (${from} to ${to})`;
  }

  const summary = runPnl(signals, from, to, sourceLabel);
  if (forDate && summary && symbols != null) {
    saveBaseline(forDate, symbols, summary);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
