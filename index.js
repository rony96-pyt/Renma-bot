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

const REQUIRED_ENV = ['DISCORD_TOKEN', 'DATABASE_URL', 'GACHA_CHANNEL_ID', 'BOT_CHANNEL_ID', 'BOOSTER_ROLE_ID', 'BOT_OWNER_ID'];
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`❌ Missing env var: ${key}`);
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
  await pool.query(`CREATE TABLE IF NOT EXISTS users (
    user_id TEXT PRIMARY KEY,
    exp INTEGER DEFAULT 0,
    inv TEXT[] DEFAULT '{}',
    luck REAL DEFAULT 1,
    last_daily BIGINT DEFAULT 0,
    last_work BIGINT DEFAULT 0,
    last_bump BIGINT DEFAULT 0,
    last_message BIGINT DEFAULT 0
  );`);
  await pool.query(`CREATE TABLE IF NOT EXISTS bot_state (
    key TEXT PRIMARY KEY,
    value TEXT
  );`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_users_exp ON users(exp DESC);`);
  console.log('✅ Database ready.');
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
  await pool.query(`INSERT INTO users (user_id, exp, inv, luck, last_daily, last_work, last_bump, last_message)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    ON CONFLICT (user_id) DO UPDATE SET
    exp=$2, inv=$3, luck=$4, last_daily=$5, last_work=$6, last_bump=$7, last_message=$8`,
    [id, user.exp, user.inv, user.luck, user.lastDaily, user.lastWork, user.lastBump, user.lastMessage]);
}

async function addMessageExp(userId, member) {
  const now = Date.now();
  let expAmount = MESSAGE_EXP;
  if (member && member.roles.cache.has(BOOSTER_ROLE_ID)) expAmount = 3;
  await pool.query('INSERT INTO users (user_id) VALUES ($1) ON CONFLICT DO NOTHING', [userId]);
  await pool.query(`UPDATE users SET exp = exp + $2, last_message = $3 WHERE user_id = $1 AND ($3 - last_message) >= $4`,
    [userId, expAmount, now, MESSAGE_COOLDOWN]);
}

async function getTopUsers(limit = 10) {
  const res = await pool.query('SELECT user_id, exp FROM users ORDER BY exp DESC LIMIT $1', [limit]);
  return res.rows;
}

async function getState(key) {
  const res = await pool.query('SELECT value FROM bot_state WHERE key = $1', [key]);
  return res.rows[0]?.value ?? null;
}

async function setState(key, value) {
  await pool.query(`INSERT INTO bot_state (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2`, [key, value]);
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

client.on('clientReady', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
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
      console.log(`✅ Gacha panel posted to #${channel.name}`);
    } else { console.log('✅ Gacha panel already exists'); }
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
        const userObj = await client.users.fetch(discordUser.id).catch(() => null);
        if (userObj) await sendPrivateMessage(userObj, { embeds: [embed] }, gachaChannel);
        return;
      }
      user.exp += BUMP_EXP;
      user.lastBump = now;
      await saveUser(discordUser.id, user);
      const embed = new EmbedBuilder()
        .setColor('#00b894')
        .setAuthor({ name: '🚀 Server Bumped!', iconURL: client.user.displayAvatarURL() })
        .setDescription(`You bumped the server and earned **+${BUMP_EXP} EXP!** ⭐\n\n> 📊 Total EXP: **${user.exp}**\n> 🎁 Summon cost: **700 EXP** ${user.exp >= 700 ? '— 🟢 Ready to summon!' : `— need ${700 - user.exp} more`}\n\n*🔁 Bump again in 24h*`)
        .setFooter({ text: 'RENMA SYSTEM  •  Private Reward', iconURL: client.user.displayAvatarURL() })
        .setTimestamp();
      const userObj = await client.users.fetch(discordUser.id).catch(() => null);
      if (userObj) await sendPrivateMessage(userObj, { embeds: [embed] }, gachaChannel);
      return;
    }
    if (message.author.bot) return;
    const id = message.author.id;
    let member = message.member;
    if (!member && message.guild) { try { member = await message.guild.members.fetch(id); } catch (e) {} }
    await addMessageExp(id, member).catch(err => console.error('addExp error:', err.message));
    if (message.channel.id !== GACHA_CHANNEL_ID) return;
    const user = await getUser(id);
    const now = Date.now();
    const cmd = message.content.toLowerCase().trim();
    const sendCommandReply = async (embed) => { await sendPrivateMessage(message.author, { embeds: [embed] }, message.channel); };

    if (cmd.startsWith('!owner')) {
      if (id !== BOT_OWNER_ID) {
        return sendCommandReply(new EmbedBuilder().setColor('#ff7675').setDescription('❌ Only the bot owner can use this command.'));
      }
      const args = message.content.slice(7).trim().split(/ +/);
      const ownerCmd = args.shift().toLowerCase();

      if (ownerCmd === 'refreshpanel') {
        try {
          const channel = await client.channels.fetch(GACHA_CHANNEL_ID);
          if (!channel) return sendCommandReply(new EmbedBuilder().setColor('#ff7675').setDescription('❌ Gacha channel not found.'));
          const oldPanelId = await getState('gacha_panel_id');
          if (oldPanelId) { try { await channel.messages.delete(oldPanelId); } catch { /* ignore */ } }
          const msg = await channel.send(buildGachaPanel());
          await setState('gacha_panel_id', msg.id);
          return sendCommandReply(new EmbedBuilder().setColor('#00b894').setDescription('✅ Gacha panel refreshed successfully!'));
        } catch (err) {
          return sendCommandReply(new EmbedBuilder().setColor('#ff7675').setDescription(`❌ Error: ${err.message}`));
        }
      }
      else if (ownerCmd === 'giveexp') {
        const targetUser = message.mentions.users.first();
        const amount = parseInt(args[0]);
        if (!targetUser || isNaN(amount) || amount <= 0) {
          return sendCommandReply(new EmbedBuilder().setColor('#ff7675').setDescription('❌ Usage: `!owner giveexp @user <positive amount>`'));
        }
        try {
          const targetData = await getUser(targetUser.id);
          targetData.exp += amount;
          await saveUser(targetUser.id, targetData);
          return sendCommandReply(new EmbedBuilder().setColor('#00b894').setDescription(`✅ Gave **${amount} EXP** to <@${targetUser.id}>. New total: **${targetData.exp}**`));
        } catch (err) {
          return sendCommandReply(new EmbedBuilder().setColor('#ff7675').setDescription(`❌ Error: ${err.message}`));
        }
      }
      else if (ownerCmd === 'resetdaily') {
        const targetUser = message.mentions.users.first();
        if (!targetUser) {
          return sendCommandReply(new EmbedBuilder().setColor('#ff7675').setDescription('❌ Usage: `!owner resetdaily @user`'));
        }
        try {
          const targetData = await getUser(targetUser.id);
          targetData.lastDaily = 0;
          await saveUser(targetUser.id, targetData);
          return sendCommandReply(new EmbedBuilder().setColor('#00b894').setDescription(`✅ Reset daily cooldown for <@${targetUser.id}>. They can claim !daily immediately.`));
        } catch (err) {
          return sendCommandReply(new EmbedBuilder().setColor('#ff7675').setDescription(`❌ Error: ${err.message}`));
        }
      }
      else if (ownerCmd === 'resetall') {
        try {
          await pool.query('UPDATE users SET exp = 0');
          return sendCommandReply(new EmbedBuilder().setColor('#00b894').setDescription('✅ All users\' EXP has been reset to 0. Inventory, luck, and cooldowns remain unchanged.'));
        } catch (err) {
          return sendCommandReply(new EmbedBuilder().setColor('#ff7675').setDescription(`❌ Error: ${err.message}`));
        }
      }
      else if (ownerCmd === 'stats') {
        try {
          const usersRes = await pool.query('SELECT COUNT(*) AS total_users, SUM(exp) AS total_exp FROM users');
          const itemsRes = await pool.query("SELECT COUNT(*) AS total_items FROM users, unnest(inv) AS item");
          let boosterCount = 0;
          try {
            const gachaChannel = await client.channels.fetch(GACHA_CHANNEL_ID);
            if (gachaChannel.guild) {
              const boosterRole = gachaChannel.guild.roles.cache.get(BOOSTER_ROLE_ID);
              if (boosterRole) boosterCount = boosterRole.members.size;
            }
          } catch { /* ignore */ }
          const embed = new EmbedBuilder()
            .setColor('#6c5ce7')
            .setAuthor({ name: '📊 Bot Global Stats', iconURL: client.user.displayAvatarURL() })
            .setDescription(
              `👥 Total Users: **${usersRes.rows[0].total_users || 0}**\n` +
              `⭐ Total EXP: **${usersRes.rows[0].total_exp || 0}**\n` +
              `🎒 Total Items: **${itemsRes.rows[0].total_items || 0}**\n` +
              `🚀 Active Boosters: **${boosterCount}**`
            )
            .setFooter({ text: 'RENMA SYSTEM  •  Owner Only' });
          return sendCommandReply(embed);
        } catch (err) {
          return sendCommandReply(new EmbedBuilder().setColor('#ff7675').setDescription(`❌ Error: ${err.message}`));
        }
      }
      else {
        return sendCommandReply(new EmbedBuilder().setColor('#ff7675').setDescription('❌ Unknown owner command. Available: refreshpanel, giveexp, resetdaily, resetall, stats'));
      }
      return;
    }

    if (cmd === '!help') {
      const embed = new EmbedBuilder().setColor('#6c5ce7').setAuthor({ name: '📖 RENMA Command List', iconURL: client.user.displayAvatarURL() })
        .setDescription(`!gacha 🎴 — Open gacha panel\n!profile 👤 — View stats\n!daily 📅 — Claim daily EXP (2 day cooldown)\n!leaderboard 🏆 — Top 10 players\n!inventory 🎒 — View items\n!ping 🏓 — Check latency\n\n──────────────────────────\n🚀 Use \`/bump\` in <#${BOT_CHANNEL_ID}> daily for **+${BUMP_EXP} EXP!**`)
        .setFooter({ text: 'RENMA SYSTEM', iconURL: client.user.displayAvatarURL() });
      return sendCommandReply(embed);
    }
    if (cmd === '!ping') { const embed = new EmbedBuilder().setColor('#00cec9').setDescription(`🏓 **Pong!** \`${client.ws.ping}ms\``).setFooter({ text: 'RENMA SYSTEM', iconURL: client.user.displayAvatarURL() }); return sendCommandReply(embed); }
    if (cmd === '!gacha') return sendCommandReply(buildGachaPanel());
    if (cmd === '!profile') {
      const bumpStatus = (now - user.lastBump) >= BUMP_COOLDOWN ? '🟢 Ready' : `⏳ ${formatCooldown(BUMP_COOLDOWN - (now - user.lastBump))}`;
      const dailyStatus = (now - user.lastDaily) >= DAILY_COOLDOWN ? '🟢 Ready' : `⏳ ${formatCooldown(DAILY_COOLDOWN - (now - user.lastDaily))}`;
      const embed = new EmbedBuilder().setColor('#08d9d6').setAuthor({ name: `${message.author.username}'s Profile`, iconURL: message.author.displayAvatarURL() }).setThumbnail(message.author.displayAvatarURL())
        .setDescription(`**⭐ EXP Progress**\n${expBar(user.exp)}\n\n🍀 **Luck:** ${user.luck}x\n🎒 **Items:** ${user.inv.length}\n\n──────────────────────────\n📅 **Daily:** ${dailyStatus}\n🚀 **Bump:** ${bumpStatus}\n\n*🔥 Grind more. Become legend.*`)
        .setFooter({ text: 'RENMA RPG SYSTEM', iconURL: client.user.displayAvatarURL() }).setTimestamp();
      return sendCommandReply(embed);
    }
    if (cmd === '!daily') {
      const remaining = DAILY_COOLDOWN - (now - user.lastDaily);
      if (remaining > 0) {
        const embed = new EmbedBuilder().setColor('#ff7675').setDescription(`⏳ Daily already claimed! Come back in **${formatCooldown(remaining)}**`).setFooter({ text: 'RENMA SYSTEM' });
        return sendCommandReply(embed);
      }
      const expGain = Math.floor(Math.random() * 7) + 1;
      user.exp += expGain; user.lastDaily = now; await saveUser(id, user);
      const embed = new EmbedBuilder().setColor('#f7b731').setAuthor({ name: '📅 Daily Reward Claimed!', iconURL: client.user.displayAvatarURL() }).setDescription(`✨ You received **+${expGain} EXP!**\n\n**Progress:**\n${expBar(user.exp)}\n\n*🔥 Come back in 2 days*`).setFooter({ text: 'RENMA SYSTEM  •  2 day reset' });
      return sendCommandReply(embed);
    }
    if (cmd === '!leaderboard') {
      const top10 = await getTopUsers(10);
      const medals = ['🥇', '🥈', '🥉', '4', '5', '6', '7', '8', '9', '10'];
      const board = top10.length ? top10.map((r, i) => `${medals[i]} <@${r.user_id}> — ⭐ **${r.exp} EXP**`).join('\n') : '*No players yet!*';
      const embed = new EmbedBuilder().setColor('#f7b731').setAuthor({ name: '🏆 Leaderboard', iconURL: client.user.displayAvatarURL() }).setTitle('Top 10 Players').setDescription(board + '\n\n*🔥 Chat to climb ranks!*').setFooter({ text: 'RENMA SYSTEM' }).setTimestamp();
      return sendCommandReply(embed);
    }
    if (cmd === '!inventory') {
      const items = user.inv.length ? user.inv.map((item, i) => `${i + 1}. ${item}`).join('\n') : '*Inventory empty.*';
      const embed = new EmbedBuilder().setColor('#6c5ce7').setAuthor({ name: `${message.author.username}'s Inventory`, iconURL: message.author.displayAvatarURL() }).setDescription(items + '\n\n*🎁 Use !gacha to earn more!*').setFooter({ text: `${user.inv.length} items  •  RENMA SYSTEM` });
      return sendCommandReply(embed);
    }
  } catch (err) { console.error('Message handler error:', err); }
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isButton()) return;
  try {
    if (interaction.channel.id !== GACHA_CHANNEL_ID) {
      await interaction.reply({ content: '❌ Buttons only work in the gacha channel!', flags: MessageFlags.Ephemeral });
      return;
    }
    const id = interaction.user.id;
    const user = await getUser(id);
    const handleEphemeral = async (payload) => {
      await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
    };
    if (interaction.customId === 'open') {
      if (user.exp < 700) {
        return handleEphemeral({ embeds: [new EmbedBuilder().setColor('#ff7675').setDescription(`❌ Need **${700 - user.exp} more EXP** to summon.\n\n${expBar(user.exp)}`).setFooter({ text: 'Chat to earn EXP' })] });
      }
      user.exp -= 700;
      const reward = rollReward(user.luck);
      user.inv.push(reward);
      await saveUser(id, user);
      return handleEphemeral({ embeds: [new EmbedBuilder().setColor(rarityColor[reward] || '#00ff88').setAuthor({ name: '🎁 Summon Result', iconURL: client.user.displayAvatarURL() }).setTitle('🎉 YOU SUMMONED').setDescription(`✨ **${reward}**\n\n──────────────────────────\n📊 EXP left: **${user.exp}**\n🎒 Items: **${user.inv.length}**\n\n*🔥 RNG favors the bold*`).setFooter({ text: 'RENMA SYSTEM' }).setTimestamp()] });
    }
    if (interaction.customId === 'exp') {
      const ready = user.exp >= 700;
      return handleEphemeral({ embeds: [new EmbedBuilder().setColor(ready ? '#00b894' : '#fdcb6e').setAuthor({ name: `${interaction.user.username}'s EXP`, iconURL: interaction.user.displayAvatarURL() }).setDescription(`**Progress:**\n${expBar(user.exp)}\n\n` + (ready ? '🟢 Ready to summon!' : `⛔ Need **${700 - user.exp} more EXP**`)).setFooter({ text: 'Only you can see this' })] });
    }
    if (interaction.customId === 'inv') {
      const items = user.inv.length ? user.inv.map((item, i) => `${i + 1}. ${item}`).join('\n') : '*Inventory empty.*';
      return handleEphemeral({ embeds: [new EmbedBuilder().setColor('#6c5ce7').setAuthor({ name: `${interaction.user.username}'s Inventory`, iconURL: interaction.user.displayAvatarURL() }).setDescription(items).setFooter({ text: `${user.inv.length} items  •  Only you can see this` })] });
    }
    if (interaction.customId === 'bump_reward') {
      const now = Date.now();
      const remaining = BUMP_COOLDOWN - (now - user.lastBump);
      const ready = remaining <= 0;
      return handleEphemeral({ embeds: [new EmbedBuilder().setColor(ready ? '#00b894' : '#fdcb6e').setAuthor({ name: '🚀 Bump Reward', iconURL: client.user.displayAvatarURL() }).setDescription(ready ? `✅ Reward ready! Go to <#${BOT_CHANNEL_ID}> and type /bump for **+${BUMP_EXP} EXP**!` : `⏳ Claimed today. Come back in **${formatCooldown(remaining)}**`).setFooter({ text: 'Only you can see this' })] });
    }
  } catch (err) { console.error('Interaction error:', err.message); }
});

initDB().then(() => client.login(process.env.DISCORD_TOKEN));
