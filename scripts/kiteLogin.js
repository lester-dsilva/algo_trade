/**
 * Get Kite request token: print login URL and catch redirect with request_token.
 * 1. Set redirect URL in Kite app to http://127.0.0.1:3000 (or KITE_REDIRECT_PORT below).
 * 2. Run: node scripts/kiteLogin.js
 * 3. Open the printed URL in browser, log in to Zerodha.
 * 4. Copy the printed request_token into .env as KITE_REQUEST_TOKEN=...
 * 5. Use that for generateSession() (e.g. npm run kite:session).
 */

import dotenv from 'dotenv';
import http from 'http';

dotenv.config();

const apiKey =
  process.env.KITE_API_KEY || process.env.api_key || process.env.API_KEY;
const port =
  parseInt(process.env.KITE_REDIRECT_PORT, 10) || 3000;

if (!apiKey) {
  console.error('Missing KITE_API_KEY (or api_key) in .env');
  process.exit(1);
}

const loginUrl = `https://kite.zerodha.com/connect/login?api_key=${apiKey}&v=3`;

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', `http://127.0.0.1:${port}`);
  const requestToken = url.searchParams.get('request_token');
  const status = url.searchParams.get('status');

  if (requestToken) {
    console.log('\n--- Request token (add to .env) ---');
    console.log('KITE_REQUEST_TOKEN=' + requestToken);
    console.log('------------------------------------\n');
    if (status === 'success') {
      console.log('Login successful. Put the above line in .env, then run e.g. npm run kite:session\n');
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(
      '<!DOCTYPE html><html><body><p>Request token received. You can close this window and add <code>KITE_REQUEST_TOKEN</code> to your .env file.</p></body></html>'
    );
    server.close();
    return;
  }

  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(
    '<!DOCTYPE html><html><body><p>Waiting for Kite redirect with request_token. If you just logged in, check the terminal for the token.</p></body></html>'
  );
});

server.listen(port, '127.0.0.1', () => {
  console.log('Redirect URL must be set in Kite app to: http://127.0.0.1:' + port);
  console.log('\nOpen this URL in your browser to log in:\n');
  console.log(loginUrl);
  console.log('\nAfter login you will be redirected here and the request_token will be printed.\n');
});
