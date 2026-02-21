/**
 * Send a test message to Telegram. Uses TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID from .env.
 *
 * Usage: node scripts/testTelegram.js [message]
 *   message  Optional. Default: "Test from stocks scanner"
 *
 * Example: node scripts/testTelegram.js "Hello from live scanner"
 */

import 'dotenv/config';
import { sendAlert, isConfigured } from '../lib/telegram.js';

const defaultMessage = 'Test from stocks scanner';
const message = process.argv[2]?.trim() || defaultMessage;

async function main() {
  if (!isConfigured()) {
    console.error('Telegram not configured. Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env');
    process.exit(1);
  }
  const ok = await sendAlert(message);
  console.log(ok ? 'Sent: ' + message : 'Send failed (check token and chat ID)');
  process.exit(ok ? 0 : 1);
}

main();
