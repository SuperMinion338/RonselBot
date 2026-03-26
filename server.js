require('dotenv').config(); // must be first — loads .env before anything else

// ============================================================
// CONFIGURATION — values are loaded from .env file
// ============================================================
const TOKEN           = process.env.TOKEN;
const ROLE_ID         = process.env.ROLE_ID;
const CHANNEL_ID      = process.env.CHANNEL_ID;
const WELCOME_CHANNEL = '1459513155679158349';
// ============================================================

const express    = require('express');
const fs         = require('fs');
const path       = require('path');
const {
  Client,
  GatewayIntentBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  EmbedBuilder,
} = require('discord.js');

// ── Storage helpers ─────────────────────────────────────────
const BUYERS_FILE = path.join(__dirname, 'buyers.json');

function loadBuyers() {
  if (!fs.existsSync(BUYERS_FILE)) {
    fs.writeFileSync(BUYERS_FILE, JSON.stringify([], null, 2));
  }
  try {
    return JSON.parse(fs.readFileSync(BUYERS_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function saveBuyers(buyers) {
  fs.writeFileSync(BUYERS_FILE, JSON.stringify(buyers, null, 2));
}

function addBuyer(email) {
  const buyers = loadBuyers();
  const normalised = email.trim().toLowerCase();
  if (!buyers.includes(normalised)) {
    buyers.push(normalised);
    saveBuyers(buyers);
    return true;
  }
  return false;
}

function isBuyer(email) {
  const buyers = loadBuyers();
  return buyers.includes(email.trim().toLowerCase());
}

// ── Express server ───────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// POST /webhook — receive Payhip payment notifications
app.post('/webhook', (req, res) => {
  const payload = req.body;
  console.log('[Webhook] Received payload:', JSON.stringify(payload, null, 2));

  const email = payload.email || payload.buyer_email;

  if (!email) {
    console.warn('[Webhook] No email found in payload.');
    return res.status(400).json({ error: 'No email in payload' });
  }

  const isNew = addBuyer(email);
  console.log(`[Webhook] Email "${email}" — ${isNew ? 'added' : 'already exists'}.`);
  if (isNew && client.isReady()) updateStatus();
  return res.status(200).json({ ok: true, email, isNew });
});

// GET /check?email= — verify whether an email is a buyer
app.get('/check', (req, res) => {
  const { email } = req.query;
  if (!email) {
    return res.status(400).json({ valid: false, error: 'No email provided' });
  }
  const valid = isBuyer(email);
  console.log(`[Check] Email "${email}" → valid: ${valid}`);
  return res.json({ valid });
});

// Keep-alive endpoint (prevents Render free tier from sleeping)
app.get('/ping', (_req, res) => res.send('pong'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[Server] Express listening on port ${PORT}`);

  // Ping ourselves every 10 minutes to stay awake on Render free tier
  const SELF_URL = process.env.RENDER_EXTERNAL_URL;
  if (SELF_URL) {
    setInterval(() => {
      require('https').get(`${SELF_URL}/ping`).on('error', () => {});
    }, 10 * 60 * 1000);
  }
});

// ── Discord bot ──────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
  ],
});

// Build the verification embed + button
function buildVerifyMessage() {
  const embed = new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle('אימות רכישה — חבילת RN')
    .setDescription(
      '👋 רכשת את חבילת **RN**? מעולה!\n\n' +
      'לחץ על הכפתור למטה, הכנס את כתובת האימייל שבה השתמשת בקנייה, ' +
      'ותקבל גישה מיידית לערוצים הבלעדיים.\n\n' +
      '> כל אימייל ניתן לשימוש פעם אחת בלבד.'
    )
    .setFooter({ text: 'RN • מערכת אימות רכישות' });

  const button = new ButtonBuilder()
    .setCustomId('verify_purchase')
    .setLabel('אמת רכישה')
    .setStyle(ButtonStyle.Primary);

  const row = new ActionRowBuilder().addComponents(button);
  return { embeds: [embed], components: [row] };
}

function updateStatus() {
  const count = loadBuyers().length;
  client.user.setPresence({
    activities: [{ name: `${count} אנשים קנו את חבילת RN`, type: 3 }], // type 3 = Watching
    status: 'online',
  });
}

client.once('clientReady', async () => {
  console.log(`[Bot] Logged in as ${client.user.tag}`);
  updateStatus();

  try {
    const channel = await client.channels.fetch(CHANNEL_ID);
    if (!channel) {
      console.error('[Bot] Channel not found. Check CHANNEL_ID.');
      return;
    }

    // Check if the bot already sent a verify message — if so, skip
    const messages = await channel.messages.fetch({ limit: 20 });
    const alreadySent = messages.some(
      (m) => m.author.id === client.user.id && m.components.length > 0
    );

    if (alreadySent) {
      console.log('[Bot] Verify message already exists in channel — skipping.');
      return;
    }

    await channel.send(buildVerifyMessage());
    console.log(`[Bot] Verify message sent to #${channel.name}`);
  } catch (err) {
    console.error('[Bot] Failed to send startup message:', err.message);
  }
});

// ── Welcome message on member join ──────────────────────────
client.on('guildMemberAdd', async (member) => {
  try {
    const channel = await client.channels.fetch(WELCOME_CHANNEL);
    if (!channel) return;

    const embed = new EmbedBuilder()
      .setColor(0x5865F2)
      .setDescription(
        `היי ${member}!\nברוך הבא לשרת הרשמי לחבילת העריכה **RN** 🎉\n\nWelcome!`
      )
      .setThumbnail(member.user.displayAvatarURL({ size: 256 }))
      .setFooter({ text: 'RN Official Server' });

    await channel.send({ embeds: [embed] });
  } catch (err) {
    console.error('[Bot] Failed to send welcome message:', err.message);
  }
});

client.on('interactionCreate', async (interaction) => {
  // ── Button press → open modal ──────────────────────────────
  if (interaction.isButton() && interaction.customId === 'verify_purchase') {
    try {
      const modal = new ModalBuilder()
        .setCustomId('verify_modal')
        .setTitle('אימות רכישה');

      const emailInput = new TextInputBuilder()
        .setCustomId('email_input')
        .setLabel('האימייל שבו השתמשת בקנייה')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('example@gmail.com')
        .setRequired(true);

      modal.addComponents(new ActionRowBuilder().addComponents(emailInput));
      await interaction.showModal(modal);
    } catch (err) {
      // Ignore "already acknowledged" errors (can happen if two instances run)
      if (err.code !== 40060) console.error('[Bot] Modal error:', err.message);
    }
    return;
  }

  // ── Modal submit → check email → assign role ───────────────
  if (interaction.isModalSubmit() && interaction.customId === 'verify_modal') {
    try {
      await interaction.deferReply({ ephemeral: true });
    } catch (err) {
      if (err.code !== 40060) console.error('[Bot] Defer error:', err.message);
      return;
    }

    const email = interaction.fields.getTextInputValue('email_input').trim();
    const valid = isBuyer(email);

    if (!valid) {
      return interaction.editReply({
        content:
          `❌ האימייל **${email}** לא נמצא במערכת.\n` +
          'וודא שאתה משתמש באותו אימייל שבו קנית.\n' +
          'אם אתה חושב שמדובר בטעות, פנה לתמיכה.',
      });
    }

    // Assign the role
    try {
      const member = interaction.member;
      if (member.roles.cache.has(ROLE_ID)) {
        return interaction.editReply({
          content: '✅ כבר יש לך את הרול המאומת!',
        });
      }

      await member.roles.add(ROLE_ID);
      console.log(`[Bot] Assigned role to ${member.user.tag} (${email})`);
      return interaction.editReply({
        content:
          '✅ האימות הצליח! קיבלת גישה לחבילת **RN**.\n' +
          'ברוך הבא, תהנה מהחומר!',
      });
    } catch (err) {
      console.error('[Bot] Failed to assign role:', err.message);
      return interaction.editReply({
        content:
          '⚠️ הרכישה אומתה אבל לא הצלחתי להוסיף את הרול.\n' +
          'פנה לאדמין עם הודעה זו.',
      });
    }
  }
});

// Start the bot
client.login(TOKEN).catch((err) => {
  console.error('[Bot] Login failed:', err.message);
  process.exit(1);
});
