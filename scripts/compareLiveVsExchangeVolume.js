/**
 * Compare 3m bar volumes: live (from volume_debug.log, else live_scanner.log) vs exchange (v2/data/YYYY-MM-DD/3m).
 * Usage: node scripts/compareLiveVsExchangeVolume.js [SYMBOL] [YYYY-MM-DD]
 * Output: data/comparison/SYMBOL_YYYY-MM-DD_volume_comparison.csv
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const LOG_PATH = path.join(ROOT, 'data', 'live_scanner.log');
const VOLUME_DEBUG_PATH = path.join(ROOT, 'data', 'volume_debug.log');
const COMPARISON_DIR = path.join(ROOT, 'data', 'comparison');
const V2_DATA = path.join(ROOT, 'v2', 'data');

const symbol = (process.argv[2] || 'AIIL').toUpperCase();
const dateStr = process.argv[3] || '2026-03-10';

function normalizeFilename(s) {
  return s.toLowerCase().replace(/&/g, '').replace(/\s/g, '');
}

// Prefer volume_debug.log (has volumeSource); fallback to live_scanner.log bar events
const liveByTime = new Map();
const volumeSourceByTime = new Map();
const useVolumeDebug = fs.existsSync(VOLUME_DEBUG_PATH);
const logPath = useVolumeDebug ? VOLUME_DEBUG_PATH : LOG_PATH;
const eventToken = useVolumeDebug ? '\tbar_volume\t' : '\tbar\t';

if (fs.existsSync(logPath)) {
  const log = fs.readFileSync(logPath, 'utf8');
  for (const line of log.split('\n')) {
    const idx = line.indexOf(eventToken);
    if (idx === -1) continue;
    try {
      const json = line.slice(idx + eventToken.length);
      const o = JSON.parse(json);
      if (o.symbol !== symbol || o.date !== dateStr || o.time == null) continue;
      const time = String(o.time).slice(0, 5);
      const vol = parseInt(o.volume, 10) || 0;
      liveByTime.set(time, vol);
      if (o.volumeSource) volumeSourceByTime.set(time, o.volumeSource);
    } catch (_) {}
  }
} else {
  console.error('Log not found:', logPath);
  process.exit(1);
}

// Bar time = bar start (e.g. 09:15 = 09:15–09:18). Live = volume when that bar closed (from ticks). Exchange = same bar from Kite historical API.
console.error('Live bars from', useVolumeDebug ? 'volume_debug.log' : 'live_scanner.log', ':', liveByTime.size);

// Load exchange 3m CSV
const exchangePath = path.join(V2_DATA, dateStr, '3m', normalizeFilename(symbol) + '.csv');
if (!fs.existsSync(exchangePath)) {
  console.error('Exchange data not found:', exchangePath);
  process.exit(1);
}
const exchangeLines = fs.readFileSync(exchangePath, 'utf8').trim().split('\n');
const exchangeByTime = new Map();
const header = exchangeLines[0].toLowerCase().split(',');
const timeIdx = header.indexOf('time');
const volIdx = header.indexOf('volume');
for (let i = 1; i < exchangeLines.length; i++) {
  const parts = exchangeLines[i].split(',');
  const time = (parts[timeIdx] || '').slice(0, 5);
  const vol = parseInt(parts[volIdx], 10) || 0;
  exchangeByTime.set(time, vol);
}
console.error('Exchange bars from', exchangePath, ':', exchangeByTime.size);

// Merge and build rows (same time = same 3m bar)
const allTimes = new Set([...liveByTime.keys(), ...exchangeByTime.keys()]);
const sortedTimes = [...allTimes].sort();

const rows = [];
let liveCum = 0;
let exchangeCum = 0;
for (const time of sortedTimes) {
  const lv = liveByTime.get(time) ?? null;
  const ev = exchangeByTime.get(time) ?? null;
  if (lv != null) liveCum += lv;
  if (ev != null) exchangeCum += ev;
  const diff = lv != null && ev != null ? lv - ev : null;
  const ratioPct = lv != null && ev != null && ev > 0 ? ((lv / ev) * 100).toFixed(2) : '';
  const volSource = volumeSourceByTime.get(time) ?? '';
  rows.push({
    time,
    live_volume: lv ?? '',
    exchange_volume: ev ?? '',
    diff: diff ?? '',
    ratio_pct: ratioPct,
    volume_source: volSource,
    live_cumulative: liveCum,
    exchange_cumulative: exchangeCum,
  });
}

// Write comparison CSV
if (!fs.existsSync(COMPARISON_DIR)) fs.mkdirSync(COMPARISON_DIR, { recursive: true });
const outPath = path.join(COMPARISON_DIR, `${symbol}_${dateStr}_volume_comparison.csv`);
const csvHeader = 'time,live_volume,exchange_volume,diff,ratio_pct,volume_source,live_cumulative,exchange_cumulative';
const csvRows = rows.map((r) =>
  [r.time, r.live_volume, r.exchange_volume, r.diff, r.ratio_pct, r.volume_source, r.live_cumulative, r.exchange_cumulative].join(',')
);
fs.writeFileSync(outPath, [csvHeader, ...csvRows].join('\n'), 'utf8');
console.error('Wrote:', outPath);
// Sanity: first bar same-time check
const firstTime = sortedTimes[0];
console.error('Sample: time', firstTime, '| live_vol', liveByTime.get(firstTime), '| exchange_vol', exchangeByTime.get(firstTime));
console.log(outPath);
