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

client.on('error', (err) => console.error('Client error:', err.message));
process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err));

client.on('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);

  client.user.setPresence({
    activities: [{ name: '🎴 Anime Gacha System', type: 0 }],
    status: 'online'
  });

  try {
    const channel = await client.channels.fetch(GACHA_CHANNEL_ID).catch(() => null);
    if (!channel || !channel.isTextBased()) return;

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
      console.log('Gacha panel already exists - never deleted');
    }
  } catch (err) {
    console.error('Could not post gacha panel:', err.message);
  }
});

function isDisboardBump(message) {
  if (message.author.id !== DISBOARD_BOT_ID) return false;

  const text =
    (message.content || '') +
    ' ' +
    message.embeds.map((e) => `${e.description || ''} ${e.title || ''}`).join(' ');

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

      if (remaining > 0) {
        const embed = new EmbedBuilder()
          .setColor('#ff7675')
          .setDescription(`⏳ Already claimed bump reward today. Come back in **${formatCooldown(remaining)}**!`)
          .setFooter({ text: 'RENMA SYSTEM' });

        const userObj = await client.users.fetch(discordUser.id).catch(() => null);
        if (userObj) {
          await sendPrivateMessage(userObj, { embeds: [embed] }, gachaChannel);
        }
        return;
      }

      user.exp += BUMP_EXP;
      user.lastBump = now;
      await saveUser(discordUser.id, user);

      const summonStatus =
        user.exp >= SUMMON_COST
          ? '- 🟢 Ready to summon!'
          : `- need ${SUMMON_COST - user.exp} more`;

      const embed = new EmbedBuilder()
        .setColor('#00b894')
        .setAuthor({
          name: '🚀 Server Bumped!',
          iconURL: client.user.displayAvatarURL()
        })
        .setDescription(
          `You bumped the server and earned **+${BUMP_EXP} EXP!** ⭐

> 📊 Total EXP: **${user.exp}**
> 🎁 Summon cost: **${SUMMON_COST} EXP** ${summonStatus}

*🔁 Bump again in 24h*`
        )
        .setFooter({
          text: 'RENMA SYSTEM • Private Reward',
          iconURL: client.user.displayAvatarURL()
        })
        .setTimestamp();

        const userObj = await client.users.fetch(discordUser.id).catch(() => null);
        if (userObj) {
          await sendPrivateMessage(userObj, { embeds: [embed] }, gachaChannel);
        }

      return;
    }

    if (message.author.bot) return;

    const id = message.author.id;
    let member = message.member;

    if (!member && message.guild) {
      try {
        member = await message.guild.members.fetch(id);
      } catch {}
    }

    await addMessageExp(id, member).catch((err) =>
      console.error('addExp error:', err.message)
    );

    const cmd = message.content.toLowerCase().trim();

    const sendCommandReply = async (payload) => {
      if (payload instanceof EmbedBuilder) {
        return sendPrivateMessage(message.author, { embeds: [payload] }, message.channel);
      }
      return sendPrivateMessage(message.author, payload, message.channel);
    };

    if (cmd.startsWith('!owner')) {
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
          const channel = await client.channels.fetch(GACHA_CHANNEL_ID).catch(() => null);

          if (!channel || !channel.isTextBased()) {
            return sendCommandReply(
              new EmbedBuilder()
                .setColor('#ff7675')
                .setDescription('❌ Gacha channel not found.')
            );
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

      else if (ownerCmd === 'giveexp') {
        const targetUser = message.mentions.users.first();
        const amount = parseInt(args[1], 10);

        if (!targetUser || isNaN(amount) || amount <= 0) {
          return sendCommandReply(
            new EmbedBuilder()
              .setColor('#ff7675')
              .setDescription('❌ Usage: `!owner giveexp @user <positive amount>`')
          );
        }

        try {
          const targetData = await getUser(targetUser.id);
          targetData.exp += amount;
          await saveUser(targetUser.id, targetData);

          return sendCommandReply(
            new EmbedBuilder()
              .setColor('#00b894')
              .setDescription(`✅ Gave **${amount} EXP** to <@${targetUser.id}>. New total: **${targetData.exp}**`)
          );
        } catch (err) {
          return sendCommandReply(
            new EmbedBuilder()
              .setColor('#ff7675')
              .setDescription(`❌ Error: ${err.message}`)
          );
        }
      }

      else if (ownerCmd === 'resetdaily') {
        const targetUser = message.mentions.users.first();

        if (!targetUser) {
          return sendCommandReply(
            new EmbedBuilder()
              .setColor('#ff7675')
              .setDescription('❌ Usage: `!owner resetdaily @user`')
          );
        }

        try {
          const targetData = await getUser(targetUser.id);
          targetData.lastDaily = 0;
          await saveUser(targetUser.id, targetData);

          return sendCommandReply(
            new EmbedBuilder()
              .setColor('#00b894')
              .setDescription(`✅ Reset daily cooldown for <@${targetUser.id}>. They can claim !daily immediately.`)
          );
        } catch (err) {
          return sendCommandReply(
            new EmbedBuilder()
              .setColor('#ff7675')
              .setDescription(`❌ Error: ${err.message}`)
          );
        }
      }

      else if (ownerCmd === 'resetall' || ownerCmd === 'resetexp') {
        try {
          await pool.query('UPDATE users SET exp = 0');

          return sendCommandReply(
            new EmbedBuilder()
              .setColor('#00b894')
              .setDescription("✅ All users' EXP has been reset to 0. Inventory, luck, and cooldowns remain unchanged.")
          );
        } catch (err) {
          return sendCommandReply(
            new EmbedBuilder()
              .setColor('#ff7675')
              .setDescription(`❌ Error: ${err.message}`)
          );
        }
      }

      else if (ownerCmd === 'stats') {
        try {
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

          const embed = new EmbedBuilder()
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

          return sendCommandReply(embed);
        } catch (err) {
          return sendCommandReply(
            new EmbedBuilder()
              .setColor('#ff7675')
              .setDescription(`❌ Error: ${err.message}`)
          );
        }
      }

      else {
        return sendCommandReply(
          new EmbedBuilder()
            .setColor('#ff7675')
            .setDescription('❌ Unknown owner command. Available: refreshpanel, giveexp, resetdaily, resetall/resetexp, stats')
        );
      }
    }

    if (message.channel.id !== GACHA_CHANNEL_ID) return;

    const user = await getUser(id);
    const now = Date.now();

    if (cmd === '!help') {
      const embed = new EmbedBuilder()
        .setColor('#6c5ce7')
        .setAuthor({
          name: '📖 RENMA Command List',
          iconURL: client.user.displayAvatarURL()
        })
        .setDescription(
          `!gacha 🎴 — View gacha info
!profile 👤 — View stats
!daily 📅 — Claim daily EXP (2 day cooldown)
!leaderboard 🏆 — Top 10 players
!inventory 🎒 — View items
!ping 🏓 — Check latency

──────────────────────────
🚀 Use \`/bump\` in <#${BOT_CHANNEL_ID}> daily for **+${BUMP_EXP} EXP!**`
        )
        .setFooter({
          text: 'RENMA SYSTEM',
          iconURL: client.user.displayAvatarURL()
        });

      return sendCommandReply(embed);
    }

    if (cmd === '!ping') {
      const embed = new EmbedBuilder()
        .setColor('#00cec9')
        .setDescription(`🏓 **Pong!** \`${client.ws.ping}ms\``)
        .setFooter({
          text: 'RENMA SYSTEM',
          iconURL: client.user.displayAvatarURL()
        });

      return sendCommandReply(embed);
    }

    if (cmd === '!gacha') {
      const panel = buildGachaPanel();
      return sendCommandReply({ embeds: panel.embeds });
    }

    if (cmd === '!profile') {
      const bumpStatus =
        now - user.lastBump >= BUMP_COOLDOWN
          ? '🟢 Ready'
          : `⏳ ${formatCooldown(BUMP_COOLDOWN - (now - user.lastBump))}`;

      const dailyStatus =
        now - user.lastDaily >= DAILY_COOLDOWN
          ? '🟢 Ready'
          : `⏳ ${formatCooldown(DAILY_COOLDOWN - (now - user.lastDaily))}`;

      const embed = new EmbedBuilder()
        .setColor('#08d9d6')
        .setAuthor({
          name: `${message.author.username}'s Profile`,
          iconURL: message.author.displayAvatarURL()
        })
        .setThumbnail(message.author.displayAvatarURL())
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

      return sendCommandReply(embed);
    }

    if (cmd === '!daily') {
      const remaining = DAILY_COOLDOWN - (now - user.lastDaily);

      if (remaining > 0) {
        const embed = new EmbedBuilder()
          .setColor('#ff7675')
          .setDescription(`⏳ Daily already claimed! Come back in **${formatCooldown(remaining)}**`)
          .setFooter({ text: 'RENMA SYSTEM' });

        return sendCommandReply(embed);
      }

      const expGain = Math.floor(Math.random() * 7) + 1;
      user.exp += expGain;
      user.lastDaily = now;
      await saveUser(id, user);

      const embed = new EmbedBuilder()
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

      return sendCommandReply(embed);
    }

    if (cmd === '!leaderboard') {
      const rows = await getAllUsers();
      const top10 = rows.slice(0, 10);
      const medals = ['🥇', '🥈', '🥉', '4', '5', '6', '7', '8', '9', '10'];

      const board = top10.length
        ? top10.map((r, i) => `${medals[i]} <@${r.user_id}> — ⭐ **${r.exp} EXP**`).join('\n')
        : '*No players yet!*';

      const embed = new EmbedBuilder()
        .setColor('#f7b731')
        .setAuthor({
          name: '🏆 Leaderboard',
          iconURL: client.user.displayAvatarURL()
        })
        .setTitle('Top 10 Players')
        .setDescription(`${board}\n\n*🔥 Chat to climb ranks!*`)
        .setFooter({ text: 'RENMA SYSTEM' })
        .setTimestamp();

      return sendCommandReply(embed);
    }

    if (cmd === '!inventory') {
      const items = user.inv.length
        ? user.inv.map((item, i) => `${i + 1}. ${item}`).join('\n')
        : '*Inventory empty.*';

      const embed = new EmbedBuilder()
        .setColor('#6c5ce7')
        .setAuthor({
          name: `${message.author.username}'s Inventory`,
          iconURL: message.author.displayAvatarURL()
        })
        .setDescription(`${items}\n\n*🎁 Use !gacha to earn more!*`)
        .setFooter({ text: `${user.inv.length} items • RENMA SYSTEM` });

      return sendCommandReply(embed);
    }
  } catch (err) {
    console.error('Message handler error:', err);
  }
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isButton()) return;

  try {
    if (!interaction.channel || interaction.channel.id !== GACHA_CHANNEL_ID) {
      await interaction.reply({
        content: '❌ Buttons only work in the gacha channel!',
        flags: MessageFlags.Ephemeral
      });

      setTimeout(() => interaction.deleteReply().catch(() => {}), DELETE_AFTER);
      return;
    }

    const id = interaction.user.id;
    const user = await getUser(id);

    const handleEphemeral = async (payload) => {
      await interaction.reply({
        ...payload,
        flags: MessageFlags.Ephemeral
      });

      setTimeout(() => interaction.deleteReply().catch(() => {}), DELETE_AFTER);
    };

    if (interaction.customId === 'open') {
      if (user.exp < SUMMON_COST) {
        return handleEphemeral({
          embeds: [
            new EmbedBuilder()
              .setColor('#ff7675')
              .setDescription(`❌ Need **${SUMMON_COST - user.exp} more EXP** to summon.\n\n${expBar(user.exp)}`)
              .setFooter({ text: 'Chat to earn EXP' })
          ]
        });
      }

      user.exp -= SUMMON_COST;
      const reward = rollReward(user.luck);

      let rewardText = reward;

      if (reward === '⭐ 15 EXP') {
        user.exp += 15;
        rewardText = '⭐ **15 EXP** added instantly!';
      } else if (reward === '⭐ 25 EXP') {
        user.exp += 25;
        rewardText = '⭐ **25 EXP** added instantly!';
      } else {
        user.inv.push(reward);
      }

      await saveUser(id, user);

      return handleEphemeral({
        embeds: [
          new EmbedBuilder()
            .setColor(rarityColor[reward] || '#00ff88')
            .setAuthor({
              name: '🎁 Summon Result',
              iconURL: client.user.displayAvatarURL()
            })
            .setTitle('🎉 YOU SUMMONED')
            .setDescription(
              `✨ ${rewardText}

──────────────────────────
📊 EXP left: **${user.exp}**
🎒 Items: **${user.inv.length}**

*🔥 RNG favors the bold*`
            )
            .setFooter({ text: 'RENMA SYSTEM' })
            .setTimestamp()
        ]
      });
    }

    if (interaction.customId === 'exp') {
      const ready = user.exp >= SUMMON_COST;

      return handleEphemeral({
        embeds: [
          new EmbedBuilder()
            .setColor(ready ? '#00b894' : '#fdcb6e')
            .setAuthor({
              name: `${interaction.user.username}'s EXP`,
              iconURL: interaction.user.displayAvatarURL()
            })
            .setDescription(
              `**Progress:**
${expBar(user.exp)}

${ready ? '🟢 Ready to summon!' : `⛔ Need **${SUMMON_COST - user.exp} more EXP**`}`
            )
            .setFooter({ text: 'Only you can see this' })
        ]
      });
    }

    if (interaction.customId === 'inv') {
      const items = user.inv.length
        ? user.inv.map((item, i) => `${i + 1}. ${item}`).join('\n')
        : 'Inventory empty.';

      return handleEphemeral({
        embeds: [
          new EmbedBuilder()
            .setColor('#6c5ce7')
            .setAuthor({
              name: `${interaction.user.username}'s Inventory`,
              iconURL: interaction.user.displayAvatarURL()
            })
            .setDescription(items)
            .setFooter({ text: `${user.inv.length} items • Only you can see this` })
        ]
      });
    }

    if (interaction.customId === 'bump_reward') {
      const now = Date.now();
      const remaining = BUMP_COOLDOWN - (now - user.lastBump);
      const ready = remaining <= 0;

      return handleEphemeral({
        embeds: [
          new EmbedBuilder()
            .setColor(ready ? '#00b894' : '#fdcb6e')
            .setAuthor({
              name: '🚀 Bump Reward',
              iconURL: client.user.displayAvatarURL()
            })
            .setDescription(
              ready
                ? `✅ Reward ready! Go to <#${BOT_CHANNEL_ID}> and type /bump for **+${BUMP_EXP} EXP**!`
                : `⏳ Claimed today. Come back in **${formatCooldown(remaining)}**`
            )
            .setFooter({ text: 'Only you can see this' })
        ]
      });
    }
  } catch (err) {
    console.error('Interaction error:', err);
  }
});

initDB()
  .then(() => client.login(process.env.DISCORD_TOKEN))
  .catch((err) => {
    console.error('Startup error:', err);
    process.exit(1);
  });
