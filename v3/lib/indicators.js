/**
 * Shared technical indicators for v3.
 */

export function sma(values, period) {
  const out = [];
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) {
      out.push(null);
      continue;
    }
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += values[j];
    out.push(sum / period);
  }
  return out;
}

export function ema(candles, key = 'close', period = 20) {
  const mult = 2 / (period + 1);
  const out = [];
  let prev = null;
  for (let i = 0; i < candles.length; i++) {
    const v = candles[i][key];
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      out.push(null);
      continue;
    }
    if (prev == null) {
      if (i < period - 1) {
        out.push(null);
        continue;
      }
      let sum = 0;
      for (let j = 0; j < period; j++) sum += candles[j][key];
      prev = sum / period;
    } else {
      prev = (v - prev) * mult + prev;
    }
    out.push(prev);
  }
  return out;
}

export function smaAtEnd(values, period) {
  if (!values.length || values.length < period) return null;
  const slice = values.slice(-period);
  return slice.reduce((s, v) => s + v, 0) / period;
}
