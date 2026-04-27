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

/* ================= ENV ================= */

const REQUIRED_ENV = ['DISCORD_TOKEN', 'DATABASE_URL', 'GACHA_CHANNEL_ID', 'BOT_CHANNEL_ID', 'BOOSTER_ROLE_ID', 'BOT_OWNER_ID'];

for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`Missing env var: ${key}`);
    process.exit(1);
  }
}

const {
  DISCORD_TOKEN,
  DATABASE_URL,
  GACHA_CHANNEL_ID,
  BOT_CHANNEL_ID,
  BOOSTER_ROLE_ID,
  BOT_OWNER_ID
} = process.env;

/* ================= CONFIG ================= */

const DISBOARD_BOT_ID = '302050872383242240';
const DELETE_AFTER = 10 * 60 * 1000;

const DAILY_COOLDOWN = 2 * 24 * 60 * 60 * 1000;
const BUMP_COOLDOWN = 24 * 60 * 60 * 1000;
const MESSAGE_COOLDOWN = 60 * 1000;

const MESSAGE_EXP = 1;
const BUMP_EXP = 5;

/* ================= DATABASE ================= */

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      user_id TEXT PRIMARY KEY,
      exp INTEGER DEFAULT 0,
      inv TEXT[] DEFAULT '{}',
      luck REAL DEFAULT 1,
      last_daily BIGINT DEFAULT 0,
      last_work BIGINT DEFAULT 0,
      last_bump BIGINT DEFAULT 0,
      last_message BIGINT DEFAULT 0
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS bot_state (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);

  console.log('Database ready.');
}

/* ================= USER ================= */

async function getUser(id) {
  const res = await pool.query('SELECT * FROM users WHERE user_id=$1', [id]);

  if (res.rows.length) {
    const r = res.rows[0];
    return {
      exp: r.exp,
      inv: r.inv || [],
      luck: r.luck,
      lastDaily: Number(r.last_daily),
      lastWork: Number(r.last_work),
      lastBump: Number(r.last_bump),
      lastMessage: Number(r.last_message)
    };
  }

  await pool.query('INSERT INTO users (user_id) VALUES ($1) ON CONFLICT DO NOTHING', [id]);

  return { exp: 0, inv: [], luck: 1, lastDaily: 0, lastWork: 0, lastBump: 0, lastMessage: 0 };
}

async function saveUser(id, u) {
  await pool.query(`
    INSERT INTO users (user_id, exp, inv, luck, last_daily, last_work, last_bump, last_message)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    ON CONFLICT (user_id) DO UPDATE SET
      exp=$2, inv=$3, luck=$4,
      last_daily=$5, last_work=$6,
      last_bump=$7, last_message=$8
  `, [id, u.exp, u.inv, u.luck, u.lastDaily, u.lastWork, u.lastBump, u.lastMessage]);
}

/* ================= EXP ================= */

async function addMessageExp(id, member) {
  const now = Date.now();
  let exp = MESSAGE_EXP;

  if (member?.roles.cache.has(BOOSTER_ROLE_ID)) exp = 3;

  await pool.query(`
    UPDATE users
    SET exp = exp + $2, last_message = $3
    WHERE user_id=$1 AND ($3 - last_message) >= $4
  `, [id, exp, now, MESSAGE_COOLDOWN]);
}

/* ================= GACHA ================= */

const rewards = [
  { name: '👑 2x Drop Gamepass (SP)', chance: 0.1 },
  { name: '👑 2x Luck Gamepass (SP)', chance: 0.2 },
  { name: '⭐ 25 EXP', chance: 39.7 },
  { name: '⭐ 15 EXP', chance: 30 },
  { name: '🔥 Cosmetic Crate (1x)', chance: 20 },
  { name: '🔥 Aura Crate (1x)', chance: 10 }
];

const rarityColor = {
  '👑 2x Drop Gamepass (SP)': '#ffd700',
  '👑 2x Luck Gamepass (SP)': '#ffd700',
  '⭐ 25 EXP': '#a8e6cf',
  '⭐ 15 EXP': '#00cec9',
  '🔥 Cosmetic Crate (1x)': '#fd79a8',
  '🔥 Aura Crate (1x)': '#e17055'
};

function rollReward(luck = 1) {
  const rand = Math.random() * 100 / luck;
  let total = 0;

  for (const r of rewards) {
    total += r.chance;
    if (rand <= total) return r.name;
  }

  return rewards.at(-1).name;
}

/* ================= UTIL ================= */

function formatCooldown(ms) {
  if (ms < 0) ms = 0;
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${m}m ${s}s`;
}

function expBar(exp, need = 700) {
  const filled = Math.min(Math.floor((exp / need) * 10), 10);
  return '█'.repeat(filled) + '░'.repeat(10 - filled) + ` ${exp}/${need}`;
}

/* ================= BOT ================= */

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

/* ================= PANEL ================= */

function buildGachaPanel() {
  return {
    embeds: [
      new EmbedBuilder()
        .setColor('#ff2e63')
        .setTitle('🎴 ANIME GACHA PANEL')
        .setDescription(
`🎰 DROP RATES

0.1% 👑 2x Drop Gamepass
0.2% 👑 2x Luck Gamepass
39.7% ⭐ 25 EXP
30% ⭐ 15 EXP
20% 🔥 Cosmetic
10% 🔥 Aura

🎁 Cost: 700 EXP`
        )
    ],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('open').setLabel('🎁 SUMMON').setStyle(ButtonStyle.Success)
      )
    ]
  };
}

/* ================= READY ================= */

client.on('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  const ch = await client.channels.fetch(GACHA_CHANNEL_ID);
  if (ch) ch.send(buildGachaPanel());
});

/* ================= MESSAGE ================= */

client.on('messageCreate', async (msg) => {
  if (msg.author.bot) return;

  await addMessageExp(msg.author.id, msg.member);

  if (msg.content === '!profile') {
    const u = await getUser(msg.author.id);

    msg.reply({
      embeds: [
        new EmbedBuilder()
          .setColor('#08d9d6')
          .setDescription(`⭐ EXP\n${expBar(u.exp)}`)
      ]
    });
  }
});

/* ================= BUTTON ================= */

client.on('interactionCreate', async (i) => {
  if (!i.isButton()) return;

  const u = await getUser(i.user.id);

  if (i.customId === 'open') {
    if (u.exp < 700) {
      return i.reply({ content: '❌ Not enough EXP', flags: MessageFlags.Ephemeral });
    }

    u.exp -= 700;
    const reward = rollReward(u.luck);
    u.inv.push(reward);

    await saveUser(i.user.id, u);

    i.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(rarityColor[reward])
          .setDescription(`🎉 You got: **${reward}**`)
      ],
      flags: MessageFlags.Ephemeral
    });
  }
});

/* ================= START ================= */

initDB().then(() => client.login(DISCORD_TOKEN));
