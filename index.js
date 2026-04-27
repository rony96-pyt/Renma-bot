const {
  Client,
  GatewayIntentBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags
} = require('discord.js');
const { Pool } = require('pg');

// Validate env vars - Owner ID defaults to your provided ID if not set in environment
const REQUIRED_ENV = ['DISCORD_TOKEN', 'DATABASE_URL', 'GACHA_CHANNEL_ID', 'BOT_CHANNEL_ID', 'BOOSTER_ROLE_ID'];
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`Missing env var: ${key}`);
    process.exit(1);
  }
}

const GACHA_CHANNEL_ID = process.env.GACHA_CHANNEL_ID;
const BOT_CHANNEL_ID = process.env.BOT_CHANNEL_ID;
const BOOSTER_ROLE_ID = process.env.BOOSTER_ROLE_ID;
const BOT_OWNER_ID = process.env.BOT_OWNER_ID || '774278713684394004'; // Your owner ID as default
const DISBOARD_BOT_ID = '302050872383242240';
const DELETE_AFTER = 10 * 60 * 1000;
const DAILY_COOLDOWN = 2 * 24 * 60 * 60 * 1000;
const BUMP_COOLDOWN = 24 * 60 * 60 * 1000;
const MESSAGE_COOLDOWN = 1 * 60 * 1000;
const MESSAGE_EXP = 1;
const BUMP_EXP = 5;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function sendPrivateMessage(targetUser, payload, fallbackChannel = null) {
  try {
    const dmMessage = await targetUser.send(payload);
    setTimeout(() => dmMessage.delete().catch(() => {}), DELETE_AFTER);
  } catch (err) {
    if (fallbackChannel) {
      const msg = await fallbackChannel.send({
        ...payload,
        content: `${targetUser.toString()}, ${payload.content || ''}`.trim(),
        allowedMentions: { users: [targetUser.id] }
      });
      setTimeout(() => msg.delete().catch(() => {}), DELETE_AFTER);
    }
  }
}

async function initDB() {
  await pool.query(` CREATE TABLE IF NOT EXISTS users ( user_id TEXT PRIMARY KEY, exp INTEGER DEFAULT 0, inv TEXT[] DEFAULT '{}', luck REAL DEFAULT 1, last_daily BIGINT DEFAULT 0, last_work BIGINT DEFAULT 0, last_bump BIGINT DEFAULT 0, last_message BIGINT DEFAULT 0 ); `);
  await pool.query(` CREATE TABLE IF NOT EXISTS bot_state ( key TEXT PRIMARY KEY, value TEXT ); `);
  console.log('Database ready.');
}

async function getUser(id) {
  const res = await pool.query('SELECT * FROM users WHERE user_id = $1', [id]);
  if (res.rows.length > 0) {
    const r = res.rows[0];
    return {
      exp: r.exp, inv: r.inv || [], luck: r.luck,
      lastDaily: Number(r.last_daily), lastWork: Number(r.last_work),
      lastBump: Number(r.last_bump), lastMessage: Number(r.last_message)
    };
  }
  await pool.query('INSERT INTO users (user_id) VALUES ($1) ON CONFLICT DO NOTHING', [id]);
  return { exp: 0, inv: [], luck: 1, lastDaily: 0, lastWork: 0, lastBump: 0, lastMessage: 0 };
}

async function saveUser(id, user) {
  await pool.query(` INSERT INTO users (user_id, exp, inv, luck, last_daily, last_work, last_bump, last_message) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (user_id) DO UPDATE SET exp=$2, inv=$3, luck=$4, last_daily=$5, last_work=$6, last_bump=$7, last_message=$8 `, [id, user.exp, user.inv, user.luck, user.lastDaily, user.lastWork, user.lastBump, user.lastMessage]);
}

async function addMessageExp(userId, member) {
  const now = Date.now();
  let expAmount = MESSAGE_EXP;
  if (member && member.roles.cache.has(BOOSTER_ROLE_ID)) expAmount = 3;
  await pool.query('INSERT INTO users (user_id) VALUES ($1) ON CONFLICT DO NOTHING', [userId]);
  await pool.query(` UPDATE users SET exp = exp + $2, last_message = $3 WHERE user_id = $1 AND ($3 - last_message) >= $4 `, [userId, expAmount, now, MESSAGE_COOLDOWN]);
}

async function getAllUsers() {
  const res = await pool.query('SELECT user_id, exp FROM users ORDER BY exp DESC');
  return res.rows;
}

async function getState(key) {
  const res = await pool.query('SELECT value FROM bot_state WHERE key = $1', [key]);
  return res.rows[0]?.value ?? null;
}

async function setState(key, value) {
  await pool.query(` INSERT INTO bot_state (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2 `, [key, value]);
}

const rewards = [
  { name: '👑 2x Drop Gamepass (SP)', chance: 0.1 },
  { name: '👑 2x Luck Gamepass (SP)', chance: 0.2 },
  { name: '⭐ 250 EXP', chance: 39.7 },
  { name: '⭐ 500 EXP', chance: 30 },
  { name: '🔥 Cosmetic Crate (1x)', chance: 20 },
  { name: '🔥 Aura Crate (1x)', chance: 10 }
];

