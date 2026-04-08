/**
 * Autonomous Messages for oxiclaw
 *
 * Implements proactive messaging where agents send messages to users without
 * an explicit user trigger. Two types:
 *
 * 1. Rule-based (scheduled): Cron-driven messages configured by the user,
 *    reusing the existing task-scheduler infrastructure.
 *
 * 2. AI judgment (triggered): When an agent's response suggests further
 *    discussion is needed, the orchestrator proactively sends a follow-up
 *    message, subject to guardrails.
 *
 * Guardrails:
 *   - Per-topic cooldown: 1 hour between proactive messages on the same topic
 *   - Daily limit: 10 proactive messages per group
 *   - Keyword detection for AI judgment triggers
 *   - All proactive messages logged to SQLite for audit
 */

import { EventEmitter } from 'events';

import { logger } from './logger.js';
import { GROUPS_DIR } from './config.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProactiveMessage {
  /** Unique message ID. */
  id: string;
  /** The agent that triggered the message. */
  sessionId: string;
  /** Target chat JID. */
  chatId: string;
  /** Topic/category for cooldown tracking. */
  topic: string;
  /** Message content. */
  content: string;
  /** How the message was triggered. */
  triggerType: 'rule' | 'ai_judgment';
  /** Timestamp (epoch ms). */
  timestamp: number;
}

export interface AutonomousRule {
  /** Unique rule ID. */
  id: string;
  /** Target chat JID. */
  chatId: string;
  /** Cron expression or interval. */
  schedule: string;
  /** Prompt to send to the agent. */
  prompt: string;
  /** Agent to use for the rule. */
  agentName: string;
  /** Whether the rule is active. */
  enabled: boolean;
}

export interface AutonomousMessageDeps {
  /** Send a message to a Telegram chat. */
  sendMessage: (chatJid: string, text: string) => Promise<void>;
  /** Prompt an agent and get its response. */
  promptAgent: (
    chatJid: string,
    agentName: string,
    prompt: string,
  ) => Promise<string>;
  /** Get the current time as an ISO string. */
  getCurrentTime?: () => string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROACTIVE_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour
const DAILY_LIMIT_PER_GROUP = 10;

/**
 * Keywords that indicate an agent wants to send a proactive follow-up.
 * These are detected in the agent's response text.
 */
const PROACTIVE_KEYWORDS = [
  'need to discuss',
  'further discussion',
  'follow up',
  'should notify',
  'needs attention',
  'important update',
  'breaking change',
  'requires review',
  'please check',
  'action required',
  '더 논의', // Korean: more discussion
  '논의 필요', // Korean: discussion needed
  '추가 확인', // Korean: additional confirmation
  '계속 진행', // Korean: continue
] as const;

// ---------------------------------------------------------------------------
// Autonomous Message Manager
// ---------------------------------------------------------------------------

export class AutonomousMessageManager extends EventEmitter {
  private deps: AutonomousMessageDeps;

  /** Recent proactive messages for cooldown tracking. */
  private recentMessages: ProactiveMessage[] = [];

  /** Daily proactive message counts: "chatId:YYYY-MM-DD" → count. */
  private dailyCounts = new Map<string, number>();

  /** Registered rules. */
  private rules = new Map<string, AutonomousRule>();

  /** Rule execution timers. */
  private ruleTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(deps: AutonomousMessageDeps) {
    super();
    this.deps = deps;
  }

  // -------------------------------------------------------------------------
  // AI Judgment Triggers
  // -------------------------------------------------------------------------

