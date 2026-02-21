/**
 * Volume-based analysis: compare winning vs losing reversal breakout trades over a longer period.
 * Uses entry bar volume, consolidation avg volume, and relative volume (vs previous N days).
 *
 * Usage: node scripts/analyzeVolume.js [from] [to]
 *   from, to  YYYY-MM-DD (default 2026-01-27 to 2026-02-19)
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { toNum, groupByDate, findReversalBreakouts } from '../lib/entryLogic.js';

const DATA_DIR = path.join(process.cwd(), 'data');
const DEFAULT_FROM = '2026-01-27';
const DEFAULT_TO = '2026-02-19';
const PREV_DAYS_FOR_AVG = 5;
const TARGET_PCT = 4.5;

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

function loadOrFetch(symbol, from, to) {
  const file = normalizeFilename(symbol) + '.csv';
  const csvPath = path.join(DATA_DIR, file);
  let rows = [];
  if (fs.existsSync(csvPath)) {
    const content = fs.readFileSync(csvPath, 'utf8');
    rows = parseCsv(content);
  }
  const normalized = rows.map((r) => ({
    date: (r.date || '').trim(),
    time: (r.time || '').trim(),
    open: toNum(r.open),
    high: toNum(r.high),
    low: toNum(r.low),
    close: toNum(r.close),
    volume: toNum(r.volume),
  })).filter((r) => r.date && r.open > 0);
  const dates = [...new Set(normalized.map((r) => r.date))].sort();
  const hasRange = dates.length >= 5 && dates[0] <= from && dates[dates.length - 1] >= to;
  if (!hasRange || normalized.length === 0) {
    try {
      const nseSym = symbol.replace(/\s/g, '');
      execSync(
        `node scripts/kiteOHLC.js NSE:${nseSym} 3minute ${from} ${to} "${csvPath}"`,
        { cwd: process.cwd(), stdio: 'pipe' }
      );
      const content = fs.readFileSync(csvPath, 'utf8');
      rows = parseCsv(content);
      return rows.map((r) => ({
        date: (r.date || '').trim(),
        time: (r.time || '').trim(),
        open: toNum(r.open),
        high: toNum(r.high),
        low: toNum(r.low),
        close: toNum(r.close),
        volume: toNum(r.volume),
      })).filter((r) => r.date && r.open > 0);
    } catch (e) {
      return normalized.length ? normalized : null;
    }
  }
  return normalized;
}

function simulateTrade(entry, candles) {
  const entryPrice = entry.close;
  const stop = entry.suggestedStop;
  const target = Math.round(entryPrice * (1 + TARGET_PCT / 100) * 100) / 100;
  const risk = entryPrice - stop;
  const timeMatch = (t) => (a) => (a.time || '').slice(0, 8) === (t || '').slice(0, 8) || a.time === t;
  const idx = candles.findIndex(timeMatch(entry.time));
  if (idx < 0 || risk <= 0) return null;
  for (let i = idx + 1; i < candles.length; i++) {
    const b = candles[i];
    if (b.low <= stop) return -1;
    if (b.high >= target) return (target - entryPrice) / risk;
  }
  return 0;
}

/** Avg bar volume over previous N trading days (before entryDate). */
function prevDaysAvgBarVolume(byDate, sortedDates, entryDate) {
  const idx = sortedDates.indexOf(entryDate);
  if (idx < PREV_DAYS_FOR_AVG) return null;
  let totalVol = 0;
  let totalBars = 0;
  for (let k = 1; k <= PREV_DAYS_FOR_AVG; k++) {
    const d = sortedDates[idx - k];
    const candles = byDate[d];
    if (!candles) continue;
    for (const c of candles) {
      totalVol += c.volume ?? 0;
      totalBars += 1;
    }
  }
  return totalBars > 0 ? totalVol / totalBars : null;
}

