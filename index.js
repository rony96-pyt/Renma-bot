const {
  Client,
  GatewayIntentBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  SlashCommandBuilder
} = require('discord.js');
const { Pool } = require('pg');

const REQUIRED_ENV = [
  'DISCORD_TOKEN',
  'DATABASE_URL',
  'GACHA_CHANNEL_ID',
  'BOT_CHANNEL_ID',
  'BOOSTER_ROLE_ID',
  'BOT_OWNER_ID'
];

for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`Missing env var: ${key}`);
    process.exit(1);
  }
}

const GACHA_CHANNEL_ID = process.env.GACHA_CHANNEL_ID;
const BOT_CHANNEL_ID = process.env.BOT_CHANNEL_ID;
const BOOSTER_ROLE_ID = process.env.BOOSTER_ROLE_ID;
const BOT_OWNER_ID = process.env.BOT_OWNER_ID;
const DISBOARD_BOT_ID = '302050872383242240';

const DELETE_AFTER = 10 * 60 * 1000;
const DAILY_COOLDOWN = 2 * 24 * 60 * 60 * 1000;
const BUMP_COOLDOWN = 24 * 60 * 60 * 1000;
const MESSAGE_COOLDOWN = 1 * 60 * 1000;
const MESSAGE_EXP = 1;
const BUMP_EXP = 5;
const SUMMON_COST = 700;

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
        content: `${targetUser.toString()}${payload.content ? `, ${payload.content}` : ''}`,
        allowedMentions: { users: [targetUser.id] }
      });

      setTimeout(() => msg.delete().catch(() => {}), DELETE_AFTER);
    }
  }
}

async function replyEphemeral(interaction, payload) {
  if (interaction.deferred || interaction.replied) {
    await interaction.editReply(payload);
  } else {
    await interaction.reply({
      ...payload,
      ephemeral: true
    });
  }

  setTimeout(() => {
    interaction.deleteReply().catch(() => {});
  }, DELETE_AFTER);
}

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

async function getUser(id) {
  const res = await pool.query('SELECT * FROM users WHERE user_id = $1', [id]);

  if (res.rows.length > 0) {
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

  await pool.query(
    'INSERT INTO users (user_id) VALUES ($1) ON CONFLICT DO NOTHING',
    [id]
  );

  return {
    exp: 0,
    inv: [],
    luck: 1,
    lastDaily: 0,
    lastWork: 0,
    lastBump: 0,
    lastMessage: 0
  };
}

async function saveUser(id, user) {
  await pool.query(
    `
      INSERT INTO users (
        user_id, exp, inv, luck, last_daily, last_work, last_bump, last_message
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT (user_id)
      DO UPDATE SET
        exp = EXCLUDED.exp,
        inv = EXCLUDED.inv,
        luck = EXCLUDED.luck,
        last_daily = EXCLUDED.last_daily,
        last_work = EXCLUDED.last_work,
        last_bump = EXCLUDED.last_bump,
        last_message = EXCLUDED.last_message
    `,
    [
      id,
      user.exp,
      user.inv,
      user.luck,
      user.lastDaily,
      user.lastWork,
      user.lastBump,
      user.lastMessage
    ]
  );
}

async function addMessageExp(userId, member) {
  const now = Date.now();
  let expAmount = MESSAGE_EXP;

  if (member && member.roles.cache.has(BOOSTER_ROLE_ID)) {
    expAmount = 3;
  }

  await pool.query(
    'INSERT INTO users (user_id) VALUES ($1) ON CONFLICT DO NOTHING',
    [userId]
  );

  await pool.query(
    `
      UPDATE users
      SET exp = exp + $2, last_message = $3
      WHERE user_id = $1
      AND ($3 - last_message) >= $4
    `,
    [userId, expAmount, now, MESSAGE_COOLDOWN]
  );
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
  await pool.query(
    `
      INSERT INTO bot_state (key, value)
      VALUES ($1, $2)
      ON CONFLICT (key)
      DO UPDATE SET value = EXCLUDED.value
    `,
    [key, value]
  );
}

const rewards = [
  { name: '👑 2x Drop Gamepass (SP)', chance: 0.1 },
  { name: '👑 2x Luck Gamepass (SP)', chance: 0.2 },
  { name: '⭐ 15 EXP', chance: 39.7 },
  { name: '⭐ 25 EXP', chance: 30 },
  { name: '🔥 Cosmetic Crate (1x)', chance: 20 },
  { name: '🔥 Aura Crate (1x)', chance: 10 }
];

const rarityColor = {
  '👑 2x Drop Gamepass (SP)': '#ffd700',
  '👑 2x Luck Gamepass (SP)': '#ffd700',
  '⭐ 15 EXP': '#a8e6cf',
  '⭐ 25 EXP': '#00cec9',
  '🔥 Cosmetic Crate (1x)': '#fd79a8',
  '🔥 Aura Crate (1x)': '#e17055'
};

function rollReward(luck = 1) {
  const rand = Math.random() * 100 / Math.max(luck, 1);
  let total = 0;

  for (const r of rewards) {
    total += r.chance;
    if (rand <= total) return r.name;
  }

  return rewards[rewards.length - 1].name;
}

function formatCooldown(ms) {
  if (ms < 0) ms = 0;

  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);

  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function expBar(exp, needed = SUMMON_COST) {
  const filled = Math.min(Math.floor((exp / needed) * 10), 10);
  return `${'█'.repeat(filled)}${'░'.repeat(10 - filled)} ${exp}/${needed}`;
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers
  ]
});

