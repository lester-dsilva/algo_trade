/**
 * Load v3 daily and hourly CSV data from v3/data/.
 */

import fs from 'fs';
import path from 'path';
import { V3_DAILY_DIR, V3_HOURLY_DIR, normalizeFilename } from './v3Universe.js';

function parseCsvRows(file) {
  if (!fs.existsSync(file)) return null;
  const raw = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n').trim();
  const lines = raw.split('\n');
  if (lines.length < 2) return [];
  const header = lines[0].toLowerCase().split(',').map((s) => s.trim());
  const get = (name) => header.indexOf(name);
  const idx = {
    date: get('date'),
    time: get('time'),
    open: get('open'),
    high: get('high'),
    low: get('low'),
    close: get('close'),
    volume: get('volume'),
  };
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const p = lines[i].split(',');
    rows.push({
      date: p[idx.date] ?? '',
      time: (p[idx.time] ?? '').trim(),
      open: parseFloat(p[idx.open]) || 0,
      high: parseFloat(p[idx.high]) || 0,
      low: parseFloat(p[idx.low]) || 0,
      close: parseFloat(p[idx.close]) || 0,
      volume: parseFloat(p[idx.volume]) || 0,
    });
  }
  return rows;
}

export function dailyCsvPath(symbol) {
  return path.join(V3_DAILY_DIR, normalizeFilename(symbol) + '.csv');
}

export function hourlyCsvPath(symbol) {
  return path.join(V3_HOURLY_DIR, normalizeFilename(symbol) + '.csv');
}

export function loadDailyForSymbol(symbol) {
  const rows = parseCsvRows(dailyCsvPath(symbol));
  if (!rows) return null;
  return rows
    .filter((r) => r.date)
    .sort((a, b) => a.date.localeCompare(b.date));
}

export function loadHourlyForSymbol(symbol) {
  const rows = parseCsvRows(hourlyCsvPath(symbol));
  if (!rows) return null;
  return rows
    .filter((r) => r.date)
    .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
}

export function listSymbolsWithData(type = 'daily') {
  const dir = type === 'hourly' ? V3_HOURLY_DIR : V3_DAILY_DIR;
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.csv'))
    .map((f) => f.slice(0, -4));
}

export function hasV3Data(symbol) {
  return fs.existsSync(dailyCsvPath(symbol)) && fs.existsSync(hourlyCsvPath(symbol));
}

export function barsUpToDate(bars, dateStr, inclusive = false) {
  if (!dateStr) return bars;
  return bars.filter((b) => (inclusive ? b.date <= dateStr : b.date < dateStr));
}

export function barsOnDate(bars, dateStr) {
  return bars.filter((b) => b.date === dateStr);
}

export function writeCsv(file, rows) {
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const header = 'date,time,open,high,low,close,volume';
  const lines = [
    header,
    ...rows.map((r) =>
      [r.date, r.time || '', r.open, r.high, r.low, r.close, r.volume ?? 0].join(',')
    ),
  ];
  fs.writeFileSync(file, lines.join('\n'), 'utf8');
}
