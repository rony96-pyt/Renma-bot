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

// Validate env vars - NEVER hardcode tokens or IDs in code!
const REQUIRED_ENV = ['DISCORD_TOKEN', 'DATABASE_URL', 'GACHA_CHANNEL_ID', 'BOT_CHANNEL_ID'];
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`Missing env var: ${key}`);
    process.exit(1);
  }
}

const GACHA_CHANNEL_ID = process.env.GACHA_CHANNEL_ID;
const BOT_CHANNEL_ID = process.env.BOT_CHANNEL_ID;
const DISBOARD_BOT_ID = '302050872383242240';
const DELETE_AFTER = 10 * 60 * 1000; // 10 minutes
const DAILY_COOLDOWN = 24 * 60 * 60 * 1000;
const WORK_COOLDOWN = 30 * 60 * 1000;
const BUMP_COOLDOWN = 24 * 60 * 60 * 1000;
const MESSAGE_COOLDOWN = 1 * 60 * 1000; // 1 minute
const MESSAGE_EXP = 1; // 1 EXP per message

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

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

async function saveUser(id, user) {
  await pool.query(` INSERT INTO users (user_id, exp, inv, luck, last_daily, last_work, last_bump, last_message) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (user_id) DO UPDATE SET exp=$2, inv=$3, luck=$4, last_daily=$5, last_work=$6, last_bump=$7, last_message=$8 `, [id, user.exp, user.inv, user.luck, user.lastDaily, user.lastWork, user.lastBump, user.lastMessage]);
}

async function addMessageExp(userId, member) {
  const now = Date.now();
  let expAmount = MESSAGE_EXP; // 1 EXP by default
  
  // Check if user is a server booster
  if (member && member.premiumSince) {
    expAmount = 3; // Boosters get 3 EXP
  }
  
  await pool.query('INSERT INTO users (user_id) VALUES ($1) ON CONFLICT DO NOTHING', [userId]);
  await pool.query(` UPDATE users SET exp = exp + $2, last_message = $3 WHERE user_id = $1 AND ($3 - last_message) >= $4 `, [userId, expAmount, now, MESSAGE_COOLDOWN]);
  
  return expAmount;
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
  '👑 2x Drop Gamepass (SP)': '#ffd700',
  '👑 2x Luck Gamepass (SP)': '#ffd700',
  '⭐ 250 EXP': '#a8e6cf',
  '⭐ 500 EXP': '#00cec9',
  '🔥 Cosmetic Crate (1x)': '#fd79a8',
  '🔥 Aura Crate (1x)': '#e17055'
};

const workMessages = [
  'trained at the dojo', 'fought a villain', 'completed a mission',
  'sold rare artifacts', 'guarded the guild hall', 'won a tournament'
];

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

function expBar(exp, needed = 700) {
  const filled = Math.min(Math.floor((exp / needed) * 10), 10);
  return '█'.repeat(filled) + '░'.repeat(10 - filled) + ` ${exp}/${needed}`;
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
    .setAuthor({ name: '⚔️ RENMA Gacha System', iconURL: client.user.displayAvatarURL() })
    .setTitle('🎴 ANIME GACHA PANEL')
    .setDescription(
      '> 💬 EXP earned from chatting unlocks awesome rewards.\n' +
      '> Free for everyone — does not reduce Chat Level!\n\n' +
      '──────────────────────────\n\n' +
      '🎰 DROP RATES\n\n' +
      '0.1% 👑 2x Drop Gamepass (SP)\n' +
      '0.2% 👑 2x Luck Gamepass (SP)\n' +
      '39.7% ⭐ 250 EXP\n' +
      '30% ⭐ 500 EXP\n' +
      '20% 🔥 Cosmetic Crate (1x)\n' +
      '10% 🔥 Aura Crate (1x)\n\n' +
      '──────────────────────────\n\n' +
      '🎁 Cost: 700 EXP\n' +
      `🚀 **Bump** in <#${BOT_CHANNEL_ID}> daily for **+100 EXP**\n\n` +
      '⚡ Choose your action below'
    )
    .setFooter({ text: 'RENMA SYSTEM • Become the strongest', iconURL: client.user.displayAvatarURL() })
    .setTimestamp();

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('open').setLabel('🎁 SUMMON').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('exp').setLabel('⭐ MY EXP').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('inv').setLabel('🎒 INVENTORY').setStyle(ButtonStyle.Secondary)
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('bump_reward')
      .setLabel('🚀 How to get Bump EXP')
      .setStyle(ButtonStyle.Secondary)
  );

  return { embeds: [embed], components: [row1, row2] };
}

