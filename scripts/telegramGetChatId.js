/**
 * Fetch recent Telegram updates and print chat IDs. Use this to find your group chat ID.
 *
 * 1. Add your bot to the group (as member).
 * 2. Send any message in the group (e.g. "hi").
 * 3. Run: node scripts/telegramGetChatId.js
 *
 * Set TELEGRAM_BOT_TOKEN in .env. TELEGRAM_CHAT_ID is not required for this script.
 */

import 'dotenv/config';

const token = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
if (!token) {
  console.error('Set TELEGRAM_BOT_TOKEN in .env');
  process.exit(1);
}

const url = `https://api.telegram.org/bot${token}/getUpdates`;

async function main() {
  const res = await fetch(url);
  const data = await res.json();
  if (!data.ok) {
    console.error('API error:', data.description || res.status);
    process.exit(1);
  }
  const updates = data.result || [];
  if (updates.length === 0) {
    console.log('No recent updates.');
    console.log('');
    console.log('To see a GROUP chat ID:');
    console.log('  1. The bot in .env (TELEGRAM_BOT_TOKEN) must be ADDED TO THE GROUP.');
    console.log('  2. In the GROUP (not in private chat), send:  /start   or  @YourBotUsername');
    console.log('  3. Run this script again right after.');
    console.log('');
    console.log('If you only see "private": you sent in private, or a different bot is in the group.');
    return;
  }
  const seen = new Set();
  let hasGroup = false;
  console.log('Chat IDs to use as TELEGRAM_CHAT_ID:\n');
  for (const u of updates) {
    const chat = u.message?.chat || u.channel_post?.chat;
    if (!chat || seen.has(chat.id)) continue;
    seen.add(chat.id);
    const type = chat.type || '?';
    const title = chat.title || chat.first_name || chat.username || '—';
    if (type === 'group' || type === 'supergroup') hasGroup = true;
    console.log(`  ${chat.id}  (${type}: ${title})`);
  }
  if (!hasGroup) {
    console.log('\n(Only private chat found. To get the group: add THIS bot to the group, then send /start in the group, run again.)');
  }
  console.log('\nFor a group, use the negative number in .env: TELEGRAM_CHAT_ID=-1001234567890');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
