/**
 * Fetch intraday historical OHLCV from Kite and output our CSV format (or JSON).
 * Usage:
 *   node scripts/kiteHistorical.js NSE:RELIANCE 2026-02-16
 *   node scripts/kiteHistorical.js NSE:BHARATSE 2026-02-16 3minute
 * Interval: minute | 3minute | 5minute | 15minute | 30minute | 60minute | day (default: 3minute)
 * Output: CSV to stdout (pipe to loadCsv or save to data/)
 */

import { getKite } from '../lib/kite.js';

const intervalMap = {
  minute: 'minute',
  min: 'minute',
  '3minute': '3minute',
  '3min': '3minute',
  '5minute': '5minute',
  '5min': '5minute',
  '15minute': '15minute',
  '15min': '15minute',
  '30minute': '30minute',
  '60minute': '60minute',
  '1hour': '60minute',
  day: 'day',
};

function parseDate(d) {
  const date = new Date(d);
  if (Number.isNaN(date.getTime())) throw new Error('Invalid date: ' + d);
  return date;
}

function findInstrumentToken(instruments, exchange, tradingsymbol) {
  const [ex, sym] = tradingsymbol.includes(':') ? tradingsymbol.split(':') : [exchange || 'NSE', tradingsymbol];
  const row = instruments.find((i) => i.exchange === ex && i.tradingsymbol === sym);
  if (!row) return null;
  return row.instrument_token;
}

function kiteCandleToRow(c) {
  const d = new Date(c.date);
  const date = d.toISOString().slice(0, 10);
  const time = d.toISOString().slice(11, 19);
  return { date, time, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume };
}

async function main() {
  const [tradingsymbol, dateStr, intervalArg] = process.argv.slice(2);
  if (!tradingsymbol || !dateStr) {
    console.error('Usage: node scripts/kiteHistorical.js <NSE:SYMBOL> <YYYY-MM-DD> [interval]');
    console.error('Interval: minute, 3minute, 5minute, 15minute, 30minute, 60minute, day (default: 3minute)');
    process.exit(1);
  }

  const interval = intervalMap[intervalArg?.toLowerCase()] || '3minute';
  const from = parseDate(dateStr + 'T09:15:00+05:30');
  const to = parseDate(dateStr + 'T15:30:00+05:30');

  const kc = await getKite();
  const instruments = await kc.getInstruments('NSE');
  const token = findInstrumentToken(instruments, 'NSE', tradingsymbol);
  if (!token) {
    console.error('Symbol not found:', tradingsymbol);
    process.exit(1);
  }

  const candles = await kc.getHistoricalData(token, interval, from, to, false, false);
  const rows = candles.map(kiteCandleToRow);

  const header = 'date,time,open,high,low,close,volume';
  const lines = [header, ...rows.map((r) => [r.date, r.time, r.open, r.high, r.low, r.close, r.volume].join(','))];
  console.log(lines.join('\n'));
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