function buildGachaPanel() {
  const embed = new EmbedBuilder()
    .setColor('#ff2e63')
    .setAuthor({
      name: '⚔️ RENMA Gacha System',
      iconURL: client.user.displayAvatarURL()
    })
    .setTitle('🎴 ANIME GACHA PANEL')
    .setDescription(
      `> 💬 EXP earned from chatting unlocks awesome rewards.
> Free for everyone - does not reduce Chat Level!

──────────────────────────

🎰 DROP RATES

0.1% 👑 2x Drop Gamepass (SP)
0.2% 👑 2x Luck Gamepass (SP)
39.7% ⭐ 15 EXP
30% ⭐ 25 EXP
20% 🔥 Cosmetic Crate (1x)
10% 🔥 Aura Crate (1x)

──────────────────────────

🎁 Cost: ${SUMMON_COST} EXP
🚀 **Bump** in <#${BOT_CHANNEL_ID}> daily for **+${BUMP_EXP} EXP**

⚡ Choose your action below`
    )
    .setFooter({
      text: 'RENMA SYSTEM • Become the strongest',
      iconURL: client.user.displayAvatarURL()
    })
    .setTimestamp();

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('open')
      .setLabel('🎁 SUMMON')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId('exp')
      .setLabel('⭐ MY EXP')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId('inv')
      .setLabel('🎒 INVENTORY')
      .setStyle(ButtonStyle.Secondary)
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('bump_reward')
      .setLabel('🚀 How to get Bump EXP')
      .setStyle(ButtonStyle.Secondary)
  );

  return { embeds: [embed], components: [row1, row2] };
}

function buildHelpEmbed() {
  return new EmbedBuilder()
    .setColor('#6c5ce7')
    .setAuthor({
      name: '📖 RENMA Command List',
      iconURL: client.user.displayAvatarURL()
    })
    .setDescription(
      `**Slash Commands**
/help — Show this menu
/gacha — View gacha info
/profile — View your stats
/daily — Claim daily EXP
/leaderboard — Top 10 players
/inventory — View your items
/ping — Check latency

**Prefix Commands**
!help
!gacha
!profile
!daily
!leaderboard
!inventory
!ping

──────────────────────────
🚀 Use \`/bump\` in <#${BOT_CHANNEL_ID}> daily for **+${BUMP_EXP} EXP!**`
    )
    .setFooter({
      text: 'RENMA SYSTEM',
      iconURL: client.user.displayAvatarURL()
    });
}

