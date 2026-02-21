/**
 * Aggregate tick stream into 3-minute bars (NSE market hours IST).
 * Emits "bar closed" when a new 3m bucket starts or date changes.
 * Used by liveScanner to build 3m candles from KiteTicker ticks.
 */

const MARKET_START_MIN = 9 * 60 + 15;  // 09:15 IST
const MARKET_END_MIN = 15 * 60 + 30;   // 15:30 IST
const BAR_MINUTES = 3;

/**
 * Convert Date (UTC epoch) to IST date and minute-of-day. IST = UTC + 5:30.
 */
function toIST(d) {
  if (typeof d === 'number') d = new Date(d);
  let h = d.getUTCHours(), m = d.getUTCMinutes(), s = d.getUTCSeconds();
  let day = d.getUTCDate(), month = d.getUTCMonth(), year = d.getUTCFullYear();
  m += 30;
  if (m >= 60) { m -= 60; h += 1; }
  h += 5;
  if (h >= 24) { h -= 24; day += 1; }
  const date = year + '-' + String(month + 1).padStart(2, '0') + '-' + String(day).padStart(2, '0');
  const mins = h * 60 + m + s / 60;
  const timeStr = String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':' + String(Math.floor(s)).padStart(2, '0');
  return { date, time: timeStr, mins: Math.floor(mins) };
}

/**
 * Get 3m bar start time (IST) for a given minute-of-day. NSE 09:15, 09:18, ...
 */
function barStartForMins(mins, barMinutes = BAR_MINUTES) {
  if (mins < MARKET_START_MIN || mins > MARKET_END_MIN) return null;
  const slot = Math.floor((mins - MARKET_START_MIN) / barMinutes) * barMinutes + MARKET_START_MIN;
  const h = Math.floor(slot / 60);
  const m = slot % 60;
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':00';
}

/**
 * Create a candle builder that aggregates ticks into N-minute bars and calls onBarClosed when a bar completes.
 * @param {({ instrumentToken, symbol, date, time, open, high, low, close, volume }) => void} onBarClosed
 * @param {{ barMinutes?: number }} [options] barMinutes default 3
 * @returns {{ addTick: (instrumentToken: number, symbol: string, lastPrice: number, quantity: number, timestamp: Date) => void }}
 */
export function createCandleBuilder(onBarClosed, options = {}) {
  const barMinutes = options.barMinutes ?? BAR_MINUTES;
  const state = new Map(); // instrumentToken -> { symbol, bucketKey, bar: { o,h,l,c,v } }

  function flushBar(instrumentToken, symbol, bucketKey, bar) {
    if (!bar || bar.v === undefined) return;
    const [date, timeStr] = bucketKey.split('|');
    onBarClosed({
      instrumentToken,
      symbol,
      date,
      time: timeStr,
      open: bar.o,
      high: bar.h,
      low: bar.l,
      close: bar.c,
      volume: bar.v,
    });
  }

  let droppedOutsideMarketHoursLogged = false;
  function addTick(instrumentToken, symbol, lastPrice, quantity, timestamp) {
    const t = typeof timestamp === 'number' ? new Date(timestamp) : timestamp;
    const { date, time, mins } = toIST(t);
    const timeStr = barStartForMins(mins, barMinutes);
    if (!timeStr) {
      // #region agent log
      if (!droppedOutsideMarketHoursLogged) {
        droppedOutsideMarketHoursLogged = true;
        fetch('http://127.0.0.1:7243/ingest/80c936d7-31a6-4384-a4b9-07a29efe225b', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ location: 'candleBuilder.js:addTick', message: 'tick dropped outside market hours', data: { symbol, date, time, mins, marketStart: MARKET_START_MIN, marketEnd: MARKET_END_MIN, ts: t.toISOString() }, timestamp: Date.now(), hypothesisId: 'H4' }) }).catch(() => {});
      }
      // #endregion
      return; // outside market hours
    }

    const bucketKey = `${date}|${timeStr}`;
    let s = state.get(instrumentToken);

    if (!s) {
      s = { symbol, bucketKey, bar: { o: lastPrice, h: lastPrice, l: lastPrice, c: lastPrice, v: quantity || 0 } };
      state.set(instrumentToken, s);
      return;
    }

    if (s.bucketKey !== bucketKey) {
      flushBar(instrumentToken, s.symbol, s.bucketKey, s.bar);
      s.bucketKey = bucketKey;
      s.bar = { o: lastPrice, h: lastPrice, l: lastPrice, c: lastPrice, v: quantity || 0 };
    } else {
      s.bar.h = Math.max(s.bar.h, lastPrice);
      s.bar.l = Math.min(s.bar.l, lastPrice);
      s.bar.c = lastPrice;
      s.bar.v += quantity || 0;
    }
  }

  return { addTick };
}

export { toIST, barStartForMins, MARKET_START_MIN, MARKET_END_MIN, BAR_MINUTES };
