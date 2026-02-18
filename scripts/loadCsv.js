/**
 * Load OHLCV from CSV and output normalized candles (JSON).
 * Usage: node scripts/loadCsv.js [path]   (default: data/*.csv or data/sample.csv)
 */

import fs from 'fs';
import path from 'path';

const defaultDir = path.join(process.cwd(), 'data');

function parseCsv(content) {
  const raw = content.replace(/^\uFEFF/, '').trim();
  const lines = raw.split(/\r?\n/);
  if (lines.length < 2) return [];
  const header = lines[0].toLowerCase().split(',').map((c) => c.trim());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split(',');
    const row = {};
    header.forEach((h, j) => {
      row[h] = values[j] !== undefined ? values[j].trim() : '';
    });
    rows.push(row);
  }
  return rows;
}

function toNumber(v) {
  const n = parseFloat(String(v).replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

function normalize(rows) {
  const hasTimestamp = rows[0] && ('timestamp' in rows[0] || 'datetime' in rows[0]);
  return rows.map((r) => {
    let date = r.date || '';
    let time = r.time || '';
    if (r.timestamp) {
      const d = new Date(Number(r.timestamp) || r.timestamp);
      date = d.toISOString().slice(0, 10);
      time = d.toISOString().slice(11, 19);
    } else if (r.datetime) {
      const s = String(r.datetime);
      date = s.slice(0, 10);
      time = s.length > 10 ? s.slice(11, 19) : '';
    }
    return {
      date,
      time,
      open: toNumber(r.open),
      high: toNumber(r.high),
      low: toNumber(r.low),
      close: toNumber(r.close),
      volume: toNumber(r.volume) || 0,
    };
  });
}

function loadPath(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const rows = parseCsv(content);
  return normalize(rows);
}

function loadDir(dir) {
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.csv'));
  if (files.length === 0) return [];
  const all = [];
  for (const f of files.sort()) {
    const candles = loadPath(path.join(dir, f));
    all.push({ file: f, candles });
  }
  return all;
}

// CLI
const arg = process.argv[2];
let result;

if (arg) {
  const full = path.isAbsolute(arg) ? arg : path.join(process.cwd(), arg);
  if (fs.statSync(full).isDirectory()) {
    result = loadDir(full);
  } else {
    result = [{ file: path.basename(full), candles: loadPath(full) }];
  }
} else {
  result = loadDir(defaultDir);
  if (result.length === 0 && fs.existsSync(path.join(defaultDir, 'sample.csv'))) {
    result = [{ file: 'sample.csv', candles: loadPath(path.join(defaultDir, 'sample.csv')) }];
  }
}

console.log(JSON.stringify(result, null, 0));
