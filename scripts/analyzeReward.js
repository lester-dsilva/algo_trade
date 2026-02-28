/**
 * For a list of symbols: load 3m data, find reversal breakout entries, simulate:
 * SL = slightly below consolidation low (entry.suggestedStop), Target = 4.5% above entry.
 *
 * Usage: node scripts/analyzeReward.js [from] [to]
 *   from, to  YYYY-MM-DD (default 2026-02-19 only)
 * Reads symbols from data/watchlist_reward.txt (one symbol per line) or uses built-in list.
 * Loads .env for GAP_UP_THRESHOLD_PCT, MAX_ENTRY_CANDLE_RANGE_PCT, MAX_SL_PCT, MIN_VOLUME_RATIO.
 */

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { toNum, groupByDate, findMomentumBreakouts } from '../lib/entryLogic.js';

const DATA_DIR = path.join(process.cwd(), 'data');
const DEFAULT_FROM = '2026-02-19';
const DEFAULT_TO = '2026-02-19';

const BUILTIN_SYMBOLS = [
  'GODFRYPHLP', 'RATNAMANI', 'KRISHNADEF', 'E2E', 'JYOTISTRUC', 'IZMO', 'PRABHA',
  'AEROFLEX', 'TARIL', 'NETWEB', 'AGIIL', 'SCHNEIDER', 'ORIENTTECH', 'NIBE',
  'TECHNOE', 'GUJTHEM', 'BHARATWIRE', 'APARINDS', 'GMDCLTD', 'GMRP&UI', 'KRN',
  'EMSLIMITED', 'HEG', 'COHANCE', 'SAMBHV', 'CHOICEIN', 'GALLANTT', 'RAMKY', 'EDELWEISS',
].map((s) => s.trim()).filter(Boolean);

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

function loadOrFetch(symbol, from, to, forceReload = false) {
  const file = normalizeFilename(symbol) + '.csv';
  const csvPath = path.join(DATA_DIR, file);
  if (forceReload && fs.existsSync(csvPath)) {
    try {
      fs.unlinkSync(csvPath);
    } catch (_) {}
  }
  if (!fs.existsSync(csvPath)) {
    try {
      const nseSym = symbol.replace(/\s/g, '');
      execSync(
        `node scripts/kiteOHLC.js NSE:${nseSym} 3minute ${from} ${to} "${csvPath}"`,
        { cwd: process.cwd(), stdio: 'pipe' }
      );
    } catch (e) {
      return null;
    }
  }
  const content = fs.readFileSync(csvPath, 'utf8');
  const rows = parseCsv(content);
  const normalized = rows.map((r) => ({
    date: (r.date || '').trim(),
    time: (r.time || '').trim(),
    open: toNum(r.open),
    high: toNum(r.high),
    low: toNum(r.low),
    close: toNum(r.close),
    volume: toNum(r.volume),
  })).filter((r) => r.date && r.open > 0);
  return normalized;
}

const TARGET_PCT = 4.5;

/** Simulate: SL = slightly below consolidation low (suggestedStop), Target = 4.5% above entry. Outcome in R. */
function simulateTrade(entry, candles) {
  const entryPrice = entry.close;
  const stop = entry.suggestedStop; // below consolidation low (from entry logic)
  const target = Math.round(entryPrice * (1 + TARGET_PCT / 100) * 100) / 100;
  const risk = entryPrice - stop;
  const timeMatch = (t) => (a) => (a.time || '').slice(0, 8) === (t || '').slice(0, 8) || a.time === t;
  const idx = candles.findIndex(timeMatch(entry.time));
  if (idx < 0 || risk <= 0) return { outcome: null, stop, target };
  for (let i = idx + 1; i < candles.length; i++) {
    const b = candles[i];
    if (b.low <= stop) return { outcome: -1, stop, target };
    if (b.high >= target) {
      const rOnWin = (target - entryPrice) / risk;
      return { outcome: Math.round(rOnWin * 100) / 100, stop, target };
    }
  }
  return { outcome: 0, stop, target };
}

