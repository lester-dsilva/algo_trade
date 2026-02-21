/**
 * Send alerts to Telegram. No-op if TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is not set.
 */

import 'dotenv/config';

const token = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
const chatId = (process.env.TELEGRAM_CHAT_ID || '').trim();

export function isConfigured() {
  return !!(token && chatId);
}

/**
 * Send a text message to the configured Telegram chat. No-op if token or chat ID missing.
 * @param {string} text
 * @returns {Promise<boolean>} true if sent, false if skipped or failed
 */
export async function sendAlert(text) {
  if (!token || !chatId) return false;
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: String(text),
        disable_web_page_preview: true,
      }),
    });
    if (!res.ok) {
      console.error('Telegram sendMessage failed:', res.status, await res.text());
      return false;
    }
    return true;
  } catch (err) {
    console.error('Telegram sendAlert error:', err?.message || err);
    return false;
  }
}
