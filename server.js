require('dotenv').config(); // must be first — loads .env before anything else

// ============================================================
// CONFIGURATION — values are loaded from .env file
// ============================================================
const TOKEN      = process.env.TOKEN;
const ROLE_ID    = process.env.ROLE_ID;
const CHANNEL_ID = process.env.CHANNEL_ID;
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
    return true; // newly added
  }
  return false;  // already existed
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

  // Payhip sends email as "email" or "buyer_email" depending on the event type
  const email = payload.email || payload.buyer_email;

  if (!email) {
    console.warn('[Webhook] No email found in payload.');
    return res.status(400).json({ error: 'No email in payload' });
  }

  const isNew = addBuyer(email);
  console.log(`[Webhook] Email "${email}" — ${isNew ? 'added' : 'already exists'}.`);
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
  ],
});

// Build the verification embed + button
function buildVerifyMessage() {
  const embed = new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle('Verify Your Purchase')
    .setDescription(
      'Purchased a product? Click the button below and enter the email address\n' +
      'you used at checkout to receive your exclusive role.'
    )
    .setFooter({ text: 'Each email can only be used once.' });

  const button = new ButtonBuilder()
    .setCustomId('verify_purchase')
    .setLabel('Verify Purchase')
    .setStyle(ButtonStyle.Primary);

  const row = new ActionRowBuilder().addComponents(button);
  return { embeds: [embed], components: [row] };
}

client.once('ready', async () => {
  console.log(`[Bot] Logged in as ${client.user.tag}`);

  try {
    const channel = await client.channels.fetch(CHANNEL_ID);
    if (!channel) {
      console.error('[Bot] Channel not found. Check CHANNEL_ID.');
      return;
    }

    // Send a fresh verify message on every startup
    await channel.send(buildVerifyMessage());
    console.log(`[Bot] Verify message sent to #${channel.name}`);
  } catch (err) {
    console.error('[Bot] Failed to send startup message:', err.message);
  }
});

client.on('interactionCreate', async (interaction) => {
  // ── Button press → open modal ──────────────────────────────
  if (interaction.isButton() && interaction.customId === 'verify_purchase') {
    const modal = new ModalBuilder()
      .setCustomId('verify_modal')
      .setTitle('Purchase Verification');

    const emailInput = new TextInputBuilder()
      .setCustomId('email_input')
      .setLabel('Email used at checkout')
      .setStyle(TextInputStyle.Short)
      .setPlaceholder('you@example.com')
      .setRequired(true);

    modal.addComponents(new ActionRowBuilder().addComponents(emailInput));
    await interaction.showModal(modal);
    return;
  }

  // ── Modal submit → check email → assign role ───────────────
  if (interaction.isModalSubmit() && interaction.customId === 'verify_modal') {
    await interaction.deferReply({ ephemeral: true });

    const email = interaction.fields.getTextInputValue('email_input').trim();

    // Call our own /check endpoint
    let valid = false;
    try {
      // Use local check directly (same process) for reliability
      valid = isBuyer(email);
    } catch (err) {
      console.error('[Bot] Error checking email:', err.message);
      return interaction.editReply({
        content: 'An error occurred while verifying your email. Please try again later.',
      });
    }

    if (!valid) {
      return interaction.editReply({
        content:
          `❌ The email **${email}** was not found in our records.\n` +
          'Make sure you are using the same email you used to purchase.\n' +
          'If you believe this is an error, contact support.',
      });
    }

    // Assign the role
    try {
      const member = interaction.member;
      if (member.roles.cache.has(ROLE_ID)) {
        return interaction.editReply({
          content: '✅ You already have the verified role!',
        });
      }

      await member.roles.add(ROLE_ID);
      console.log(`[Bot] Assigned role to ${member.user.tag} (${email})`);
      return interaction.editReply({
        content:
          '✅ Verification successful! You have been granted access.\n' +
          'Welcome, and enjoy your purchase!',
      });
    } catch (err) {
      console.error('[Bot] Failed to assign role:', err.message);
      return interaction.editReply({
        content:
          '⚠️ Your purchase was verified but I could not assign your role.\n' +
          'Please contact an admin and show them this message.',
      });
    }
  }
});

// Start the bot
client.login(process.env.TOKEN || TOKEN).catch((err) => {
  console.error('[Bot] Login failed:', err.message);
  process.exit(1);
});