function median(arr) {
  if (arr.length === 0) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function mean(arr) {
  if (arr.length === 0) return null;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function main() {
  const from = process.argv[2] || DEFAULT_FROM;
  const to = process.argv[3] || DEFAULT_TO;

  const watchlistPath = path.join(DATA_DIR, 'watchlist_reward.txt');
  let symbols = BUILTIN_SYMBOLS;
  if (fs.existsSync(watchlistPath)) {
    const lines = fs.readFileSync(watchlistPath, 'utf8').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    if (lines.length > 0) symbols = lines;
  }

  const winners = [];
  const losers = [];
  let skipped = 0;

  for (const symbol of symbols) {
    const rows = loadOrFetch(symbol, from, to);
    if (!rows || rows.length === 0) {
      skipped++;
      continue;
    }
    const byDate = groupByDate(rows);
    const sortedDates = Object.keys(byDate).sort();
    const entries = findReversalBreakouts(byDate, sortedDates);
    const avgBarPrev = prevDaysAvgBarVolume(byDate, sortedDates, sortedDates[0]);
    for (const e of entries) {
      const candles = byDate[e.date];
      const outcome = simulateTrade(e, candles);
      if (outcome === null) continue;
      const avgBarPrev5 = prevDaysAvgBarVolume(byDate, sortedDates, e.date);
      const relVol = avgBarPrev5 != null && avgBarPrev5 > 0
        ? (e.entryBarVolume ?? 0) / avgBarPrev5
        : null;
      const rec = {
        symbol: symbol,
        date: e.date,
        time: e.timeIST,
        entryBarVolume: e.entryBarVolume ?? 0,
        consolidationAvgVolume: e.consolidationAvgVolume ?? 0,
        relativeVolume: relVol,
        entryToConsVol: (e.consolidationAvgVolume > 0) ? (e.entryBarVolume ?? 0) / e.consolidationAvgVolume : null,
      };
      if (outcome > 0) winners.push(rec);
      else if (outcome === -1) losers.push(rec);
    }
  }

  console.log('\n--- Volume analysis: winners vs losers (reversal breakout, SL = consolidation low, target 4.5%) ---');
  console.log(`Date range: ${from} to ${to}  (prev ${PREV_DAYS_FOR_AVG} days for relative vol)`);
  console.log(`Symbols: ${symbols.length} (skipped: ${skipped})`);
  console.log(`Winners: ${winners.length}  Losers: ${losers.length}`);
  console.log('');

  const wVol = winners.map((r) => r.entryBarVolume).filter((v) => v >= 0);
  const lVol = losers.map((r) => r.entryBarVolume).filter((v) => v >= 0);
  const wRel = winners.map((r) => r.relativeVolume).filter((v) => v != null);
  const lRel = losers.map((r) => r.relativeVolume).filter((v) => v != null);
  const wCons = winners.map((r) => r.consolidationAvgVolume).filter((v) => v >= 0);
  const lCons = losers.map((r) => r.consolidationAvgVolume).filter((v) => v >= 0);
  const wEntryToCons = winners.map((r) => r.entryToConsVol).filter((v) => v != null);
  const lEntryToCons = losers.map((r) => r.entryToConsVol).filter((v) => v != null);

  console.log('                    Winners              Losers              Difference (W - L)');
  console.log('-'.repeat(78));
  if (wVol.length && lVol.length) {
    const wm = mean(wVol).toFixed(0);
    const lm = mean(lVol).toFixed(0);
    const diff = (mean(wVol) - mean(lVol)).toFixed(0);
    console.log(`Entry bar volume (mean)   ${String(wm).padStart(12)}    ${String(lm).padStart(12)}    ${String(diff).padStart(12)}`);
    const wmed = median(wVol).toFixed(0);
    const lmed = median(lVol).toFixed(0);
    console.log(`Entry bar volume (median) ${String(wmed).padStart(12)}    ${String(lmed).padStart(12)}`);
  }
  if (wRel.length && lRel.length) {
    const wm = mean(wRel).toFixed(2);
    const lm = mean(lRel).toFixed(2);
    const diff = (mean(wRel) - mean(lRel)).toFixed(2);
    console.log(`Relative vol vs prev 5d   ${String(wm).padStart(12)}    ${String(lm).padStart(12)}    ${String(diff).padStart(12)}`);
    const wmed = median(wRel).toFixed(2);
    const lmed = median(lRel).toFixed(2);
    console.log(`  (median)                 ${String(wmed).padStart(12)}    ${String(lmed).padStart(12)}`);
  }
  if (wCons.length && lCons.length) {
    const wm = mean(wCons).toFixed(0);
    const lm = mean(lCons).toFixed(0);
    console.log(`Consolidation avg vol     ${String(wm).padStart(12)}    ${String(lm).padStart(12)}`);
  }
  if (wEntryToCons.length && lEntryToCons.length) {
    const wm = mean(wEntryToCons).toFixed(2);
    const lm = mean(lEntryToCons).toFixed(2);
    const diff = (mean(wEntryToCons) - mean(lEntryToCons)).toFixed(2);
    console.log(`Entry bar / cons avg      ${String(wm).padStart(12)}    ${String(lm).padStart(12)}    ${String(diff).padStart(12)}`);
  }

  console.log('');
  console.log('Relative volume = entry bar volume / (avg bar volume over previous 5 trading days).');
  console.log('Entry/cons = entry bar volume / avg volume during consolidation bars.');
  console.log('');
}

main();
