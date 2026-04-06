/**
 * Live order placement via Kite Connect.
 *
 * All orders are MARKET / MIS (intraday). Functions never throw — they catch
 * errors internally, log them, and return { error } so the caller (liveScanner)
 * never crashes on an order failure.
 *
 * Usage:
 *   import { placeBuyOrder, placeSellOrder } from './orderExecutor.js';
 *   const result = await placeBuyOrder(kite, 'INFY', 10, logToFile, sendAlert);
 *   // result: { orderId: '...' } | { error: '...' }
 *
 * MARKET orders require market_protection (Kite API). Default 0.5 (%). Override:
 * KITE_MARKET_PROTECTION=-1 (exchange auto) or a positive percent up to 100.
 */

const ORDER_VARIETY  = 'regular';
const ORDER_EXCHANGE = 'NSE';
const ORDER_TYPE     = 'MARKET';
const ORDER_PRODUCT  = 'MIS';

function resolvedMarketProtection() {
  const raw = process.env.KITE_MARKET_PROTECTION;
  if (raw == null || String(raw).trim() === '') return 0.5;
  const n = Number(String(raw).trim());
  if (!Number.isFinite(n)) return 0.5;
  if (n === -1) return -1;
  if (n > 0 && n <= 100) return n;
  return 0.5;
}

/**
 * Place a MIS MARKET BUY order. Returns { orderId } or { error }.
 */
export async function placeBuyOrder(kite, symbol, qty, logToFile, sendAlert) {
  return _placeOrder(kite, symbol, 'BUY', qty, logToFile, sendAlert);
}

/**
 * Place a MIS MARKET SELL order. Returns { orderId } or { error }.
 */
export async function placeSellOrder(kite, symbol, qty, logToFile, sendAlert) {
  return _placeOrder(kite, symbol, 'SELL', qty, logToFile, sendAlert);
}

async function _placeOrder(kite, symbol, side, qty, logToFile, sendAlert) {
  const marketProtection = resolvedMarketProtection();
  const params = {
    tradingsymbol:     symbol,
    exchange:          ORDER_EXCHANGE,
    transaction_type:  side,
    order_type:        ORDER_TYPE,
    quantity:          qty,
    product:           ORDER_PRODUCT,
    market_protection: marketProtection,
  };

  try {
    const response = await kite.placeOrder(ORDER_VARIETY, params);
    const orderId = response?.order_id ?? response;
    console.error(`[ORDER_OK] ${side} ${symbol} qty=${qty} mp=${marketProtection}% orderId=${orderId}`);
    if (typeof logToFile === 'function') {
      logToFile('order_placed', { side, symbol, qty, orderId, variety: ORDER_VARIETY, product: ORDER_PRODUCT, market_protection: marketProtection });
    }
    return { orderId };
  } catch (err) {
    const msg = err?.message ?? String(err);
    console.error(`[ORDER_FAIL] ${side} ${symbol} qty=${qty} | ${msg}`);
    if (typeof logToFile === 'function') {
      logToFile('order_failed', { side, symbol, qty, error: msg });
    }
    if (typeof sendAlert === 'function') {
      sendAlert([
        `ORDER FAILED (${side})`,
        `Symbol: ${symbol}`,
        `Qty: ${qty}`,
        `Error: ${msg}`,
        'Check Kite dashboard — manual action may be needed',
      ].join('\n'));
    }
    return { error: msg };
  }
}
