/**
 * Compare exit-rule variants on same set of trades. Uses same entry signals,
 * runs three exit rules and sums PnL.
 *
 * Variant 1 (baseline): 3% first target, 1.5% trail, initial SL on bar.low <= stop
 * Variant A (wider trail): 3% first target, 2% trail, initial SL on bar.low <= stop
 * Variant B (close-based SL): 3% first target, 1.5% trail, initial SL on bar.close <= stop
 *
 * Usage: node scripts/compareExitVariants.js
 */

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { groupByDate, findMomentumBreakouts } from '../lib/entryLogic.js';
import { POSITION_VALUE } from '../lib/positionStore.js';

const DATA_DIR = path.join(process.cwd(), 'data');
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

/**
 * Simulate one trade with configurable exit rules.
 * @param {object} signal - { date, time, entry, stop }
 * @param {object[]} candles - all 3m bars (multi-day)
 * @param {object} opts - { firstTargetPct, trailPct, slOnClose } (slOnClose: use close <= stop for initial SL)
 */
function simulate(signal, candles, opts) {
  const { date, time, entry, stop } = signal;
  const { firstTargetPct = 3, trailPct = 1.5, slOnClose = false } = opts;
  const dayCandles = candles.filter((c) => c.date === date).sort((a, b) => (a.time || '').localeCompare(b.time || ''));
  const qty = Math.floor(POSITION_VALUE / entry);
  if (qty <= 0) return { pnl: 0, exitReason: 'skip' };
  const firstTarget = Math.round(entry * (1 + firstTargetPct / 100) * 100) / 100;
  const timeMatch = (t) => (c) => (c.time || '').slice(0, 5) === (t || '').slice(0, 5) || c.time === t;
  let idx = dayCandles.findIndex(timeMatch(time));
  if (idx < 0) idx = dayCandles.findIndex((c) => (c.time || '').localeCompare(time) >= 0);
  if (idx < 0) return { pnl: 0, exitReason: 'no_bar' };

  let hitFirstTarget = false;
  let highWaterMark = 0;
  for (let i = idx + 1; i < dayCandles.length; i++) {
    const b = dayCandles[i];
    // Initial SL
    if (!hitFirstTarget) {
      const hitSl = slOnClose ? (b.close <= stop) : (b.low <= stop);
      if (hitSl) return { pnl: (stop - entry) * qty, exitReason: 'initial_sl' };
    }
    if (!hitFirstTarget && b.close >= firstTarget) {
      hitFirstTarget = true;
      if ((b.time || '').startsWith(EOD_BAR_TIME) || b.time >= '15:24') {
        return { pnl: (b.close - entry) * qty, exitReason: 'eod' };
      }
      continue;
    }
    if (hitFirstTarget) {
      highWaterMark = Math.max(highWaterMark, b.high);
      const trailExit = Math.round(highWaterMark * (1 - trailPct / 100) * 100) / 100;
      if (b.close <= trailExit) return { pnl: (trailExit - entry) * qty, exitReason: 'trail' };
    }
    if ((b.time || '').startsWith(EOD_BAR_TIME) || b.time >= '15:24') {
      return { pnl: (b.close - entry) * qty, exitReason: 'eod' };
    }
  }
  const last = dayCandles[dayCandles.length - 1];
  const pnl = last ? (last.close - entry) * qty : 0;
  return { pnl, exitReason: 'eod' };
}

const DATES = ['2026-02-18', '2026-02-19', '2026-02-20', '2026-02-23', '2026-02-24', '2026-02-25'];

function main() {
  const signals = [];
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
        maxPullbackPct: process.env.MAX_PULLBACK_PCT != null ? parseFloat(process.env.MAX_PULLBACK_PCT) : 5,
      });

      for (const e of entries) {
        if (e.date !== forDate) continue;
        signals.push({
          symbol,
          date: e.date,
          time: (e.time || '').slice(0, 8),
          entry: e.close,
          stop: e.suggestedStop ?? e.close * 0.99,
          candles: rows,
        });
      }
    }
  }

  const baseline = { firstTargetPct: 3, trailPct: 1.5, slOnClose: false };
  const variantA = { firstTargetPct: 3, trailPct: 2, slOnClose: false };
  const variantB = { firstTargetPct: 3, trailPct: 1.5, slOnClose: true };

  let totalBaseline = 0, totalA = 0, totalB = 0;
  const counts = { baseline: { initial_sl: 0, trail: 0, eod: 0 }, A: { initial_sl: 0, trail: 0, eod: 0 }, B: { initial_sl: 0, trail: 0, eod: 0 } };

  for (const sig of signals) {
    const r0 = simulate(sig, sig.candles, baseline);
    const rA = simulate(sig, sig.candles, variantA);
    const rB = simulate(sig, sig.candles, variantB);
    totalBaseline += r0.pnl;
    totalA += rA.pnl;
    totalB += rB.pnl;
    counts.baseline[r0.exitReason]++;
    counts.A[rA.exitReason]++;
    counts.B[rB.exitReason]++;
  }

  console.log('\n=== Exit variant comparison (same ' + signals.length + ' trades) ===\n');
  console.log('Baseline: 3% first target, 1.5% trail, initial SL on low <= stop');
  console.log('  Total PnL: Rs.' + totalBaseline.toFixed(2) + '  |  initial_sl: ' + counts.baseline.initial_sl + '  trail: ' + counts.baseline.trail + '  eod: ' + counts.baseline.eod);
  console.log('\nVariant A (wider trail): 3% first target, 2% trail, initial SL on low <= stop');
  console.log('  Total PnL: Rs.' + totalA.toFixed(2) + '  |  initial_sl: ' + counts.A.initial_sl + '  trail: ' + counts.A.trail + '  eod: ' + counts.A.eod);
  console.log('\nVariant B (close-based SL): 3% first target, 1.5% trail, initial SL on close <= stop');
  console.log('  Total PnL: Rs.' + totalB.toFixed(2) + '  |  initial_sl: ' + counts.B.initial_sl + '  trail: ' + counts.B.trail + '  eod: ' + counts.B.eod);

  const best = [['Baseline', totalBaseline], ['Variant A (2% trail)', totalA], ['Variant B (close SL)', totalB]].sort((a, b) => b[1] - a[1]);
  console.log('\n--- Best: ' + best[0][0] + ' (Rs.' + best[0][1].toFixed(2) + ') ---\n');
}

main();
