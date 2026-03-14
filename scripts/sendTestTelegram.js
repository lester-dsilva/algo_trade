/**
 * Send a test message to Telegram. Run: node scripts/sendTestTelegram.js
 */
import { sendAlert, isConfigured } from '../lib/telegram.js';

async function main() {
  if (!isConfigured()) {
    console.error('Telegram not configured. Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env');
    process.exit(1);
  }
  const ok = await sendAlert('Test message from stocks app — ' + new Date().toISOString());
  console.log(ok ? 'Test message sent.' : 'Failed to send.');
  process.exit(ok ? 0 : 1);
}

main();
