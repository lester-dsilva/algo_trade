/**
 * Backtest one date on full universe using only 3m data on disk (no Kite).
 * Entry: findMomentumBreakouts. Exit: 3% first target, 1.5% trail, close-based initial SL.
 * Gap filter uses prev day last close and today first open from 3m.
 *
 * Usage: node scripts/backtestFullUniverse.js [date]
 *   date  YYYY-MM-DD (default 2026-02-18)
 * Symbols from config/nse_mcap_above_900cr.csv. Requires data/<prevDay> and data/<date> 3m CSVs.
 */

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { groupByDate, findMomentumBreakouts } from '../lib/entryLogic.js';
import { POSITION_VALUE, FIRST_TARGET_PCT, TRAIL_PCT } from '../lib/positionStore.js';

const DATA_DIR = path.join(process.cwd(), 'data');
const CONFIG_WATCHLIST = path.join(process.cwd(), 'config', 'nse_mcap_above_900cr.csv');
const EOD_BAR_TIME = '15:24';

function toNum(v) {
  const n = parseFloat(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
}

function normalizeFilename(symbol) {
  return symbol.toLowerCase().replace(/&/g, '').replace(/\s/g, '');
}

function parseCsv(content) {
  const raw = content.replace(/^\uFEFF/, '').trim();
  const lines = raw.split(/\r?\n/);
  if (lines.length < 2) return [];
  const header = lines[0].toLowerCase().split(',').map((c) => c.trim());
  return lines.slice(1).map((l) => {
    const v = l.split(',');
    const r = {};
    header.forEach((h, i) => { r[h] = (v[i] || '').trim(); });
    return r;
  });
}

function load3m(symbol, fromDate, toDate) {
  const file = normalizeFilename(symbol) + '.csv';
  const rows = [];
  for (const d of [fromDate, toDate].filter((x, i, a) => a.indexOf(x) === i)) {
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
}

function simulate(signal, candles) {
  const { date, time, entry, stop } = signal;
  const dayCandles = candles.filter((c) => c.date === date).sort((a, b) => (a.time || '').localeCompare(b.time || ''));
  const qty = Math.floor(POSITION_VALUE / entry);
  if (qty <= 0) return { pnl: 0, exitReason: 'skip' };
  const firstTarget = Math.round(entry * (1 + FIRST_TARGET_PCT / 100) * 100) / 100;
  const timeMatch = (t) => (c) => (c.time || '').slice(0, 5) === (t || '').slice(0, 5) || c.time === t;
  let idx = dayCandles.findIndex(timeMatch(time));
  if (idx < 0) idx = dayCandles.findIndex((c) => (c.time || '').localeCompare(time) >= 0);
  if (idx < 0) return { pnl: 0, exitReason: 'no_bar' };

  let hitFirstTarget = false;
  let highWaterMark = 0;
  for (let i = idx + 1; i < dayCandles.length; i++) {
    const b = dayCandles[i];
    if (!hitFirstTarget && b.close <= stop) return { pnl: (stop - entry) * qty, exitReason: 'stop' };
    if (!hitFirstTarget && b.close >= firstTarget) {
      hitFirstTarget = true;
      if ((b.time || '').startsWith(EOD_BAR_TIME) || b.time >= '15:24') {
        return { pnl: (b.close - entry) * qty, exitReason: 'eod' };
      }
      continue;
    }
    if (hitFirstTarget) {
      highWaterMark = Math.max(highWaterMark, b.high);
      const trailExit = Math.round(highWaterMark * (1 - TRAIL_PCT / 100) * 100) / 100;
      if (b.close <= trailExit) return { pnl: (trailExit - entry) * qty, exitReason: 'stop' };
    }
    if ((b.time || '').startsWith(EOD_BAR_TIME) || b.time >= '15:24') {
      return { pnl: (b.close - entry) * qty, exitReason: 'eod' };
    }
  }
  const last = dayCandles[dayCandles.length - 1];
  const pnl = last ? (last.close - entry) * qty : 0;
  return { pnl, exitReason: 'eod' };
}

function main() {
  const forDate = process.argv[2] || '2026-02-18';
  const prevDate = fs.readdirSync(DATA_DIR)
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && d < forDate)
    .sort().reverse()[0];
  if (!prevDate) {
    console.error('No prev date folder in data/ for ' + forDate);
    process.exit(1);
  }

  let symbols = [];
  if (fs.existsSync(CONFIG_WATCHLIST)) {
    const lines = fs.readFileSync(CONFIG_WATCHLIST, 'utf8').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    if (lines[0].toLowerCase().split(',')[0].trim() === 'tradingsymbol') lines.shift();
    symbols = lines.map((l) => l.split(',')[0].trim()).filter(Boolean);
  }
  if (symbols.length === 0) {
    console.error('No symbols in ' + CONFIG_WATCHLIST);
    process.exit(1);
  }

  console.error('Backtest ' + forDate + ' | full universe: ' + symbols.length + ' symbols | 3m only (no Kite)\n');

  const results = [];
  let skipped = 0;
  for (let i = 0; i < symbols.length; i++) {
    const symbol = symbols[i];
    if ((i + 1) % 200 === 0) console.error('  ' + (i + 1) + '/' + symbols.length);
    const rows = load3m(symbol, prevDate, forDate);
    if (!rows || rows.length === 0) { skipped++; continue; }
    const byDate = groupByDate(rows);
    const sortedDates = Object.keys(byDate).sort();
    const forDateIdx = sortedDates.indexOf(forDate);
    if (!sortedDates.includes(forDate) || forDateIdx <= 0) { skipped++; continue; }

    const getPrevDayVolume = () => (byDate[sortedDates[forDateIdx - 1]] || []).reduce((s, b) => s + (b.volume ?? 0), 0);
    const prevCandles = byDate[sortedDates[forDateIdx - 1]] || [];
    const lastPrev = prevCandles[prevCandles.length - 1];
    const getPrevDayCloseDaily = lastPrev?.close != null ? () => lastPrev.close : null;
    const dayOpen = (byDate[forDate] && byDate[forDate].length) ? byDate[forDate][0].open : null;
    const getDayOpenDaily = dayOpen != null ? () => dayOpen : null;

    const entries = findMomentumBreakouts(byDate, sortedDates, {
      sharpMovePct: 4,
      maxSlPct: 2,
      getPrevDayVolume,
      getPrevDayCloseDaily,
      getDayOpenDaily,
      maxGapUpPct: process.env.GAP_UP_THRESHOLD_PCT != null ? parseFloat(process.env.GAP_UP_THRESHOLD_PCT) : null,
      maxEntryCandleRangePct: 1.5,
      structureBars: 7,
      maxConsolidationRangePct: 2,
      minBreakoutVolumeRatio: 2,
      stopBelowStructurePct: 0.2,
      maxPullbackPct: process.env.MAX_PULLBACK_PCT != null ? parseFloat(process.env.MAX_PULLBACK_PCT) : 5,
    });

    for (const e of entries) {
      if (e.date !== forDate) continue;
      const entry = e.close;
      const stop = e.suggestedStop ?? entry * 0.99;
      const sim = simulate({ date: e.date, time: (e.time || '').slice(0, 8), entry, stop }, rows);
      results.push({
        symbol,
        date: e.date,
        time: (e.time || '').slice(0, 8),
        entry,
        stop,
        qty: sim.exitReason === 'skip' || sim.exitReason === 'no_bar' ? 0 : Math.floor(POSITION_VALUE / entry),
        exitReason: sim.exitReason,
        pnl: Math.round(sim.pnl * 100) / 100,
      });
    }
  }

  const totalPnl = results.reduce((s, r) => s + r.pnl, 0);
  const byStop = results.filter((r) => r.exitReason === 'stop');
  const byEod = results.filter((r) => r.exitReason === 'eod');

  console.error('\nSkipped (no 3m data): ' + skipped + '\n');
  console.log('Symbol        Date       Time   Entry     Stop     Qty  Exit    P&L');
  console.log('-'.repeat(75));
  for (const r of results) {
    const qty = r.qty || Math.floor(POSITION_VALUE / r.entry);
    console.log(
      String(r.symbol).padEnd(13) + ' ' + r.date + '  ' + String(r.time).padEnd(8) + ' ' +
      String(r.entry).padStart(8) + ' ' + String(r.stop).padStart(8) + ' ' + String(qty).padStart(4) + ' ' +
      String(r.exitReason).padEnd(6) + ' ' + (r.pnl >= 0 ? ' ' : '') + r.pnl.toFixed(2)
    );
  }
  console.log('-'.repeat(75));
  console.log('Total trades: ' + results.length + '  |  Stop: ' + byStop.length + '  EOD: ' + byEod.length);
  console.log('Total P&L: Rs.' + totalPnl.toFixed(2));
}

main();