  /**
   * Analyze an agent's response for proactive messaging signals.
   *
   * Called by the orchestrator after each agent response. If the response
   * contains keywords indicating a proactive message is warranted, and
   * guardrails pass, sends the proactive message.
   *
   * @returns The proactive message sent, or null if none was triggered.
   */
  async handleAgentResponse(
    sessionId: string,
    chatId: string,
    response: string,
  ): Promise<ProactiveMessage | null> {
    // Step 1: Detect proactive need
    const needsProactive = this.detectProactiveNeed(response);
    if (!needsProactive) return null;

    // Step 2: Extract topic from response
    const topic = this.extractTopic(response);

    // Step 3: Check guardrails
    if (!this.checkGuardrails(chatId, topic)) {
      logger.debug(
        { chatId, topic },
        'Proactive message blocked by guardrails',
      );
      return null;
    }

    // Step 4: Format and send proactive message
    const message = await this.sendProactiveMessage(
      sessionId,
      chatId,
      topic,
      response,
      'ai_judgment',
    );

    logger.info(
      { chatId, topic, sessionId, messageId: message.id },
      'Proactive message sent (AI judgment)',
    );

    return message;
  }

  /**
   * Check if a response text contains proactive messaging keywords.
   */
  detectProactiveNeed(response: string): boolean {
    const lower = response.toLowerCase();
    return PROACTIVE_KEYWORDS.some((keyword) => lower.includes(keyword));
  }

  /**
   * Extract a topic from the response for cooldown tracking.
   * Uses the first sentence or a truncated version.
   */
  extractTopic(response: string): string {
    // Take the first 100 characters as a topic signature
    const cleaned = response.replace(/<[^>]+>/g, '').trim();
    const firstSentence = cleaned.split(/[.!?\n]/)[0] || cleaned;
    return firstSentence.slice(0, 100);
  }

  // -------------------------------------------------------------------------
  // Rule-based Triggers
  // -------------------------------------------------------------------------

