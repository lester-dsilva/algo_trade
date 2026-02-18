/**
 * Fetch OHLC data from Kite for an instrument over a date range.
 *
 * Usage:
 *   node scripts/kiteOHLC.js <instrument> <interval> <from> <to>
 *
 * Arguments:
 *   instrument  e.g. NSE:RELIANCE, NSE:BHARATSE
 *   interval    minute | 3minute | 5minute | 15minute | 30minute | 60minute | day
 *   from        Start date YYYY-MM-DD
 *   to          End date YYYY-MM-DD (inclusive)
 *
 * Output: CSV to stdout (date,time,open,high,low,close,volume)
 *
 * Examples:
 *   node scripts/kiteOHLC.js NSE:RELIANCE 3minute 2026-02-16 2026-02-18
 *   node scripts/kiteOHLC.js NSE:BHARATSE day 2026-01-01 2026-02-17
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

const INTRADAY_INTERVALS = new Set(['minute', '3minute', '5minute', '15minute', '30minute', '60minute']);

function parseDate(str) {
  const d = new Date(str);
  if (Number.isNaN(d.getTime())) throw new Error('Invalid date: ' + str);
  return d;
}

function findInstrumentToken(instruments, tradingsymbol) {
  const [ex, sym] = tradingsymbol.includes(':')
    ? tradingsymbol.split(':')
    : ['NSE', tradingsymbol];
  const row = instruments.find((i) => i.exchange === ex && i.tradingsymbol === sym);
  return row ? row.instrument_token : null;
}

// Output date/time in IST so CSV matches TradingView (NSE). IST = UTC + 5:30.
function toISTDateAndTime(d) {
  let h = d.getUTCHours(), min = d.getUTCMinutes(), s = d.getUTCSeconds();
  let day = d.getUTCDate(), month = d.getUTCMonth(), year = d.getUTCFullYear();
  min += 30;
  if (min >= 60) { min -= 60; h += 1; }
  h += 5;
  if (h >= 24) { h -= 24; day += 1; }
  if (day > new Date(year, month + 1, 0).getDate()) { day = 1; month += 1; }
  if (month > 11) { month = 0; year += 1; }
  const date = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const time = `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return { date, time };
}

function kiteCandleToRow(c) {
  const d = new Date(c.date);
  const { date, time } = toISTDateAndTime(d);
  return { date, time, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume };
}

// Intraday interval in minutes (for gap-fill grid)
const INTERVAL_MINUTES = {
  minute: 1,
  '3minute': 3,
  '5minute': 5,
  '15minute': 15,
  '30minute': 30,
  '60minute': 60,
};

/** Fill missing intraday bars so we have a full grid (Kite returns only candles with trades). */
function fillIntradayGaps(rows, interval) {
  const stepMin = INTERVAL_MINUTES[interval];
  if (!stepMin || rows.length === 0) return rows;

  const byDate = {};
  for (const r of rows) {
    const d = r.date;
    if (!byDate[d]) byDate[d] = [];
    byDate[d].push({ ...r });
  }

  const filled = [];
  // NSE market hours in IST (CSV is now in IST to match TradingView)
  const marketStartMin = 9 * 60 + 15;   // 09:15
  const marketEndMin = 15 * 60 + 30;    // 15:30

  for (const date of Object.keys(byDate).sort()) {
    const dayRows = byDate[date].sort((a, b) => (a.time || '').localeCompare(b.time || ''));
    const byTime = {};
    for (const r of dayRows) byTime[r.time] = r;

    let lastClose = dayRows[0] ? dayRows[0].open : 0;
    for (let min = marketStartMin; min <= marketEndMin; min += stepMin) {
      const h = Math.floor(min / 60);
      const m = min % 60;
      const time = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`;
      const existing = byTime[time];
      if (existing) {
        filled.push(existing);
        lastClose = existing.close;
      } else {
        filled.push({
          date,
          time,
          open: lastClose,
          high: lastClose,
          low: lastClose,
          close: lastClose,
          volume: 0,
        });
      }
    }
  }
  return filled.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
}

// Iterate calendar dates YYYY-MM-DD without timezone (so 18–19 yields 18 and 19, not 17 and 18)
function* dateRange(fromStr, toStr) {
  const [y1, m1, d1] = fromStr.split('-').map(Number);
  const [y2, m2, d2] = toStr.split('-').map(Number);
  const start = new Date(y1, m1 - 1, d1);
  const end = new Date(y2, m2 - 1, d2);
  const cur = new Date(start);
  while (cur <= end) {
    const y = cur.getFullYear();
    const m = cur.getMonth() + 1;
    const d = cur.getDate();
    yield `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    cur.setDate(cur.getDate() + 1);
  }
}

async function main() {
  const [instrument, intervalArg, fromStr, toStr] = process.argv.slice(2);

  if (!instrument || !intervalArg || !fromStr || !toStr) {
    console.error('Usage: node scripts/kiteOHLC.js <instrument> <interval> <from> <to>');
    console.error('  instrument  e.g. NSE:RELIANCE, NSE:BHARATSE');
    console.error('  interval    minute | 3minute | 5minute | 15minute | 30minute | 60minute | day');
    console.error('  from, to    YYYY-MM-DD');
    console.error('');
    console.error('Example: node scripts/kiteOHLC.js NSE:RELIANCE 3minute 2026-02-16 2026-02-18');
    process.exit(1);
  }

  const interval = intervalMap[intervalArg.toLowerCase()];
  if (!interval) {
    console.error('Invalid interval:', intervalArg);
    process.exit(1);
  }

  const from = parseDate(fromStr);
  const to = parseDate(toStr);
  if (from > to) {
    console.error('from date must be <= to date');
    process.exit(1);
  }

  const kc = await getKite();
  const instruments = await kc.getInstruments('NSE');
  const token = findInstrumentToken(instruments, instrument);
  if (!token) {
    console.error('Instrument not found:', instrument);
    process.exit(1);
  }

  const allRows = [];

  if (interval === 'day') {
    const candles = await kc.getHistoricalData(token, interval, from, to, false, false);
    allRows.push(...candles.map(kiteCandleToRow));
  } else {
    for (const dateStr of dateRange(fromStr, toStr)) {
      const dayFrom = dateStr + ' 09:15:00';
      const dayTo = dateStr + ' 15:30:00';
      const candles = await kc.getHistoricalData(token, interval, dayFrom, dayTo, false, false);
      allRows.push(...candles.map(kiteCandleToRow));
    }
  }

  // Fill missing intraday bars so we have a full 3m/5m/... grid (Kite returns only candles with trades)
  let outputRows = interval === 'day' ? allRows : fillIntradayGaps(allRows, interval);

  const header = 'date,time,open,high,low,close,volume';
  const lines = [header, ...outputRows.map((r) => [r.date, r.time, r.open, r.high, r.low, r.close, r.volume].join(','))];
  const out = lines.join('\n');
  const outPath = process.argv[6];
  if (outPath) {
    const fs = await import('fs');
    fs.writeFileSync(outPath, out, 'utf8');
    console.error('Wrote', outputRows.length, 'rows to', outPath);
  } else {
    console.log(out);
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
