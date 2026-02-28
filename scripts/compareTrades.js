/**
 * Compare winning vs losing trades: collect entry features (vol ratio, time) and
 * outcome (exit reason, PnL), then print stats and suggest refinements.
 * Uses only 3m data on disk (no Kite). Gap filter uses prev day last close / today first open from 3m.
 *
 * Usage: node scripts/compareTrades.js [date1] [date2] ...
 *   If no dates: run 2026-02-18, 19, 20, 23, 24, 25 (watchlists must exist).
 */

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { groupByDate, findMomentumBreakouts } from '../lib/entryLogic.js';
import { POSITION_VALUE, FIRST_TARGET_PCT, TRAIL_PCT, EOD_BAR_TIME } from '../lib/positionStore.js';

const DATA_DIR = path.join(process.cwd(), 'data');

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
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split(',');
    const row = {};
    header.forEach((h, j) => { row[h] = values[j] !== undefined ? values[j].trim() : ''; });
    rows.push(row);
  }
  return rows;
}

function load3mDiskOnly(symbol, fromDate, toDate) {
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

function timeToMins(timeStr) {
  const parts = (timeStr || '').split(':').map(Number);
  return (parts[0] || 0) * 60 + (parts[1] || 0) + (parts[2] || 0) / 60;
}

function computeTarget(entry, stop) {
  const risk = entry - stop;
  return Math.round((entry + 2 * risk) * 100) / 100;
}

function simulateTrade(signal, candles) {
  const { date, time, entry, stop } = signal;
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

const DEFAULT_DATES = ['2026-02-18', '2026-02-19', '2026-02-20', '2026-02-23', '2026-02-24', '2026-02-25'];

function main() {
  const dateArgs = process.argv.slice(2).filter((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));
  const dates = dateArgs.length ? dateArgs : DEFAULT_DATES;

  const maxGapUpPct = process.env.GAP_UP_THRESHOLD_PCT != null ? parseFloat(process.env.GAP_UP_THRESHOLD_PCT) : null;
  const maxEntryCandleRangePct = process.env.MAX_ENTRY_CANDLE_RANGE_PCT != null ? parseFloat(process.env.MAX_ENTRY_CANDLE_RANGE_PCT) : 1.5;
  const maxSlPct = process.env.MAX_SL_PCT != null ? parseFloat(process.env.MAX_SL_PCT) : 2;
  const maxConsolidationRangePct = process.env.MAX_CONSOLIDATION_RANGE_PCT != null ? parseFloat(process.env.MAX_CONSOLIDATION_RANGE_PCT) : 2;
  const maxEntryTime = process.env.MAX_ENTRY_TIME ?? null;

  const allTrades = [];

  for (const forDate of dates) {
    const watchPath = path.join(DATA_DIR, 'watchlists', forDate, 'watchlist.txt');
    if (!fs.existsSync(watchPath)) {
      console.error(`Skip ${forDate}: no watchlist`);
      continue;
    }
    const symbols = fs.readFileSync(watchPath, 'utf8').trim().split(/\r?\n/).map((l) => l.split(',')[0].trim()).filter(Boolean);
    const prevDate = fs.readdirSync(DATA_DIR)
      .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && d < forDate)
      .sort().reverse()[0];
    if (!prevDate) {
      console.error(`Skip ${forDate}: no prev date folder`);
      continue;
    }

    for (const symbol of symbols) {
      const rows = load3mDiskOnly(symbol, prevDate, forDate);
      if (!rows || rows.length === 0) continue;
      const byDate = groupByDate(rows);
      const sortedDates = Object.keys(byDate).sort();
      const forDateIdx = sortedDates.indexOf(forDate);
      if (!sortedDates.includes(forDate) || forDateIdx <= 0) continue;

      const getPrevDayVolume = () => (byDate[sortedDates[forDateIdx - 1]] || []).reduce((s, b) => s + (b.volume ?? 0), 0);
      const prevCandles = byDate[sortedDates[forDateIdx - 1]] || [];
      const lastPrev = prevCandles[prevCandles.length - 1];
      const getPrevDayCloseDaily = lastPrev && lastPrev.close != null ? () => lastPrev.close : null;
      const dayOpenFrom3m = (byDate[forDate] && byDate[forDate].length) ? byDate[forDate][0].open : null;
      const getDayOpenDaily = dayOpenFrom3m != null ? () => dayOpenFrom3m : null;

      const entries = findMomentumBreakouts(byDate, sortedDates, {
        sharpMovePct: 4,
        maxSlPct,
        getPrevDayVolume,
        getPrevDayCloseDaily,
        getDayOpenDaily,
        maxEntryTime,
        maxGapUpPct,
        maxEntryCandleRangePct,
        structureBars: 7,
        maxConsolidationRangePct,
        minBreakoutVolumeRatio: 2,
        stopBelowStructurePct: 0.2,
      });

      for (const e of entries) {
        if (e.date !== forDate) continue;
        const entryPrice = e.close;
        const stop = e.suggestedStop ?? entryPrice * 0.99;
        const target = computeTarget(entryPrice, stop);
        const consAvg = e.consolidationAvgVolume ?? 0;
        const volRatio = consAvg > 0 ? (e.entryBarVolume ?? 0) / consAvg : 0;
        const timeMins = timeToMins(e.time);
        const sim = simulateTrade(
          { symbol, date: e.date, time: (e.time || '').slice(0, 8), entry: entryPrice, stop, target },
          rows
        );
        allTrades.push({
          symbol,
          date: e.date,
          time: (e.time || '').slice(0, 8),
          entry: entryPrice,
          stop,
          volRatio: Math.round(volRatio * 100) / 100,
          timeMins,
          exitReason: sim.exitReason,
          pnl: Math.round(sim.pnl * 100) / 100,
        });
      }
    }
  }

  const winners = allTrades.filter((t) => t.pnl > 0);
  const losers = allTrades.filter((t) => t.pnl <= 0);
  const totalPnl = allTrades.reduce((s, t) => s + t.pnl, 0);

  console.log('\n=== Trade comparison (winners vs losers) ===\n');
  console.log(`Total trades: ${allTrades.length}  |  Winners: ${winners.length}  |  Losers: ${losers.length}  |  Total P&L: ₹${totalPnl.toFixed(2)}\n`);

  if (winners.length > 0 && losers.length > 0) {
    const avgVolW = winners.reduce((s, t) => s + t.volRatio, 0) / winners.length;
    const avgVolL = losers.reduce((s, t) => s + t.volRatio, 0) / losers.length;
    const avgTimeW = winners.reduce((s, t) => s + t.timeMins, 0) / winners.length;
    const avgTimeL = losers.reduce((s, t) => s + t.timeMins, 0) / losers.length;
    console.log('Avg vol ratio (entry bar / structure avg):');
    console.log(`  Winners: ${avgVolW.toFixed(2)}  |  Losers: ${avgVolL.toFixed(2)}`);
    console.log('Avg entry time (minutes from midnight):');
    console.log(`  Winners: ${avgTimeW.toFixed(0)} (${Math.floor(avgTimeW / 60)}:${String(avgTimeW % 60).padStart(2, '0')})  |  Losers: ${avgTimeL.toFixed(0)} (${Math.floor(avgTimeL / 60)}:${String(avgTimeL % 60).padStart(2, '0')})`);
  }

  const byExit = {};
  for (const t of allTrades) {
    byExit[t.exitReason] = (byExit[t.exitReason] || 0) + 1;
  }
  console.log('\nExit reason counts:', byExit);

  console.log('\n--- Per-trade list (symbol, date, time, volRatio, exitReason, pnl) ---');
  for (const t of allTrades) {
    console.log(`${t.symbol}\t${t.date}\t${t.time}\tvolRatio=${t.volRatio}\t${t.exitReason}\t${t.pnl >= 0 ? '' : ''}${t.pnl.toFixed(2)}`);
  }

  console.log('\n--- Refinement notes ---');
  if (winners.length > 0 && losers.length > 0) {
    const avgVolW = winners.reduce((s, t) => s + t.volRatio, 0) / winners.length;
    const avgVolL = losers.reduce((s, t) => s + t.volRatio, 0) / losers.length;
    console.log(`- Winners avg vol ratio ${avgVolW.toFixed(2)} vs losers ${avgVolL.toFixed(2)}: minBreakoutVolumeRatio >= 2 filters weak breakouts.`);
    const lowVolLosers = losers.filter((t) => t.volRatio < 2);
    const lowVolWinners = winners.filter((t) => t.volRatio < 2);
    if (lowVolLosers.length > 0 || lowVolWinners.length > 0) {
      const lost = lowVolLosers.reduce((s, t) => s + t.pnl, 0);
      const won = lowVolWinners.reduce((s, t) => s + t.pnl, 0);
      console.log(`- Trades with vol ratio < 2: ${lowVolLosers.length} losers (${lost.toFixed(0)}), ${lowVolWinners.length} winners (${won.toFixed(0)}). Net if excluded: ${(totalPnl - lost - won).toFixed(0)}.`);
    }
    const stopLosers = losers.filter((t) => t.exitReason === 'stop');
    if (stopLosers.length >= losers.length * 0.7) {
      console.log('- Most losers exit at stop: oversupply/wick filters and vol ratio help avoid weak entries.');
    }
  }
  console.log('');
}

main();