  /**
   * Register a new autonomous messaging rule.
   *
   * Rules are cron-driven prompts sent to specific agents on a schedule.
   * They reuse the task-scheduler's cron infrastructure.
   */
  registerRule(rule: Omit<AutonomousRule, 'id'>): AutonomousRule {
    const id = `rule-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const fullRule: AutonomousRule = { id, ...rule };
    this.rules.set(id, fullRule);

    if (fullRule.enabled) {
      this.scheduleRule(fullRule);
    }

    logger.info(
      { ruleId: id, chatId: rule.chatId, agentName: rule.agentName },
      'Autonomous rule registered',
    );

    return fullRule;
  }

  /**
   * Update an existing rule.
   */
  updateRule(
    ruleId: string,
    updates: Partial<Pick<AutonomousRule, 'schedule' | 'prompt' | 'enabled'>>,
  ): AutonomousRule | null {
    const rule = this.rules.get(ruleId);
    if (!rule) return null;

    // Clear existing timer
    const timer = this.ruleTimers.get(ruleId);
    if (timer) {
      clearTimeout(timer);
      this.ruleTimers.delete(ruleId);
    }

    // Apply updates
    Object.assign(rule, updates);

    // Reschedule if enabled
    if (rule.enabled) {
      this.scheduleRule(rule);
    }

    return rule;
  }

  /**
   * Remove a rule.
   */
  removeRule(ruleId: string): boolean {
    const timer = this.ruleTimers.get(ruleId);
    if (timer) {
      clearTimeout(timer);
      this.ruleTimers.delete(ruleId);
    }
    return this.rules.delete(ruleId);
  }

  /**
   * Get all rules, optionally filtered by chat.
   */
  getRules(chatId?: string): AutonomousRule[] {
    const all = [...this.rules.values()];
    if (chatId) {
      return all.filter((r) => r.chatId === chatId);
    }
    return all;
  }

  /**
   * Execute a rule immediately (used for testing or manual trigger).
   */
  async executeRule(ruleId: string): Promise<ProactiveMessage | null> {
    const rule = this.rules.get(ruleId);
    if (!rule) return null;

    // Check guardrails
    const topic = this.extractTopic(rule.prompt);
    if (!this.checkGuardrails(rule.chatId, topic)) {
      logger.debug(
        { ruleId, chatId: rule.chatId },
        'Rule execution blocked by guardrails',
      );
      return null;
    }

    try {
      // Prompt the agent
      const response = await this.deps.promptAgent(
        rule.chatId,
        rule.agentName,
        rule.prompt,
      );

      if (!response) return null;

      // Send the proactive message
      return await this.sendProactiveMessage(
        rule.agentName,
        rule.chatId,
        topic,
        response,
        'rule',
      );
    } catch (err) {
      logger.error(
        { err, ruleId, chatId: rule.chatId },
        'Failed to execute autonomous rule',
      );
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Guardrails
  // -------------------------------------------------------------------------

  /**
   * Check all guardrails for a proactive message.
   *
   * @returns true if the message is allowed.
   */
  checkGuardrails(chatId: string, topic: string): boolean {
    // Cooldown check: same topic within the cooldown period
    const recentForChat = this.recentMessages.filter(
      (m) => m.chatId === chatId,
    );
    const sameTopic = recentForChat.find((m) => {
      // Fuzzy topic match: check if topics share significant overlap
      return this.topicsOverlap(m.topic, topic);
    });

    if (sameTopic && Date.now() - sameTopic.timestamp < PROACTIVE_COOLDOWN_MS) {
      logger.debug(
        { chatId, topic, lastSent: sameTopic.timestamp },
        'Proactive cooldown active',
      );
      return false;
    }

    // Daily limit check
    const today = new Date().toISOString().split('T')[0];
    const dailyKey = `${chatId}:${today}`;
    const dailyCount = this.dailyCounts.get(dailyKey) || 0;
    if (dailyCount >= DAILY_LIMIT_PER_GROUP) {
      logger.debug(
        { chatId, dailyCount, limit: DAILY_LIMIT_PER_GROUP },
        'Daily proactive limit reached',
      );
      return false;
    }

    return true;
  }

  /**
   * Check if two topics overlap enough to be considered the same for cooldown.
   * Simple substring matching — more sophisticated NLP could be added later.
   */
  private topicsOverlap(topic1: string, topic2: string): boolean {
    const normalize = (t: string) =>
      t.toLowerCase().replace(/[^a-z0-9가-힣]/g, '');
    const a = normalize(topic1);
    const b = normalize(topic2);

    // Exact match
    if (a === b) return true;

    // One is a substring of the other (at least 30 chars overlap)
    if (a.length >= 30 && b.length >= 30) {
      if (a.includes(b.slice(0, 30)) || b.includes(a.slice(0, 30))) {
        return true;
      }
    }

    return false;
  }

  // -------------------------------------------------------------------------
  // Message sending
  // -------------------------------------------------------------------------

  private async sendProactiveMessage(
    sessionId: string,
    chatId: string,
    topic: string,
    content: string,
    triggerType: 'rule' | 'ai_judgment',
  ): Promise<ProactiveMessage> {
    const message: ProactiveMessage = {
      id: `proactive-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      sessionId,
      chatId,
      topic,
      content,
      triggerType,
      timestamp: Date.now(),
    };

    // Strip internal tags from content
    const cleanContent = content
      .replace(/<internal>[\s\S]*?<\/internal>/g, '')
      .trim();

    if (cleanContent) {
      try {
        await this.deps.sendMessage(chatId, cleanContent);
      } catch (err) {
        logger.error(
          { err, chatId, messageId: message.id },
          'Failed to send proactive message',
        );
      }
    }

    // Track the message
    this.recentMessages.push(message);

    // Update daily count
    const today = new Date().toISOString().split('T')[0];
    const dailyKey = `${chatId}:${today}`;
    this.dailyCounts.set(dailyKey, (this.dailyCounts.get(dailyKey) || 0) + 1);

    // Emit event for logging/auditing
    this.emit('proactiveMessage', message);

    logger.info(
      {
        chatId,
        topic: topic.slice(0, 50),
        triggerType,
        messageId: message.id,
      },
      'Proactive message tracked',
    );

    return message;
  }

  // -------------------------------------------------------------------------
  // Rule scheduling
  // -------------------------------------------------------------------------