function main() {
  const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const reload = process.argv.includes('--reload');
  const from = args[0] || DEFAULT_FROM;
  const to = args[1] || DEFAULT_TO;

  const watchlistPath = path.join(DATA_DIR, 'watchlist_reward.txt');
  let symbols = BUILTIN_SYMBOLS;
  if (fs.existsSync(watchlistPath)) {
    const lines = fs.readFileSync(watchlistPath, 'utf8').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    if (lines.length > 0) symbols = lines;
  }

  if (reload) {
    console.error('Reloading 3m data from Kite for', symbols.length, 'symbols (' + from + ' to ' + to + ')...');
    for (const symbol of symbols) {
      const file = normalizeFilename(symbol) + '.csv';
      const csvPath = path.join(DATA_DIR, file);
      if (fs.existsSync(csvPath)) {
        try {
          fs.unlinkSync(csvPath);
        } catch (_) {}
      }
    }
  }

  const allTrades = [];
  const skipped = [];

  for (const symbol of symbols) {
    const rows = loadOrFetch(symbol, from, to, reload);
    if (!rows || rows.length === 0) {
      skipped.push(symbol);
      continue;
    }
    const byDate = groupByDate(rows);
    const sortedDates = Object.keys(byDate).sort();
    const maxGapUpPct = process.env.GAP_UP_THRESHOLD_PCT != null ? parseFloat(process.env.GAP_UP_THRESHOLD_PCT) : null;
    const maxEntryCandleRangePct = process.env.MAX_ENTRY_CANDLE_RANGE_PCT != null ? parseFloat(process.env.MAX_ENTRY_CANDLE_RANGE_PCT) : 1.5;
    const maxSlPct = process.env.MAX_SL_PCT != null ? parseFloat(process.env.MAX_SL_PCT) : 2;
    const entries = findMomentumBreakouts(byDate, sortedDates, {
      sharpMovePct: 4,
      maxSlPct,
      maxGapUpPct,
      maxEntryCandleRangePct,
    });
    const minVolRatio = process.env.MIN_VOLUME_RATIO != null ? parseFloat(process.env.MIN_VOLUME_RATIO) : null;
    for (const e of entries) {
      if (minVolRatio != null && Number.isFinite(minVolRatio)) {
        const consAvg = e.consolidationAvgVolume ?? 0;
        const ratio = consAvg > 0 ? (e.entryBarVolume ?? 0) / consAvg : 0;
        if (ratio < minVolRatio) continue;
      }
      const candles = byDate[e.date];
      const { outcome, stop, target } = simulateTrade(e, candles);
      allTrades.push({
        symbol,
        date: e.date,
        time: e.timeIST,
        entry: e.close,
        stop,
        target,
        outcome,
      });
    }
  }

  const wins = allTrades.filter((t) => t.outcome > 0);
  const losses = allTrades.filter((t) => t.outcome === -1);
  const noHit = allTrades.filter((t) => t.outcome === 0);
  const totalR = allTrades.reduce((sum, t) => sum + (t.outcome ?? 0), 0);

  const minVolRatio = process.env.MIN_VOLUME_RATIO != null ? parseFloat(process.env.MIN_VOLUME_RATIO) : null;
  const gapNote = process.env.GAP_UP_THRESHOLD_PCT != null && Number.isFinite(parseFloat(process.env.GAP_UP_THRESHOLD_PCT)) ? ` | GAP_UP_THRESHOLD_PCT=${process.env.GAP_UP_THRESHOLD_PCT}` : '';
  const volFilterNote = minVolRatio != null && Number.isFinite(minVolRatio) ? ` | MIN_VOLUME_RATIO=${minVolRatio}` : '';
  const entryCandleNote = process.env.MAX_ENTRY_CANDLE_RANGE_PCT != null ? ` | MAX_ENTRY_CANDLE_RANGE_PCT=${process.env.MAX_ENTRY_CANDLE_RANGE_PCT}` : ' | MAX_ENTRY_CANDLE_RANGE_PCT=1.5';
  const slNote = process.env.MAX_SL_PCT != null ? ` | MAX_SL_PCT=${process.env.MAX_SL_PCT}%` : ' | MAX_SL_PCT=2%';
  console.log(`\n--- Reversal breakout entries | SL = below consolidation low | Target ${TARGET_PCT}%${volFilterNote}${gapNote}${entryCandleNote}${slNote} ---`);
  console.log(`Date range: ${from} to ${to}`);
  console.log(`Symbols: ${symbols.length} (skipped: ${skipped.length})`);
  console.log('');
  if (allTrades.length === 0) {
    console.log('No reversal breakout entries found.');
    if (skipped.length) console.log('Skipped (no data):', skipped.join(', '));
    return;
  }
  console.log('Symbol      Date       Time   Entry    Stop     Target   Outcome');
  console.log('-'.repeat(72));
  for (const t of allTrades) {
    const out = t.outcome > 0 ? `+${t.outcome}R` : t.outcome === -1 ? '-1R' : 'EOD';
    console.log(
      `${String(t.symbol).padEnd(12)} ${t.date}  ${String(t.time).padEnd(6)} ${String(t.entry).padStart(8)} ${String(t.stop).padStart(8)} ${String(t.target).padStart(8)} ${out}`
    );
  }
  console.log('-'.repeat(72));
  console.log(`Total trades: ${allTrades.length}  Wins: ${wins.length}  Losses: ${losses.length}  No hit (EOD): ${noHit.length}`);
  console.log(`Total Reward (in R): ${Math.round(totalR * 100) / 100}R`);
  if (skipped.length) console.log('\nSkipped (no data):', skipped.join(', '));
  console.log('');
}

main();
