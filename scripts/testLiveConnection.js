/**
 * Minimal Kite ticker test — subscribe to token 119555335 (CRUDEOIL26FEBFUT), log ticks.
 * Usage: node scripts/testLiveConnection.js
 * Requires: .env (KITE_API_KEY), .kite_session (access_token).
 */

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { KiteTicker } from 'kiteconnect';

const apiKey = process.env.KITE_API_KEY || process.env.api_key || process.env.API_KEY;
const sessionPath = path.join(process.cwd(), '.kite_session');
const session = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
const accessToken = session.access_token;

const ticker = new KiteTicker({
  api_key: apiKey,
  access_token: accessToken,
});

const ITEMS = [738561];

ticker.connect();
ticker.on('ticks', onTicks);
ticker.on('connect', subscribe);
ticker.on('disconnect', onDisconnect);
ticker.on('error', onError);
ticker.on('close', onClose);
ticker.on('order_update', onTrade);

function onTicks(ticks) {
  console.log('Ticks', ticks);
}

function subscribe() {
  ticker.subscribe(ITEMS);
  ticker.setMode(ticker.modeFull, ITEMS);
}

function onDisconnect(error) {
  console.log('Closed connection on disconnect', error);
}

function onError(error) {
  console.log('Closed connection on error', error);
}

function onClose(reason) {
  console.log('Closed connection on close', reason);
}

function onTrade(order) {
  console.log('Order update', order);
}