function buildProfileEmbed(discordUser, user) {
  const now = Date.now();

  const bumpStatus =
    now - user.lastBump >= BUMP_COOLDOWN
      ? '🟢 Ready'
      : `⏳ ${formatCooldown(BUMP_COOLDOWN - (now - user.lastBump))}`;

  const dailyStatus =
    now - user.lastDaily >= DAILY_COOLDOWN
      ? '🟢 Ready'
      : `⏳ ${formatCooldown(DAILY_COOLDOWN - (now - user.lastDaily))}`;

  return new EmbedBuilder()
    .setColor('#08d9d6')
    .setAuthor({
      name: `${discordUser.username}'s Profile`,
      iconURL: discordUser.displayAvatarURL()
    })
    .setThumbnail(discordUser.displayAvatarURL())
    .setDescription(
      `**⭐ EXP Progress**
${expBar(user.exp)}

🍀 **Luck:** ${user.luck}x
🎒 **Items:** ${user.inv.length}

──────────────────────────
📅 **Daily:** ${dailyStatus}
🚀 **Bump:** ${bumpStatus}

*🔥 Grind more. Become legend.*`
    )
    .setFooter({
      text: 'RENMA RPG SYSTEM',
      iconURL: client.user.displayAvatarURL()
    })
    .setTimestamp();
}

function buildInventoryEmbed(discordUser, user, privateText = false) {
  const items = user.inv.length
    ? user.inv.map((item, i) => `${i + 1}. ${item}`).join('\n')
    : '*Inventory empty.*';

  return new EmbedBuilder()
    .setColor('#6c5ce7')
    .setAuthor({
      name: `${discordUser.username}'s Inventory`,
      iconURL: discordUser.displayAvatarURL()
    })
    .setDescription(`${items}\n\n*🎁 Use /gacha or !gacha to earn more!*`)
    .setFooter({
      text: `${user.inv.length} items${privateText ? ' • Only you can see this' : ''} • RENMA SYSTEM`
    });
}

async function buildLeaderboardEmbed() {
  const rows = await getAllUsers();
  const top10 = rows.slice(0, 10);
  const medals = ['🥇', '🥈', '🥉', '4', '5', '6', '7', '8', '9', '10'];

  const board = top10.length
    ? top10.map((r, i) => `${medals[i]} <@${r.user_id}> — ⭐ **${r.exp} EXP**`).join('\n')
    : '*No players yet!*';

  return new EmbedBuilder()
    .setColor('#f7b731')
    .setAuthor({
      name: '🏆 Leaderboard',
      iconURL: client.user.displayAvatarURL()
    })
    .setTitle('Top 10 Players')
    .setDescription(`${board}\n\n*🔥 Chat to climb ranks!*`)
    .setFooter({ text: 'RENMA SYSTEM' })
    .setTimestamp();
}

function buildPingEmbed() {
  return new EmbedBuilder()
    .setColor('#00cec9')
    .setDescription(`🏓 **Pong!** \`${client.ws.ping}ms\``)
    .setFooter({
      text: 'RENMA SYSTEM',
      iconURL: client.user.displayAvatarURL()
    });
}

async function claimDailyEmbed(userId) {
  const user = await getUser(userId);
  const now = Date.now();
  const remaining = DAILY_COOLDOWN - (now - user.lastDaily);

  if (remaining > 0) {
    return new EmbedBuilder()
      .setColor('#ff7675')
      .setDescription(`⏳ Daily already claimed! Come back in **${formatCooldown(remaining)}**`)
      .setFooter({ text: 'RENMA SYSTEM' });
  }

  const expGain = Math.floor(Math.random() * 7) + 1;
  user.exp += expGain;
  user.lastDaily = now;
  await saveUser(userId, user);

  return new EmbedBuilder()
    .setColor('#f7b731')
    .setAuthor({
      name: '📅 Daily Reward Claimed!',
      iconURL: client.user.displayAvatarURL()
    })
    .setDescription(
      `✨ You received **+${expGain} EXP!**

**Progress:**
${expBar(user.exp)}

*🔥 Come back in 2 days*`
    )
    .setFooter({ text: 'RENMA SYSTEM • 2 day reset' });
}

