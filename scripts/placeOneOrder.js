/**
 * One-shot: place a single NSE MIS MARKET order (regular variety) using .kite_session + .env.
 *
 * Usage:
 *   node scripts/placeOneOrder.js <SYMBOL> <BUY|SELL> <QTY>
 *
 * Example (Ashok Leyland, 1 share buy):
 *   node scripts/placeOneOrder.js ASHOKLEY BUY 1
 *
 * Same market protection as live trading: default 0.5% (KITE_MARKET_PROTECTION in .env).
 */

import { getKite } from '../lib/kite.js';
import { placeBuyOrder, placeSellOrder } from '../lib/orderExecutor.js';

function usage() {
  console.error(`
Usage: node scripts/placeOneOrder.js <SYMBOL> <BUY|SELL> <QTY>

Example:
  node scripts/placeOneOrder.js ASHOKLEY BUY 1
`);
}

async function main() {
  const [, , symRaw, sideRaw, qtyRaw] = process.argv;
  if (!symRaw || !sideRaw || qtyRaw == null) {
    usage();
    process.exit(1);
  }
  const symbol = symRaw.trim().toUpperCase();
  const side = sideRaw.trim().toUpperCase();
  const qty = parseInt(String(qtyRaw).trim(), 10);
  if (side !== 'BUY' && side !== 'SELL') {
    console.error('SIDE must be BUY or SELL');
    usage();
    process.exit(1);
  }
  if (!Number.isFinite(qty) || qty < 1) {
    console.error('QTY must be a positive integer');
    process.exit(1);
  }

  const kite = await getKite();
  const place = side === 'BUY' ? placeBuyOrder : placeSellOrder;
  const result = await place(kite, symbol, qty, null, null);

  if (result.error) {
    console.error(result.error);
    process.exit(1);
  }
  console.log(JSON.stringify({ ok: true, orderId: result.orderId, symbol, side, qty }, null, 2));
}

main().catch((e) => {
  console.error(e?.message ?? e);
  process.exit(1);
});
