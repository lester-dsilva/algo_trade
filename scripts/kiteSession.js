/**
 * Verify Kite session: load .env, generate session, fetch profile.
 * Usage: node scripts/kiteSession.js
 */

import { getKite } from '../lib/kite.js';

async function main() {
  const kc = await getKite();
  const profile = await kc.getProfile();
  console.log('Session OK. Profile:', profile.user_name, profile.email);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