function buildSlashCommands() {
  return [
    new SlashCommandBuilder()
      .setName('help')
      .setDescription('Show RENMA command list'),

    new SlashCommandBuilder()
      .setName('gacha')
      .setDescription('View gacha information'),

    new SlashCommandBuilder()
      .setName('profile')
      .setDescription('View your gacha profile'),

    new SlashCommandBuilder()
      .setName('daily')
      .setDescription('Claim your daily EXP'),

    new SlashCommandBuilder()
      .setName('leaderboard')
      .setDescription('View the top 10 players'),

    new SlashCommandBuilder()
      .setName('inventory')
      .setDescription('View your inventory'),

    new SlashCommandBuilder()
      .setName('ping')
      .setDescription('Check bot latency'),

    new SlashCommandBuilder()
      .setName('owner')
      .setDescription('Bot owner commands')
      .addSubcommand((sub) =>
        sub
          .setName('refreshpanel')
          .setDescription('Refresh the gacha panel')
      )
      .addSubcommand((sub) =>
        sub
          .setName('giveexp')
          .setDescription('Give EXP to a user')
          .addUserOption((opt) =>
            opt
              .setName('user')
              .setDescription('Target user')
              .setRequired(true)
          )
          .addIntegerOption((opt) =>
            opt
              .setName('amount')
              .setDescription('EXP amount')
              .setMinValue(1)
              .setRequired(true)
          )
      )
      .addSubcommand((sub) =>
        sub
          .setName('resetdaily')
          .setDescription('Reset daily cooldown for a user')
          .addUserOption((opt) =>
            opt
              .setName('user')
              .setDescription('Target user')
              .setRequired(true)
          )
      )
      .addSubcommand((sub) =>
        sub
          .setName('resetall')
          .setDescription('Reset all users EXP to 0')
      )
      .addSubcommand((sub) =>
        sub
          .setName('resetexp')
          .setDescription('Reset all users EXP to 0')
      )
      .addSubcommand((sub) =>
        sub
          .setName('stats')
          .setDescription('View bot global stats')
      )
  ].map((cmd) => cmd.toJSON());
}

async function refreshGachaPanel() {
  const channel = await client.channels.fetch(GACHA_CHANNEL_ID).catch(() => null);

  if (!channel || !channel.isTextBased()) {
    throw new Error('Gacha channel not found.');
  }

  const oldPanelId = await getState('gacha_panel_id');

  if (oldPanelId) {
    const oldMsg = await channel.messages.fetch(oldPanelId).catch(() => null);
    if (oldMsg) {
      await oldMsg.delete().catch(() => {});
    }
  }

  const msg = await channel.send(buildGachaPanel());
  await setState('gacha_panel_id', msg.id);

  return msg;
}

async function buildOwnerStatsEmbed() {
  const usersRes = await pool.query(
    'SELECT COUNT(*) AS total_users, SUM(exp) AS total_exp FROM users'
  );

  const itemsRes = await pool.query(
    'SELECT COUNT(*) AS total_items FROM users, unnest(inv) AS item'
  );

  let boosterCount = 0;

  try {
    const gachaChannel = await client.channels.fetch(GACHA_CHANNEL_ID).catch(() => null);

    if (gachaChannel?.guild) {
      const boosterRole = gachaChannel.guild.roles.cache.get(BOOSTER_ROLE_ID);
      if (boosterRole) boosterCount = boosterRole.members.size;
    }
  } catch {}

  return new EmbedBuilder()
    .setColor('#6c5ce7')
    .setAuthor({
      name: '📊 Bot Global Stats',
      iconURL: client.user.displayAvatarURL()
    })
    .setDescription(
      `👥 Total Users: **${usersRes.rows[0].total_users || 0}**
⭐ Total EXP: **${usersRes.rows[0].total_exp || 0}**
🎒 Total Items: **${itemsRes.rows[0].total_items || 0}**
🚀 Active Boosters: **${boosterCount}**`
    )
    .setFooter({ text: 'RENMA SYSTEM • Owner Only' });
}

async function handleOwnerPrefix(message, sendCommandReply) {
  const id = message.author.id;

  if (id !== BOT_OWNER_ID) {
    return sendCommandReply(
      new EmbedBuilder()
        .setColor('#ff7675')
        .setDescription('❌ Only the bot owner can use this command.')
    );
  }

  const args = message.content.trim().split(/\s+/).slice(1);
  const ownerCmd = (args.shift() || '').toLowerCase();

  if (ownerCmd === 'refreshpanel') {
    try {
      await refreshGachaPanel();

      return sendCommandReply(
        new EmbedBuilder()
          .setColor('#00b894')
          .setDescription('✅ Gacha panel refreshed successfully!')
      );
    } catch (err) {
      return sendCommandReply(
        new EmbedBuilder()
          .setColor('#ff7675')
          .setDescription(`❌ Error: ${err.message}`)
      );
    }
  }

  if (ownerCmd === 'giveexp') 
