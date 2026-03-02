/**
 * Analyze exit quality: for each trade compute MFE (max favorable excursion)
 * and MAE (max adverse excursion) vs actual exit. Helps tune SL/trail/EOD.
 *
 * Usage: node scripts/analyzeExits.js
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

function simulateWithMFE_MAE(signal, candles) {
  const { date, time, entry, stop } = signal;
  const dayCandles = candles.filter((c) => c.date === date).sort((a, b) => (a.time || '').localeCompare(b.time || ''));
  const qty = Math.floor(POSITION_VALUE / entry);
  if (qty <= 0) return null;
  const firstTarget = Math.round(entry * (1 + FIRST_TARGET_PCT / 100) * 100) / 100;
  const timeMatch = (t) => (c) => (c.time || '').slice(0, 5) === (t || '').slice(0, 5) || c.time === t;
  let idx = dayCandles.findIndex(timeMatch(time));
  if (idx < 0) idx = dayCandles.findIndex((c) => (c.time || '').localeCompare(time) >= 0);
  if (idx < 0) return null;

  let mfePct = 0, maePct = 0;
  let hitFirstTarget = false;
  let highWaterMark = 0;
  let exitReason = 'eod';
  let exitPrice = entry;
  let exitBarTime = '';

  for (let i = idx + 1; i < dayCandles.length; i++) {
    const b = dayCandles[i];
    mfePct = Math.max(mfePct, ((b.high - entry) / entry) * 100);
    maePct = Math.min(maePct, ((b.low - entry) / entry) * 100);

    if (!hitFirstTarget && b.close <= stop) {
      exitReason = 'initial_sl';
      exitPrice = stop;
      exitBarTime = b.time;
      break;
    }
    if (!hitFirstTarget && b.close >= firstTarget) {
      hitFirstTarget = true;
      highWaterMark = b.high;
      if ((b.time || '').startsWith(EOD_BAR_TIME) || b.time >= '15:24') {
        exitReason = 'eod';
        exitPrice = b.close;
        exitBarTime = b.time;
        break;
      }
      continue;
    }
    if (hitFirstTarget) {
      highWaterMark = Math.max(highWaterMark, b.high);
      const trailExit = Math.round(highWaterMark * (1 - TRAIL_PCT / 100) * 100) / 100;
      if (b.close <= trailExit) {
        exitReason = 'trail';
        exitPrice = trailExit;
        exitBarTime = b.time;
        break;
      }
    }
    if ((b.time || '').startsWith(EOD_BAR_TIME) || b.time >= '15:24') {
      exitReason = 'eod';
      exitPrice = b.close;
      exitBarTime = b.time;
      break;
    }
  }
  if (exitReason === 'eod' && !exitBarTime) {
    const last = dayCandles[dayCandles.length - 1];
    exitPrice = last ? last.close : entry;
    exitBarTime = last ? last.time : '';
  }
  const pnl = (exitPrice - entry) * qty;
  const exitPct = ((exitPrice - entry) / entry) * 100;
  return { mfePct, maePct, exitReason, exitPrice, exitPct, pnl, qty, exitBarTime };
}

const DATES = ['2026-02-18', '2026-02-19', '2026-02-20', '2026-02-23', '2026-02-24', '2026-02-25'];

function main() {
  const all = [];
  for (const forDate of DATES) {
    const watchPath = path.join(DATA_DIR, 'watchlists', forDate, 'watchlist.txt');
    if (!fs.existsSync(watchPath)) continue;
    const symbols = fs.readFileSync(watchPath, 'utf8').trim().split(/\r?\n/).map((l) => l.split(',')[0].trim()).filter(Boolean);
    const prevDate = fs.readdirSync(DATA_DIR).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && d < forDate).sort().reverse()[0];
    if (!prevDate) continue;

    for (const symbol of symbols) {
      const rows = load3m(symbol, prevDate, forDate);
      if (!rows || rows.length === 0) continue;
      const byDate = groupByDate(rows);
      const sortedDates = Object.keys(byDate).sort();
      const forDateIdx = sortedDates.indexOf(forDate);
      if (!sortedDates.includes(forDate) || forDateIdx <= 0) continue;

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
      });

      for (const e of entries) {
        if (e.date !== forDate) continue;
        const entry = e.close;
        const stop = e.suggestedStop ?? entry * 0.99;
        const sim = simulateWithMFE_MAE(
          { symbol, date: e.date, time: (e.time || '').slice(0, 8), entry, stop },
          rows
        );
        if (sim) all.push({ symbol, date: e.date, time: (e.time || '').slice(0, 8), entry, stop, ...sim });
      }
    }
  }

  const winners = all.filter((t) => t.pnl > 0);
  const losers = all.filter((t) => t.pnl <= 0);
  const byTrail = all.filter((t) => t.exitReason === 'trail');
  const byInitialSl = all.filter((t) => t.exitReason === 'initial_sl');
  const byEod = all.filter((t) => t.exitReason === 'eod');

  console.log('\n=== Exit analysis (MFE = max favorable %, MAE = max adverse %) ===\n');
  console.log(`Total: ${all.length}  Winners: ${winners.length}  Losers: ${losers.length}`);
  console.log(`Exit reasons: trail ${byTrail.length}  initial_sl ${byInitialSl.length}  eod ${byEod.length}\n`);

  if (byTrail.length > 0) {
    const avgMfeTrail = byTrail.reduce((s, t) => s + t.mfePct, 0) / byTrail.length;
    const avgExitTrail = byTrail.reduce((s, t) => s + t.exitPct, 0) / byTrail.length;
    const leftOnTable = byTrail.map((t) => t.mfePct - t.exitPct);
    const avgLeft = leftOnTable.reduce((a, b) => a + b, 0) / leftOnTable.length;
    console.log('--- Exits at TRAIL (after 3% target) ---');
    console.log(`  Avg MFE: ${avgMfeTrail.toFixed(2)}%  Avg exit %: ${avgExitTrail.toFixed(2)}%  Avg left on table: ${avgLeft.toFixed(2)}%`);
  }
  if (byInitialSl.length > 0) {
    const avgMaeSl = byInitialSl.reduce((s, t) => s + t.maePct, 0) / byInitialSl.length;
    const cameBack = byInitialSl.filter((t) => t.mfePct > 1).length;
    console.log('\n--- Exits at INITIAL SL ---');
    console.log(`  Avg MAE: ${avgMaeSl.toFixed(2)}%  (Count that later had MFE>1%: ${cameBack}/${byInitialSl.length})`);
  }
  if (byEod.length > 0) {
    const eodWinners = byEod.filter((t) => t.pnl > 0);
    const eodHit3 = byEod.filter((t) => t.mfePct >= 2.9).length;
    console.log('\n--- Exits at EOD ---');
    console.log(`  Count: ${byEod.length}  Winners: ${eodWinners.length}  Had MFE>=3%: ${eodHit3}`);
  }

  console.log('\n--- Sample: trail exits (MFE vs exit %) ---');
  byTrail.slice(0, 15).forEach((t) => {
    console.log(`  ${t.symbol} ${t.date} ${t.time}  MFE=${t.mfePct.toFixed(2)}%  exit=${t.exitPct.toFixed(2)}%  left=${(t.mfePct - t.exitPct).toFixed(2)}%  PnL=${t.pnl.toFixed(0)}`);
  });
  console.log('');
}

main();