const rarityColor = {
  '👑 2x Drop Gamepass (SP)': '#ffd700', '👑 2x Luck Gamepass (SP)': '#ffd700',
  '⭐ 250 EXP': '#a8e6cf', '⭐ 500 EXP': '#00cec9',
  '🔥 Cosmetic Crate (1x)': '#fd79a8', '🔥 Aura Crate (1x)': '#e17055'
};

function rollReward(luck = 1) {
  const rand = Math.random() * 100 / Math.max(luck, 1);
  let total = 0;
  for (const r of rewards) { total += r.chance; if (rand <= total) return r.name; }
  return rewards[rewards.length - 1].name;
}

function formatCooldown(ms) {
  if (ms < 0) ms = 0;
  const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000), s = Math.floor((ms % 60000) / 1000);
  if (h > 0) return `${h}h ${m}m`; if (m > 0) return `${m}m ${s}s`; return `${s}s`;
}

function expBar(exp, needed = 700) {
  const filled = Math.min(Math.floor((exp / needed) * 10), 10);
  return '█'.repeat(filled) + '░'.repeat(10 - filled) + ` ${exp}/${needed}`;
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMembers]
});

function buildGachaPanel() {
  const embed = new EmbedBuilder()
    .setColor('#ff2e63')
    .setAuthor({ name: '⚔️ RENMA Gacha System', iconURL: client.user.displayAvatarURL() })
    .setTitle('🎴 ANIME GACHA PANEL')
    .setDescription(
      '> 💬 EXP earned from chatting unlocks awesome rewards.\n> Free for everyone — does not reduce Chat Level!\n\n' +
      '──────────────────────────\n\n🎰 DROP RATES\n\n' +
      '0.1% 👑 2x Drop Gamepass (SP)\n0.2% 👑 2x Luck Gamepass (SP)\n' +
      '39.7% ⭐ 250 EXP\n30% ⭐ 500 EXP\n20% 🔥 Cosmetic Crate (1x)\n10% 🔥 Aura Crate (1x)\n\n' +
      '──────────────────────────\n\n🎁 Cost: 700 EXP\n' +
      `🚀 **Bump** in <#${BOT_CHANNEL_ID}> daily for **+${BUMP_EXP} EXP**\n\n⚡ Choose your action below`
    )
    .setFooter({ text: 'RENMA SYSTEM • Become the strongest', iconURL: client.user.displayAvatarURL() })
    .setTimestamp();
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('open').setLabel('🎁 SUMMON').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('exp').setLabel('⭐ MY EXP').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('inv').setLabel('🎒 INVENTORY').setStyle(ButtonStyle.Secondary)
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('bump_reward').setLabel('🚀 How to get Bump EXP').setStyle(ButtonStyle.Secondary)
  );
  return { embeds: [embed], components: [row1, row2] };
}

client.on('error', (err) => console.error('Client error:', err.message));
process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err?.message));

client.on('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  client.user.setPresence({ activities: [{ name: '🎴 Anime Gacha System', type: 0 }], status: 'online' });
  try {
    const channel = await client.channels.fetch(GACHA_CHANNEL_ID);
    if (!channel) return;
    const savedPanelId = await getState('gacha_panel_id');
    let panelExists = false;
    if (savedPanelId) {
      try { await channel.messages.fetch(savedPanelId); panelExists = true; } catch { panelExists = false; }
    }
    if (!panelExists) {
      const msg = await channel.send(buildGachaPanel());
      await setState('gacha_panel_id', msg.id);
      console.log(`Gacha panel posted to #${channel.name}`);
    } else { console.log('Gacha panel already exists - never deleted'); }
  } catch (err) { console.error('Could not post gacha panel:', err.message); }
});

function isDisboardBump(message) {
  if (message.author.id !== DISBOARD_BOT_ID) return false;
  const text = (message.content || '') + ' ' + message.embeds.map(e => `${e.description || ''} ${e.title || ''}`).join(' ');
  return /bump done/i.test(text);
}

function getBumper(message) { return message.interactionMetadata?.user || message.interaction?.user || null; }

client.on('messageCreate', async (message) => {
  try {
    if (message.author.bot && message.author.id === DISBOARD_BOT_ID) {
      if (!isDisboardBump(message)) return;
      const discordUser = getBumper(message);
      if (!discordUser) return;
      const user = await getUser(discordUser.id);
      const now = Date.now();
      const remaining = BUMP_COOLDOWN - (now - user.lastBump);
      const gachaChannel = await client.channels.fetch(GACHA_CHANNEL_ID).catch(() => null);
      if (remaining > 0) {
        const embed = new EmbedBuilder().setColor('#ff7675').setDescription(`⏳ Already claimed bump reward today. Come back in **${formatCooldown(remaining)}**!`).setFooter({ text: 'RENMA SYSTEM' });
        const userObj = await 