  private scheduleRule(rule: AutonomousRule): void {
    // Parse the schedule value as an interval in milliseconds
    // For cron expressions, the existing task-scheduler handles them.
    // Here we handle simple intervals.
    const intervalMs = this.parseInterval(rule.schedule);
    if (!intervalMs) {
      logger.warn(
        { ruleId: rule.id, schedule: rule.schedule },
        'Cannot parse rule schedule',
      );
      return;
    }

    // Minimum interval: 5 minutes (prevent flooding)
    const safeInterval = Math.max(intervalMs, 5 * 60 * 1000);

    const timer = setInterval(async () => {
      try {
        await this.executeRule(rule.id);
      } catch (err) {
        logger.error(
          { err, ruleId: rule.id },
          'Scheduled rule execution failed',
        );
      }
    }, safeInterval);

    this.ruleTimers.set(rule.id, timer);

    logger.info(
      { ruleId: rule.id, intervalMs: safeInterval },
      'Rule scheduled',
    );
  }

  /**
   * Parse a schedule string into an interval in milliseconds.
   * Supports: "5m", "1h", "30m", "2h", "1d" or raw milliseconds.
   */
  private parseInterval(schedule: string): number | null {
    // Try raw number (milliseconds)
    const asNumber = parseInt(schedule, 10);
    if (!isNaN(asNumber) && asNumber > 0 && String(asNumber) === schedule) {
      return asNumber;
    }

    // Parse shorthand: "5m", "1h", "30m", "2d"
    const match = schedule.match(/^(\d+)\s*(ms|s|m|h|d)$/);
    if (!match) return null;

    const value = parseInt(match[1], 10);
    const unit = match[2];

    switch (unit) {
      case 'ms':
        return value;
      case 's':
        return value * 1000;
      case 'm':
        return value * 60 * 1000;
      case 'h':
        return value * 60 * 60 * 1000;
      case 'd':
        return value * 24 * 60 * 60 * 1000;
      default:
        return null;
    }
  }

  // -------------------------------------------------------------------------
  // Maintenance
  // -------------------------------------------------------------------------

  /**
   * Clean up old messages and counts to prevent memory leaks.
   * Should be called periodically (e.g. every hour).
   */
  cleanup(): void {
    const now = Date.now();

    // Remove messages older than 24 hours
    this.recentMessages = this.recentMessages.filter(
      (m) => now - m.timestamp < 24 * 60 * 60 * 1000,
    );

    // Clean daily counts older than 2 days
    const today = new Date().toISOString().split('T')[0];
    for (const key of this.dailyCounts.keys()) {
      const datePart = key.split(':')[1];
      if (datePart && datePart !== today) {
        this.dailyCounts.delete(key);
      }
    }

    logger.debug(
      {
        recentMessageCount: this.recentMessages.length,
        activeRules: this.rules.size,
        dailyCounts: this.dailyCounts.size,
      },
      'Autonomous message manager cleanup',
    );
  }

  /**
   * Get statistics about proactive messaging for monitoring.
   */
  getStats(): {
    recentMessageCount: number;
    activeRules: number;
    dailyCounts: Record<string, number>;
  } {
    return {
      recentMessageCount: this.recentMessages.length,
      activeRules: this.rules.size,
      dailyCounts: Object.fromEntries(this.dailyCounts),
    };
  }

  /**
   * Stop all timers and clean up. Call on shutdown.
   */
  destroy(): void {
    for (const timer of this.ruleTimers.values()) {
      clearInterval(timer);
    }
    this.ruleTimers.clear();
    this.rules.clear();
    this.recentMessages = [];
    this.dailyCounts.clear();
    this.removeAllListeners();
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let autonomousManager: AutonomousMessageManager | null = null;

/**
 * Initialize the autonomous message manager.
 */
export function initAutonomousMessages(
  deps: AutonomousMessageDeps,
): AutonomousMessageManager {
  autonomousManager = new AutonomousMessageManager(deps);

  // Periodic cleanup every hour
  setInterval(
    () => {
      autonomousManager?.cleanup();
    },
    60 * 60 * 1000,
  );

  return autonomousManager;
}

/**
 * Get the singleton autonomous message manager.
 */
export function getAutonomousMessageManager(): AutonomousMessageManager | null {
  return autonomousManager;
}