async function sendAndDelete(channel, payload) {
  try {
    const msg = await channel.send(payload);
    setTimeout(() => msg.delete().catch(() => {}), DELETE_AFTER);
  } catch (e) {
    console.error('sendAndDelete error:', e.message);
  }
}

async function replyAndDelete(message, payload) {
  try {
    const reply = await message.reply(payload);
    setTimeout(() => reply.delete().catch(() => {}), DELETE_AFTER);
  } catch (e) {
    console.error('replyAndDelete error:', e.message);
  }
}

// Function to post daily leaderboard and delete old ones
async function postDailyLeaderboard() {
  try {
    const channel = await client.channels.fetch(GACHA_CHANNEL_ID).catch(() => null);
    if (!channel) return;

    // Get the current date in YYYY-MM-DD format
    const today = new Date().toISOString().split('T')[0];
    const lastLeaderboardDate = await getState('last_leaderboard_date');
    
    // If we already posted today, don't post again
    if (lastLeaderboardDate === today) return;

    // Get the previous leaderboard message ID and delete it
    const lastLeaderboardId = await getState('daily_leaderboard_id');
    if (lastLeaderboardId) {
      try {
        const oldMsg = await channel.messages.fetch(lastLeaderboardId);
        await oldMsg.delete();
        console.log('Deleted previous daily leaderboard');
      } catch (e) {
        // Message might already be deleted or not found
        console.log('Previous leaderboard not found or already deleted');
      }
    }

    // Create new leaderboard
    const rows = await getAllUsers();
    const top10 = rows.slice(0, 10);
    const medals = ['🥇', '🥈', '🥉', '4', '5', '6', '7', '8', '9', '10'];
    const board = top10.length
      ? top10.map((r, i) => `${medals[i]}  <@${r.user_id}>  —  ⭐ **${r.exp} EXP**`).join('\n')
      : '*No players yet — start chatting!*';

    const embed = new EmbedBuilder()
      .setColor('#f7b731')
      .setAuthor({ name: '🏆 Daily Leaderboard', iconURL: client.user.displayAvatarURL() })
      .setTitle(`Top Players by EXP - ${today}`)
      .setDescription(board + '\n\n──────────────────────────\n*🔥 Chat & grind to climb the ranks!*')
      .setFooter({ text: 'RENMA SYSTEM  •  Ranked by EXP  •  Resets daily', iconURL: client.user.displayAvatarURL() })
      .setTimestamp();

    const msg = await channel.send({ embeds: [embed] });
    
    // Save the new leaderboard info
    await setState('daily_leaderboard_id', msg.id);
    await setState('last_leaderboard_date', today);
    
    console.log(`Posted daily leaderboard for ${today}`);
  } catch (err) {
    console.error('Daily leaderboard error:', err);
  }
}

client.on('error', (err) => console.error('Client error:', err.message));
process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err?.message));

client.on('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  client.user.setPresence({
    activities: [{ name: '🎴 Anime Gacha System', type: 0 }],
    status: 'online'
  });

  try {
    const channel = await client.channels.fetch(GACHA_CHANNEL_ID);
    if (!channel) return;

    const savedPanelId = await getState('gacha_panel_id');
    let panelExists = false;
    if (savedPanelId) {
      try {
        await channel.messages.fetch(savedPanelId);
        panelExists = true;
      } catch {
        panelExists = false;
      }
    }

    if (!panelExists) {
      const msg = await channel.send(buildGachaPanel());
      await setState('gacha_panel_id', msg.id);
      console.log(`Gacha panel posted to #${channel.name}`);
    } else {
      console.log('Gacha panel already exists.');
    }

    // Post daily leaderboard on startup and check every hour
    await postDailyLeaderboard();
    
    // Check for new day every hour (3600000 ms)
    setInterval(postDailyLeaderboard, 3600000);
    
    // Also schedule a check at midnight (using cron-like approach)
    scheduleMidnightLeaderboard();
  } catch (err) {
    console.error('Could not initialize:', err.message);
  }
});

// Function to schedule leaderboard post at midnight
function scheduleMidnightLeaderboard() {
  const now = new Date();
  const midnight = new Date();
  midnight.setHours(24, 0, 0, 0); // Next midnight
  const timeUntilMidnight = midnight - now;
  
  setTimeout(() => {
    postDailyLeaderboard();
    // Then schedule again for next midnight
    setInterval(postDailyLeaderboard, 24 * 60 * 60 * 1000); // Every 24 hours
  }, timeUntilMidnight);
  
  console.log(`Scheduled next leaderboard post in ${Math.floor(timeUntilMidnight / 1000 / 60)} minutes`);
}

