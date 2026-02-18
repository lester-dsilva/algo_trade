/**
 * Zerodha Kite Connect client — reads credentials from .env, exposes authenticated kc.
 * Access token is persisted in .kite_session so scripts can reuse it across runs
 * until it expires; then you run kite:login again and get a new request token.
 */

import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { KiteConnect } from 'kiteconnect';

dotenv.config();

const apiKey = process.env.KITE_API_KEY || process.env.api_key || process.env.API_KEY;
const apiSecret = process.env.KITE_API_SECRET || process.env.api_secret || process.env.API_SECRET;
const requestToken = process.env.KITE_REQUEST_TOKEN || process.env.request_token || process.env.REQUEST_TOKEN;

const SESSION_FILE = path.join(process.cwd(), '.kite_session');

let kc = null;
let sessionPromise = null;

function getKiteConnect() {
  if (!apiKey) throw new Error('Missing KITE_API_KEY in .env');
  if (!kc) kc = new KiteConnect({ api_key: apiKey });
  return kc;
}

function loadSessionFile() {
  try {
    const data = fs.readFileSync(SESSION_FILE, 'utf8');
    return JSON.parse(data);
  } catch {
    return null;
  }
}

function saveSessionFile(accessToken, loginTime) {
  try {
    fs.writeFileSync(SESSION_FILE, JSON.stringify({ access_token: accessToken, login_time: loginTime }), 'utf8');
  } catch (err) {
    // ignore write errors (e.g. read-only fs)
  }
}

function deleteSessionFile() {
  try {
    fs.unlinkSync(SESSION_FILE);
  } catch {}
}

function isTokenError(err) {
  const msg = err?.message || String(err);
  return /invalid|expired|token|unauthorized|403|401/i.test(msg);
}

/**
 * Generate session from request token (one-time use per token). Saves access token to .kite_session.
 */
async function generateSession() {
  if (sessionPromise) return sessionPromise;
  const kite = getKiteConnect();
  if (!apiSecret || !requestToken) {
    throw new Error('Missing KITE_API_SECRET or KITE_REQUEST_TOKEN in .env');
  }
  try {
    sessionPromise = kite.generateSession(requestToken, apiSecret);
    const res = await sessionPromise;
    kite.setAccessToken(res.access_token);
    saveSessionFile(res.access_token, res.login_time);
    return res;
  } catch (err) {
    sessionPromise = null;
    if (isTokenError(err)) {
      throw new Error(
        'Kite token invalid or expired. Get a new request token: run "npm run kite:login", log in, then put the printed KITE_REQUEST_TOKEN in .env and try again.'
      );
    }
    throw err;
  }
}

/**
 * Get authenticated Kite instance. Uses cached .kite_session if valid, else generateSession() with request token.
 */
async function getKite() {
  const kite = getKiteConnect();
  const cached = loadSessionFile();
  if (cached?.access_token) {
    kite.setAccessToken(cached.access_token);
    try {
      await kite.getProfile();
      return kite;
    } catch (err) {
      if (isTokenError(err)) {
        deleteSessionFile();
        // fall through to generateSession
      } else {
        throw err;
      }
    }
  }
  await generateSession();
  return getKiteConnect();
}

export { getKiteConnect, getKite, generateSession };
