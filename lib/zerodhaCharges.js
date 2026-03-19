/**
 * Zerodha intraday equity charges calculator.
 * Based on official Zerodha brokerage calculator: zerodha.com/charges
 */

// Rates (Zerodha equity intraday)
const BROKERAGE_RATE_PCT = 0.03;
const BROKERAGE_MAX_PER_ORDER = 20;
const STT_RATE_PCT = 0.025;        // on sell side only
const EXCHANGE_NSE_PCT = 0.00307;
const EXCHANGE_BSE_PCT = 0.00375;
const SEBI_PER_CRORE = 10;
const STAMP_RATE_PCT = 0.003;     // on buy side only
const GST_RATE_PCT = 18;

/** Round to 2 decimal places for currency. */
function round2(n) {
  return Math.round((n || 0) * 100) / 100;
}

/**
 * Calculate Zerodha intraday equity charges for a single trade.
 * @param {number} buyPrice - Entry price
 * @param {number} sellPrice - Exit price
 * @param {number} qty - Quantity
 * @param {string} [exchange='NSE'] - 'NSE' or 'BSE'
 * @returns {{ turnover, brokerage, stt, exchangeCharge, sebi, stampDuty, gst, totalCharges }}
 */
export function calculateIntradayCharges(buyPrice, sellPrice, qty, exchange = 'NSE') {
  if (!Number.isFinite(qty) || qty <= 0) {
    return { turnover: 0, brokerage: 0, stt: 0, exchangeCharge: 0, sebi: 0, stampDuty: 0, gst: 0, totalCharges: 0 };
  }
  const buyVal = (Number(buyPrice) || 0) * qty;
  const sellVal = (Number(sellPrice) || 0) * qty;
  const turnover = buyVal + sellVal;

  // Brokerage: min(0.03% of trade value, ₹20) per order × 2 (buy + sell)
  const buyBrokerage = Math.min(buyVal * (BROKERAGE_RATE_PCT / 100), BROKERAGE_MAX_PER_ORDER);
  const sellBrokerage = Math.min(sellVal * (BROKERAGE_RATE_PCT / 100), BROKERAGE_MAX_PER_ORDER);
  const brokerage = round2(buyBrokerage + sellBrokerage);

  // STT: 0.025% on sell value
  const stt = round2(sellVal * (STT_RATE_PCT / 100));

  // Exchange: NSE 0.00307% or BSE 0.00375% of turnover
  const exRate = (exchange || 'NSE').toUpperCase() === 'BSE' ? EXCHANGE_BSE_PCT : EXCHANGE_NSE_PCT;
  const exchangeCharge = round2(turnover * (exRate / 100));

  // SEBI: ₹10 per crore of turnover
  const sebi = round2((turnover / 1e7) * SEBI_PER_CRORE);

  // Stamp duty: 0.003% on buy value
  const stampDuty = round2(buyVal * (STAMP_RATE_PCT / 100));

  // GST: 18% on (brokerage + exchange + sebi)
  const taxableBase = brokerage + exchangeCharge + sebi;
  const gst = round2(taxableBase * (GST_RATE_PCT / 100));

  const totalCharges = round2(brokerage + stt + exchangeCharge + sebi + stampDuty + gst);

  return {
    turnover: round2(turnover),
    brokerage,
    stt,
    exchangeCharge,
    sebi,
    stampDuty,
    gst,
    totalCharges,
  };
}

/**
 * Sum charges for an array of trades.
 * @param {Array<{ entry: number, exitPrice: number, qty: number }>} trades - Trade list
 * @param {string} [exchange='NSE'] - Exchange
 * @returns {number} Total charges
 */
export function sumChargesForTrades(trades, exchange = 'NSE') {
  if (!Array.isArray(trades) || trades.length === 0) return 0;
  let total = 0;
  for (const t of trades) {
    const entry = t.entry ?? t.buyPrice;
    const exitPrice = t.exitPrice ?? t.sellPrice;
    const qty = t.qty ?? 0;
    if (!Number.isFinite(entry) || !Number.isFinite(exitPrice) || !Number.isFinite(qty) || qty <= 0) continue;
    const c = calculateIntradayCharges(entry, exitPrice, qty, exchange);
    total += c.totalCharges;
  }
  return round2(total);
}