function isDisboardBump(message) {
  if (message.author.id !== DISBOARD_BOT_ID) return false;
  const text = (message.content || '') + ' ' +
    message.embeds.map(e => `${e.description || ''} ${e.title || ''}`).join(' ');
  return /bump done/i.test(text);
}

function getBumper(message) {
  return message.interactionMetadata?.user || message.interaction?.user || null;
}

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
      if (!gachaChannel) return;

      if (remaining > 0) {
        const embed = new EmbedBuilder()
          .setColor('#ff7675')
          .setDescription(`⏳ **${discordUser.username}** bumped but already claimed today's reward.\nCome back in **${formatCooldown(remaining)}**!`)
          .setFooter({ text: 'RENMA SYSTEM  •  Deletes in 10 min' });
        return sendAndDelete(gachaChannel, { embeds: [embed] });
      }

      user.exp += 100;
      user.lastBump = now;
      await saveUser(discordUser.id, user);

      const embed = new EmbedBuilder()
        .setColor('#00b894')
        .setAuthor({ name: '🚀 Server Bumped!', iconURL: client.user.displayAvatarURL() })
        .setDescription(
          `<@${discordUser.id}> bumped the server and earned **+100 EXP!** ⭐\n\n` +
          `> 📊 Total EXP: **${user.exp}**\n` +
          `> 🎁 Summon cost: **700 EXP** ${user.exp >= 700 ? '— 🟢 Ready to summon!' : `— need ${700 - user.exp} more`}\n\n` +
          '*🔁 Bump again in 24h for more EXP!*'
        )
        .setFooter({ text: 'RENMA SYSTEM  •  Deletes in 10 min', iconURL: client.user.displayAvatarURL() })
        .setTimestamp();
      return sendAndDelete(gachaChannel, { embeds: [embed] });
    }

    if (message.author.bot) return;

    const id = message.author.id;
    
    // Add EXP for message (with booster check)
    let member = message.member;
    if (!member && message.guild) {
      try {
        member = await message.guild.members.fetch(id);
      } catch (e) {
        console.error('Failed to fetch member:', e.message);
      }
    }
    
    await addMessageExp(id, member).catch(err => console.error('addExp error:', err.message));

    if (message.channel.id !== GACHA_CHANNEL_ID) return;

    const user = await getUser(id);
    const now = Date.now();
    const cmd = message.content.toLowerCase().trim();

    if (cmd === '!help') {
      const embed = new EmbedBuilder()
        .setColor('#6c5ce7')
        .setAuthor({ name: '📖 RENMA Command List', iconURL: client.user.displayAvatarURL() })
        .setTitle('All Available Commands')
        .setDescription(
          '!gacha 🎴 — Open the gacha panel\n' +
          '!profile 👤 — View your stats\n' +
          '!daily 📅 — Claim daily EXP reward\n' +
          '!work 💼 — Work for EXP (30 min cooldown)\n' +
          '!leaderboard 🏆 — Top 10 players\n' +
          '!inventory 🎒 — View your items\n' +
          '!ping 🏓 — Check bot latency\n\n' +
          '──────────────────────────\n' +
          `🚀 Use \/bump\ in <#${BOT_CHANNEL_ID}> daily for **+100 EXP!**`
        )
        .setFooter({ text: 'RENMA SYSTEM', iconURL: client.user.displayAvatarURL() });
      return replyAndDelete(message, { embeds: [embed] });
    }

    if (cmd === '!ping') {
      const embed = new EmbedBuilder()
        .setColor('#00cec9')
        .setDescription(`🏓 **Pong!**  \`${client.ws.ping}ms\``)
        .setFooter({ text: 'RENMA SYSTEM', iconURL: client.user.displayAvatarURL() });
      return replyAndDelete(message, { embeds: [embed] });
    }

    if (cmd === '!gacha') return replyAndDelete(message, buildGachaPanel());

    if (cmd === '!profile') {
      const bumpStatus = (now - user.lastBump) >= BUMP_COOLDOWN ? '🟢 Ready' : `⏳ ${formatCooldown(BUMP_COOLDOWN - (now - user.lastBump))}`;
      const dailyStatus = (now - user.lastDaily) >= DAILY_COOLDOWN ? '🟢 Ready' : `⏳ ${formatCooldown(DAILY_COOLDOWN - (now - user.lastDaily))}`;
      const workStatus = (now - user.lastWork) >= WORK_COOLDOWN ? '🟢 Ready' : `⏳ ${formatCooldown(WORK_COOLDOWN - (now - user.lastWork))}`;
      const embed = new EmbedBuilder()
        .setColor('#08d9d6')
        .setAuthor({ name: `${message.author.username}'s Profile`, iconURL: message.author.displayAvatarURL() })
        .setThumbnail(message.author.displayAvatarURL())
        .setDescription(
          '**⭐ EXP Progress**\n' +
          `${expBar(user.exp)}\n\n` +
          `🍀 **Luck Multiplier:** ${user.luck}x\n` +
          `🎒 **Items Collected:** ${user.inv.length}\n\n` +
          '──────────────────────────\n\n' +
          `📅 **Daily:**  ${dailyStatus}\n` +
          `💼 **Work:**   ${workStatus}\n` +
          `🚀 **Bump:**   ${bumpStatus}\n\n` +
          '*🔥 Grind more. Become legend.*'
        )
        .setFooter({ text: 'RENMA RPG SYSTEM', iconURL: client.user.displayAvatarURL() })
        .setTimestamp();
      return replyAndDelete(message, { embeds: [embed] });
    }

    if (cmd === '!daily') {
      const remaining = DAILY_COOLDOWN - (now - user.lastDaily);
      if (remaining > 0) {
        const embed = new EmbedBuilder()
          .setColor('#ff7675')
          .setDescription(`⏳ **Daily already claimed!**\nCome back in **${formatCooldown(remaining)}**`)
          .setFooter({ text: 'RENMA SYSTEM', iconURL: client.user.displayAvatarURL() });
        return replyAndDelete(message, { embeds: [embed] });
      }
      const expGain = Math.floor(Math.random() * 200) + 100;
      user.exp += expGain;
      user.lastDaily = now;
      await saveUser(id, user);
      const embed = new EmbedBuilder()
        .setColor('#f7b731')
        .setAuthor({ name: '📅 Daily Reward Claimed!', iconURL: client.user.displayAvatarURL() })
        .setDescription(
          `✨ You received **+${expGain} EXP!**\n\n` +
          `**Progress to Summon:**\n${expBar(user.exp)}\n\n` +
          '*🔥 Come back tomorrow for more!*'
        )
        .setFooter({ text: 'RENMA SYSTEM  •  Resets every 24h', iconURL: client.user.displayAvatarURL() });
      return replyAndDelete(message, { embeds: [embed] });
    }

    if (cmd === '!work') {
      const remaining = WORK_COOLDOWN - (now - user.lastWork);
      if (remaining > 0) {
        const embed = new EmbedBuilder()
          .setColor('#ff7675')
          .setDescription(`😓 **You're tired!**\nRest for **${formatCooldown(remaining)}** before working again.`)
          .setFooter({ text: 'RENMA SYSTEM', iconURL: client.user.displayAvatarURL() });
        return replyAndDelete(message, { embeds: [embed] });
      }
      const expGain = Math.floor(Math.random() * 50) + 20;
      user.exp += expGain;
      user.lastWork = now;
      await saveUser(id, user);
      const action = workMessages[Math.floor(Math.random() * workMessages.length)];
      const embed = new EmbedBuilder()
        .setColor('#a29bfe')
        .setAuthor({ name: '💼 Mission Complete!', iconURL: client.user.displayAvatarURL() })
        .setDescription(
          `${message.author.username} **${action}**!\n\n` +
          `✨ Earned **+${expGain} EXP**\n\n` +
          `**Progress to Summon:**\n${expBar(user.exp)}\n\n` +
          '*⏳ Next work available in 30 min*'
        )
        .setFooter({ text: 'RENMA SYSTEM', iconURL: client.user.displayAvatarURL() });
      return replyAndDelete(message, { embeds: [embed] });
    }

    if (cmd === '!leaderboard') {
      const rows = await getAllUsers();
      const top10 = rows.slice(0, 10);
      const medals = ['🥇', '🥈', '🥉', '4', '5', '6', '7', '8', '9', '10'];
      const board = top10.length
        ? top10.map((r, i) => `${medals[i]}  <@${r.user_id}>  —  ⭐ **${r.exp} EXP**`).join('\n')
        : '*No players yet — start chatting!*';
      const embed = new EmbedBuilder()
        .setColor('#f7b731')
        .setAuthor({ name: '🏆 RENMA Leaderboard', iconURL: client.user.displayAvatarURL() })
        .setTitle('Top Players by EXP')
        .setDescription(board + '\n\n──────────────────────────\n*🔥 Chat & grind to climb the ranks!*')
        .setFooter({ text: 'RENMA SYSTEM  •  Ranked by EXP', iconURL: client.user.displayAvatarURL() })
        .setTimestamp();
      return replyAndDelete(message, { embeds: [embed], allowedMentions: { parse: [] } });
    }

    if (cmd === '!inventory') {
      const items = user.inv.length
        ? user.inv.map((item, i) => `${i + 1}. ${item}`).join('\n')
        : '*Your inventory is empty.*';
      const embed = new EmbedBuilder()
        .setColor('#6c5ce7')
        .setAuthor({ name: `${message.author.username}'s Inventory`, iconURL: message.author.displayAvatarURL() })
        .setDescription(items + '\n\n*🎁 Use !gacha to earn more items!*')
        .setFooter({ text: `${user.inv.length} item(s) collected  •  RENMA SYSTEM`, iconURL: client.user.displayAvatarURL() });
      return replyAndDelete(message, { embeds: [embed] });
    }
  } catch (err) {
    console.error('Message handler error:', err);
  }
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isButton()) return;
  try {
    if (interaction.channel.id !== GACHA_CHANNEL_ID) {
      return interaction.reply({ content: '❌ Buttons only work in the gacha channel!', flags: MessageFlags.Ephemeral });
    }

    const id = interaction.user.id;
    const user = await getUser(id);

    if (interaction.customId === 'open') {
      if (user.exp < 700) {
        const embed = new EmbedBuilder()
          .setColor('#ff7675')
          .setDescription(`❌ **Not enough EXP!**\n\nYou have **${user.exp} EXP** — need **${700 - user.exp} more** to summon.\n\n${expBar(user.exp)}`)
          .setFooter({ text: 'Chat to earn EXP  •  RENMA SYSTEM' });
        return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
      }
      user.exp -= 700;
      const reward = rollReward(user.luck);
      user.inv.push(reward);
      await saveUser(id, user);
      const embed = new EmbedBuilder()
        .setColor(rarityColor[reward] || '#00ff88')
        .setAuthor({ name: '🎁 Summon Result', iconURL: client.user.displayAvatarURL() })
        .setTitle('🎉  YOU SUMMONED')
        .setDescription(`✨  **${reward}**\n\n──────────────────────────\n📊 EXP remaining: **${user.exp}**\n🎒 Items owned: **${user.inv.length}**\n\n*🔥 RNG favors the bold...*`)
        .setFooter({ text: 'Keep summoning for legendary drops  •  RENMA SYSTEM' })
        .setTimestamp();
      return interaction.reply({ embeds: [embed] });
    }

    if (interaction.customId === 'exp') {
      const ready = user.exp >= 700;
      const embed = new EmbedBuilder()
        .setColor(ready ? '#00b894' : '#fdcb6e')
        .setAuthor({ name: `${interaction.user.username}'s EXP`, iconURL: interaction.user.displayAvatarURL() })
        .setDescription(`**Progress to Summon:**\n${expBar(user.exp)}\n\n` + (ready ? '🟢 **You have enough EXP to summon!**' : `⛔ Need **${700 - user.exp} more EXP** to summon`))
        .setFooter({ text: 'RENMA SYSTEM  •  Only you can see this' });
      return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    }

    if (interaction.customId === 'inv') {
      const items = user.inv.length ? user.inv.map((item, i) => `${i + 1}. ${item}`).join('\n') : '*Your inventory is empty.*';
      const embed = new EmbedBuilder()
        .setColor('#6c5ce7')
        .setAuthor({ name: `${interaction.user.username}'s Inventory`, iconURL: interaction.user.displayAvatarURL() })
        .setDescription(items)
        .setFooter({ text: `${user.inv.length} item(s)  •  RENMA SYSTEM  •  Only you can see this` });
      return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    }

    if (interaction.customId === 'bump_reward') {
      const now = Date.now();
      const remaining = BUMP_COOLDOWN - (now - user.lastBump);
      const ready = remaining <= 0;
      const embed = new EmbedBuilder()
        .setColor(ready ? '#00b894' : '#fdcb6e')
        .setAuthor({ name: '🚀 Bump Reward', iconURL: client.user.displayAvatarURL() })
        .setDescription(ready
          ? `✅ **Your bump reward is ready!**\n\nGo to <#${BOT_CHANNEL_ID}> and type \/bump\nYou'll earn **+100 EXP** automatically!`
          : `⏳ **Already claimed today!**\n\nCome back in **${formatCooldown(remaining)}**\nThen go to <#${BOT_CHANNEL_ID}> and type \/bump`)
        .setFooter({ text: 'RENMA SYSTEM  •  Only you can see this' });
      return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    }
  } catch (err) {
    console.error('Interaction error:', err.message);
  }
});

initDB().then(() => client.login(process.env.DISCORD_TOKEN));
