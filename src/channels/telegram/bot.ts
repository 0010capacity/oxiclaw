/**
 * Telegram Bot Channel for oxiclaw
 *
 * Sets up a Telegram bot using Telegraf (grammY-compatible API) that integrates
 * with the existing oxiclaw channel registry. Handles incoming messages, commands,
 * and swarm routing for multi-agent groups.
 *
 * Key behaviors:
 * - Registers as a channel via the channel registry (self-registration pattern)
 * - Converts Telegram messages into the unified NewMessage format
 * - Supports JID prefix "tg:" for Telegram chat identification
 * - Registers bot commands (/meeting, /extension, /agents)
 * - Integrates with the swarm router for @agent_* mention handling
 * - Privacy mode must be DISABLED in BotFather for group message reception
 */

import { existsSync } from 'fs';
import { Telegraf, Context } from 'telegraf';
import { message } from 'telegraf/filters';

import {
  Channel,
  NewMessage,
  OnInboundMessage,
  OnChatMetadata,
  RegisteredGroup,
} from '../../types.js';
import { registerChannel, ChannelOpts } from '../registry.js';
import { logger } from '../../logger.js';
import { ASSISTANT_NAME, GROUPS_DIR } from '../../config.js';
import { sanitizeHtmlForTelegram } from '../../sanitize.js';
import { SwarmRouter } from './swarm-router.js';
import { MeetingManager } from './meeting-manager.js';
import { registerSkillCommands } from './skill-commands.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const JID_PREFIX = 'tg:';

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let bot: Telegraf | null = null;
let swarmRouter: SwarmRouter | null = null;

// ---------------------------------------------------------------------------
// JID helpers
// ---------------------------------------------------------------------------

function makeJid(chatId: number | string): string {
  return `${JID_PREFIX}${chatId}`;
}

function isTelegramJid(jid: string): boolean {
  return jid.startsWith(JID_PREFIX);
}

function extractChatId(jid: string): string {
  return jid.slice(JID_PREFIX.length);
}

// ---------------------------------------------------------------------------
// Message conversion
// ---------------------------------------------------------------------------

/**
 * Convert a Telegram message into the unified NewMessage format.
 */
function toNewMessage(ctx: Context, isBot = false): NewMessage | null {
  const msg = ctx.message;
  if (!msg) return null;

  const chatId = makeJid(msg.chat.id);
  const messageId = String(msg.message_id);
  const sender = String(msg.from?.id || 'unknown');
  const senderName =
    msg.from?.username ||
    msg.from?.first_name ||
    msg.from?.last_name ||
    'unknown';
  const content =
    'text' in msg ? msg.text : 'caption' in msg ? msg.caption : '';

  if (!content) return null;

  return {
    id: messageId,
    chat_jid: chatId,
    sender,
    sender_name: senderName,
    content,
    timestamp: new Date((msg.date || 0) * 1000).toISOString(),
    is_from_me: isBot,
    is_bot_message: isBot,
    reply_to_message_id:
      'reply_to_message' in msg && msg.reply_to_message
        ? String(msg.reply_to_message.message_id)
        : undefined,
    reply_to_message_content:
      'reply_to_message' in msg && msg.reply_to_message
        ? (msg.reply_to_message as { text?: string }).text
        : undefined,
    reply_to_sender_name:
      'reply_to_message' in msg && msg.reply_to_message
        ? msg.reply_to_message.from?.username ||
          msg.reply_to_message.from?.first_name ||
          undefined
        : undefined,
  };
}

// ---------------------------------------------------------------------------
// Channel factory
// ---------------------------------------------------------------------------

/**
 * Create and register the Telegram channel.
 *
 * Returns null if TELEGRAM_BOT_TOKEN is not set (channel is not configured).
 */
