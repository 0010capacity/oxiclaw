/**
 * Swarm Router for oxiclaw Telegram Channel
 *
 * Routes messages to the appropriate agent in the swarm based on @agent_*
 * mentions parsed via regex. Telegram does not recognize bot usernames that
 * aren't actual accounts as mention entities, so we parse plain text with
 * /@agent_(\w+)/.
 *
 * Features:
 * - Regex-based mention parsing from message text
 * - Mention-all support: "@oxiclawbot all" triggers all agents
 * - Agent prefix formatting in responses: "[Developer] ..."
 * - Response routing from pi-mono sessions back to Telegram
 * - Integration with MeetingManager for /meeting command
 * - Agent session lifecycle hooks for the orchestrator
 */

import { sanitizeHtmlForTelegram } from '../../sanitize.js';
import { Telegraf } from 'telegraf';
import type { ParseMode } from '@telegraf/types';

import { logger } from '../../logger.js';
import {
  getAgent,
  getActiveAgents,
  getMeetingParticipants,
  agentExists,
  AgentInfo,
} from '../../agent-manager.js';
import {
  loadPersona,
  getAgentPrefix,
  getDefaultPrefix,
  listAgentNames,
  loadAllPersonas,
} from '../../persona-loader.js';
import { GROUPS_DIR } from '../../config.js';
import { RegisteredGroup } from '../../types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SwarmRouterDeps {
  /** Send a message to a Telegram chat via JID. */
  sendMessage: (jid: string, text: string) => Promise<void>;
  /** Access current registered groups. */
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export interface RoutedMessage {
  /** The agent name targeted by the mention. */
  agentName: string;
  /** The original chat JID (e.g. "tg:-1001234567890"). */
  chatJid: string;
  /** The message text with mentions stripped. */
  prompt: string;
  /** The sender's display name. */
  sender: string;
  /** The original Telegram message ID. */
  messageId: number;
  /** Whether this is a mention-all request. */
  isAllMention: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Regex pattern to extract agent mentions from message text.
 * Matches @agent_{name} where name consists of word characters.
 *
 * Example: "@agent_marketer strategy?" → ["marketer"]
 */
const AGENT_MENTION_REGEX = /@agent_(\w+)/;

/**
 * Pattern for the mention-all trigger.
 * Matches: "@oxiclawbot all", "bot all", etc.
 */
const ALL_AGENTS_PATTERN = /(?:@oxiclawbot\s+)?all\s/i;

/**
 * Regex to strip @agent_* mentions from message text.
 */
const STRIP_MENTION_REGEX = /@agent_\w+\s*/g;

/**
 * Rate limiting: minimum interval between messages to the same agent
 * in the same chat (prevents duplicate processing).
 */
const MESSAGE_DEDUP_INTERVAL_MS = 500;

// ---------------------------------------------------------------------------
// Swarm Router class
// ---------------------------------------------------------------------------

export class SwarmRouter {
  private deps: SwarmRouterDeps;
  private bot: Telegraf;

  /** Deduplication cache: "${chatJid}:${agentName}" → last processed timestamp */
  private recentRoutes = new Map<string, number>();

  /** Callbacks for external consumers (e.g. orchestrator message loop). */
  private routeHandlers: Array<(msg: RoutedMessage) => Promise<void>> = [];

  constructor(bot: Telegraf, deps: SwarmRouterDeps) {
    this.bot = bot;
    this.deps = deps;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Register a handler called when a message is routed to an agent.
   * Used by the orchestrator to feed messages into container agent sessions.
   */
  onRoute(handler: (msg: RoutedMessage) => Promise<void>): void {
    this.routeHandlers.push(handler);
  }

  /**
   * Main routing entry point.
   *
   * Parses a Telegram message for @agent_* mentions and routes
   * to the appropriate agent sessions. Called by the bot message handler.
   */
  async routeMessage(
    chatJid: string,
    sender: string,
    text: string,
    messageId: number,
  ): Promise<void> {
    if (!text) return;

    const mentions = this.parseMentions(text);
    if (mentions.length === 0) return;

    const cleanText = this.stripMentions(text);
    const isAll = mentions.includes('all');

    if (isAll) {
      await this.routeToAll(chatJid, sender, cleanText, messageId);
      return;
    }

    for (const agentName of mentions) {
      // Deduplication check
      const dedupKey = `${chatJid}:${agentName}`;
      const lastRouted = this.recentRoutes.get(dedupKey) || 0;
      if (Date.now() - lastRouted < MESSAGE_DEDUP_INTERVAL_MS) {
        logger.debug(
          { chatJid, agentName },
          'Skipping duplicate route (dedup)',
        );
        continue;
      }
      this.recentRoutes.set(dedupKey, Date.now());

      // Check if the agent exists
      if (!agentExists(chatJid, agentName)) {
        const chatId = chatJid.replace(/^tg:/, '');
        await this.bot.telegram.sendMessage(
          chatId,
          `Unknown agent: @agent_${agentName}. Use /agents to list available agents.`,
          { reply_parameters: { message_id: messageId } },
        );
        continue;
      }

      const routedMsg: RoutedMessage = {
        agentName,
        chatJid,
        prompt: cleanText,
        sender,
        messageId,
        isAllMention: false,
      };

      // Notify route handlers (orchestrator will feed into container)
      await this.notifyHandlers(routedMsg);
    }
  }

  /**
   * Trigger a meeting for all agents in a group.
   * Called by the /meeting command handler.
   */
  async triggerMeeting(chatJid: string, agenda: string): Promise<void> {
    const chatId = chatJid.replace(/^tg:/, '');
    const participants = getMeetingParticipants(chatJid);

    if (participants.length < 2) {
      await this.bot.telegram.sendMessage(
        chatId,
        'Need at least 2 active agents for a meeting. Register agents first.',
      );
      return;
    }

    // Import MeetingManager dynamically to avoid circular dependencies
    const { MeetingManager } = await import('./meeting-manager.js');
    const meetingManager = MeetingManager.getInstance();

    if (!meetingManager) {
      await this.bot.telegram.sendMessage(
        chatId,
        'Meeting system not available.',
      );
      return;
    }

    const agentNames = participants.map((p) => p.name);
    await meetingManager.startMeeting(chatJid, agenda, agentNames);

    await this.bot.telegram.sendMessage(
      chatId,
      `[Meeting] Started: "${agenda}"\nParticipants: ${agentNames.map((n) => `@agent_${n}`).join(', ')}`,
    );
  }

  /**
   * List agents available in a specific chat.
   */
  listAgentsForChat(chatJid: string): Array<{ name: string; role: string }> {
    const agentDirs = listAgentNames(chatJid);
    return agentDirs.map((name) => {
      const persona = loadPersona(chatJid, name);
      return {
        name,
        role: persona?.role || name,
      };
    });
  }

  /**
   * Format an agent response with its prefix for Telegram delivery.
   */
  formatAgentResponse(
    chatJid: string,
    agentName: string,
    content: string,
  ): string {
    const prefix = getAgentPrefix(chatJid, agentName);
    // Avoid double-prefixing
    if (content.startsWith(prefix)) return content;
    return `${prefix} ${content}`;
  }

  // -------------------------------------------------------------------------
  // Mention parsing
  // -------------------------------------------------------------------------

  /**
   * Parse agent mentions from message text.
   *
   * @returns Array of agent names (e.g. ["marketer", "developer"])
   *          or ["all"] for mention-all.
   */
  parseMentions(text: string): string[] {
    const agents: string[] = [];

    // Use matchAll for non-global regex — cleaner and avoids lastIndex issues
    for (const match of text.matchAll(AGENT_MENTION_REGEX)) {
      agents.push(match[1].toLowerCase());
    }

    // Check for mention-all pattern
    if (ALL_AGENTS_PATTERN.test(text)) {
      agents.push('all');
    }

    // Deduplicate while preserving order
    return [...new Set(agents)];
  }

  /**
   * Strip @agent_* mentions from message text to get the clean prompt.
   */
  stripMentions(text: string): string {
    return text.replace(STRIP_MENTION_REGEX, '').trim();
  }

  // -------------------------------------------------------------------------
  // Route to all agents (mention-all)
  // -------------------------------------------------------------------------

  private async routeToAll(
    chatJid: string,
    sender: string,
    prompt: string,
    messageId: number,
  ): Promise<void> {
    const activeAgents = getActiveAgents(chatJid);

    if (activeAgents.length === 0) {
      const chatId = chatJid.replace(/^tg:/, '');
      await this.bot.telegram.sendMessage(
        chatId,
        'No active agents in this group. Register agents first.',
        { reply_parameters: { message_id: messageId } },
      );
      return;
    }

    // Route to all agents in parallel
    const routes = activeAgents.map((agent) => {
      const routedMsg: RoutedMessage = {
        agentName: agent.name,
        chatJid,
        prompt,
        sender,
        messageId,
        isAllMention: true,
      };
      return this.notifyHandlers(routedMsg);
    });

    await Promise.allSettled(routes);

    logger.info(
      { chatJid, agentCount: activeAgents.length },
      'Routed mention-all to agents',
    );
  }

  // -------------------------------------------------------------------------
  // Handler notification
  // -------------------------------------------------------------------------

  private async notifyHandlers(msg: RoutedMessage): Promise<void> {
    for (const handler of this.routeHandlers) {
      try {
        await handler(msg);
      } catch (err) {
        logger.error(
          { err, agentName: msg.agentName, chatJid: msg.chatJid },
          'Route handler error',
        );
      }
    }
  }

  // -------------------------------------------------------------------------
  // Response delivery (called by orchestrator when agent responds)
  // -------------------------------------------------------------------------

  /**
   * Deliver an agent's response to the Telegram chat.
   *
   * This is called by the orchestrator when a container agent produces output.
   * It formats the response with the agent's prefix and sends it via the bot.
   */
  async deliverResponse(
    chatJid: string,
    agentName: string,
    content: string,
    replyToMessageId?: number,
  ): Promise<void> {
    const formatted = this.formatAgentResponse(chatJid, agentName, content);
    const chatId = chatJid.replace(/^tg:/, '');

    try {
      const options: {
        parse_mode?: ParseMode;
        reply_parameters?: { message_id: number };
      } = {};
      if (replyToMessageId) {
        options.reply_parameters = { message_id: replyToMessageId };
      }
      await this.bot.telegram.sendMessage(chatId, sanitizeHtmlForTelegram(formatted), options);
    } catch (err) {
      logger.error(
        { err, chatJid, agentName },
        'Failed to deliver agent response',
      );
    }
  }
}
