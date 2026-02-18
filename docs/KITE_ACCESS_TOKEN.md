# How to get the Kite access token

Kite uses a **two-step** flow. You never get an "access token" by hand — you get a **request token** from the browser, then exchange it for an **access token** in code.

---

## Step 1: Request token (one-time per session/day)

1. **Redirect URL** must be set in your [Kite app settings](https://kite.zerodha.com/apps):
   - Use e.g. `http://127.0.0.1:3000` or `http://localhost:3000` for local scripts.
   - Kite will redirect the user here after login with `?request_token=...` in the URL.

2. **Open the login URL** in a browser (or use the script below to print it and start a catcher):
   ```
   https://kite.zerodha.com/connect/login?api_key=YOUR_API_KEY&v=3
   ```
   Replace `YOUR_API_KEY` with your actual API key from .env.

3. **Log in** with your Zerodha credentials and approve the app if asked.

4. **After login**, the browser is redirected to your redirect URL with a query string:
   ```
   http://127.0.0.1:3000?request_token=AbCdEf123456&action=login&status=success
   ```
   Copy the **request_token** value (e.g. `AbCdEf123456`).

5. Put it in `.env`:
   ```
   KITE_REQUEST_TOKEN=AbCdEf123456
   ```
   (or `request_token=...`)

---

## Step 2: Access token (used for all API calls)

You **don’t put the access token in .env** yourself. Your code gets it by calling Kite’s API with the request token and API secret:

```js
const response = await kc.generateSession(requestToken, apiSecret);
// response.access_token  ← this is the access token
kc.setAccessToken(response.access_token);
```

`lib/kite.js` does this when you call `getKite()` or `generateSession()`: it reads `KITE_REQUEST_TOKEN` and `KITE_API_SECRET` from `.env`, calls `generateSession()`, and sets the access token on the client. All later requests (getProfile, getHistoricalData, placeOrder, etc.) use that access token automatically.

---

## Validity

- **Request token**: one-time use. After you call `generateSession()`, that request token is consumed and cannot be used again.
- **Access token**: valid until end of the trading day (or as per Kite’s policy). Next day you repeat **Step 1** (login in browser → get new request token → put in .env) and run your script again; `generateSession()` will then give you a fresh access token.

---

## Quick run with the helper script

From the project root:

```bash
node scripts/kiteLogin.js
```

This will:
1. Print the login URL (open it in a browser).
2. Start a small server on `http://127.0.0.1:3000`.
3. After you log in, Kite redirects to that server; the script will print the **request_token** and tell you to add it to `.env`.
4. Put that value in `.env` as `KITE_REQUEST_TOKEN=...`, then run e.g. `npm run kite:session` or `kiteHistorical.js`.

Ensure your Kite app’s redirect URL is exactly `http://127.0.0.1:3000` (or the URL the script prints).