function createTelegramChannel(opts: ChannelOpts): Channel | null {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) {
    logger.debug('TELEGRAM_BOT_TOKEN not set, skipping Telegram channel');
    return null;
  }

  bot = new Telegraf(botToken);
  const registeredGroups = opts.registeredGroups;

  // Initialize the swarm router for mention-based agent routing
  swarmRouter = new SwarmRouter(bot, {
    sendMessage: async (jid: string, text: string) => {
      if (!isTelegramJid(jid)) {
        logger.warn({ jid }, 'Cannot send Telegram message to non-TG JID');
        return;
      }
      const chatId = extractChatId(jid);
      await bot!.telegram.sendMessage(chatId, sanitizeHtmlForTelegram(text), {
        parse_mode: 'HTML',
      });
    },
    registeredGroups,
  });

  // Initialize the meeting manager so /meeting command works
  MeetingManager.initialize({
    sendMessage: async (jid: string, text: string) => {
      if (!isTelegramJid(jid)) {
        logger.warn({ jid }, 'Cannot send Telegram message to non-TG JID');
        return;
      }
      const chatId = extractChatId(jid);
      await bot!.telegram.sendMessage(chatId, sanitizeHtmlForTelegram(text), {
        parse_mode: 'HTML',
      });
    },
    // promptAgent is optional — meeting responses are processed via
    // the orchestrator's normal message flow (processGroupMessages).
  });

  // Register /skill commands for listing and managing container skills
  registerSkillCommands(bot, registeredGroups);

  // -------------------------------------------------------------------------
  // Message handler
  // -------------------------------------------------------------------------

  bot.on(message('text'), async (ctx: Context) => {
    try {
      const newMsg = toNewMessage(ctx);
      if (!newMsg) return;

      const chatId = newMsg.chat_jid;

      // Report chat metadata for group discovery
      const chatName = (ctx.chat as { title?: string })?.title || undefined;
      const isGroup =
        ctx.chat?.type === 'group' || ctx.chat?.type === 'supergroup';
      opts.onChatMetadata(
        chatId,
        newMsg.timestamp,
        chatName,
        'telegram',
        isGroup,
      );

      // Only process messages for registered groups
      const groups = registeredGroups();
      const group = groups[chatId];
      if (!group) {
        // Not a registered group — still store metadata but skip message
        return;
      }

      // Deliver the message to the orchestrator's message pipeline
      opts.onMessage(chatId, newMsg);

      // Also route through swarm router for @agent_* mentions
      if (swarmRouter) {
        await swarmRouter.routeMessage(
          chatId,
          newMsg.sender_name,
          newMsg.content,
          Number(newMsg.id),
        );
      }
    } catch (err) {
      logger.error({ err }, 'Telegram message handler error');
    }
  });

  // Handle photo messages with multimodal support
  bot.on(message('photo'), async (ctx: Context) => {
    try {
      if (!ctx.chat || !ctx.message) return;
      const chatId = makeJid(ctx.chat.id);
      const messageId = String(ctx.message.message_id || 'unknown');
      const sender = String(ctx.message.from?.id || 'unknown');
      const senderName =
        ctx.message.from?.username ||
        ctx.message.from?.first_name ||
        ctx.message.from?.last_name ||
        'unknown';
      const caption = (ctx.message as { caption?: string }).caption || '';
      const timestamp = new Date((ctx.message.date || 0) * 1000).toISOString();

      opts.onChatMetadata(chatId, timestamp, undefined, 'telegram', true);

      // Only process messages for registered groups
      const groups = registeredGroups();
      const group = groups[chatId];
      if (!group) return;

      // Download and encode the largest photo
      let image_base64: string | undefined;
      const photos = (ctx.message as { photo?: Array<{ file_id: string }> })
        .photo;
      if (photos && photos.length > 0) {
        try {
          // Get the largest photo size (last in array)
          const largestPhoto = photos[photos.length - 1];
          const file = await ctx.telegram.getFile(largestPhoto.file_id);

          // Construct download URL
          const botToken = process.env.TELEGRAM_BOT_TOKEN || '';
          const downloadUrl = `https://api.telegram.org/file/bot${botToken}/${file.file_path}`;

          // Download and base64-encode
          const response = await fetch(downloadUrl);
          if (response.ok) {
            const arrayBuffer = await response.arrayBuffer();
            const buffer = Buffer.from(arrayBuffer);
            image_base64 = buffer.toString('base64');
          }
        } catch (imgErr) {
          logger.warn({ err: imgErr }, 'Failed to download Telegram photo');
        }
      }

      // Always deliver the message (with or without image)
      opts.onMessage(chatId, {
        id: messageId,
        chat_jid: chatId,
        sender,
        sender_name: senderName,
        content: caption,
        timestamp,
        image_base64,
      });
    } catch (err) {
      logger.error({ err }, 'Telegram photo handler error');
    }
  });

  // -------------------------------------------------------------------------
  // Command handlers
  // -------------------------------------------------------------------------

  // /meeting command — triggers agent meeting (Phase 3)
  bot.command('meeting', async (ctx: Context) => {
    const text =
      'text' in (ctx.message || {})
        ? (ctx.message as { text?: string }).text || ''
        : '';
    const agenda = text.replace('/meeting', '').trim();

    if (!agenda) {
      await ctx.reply(
        'Usage: /meeting <agenda>\n' + 'Example: /meeting Discuss Q3 strategy',
      );
      return;
    }

    const chatId = makeJid(ctx.chat?.id || 0);
    if (swarmRouter) {
      await swarmRouter.triggerMeeting(chatId, agenda);
    } else {
      await ctx.reply('Swarm router not initialized.');
    }
  });

  // /agents command — list agents in the group
  bot.command('agents', async (ctx: Context) => {
    const chatId = makeJid(ctx.chat?.id || 0);
    if (swarmRouter) {
      const agentList = swarmRouter.listAgentsForChat(chatId);
      if (agentList.length === 0) {
        await ctx.reply('No agents registered in this group.');
      } else {
        const lines = agentList.map((a) => `- @agent_${a.name} (${a.role})`);
        await ctx.reply(`Agents in this group:\n${lines.join('\n')}`);
      }
    } else {
      await ctx.reply('Swarm router not initialized.');
    }
  });

  // Register bot commands with Telegram
  bot.telegram
    .setMyCommands([
      { command: 'meeting', description: 'Start an agent meeting' },
      { command: 'agents', description: 'List agents in this group' },
      { command: 'skill', description: 'List and manage skills' },
    ])
    .catch((err: unknown) => {
      logger.warn({ err }, 'Failed to set Telegram bot commands');
    });

  // -------------------------------------------------------------------------
  // Channel interface implementation
  // -------------------------------------------------------------------------

  const channel: Channel = {
    name: 'telegram',

    async connect(): Promise<void> {
      if (!bot) throw new Error('Bot not initialized');

      // Enable graceful stop
      bot.catch((err: unknown) => {
        logger.error({ err }, 'Telegraf error');
      });

      // Launch with long polling (grammY/Telegraf pattern)
      await bot.launch({
        allowedUpdates: ['message', 'edited_message'],
      });

      logger.info('Telegram bot connected');
    },

    async sendMessage(jid: string, text: string): Promise<void> {
      if (!bot) throw new Error('Bot not initialized');
      if (!isTelegramJid(jid)) {
        throw new Error(`Not a Telegram JID: ${jid}`);
      }
      const chatId = extractChatId(jid);

      try {
        await bot.telegram.sendMessage(chatId, text);
      } catch (err) {
        logger.error({ jid, err }, 'Failed to send Telegram message');
        throw err;
      }
    },

    async sendFile(
      jid: string,
      filePath: string,
      caption?: string,
    ): Promise<void> {
      if (!bot) throw new Error('Bot not initialized');
      if (!isTelegramJid(jid)) {
        throw new Error(`Not a Telegram JID: ${jid}`);
      }
      const chatId = extractChatId(jid);

      try {
        await bot.telegram.sendPhoto(chatId, { source: filePath }, { caption });
      } catch (err) {
        logger.error({ jid, err }, 'Failed to send Telegram photo');
        throw err;
      }
    },

    isConnected(): boolean {
      return bot !== null && bot.botInfo !== undefined;
    },

    ownsJid(jid: string): boolean {
      return isTelegramJid(jid);
    },

    async disconnect(): Promise<void> {
      if (bot) {
        bot.stop();
        bot = null;
        logger.info('Telegram bot disconnected');
      }
    },

    async setTyping(jid: string, isTyping: boolean): Promise<void> {
      if (!bot || !isTelegramJid(jid)) return;
      const chatId = extractChatId(jid);
      try {
        if (isTyping) {
          await bot.telegram.sendChatAction(chatId, 'typing');
        }
        // Telegram has no "stop typing" action — it auto-expires after 5s
      } catch (err) {
        // Chat action errors are non-critical, log and continue
        logger.debug({ jid, err }, 'Failed to set Telegram typing indicator');
      }
    },

    async syncGroups(force: boolean): Promise<void> {
      // Telegram groups are discovered through incoming messages.
      // We don't have an API to list all groups the bot is in,
      // but we can rely on the chat metadata from incoming messages.
      logger.debug(
        { force },
        'Telegram group sync (no-op, uses message discovery)',
      );
    },
  };

  return channel;
}

// ---------------------------------------------------------------------------
// Self-registration
// ---------------------------------------------------------------------------

registerChannel('telegram', createTelegramChannel);

// ---------------------------------------------------------------------------
// Exports (for direct use by other modules)
// ---------------------------------------------------------------------------

/**
 * Get the underlying Telegraf bot instance.
 * Returns null if the channel is not initialized.
 */
export function getBot(): Telegraf | null {
  return bot;
}

/**
 * Get the swarm router instance.
 * Returns null if the channel is not initialized.
 */
export function getSwarmRouter(): SwarmRouter | null {
  return swarmRouter;
}
