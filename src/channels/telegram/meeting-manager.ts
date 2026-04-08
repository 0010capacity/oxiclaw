/**
 * Meeting Manager for oxiclaw
 *
 * Implements the autonomous meeting system described in the design spec.
 * A meeting is a structured multi-agent discussion coordinated by a Moderator
 * agent, with a full state machine, safety guards, and meeting summary.
 *
 * State machine:
 *   idle → scheduled → in_progress → summarizing → completed → idle
 *                  └→ cancelled ←─┘
 *
 * Safety guards:
 *   - Max 15 turns total, max 3 per agent
 *   - Max 10 minutes per meeting
 *   - No consecutive turns by the same agent
 *   - Daily meeting limit: 5 per group
 *   - Same-topic cooldown: 1 hour
 *   - Force-cancel via /meeting cancel
 */

import { EventEmitter } from 'events';

import { logger } from '../../logger.js';
import { GROUPS_DIR } from '../../config.js';
import {
  getActiveAgents,
  getAgent,
  setAgentStatus,
  selectModerator,
  AgentInfo,
} from '../../agent-manager.js';
import {
  getAgentPrefix,
  loadPersona,
  loadAllPersonas,
} from '../../persona-loader.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MeetingState =
  | 'idle'
  | 'scheduled'
  | 'in_progress'
  | 'summarizing'
  | 'completed'
  | 'cancelled';

export interface Turn {
  /** The agent that spoke. */
  agent: string;
  /** The content of the turn. */
  content: string;
  /** Timestamp (epoch ms). */
  timestamp: number;
}

export interface Meeting {
  /** Unique meeting identifier. */
  id: string;
  /** The Telegram chat JID. */
  chatId: string;
  /** Current state in the state machine. */
  state: MeetingState;
  /** The meeting agenda / topic. */
  agenda: string;
  /** The moderator agent name. */
  moderator: string;
  /** All participating agent names. */
  participants: string[];
  /** Total turns taken so far. */
  turns: number;
  /** Maximum turns allowed. */
  maxTurns: number;
  /** Maximum turns per agent. */
  maxTurnsPerAgent: number;
  /** Meeting start time (epoch ms). */
  startTime: number;
  /** Maximum meeting duration (ms). */
  maxDuration: number;
  /** History of all turns. */
  turnHistory: Turn[];
  /** Meeting creation time. */
  createdAt: number;
  /** Scheduled start time (for future meetings). */
  scheduledAt: number | null;
  /** Meeting summary text. */
  summary: string | null;
}

export interface MeetingManagerDeps {
  /** Send a message to a chat. */
  sendMessage: (chatJid: string, text: string) => Promise<void>;
  /** Send a prompt to a specific agent session (optional — meeting responses can arrive via orchestrator message flow). */
  promptAgent?: (
    chatJid: string,
    agentName: string,
    prompt: string,
  ) => Promise<string>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MEETING_CONSTRAINTS = {
  MAX_TURNS: 15,
  MAX_TURNS_PER_AGENT: 3,
  MAX_DURATION_MS: 10 * 60 * 1000, // 10 minutes
  COOLDOWN_SAME_TOPIC_MS: 60 * 60 * 1000, // 1 hour
  DAILY_LIMIT: 5,
} as const;

// ---------------------------------------------------------------------------
// Meeting Manager singleton
// ---------------------------------------------------------------------------

let instance: MeetingManager | null = null;

export class MeetingManager extends EventEmitter {
  /** Active meetings by chat JID. */
  private meetings = new Map<string, Meeting>();

  /** Topic cooldown tracking: "chatId:agendaHash" → last meeting timestamp. */
  private topicCooldowns = new Map<string, number>();

  /** Daily meeting counts: "chatId:YYYY-MM-DD" → count. */
  private dailyCounts = new Map<string, number>();

  /** Dependencies for sending messages and prompting agents. */
  private deps: MeetingManagerDeps | null = null;

  /** Timer for checking meeting timeouts. */
  private timeoutChecker: ReturnType<typeof setInterval> | null = null;

  /** Track summarizing auto-completion timers to prevent memory leaks. */
  private summarizingTimeouts = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();

  private constructor() {
    super();
  }

  /**
   * Get the singleton instance. Returns null if not initialized.
   */
  static getInstance(): MeetingManager | null {
    return instance;
  }

  /**
   * Initialize (or re-initialize) the singleton with dependencies.
   */
  static initialize(deps: MeetingManagerDeps): MeetingManager {
    if (instance) {
      instance.deps = deps;
      return instance;
    }
    instance = new MeetingManager();
    instance.deps = deps;
    instance.startTimeoutChecker();
    return instance;
  }

  /**
   * Destroy the singleton and clean up timers.
   */
  static destroy(): void {
    if (instance) {
      instance.stopTimeoutChecker();
      // Clear all summarizing timeouts to prevent memory leaks
      for (const timer of instance.summarizingTimeouts.values()) {
        clearTimeout(timer);
      }
      instance.summarizingTimeouts.clear();
      instance.meetings.clear();
      instance = null;
    }
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Start a new meeting for a group.
   *
   * @param chatJid     - The group's JID (e.g. "tg:-1001234567890").
   * @param agenda      - The meeting topic/agenda.
   * @param participants - Agent names to include.
   * @returns The Meeting object.
   * @throws Error if guardrails prevent the meeting.
   */
  async startMeeting(
    chatJid: string,
    agenda: string,
    participants: string[],
  ): Promise<Meeting> {
    // Guard: check daily limit
    const today = new Date().toISOString().split('T')[0];
    const dailyKey = `${chatJid}:${today}`;
    const dailyCount = this.dailyCounts.get(dailyKey) || 0;
    if (dailyCount >= MEETING_CONSTRAINTS.DAILY_LIMIT) {
      throw new Error(
        `Daily meeting limit reached (${MEETING_CONSTRAINTS.DAILY_LIMIT} per group)`,
      );
    }

    // Guard: check same-topic cooldown
    const topicKey = `${chatJid}:${this.hashAgenda(agenda)}`;
    const lastMeetingTime = this.topicCooldowns.get(topicKey);
    if (
      lastMeetingTime &&
      Date.now() - lastMeetingTime < MEETING_CONSTRAINTS.COOLDOWN_SAME_TOPIC_MS
    ) {
      const remaining = Math.ceil(
        (MEETING_CONSTRAINTS.COOLDOWN_SAME_TOPIC_MS -
          (Date.now() - lastMeetingTime)) /
          60000,
      );
      throw new Error(
        `Same topic cooldown active. Try again in ${remaining} minutes.`,
      );
    }

    // Guard: already a meeting in progress
    const existing = this.meetings.get(chatJid);
    if (
      existing &&
      existing.state !== 'completed' &&
      existing.state !== 'cancelled'
    ) {
      throw new Error(
        `A meeting is already in progress for this group (state: ${existing.state})`,
      );
    }

    // Guard: minimum 2 participants
    if (participants.length < 2) {
      throw new Error('Need at least 2 agents for a meeting.');
    }

    // Select moderator (first participant or explicitly designated)
    const moderator = selectModerator(chatJid)?.name || participants[0];

    const meeting: Meeting = {
      id: `meeting-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      chatId: chatJid,
      state: 'idle',
      agenda,
      moderator,
      participants,
      turns: 0,
      maxTurns: MEETING_CONSTRAINTS.MAX_TURNS,
      maxTurnsPerAgent: MEETING_CONSTRAINTS.MAX_TURNS_PER_AGENT,
      startTime: Date.now(),
      maxDuration: MEETING_CONSTRAINTS.MAX_DURATION_MS,
      turnHistory: [],
      createdAt: Date.now(),
      scheduledAt: null,
      summary: null,
    };

    this.meetings.set(chatJid, meeting);

    // Update cooldown tracker
    this.topicCooldowns.set(topicKey, Date.now());

    // Increment daily count
    this.dailyCounts.set(dailyKey, dailyCount + 1);

    logger.info(
      { chatJid, agenda, participants, moderator, meetingId: meeting.id },
      'Meeting created',
    );

    // Transition to in_progress and start the discussion
    await this.transition(chatJid, 'in_progress');

    return meeting;
  }

  /**
   * Cancel the active meeting for a group.
   */
  async cancelMeeting(chatJid: string): Promise<void> {
    const meeting = this.meetings.get(chatJid);
    if (!meeting) {
      throw new Error('No meeting in progress for this group.');
    }
    await this.transition(chatJid, 'cancelled');
  }

  /**
   * Get the active meeting for a group.
   */
  getActiveMeeting(chatJid: string): Meeting | null {
    const meeting = this.meetings.get(chatJid);
    if (
      !meeting ||
      meeting.state === 'completed' ||
      meeting.state === 'cancelled'
    ) {
      return null;
    }
    return meeting;
  }

  /**
   * Process an agent's response during a meeting.
   *
   * Called by the orchestrator when an agent produces output during a meeting.
   * Checks turn constraints, records the turn, and advances the state machine.
   */
  async processAgentResponse(
    chatJid: string,
    agentName: string,
    content: string,
  ): Promise<boolean> {
    const meeting = this.meetings.get(chatJid);
    if (!meeting) return false;

    // Handle summarizing state — capture the summary and transition
    if (meeting.state === 'summarizing') {
      meeting.summary = content.trim() || null;
      // Cancel the auto-completion timer since we have a real summary
      const timer = this.summarizingTimeouts.get(chatJid);
      if (timer) {
        clearTimeout(timer);
        this.summarizingTimeouts.delete(chatJid);
      }
      await this.transition(chatJid, 'completed');
      return true;
    }

    if (meeting.state !== 'in_progress') return false;

    // Check if this agent can speak
    if (!this.canSpeak(chatJid, agentName)) {
      logger.debug(
        { chatJid, agentName },
        'Agent cannot speak (turn limit or consecutive)',
      );
      return false;
    }

    // Record the turn
    const turn: Turn = {
      agent: agentName,
      content,
      timestamp: Date.now(),
    };
    meeting.turnHistory.push(turn);
    meeting.turns++;

    logger.debug(
      { chatJid, agentName, turn: meeting.turns, maxTurns: meeting.maxTurns },
      'Meeting turn recorded',
    );

    // Check termination conditions
    if (meeting.turns >= meeting.maxTurns) {
      await this.transition(chatJid, 'summarizing');
      return true;
    }

    if (Date.now() - meeting.startTime > meeting.maxDuration) {
      logger.info({ chatJid }, 'Meeting time limit reached');
      await this.transition(chatJid, 'summarizing');
      return true;
    }

    // Prompt the next agent in round-robin order
    await this.promptNextAgent(chatJid);

    return true;
  }

  /**
   * Get meeting history for a group (including completed meetings).
   */
  getMeetingHistory(chatJid: string): Meeting | null {
    return this.meetings.get(chatJid) || null;
  }

  // -------------------------------------------------------------------------
  // State machine transitions
  // -------------------------------------------------------------------------

  private async transition(
    chatJid: string,
    newState: MeetingState,
  ): Promise<void> {
    const meeting = this.meetings.get(chatJid);
    if (!meeting) {
      logger.error({ chatJid }, 'No meeting found for state transition');
      return;
    }

    // Clear summarizing timeout when leaving summarizing state
    if (meeting.state === 'summarizing' && newState !== 'summarizing') {
      const timer = this.summarizingTimeouts.get(chatJid);
      if (timer) {
        clearTimeout(timer);
        this.summarizingTimeouts.delete(chatJid);
      }
    }

    const oldState = meeting.state;
    meeting.state = newState;

    logger.info(
      { chatJid, meetingId: meeting.id, oldState, newState },
      'Meeting state transition',
    );

    this.emit('stateChange', {
      chatJid,
      meetingId: meeting.id,
      oldState,
      newState,
    });

    switch (newState) {
      case 'in_progress':
        await this.onInProgress(chatJid);
        break;
      case 'summarizing':
        await this.onSummarizing(chatJid);
        break;
      case 'completed':
        await this.onCompleted(chatJid);
        break;
      case 'cancelled':
        await this.onCancelled(chatJid);
        break;
    }
  }

  private async onInProgress(chatJid: string): Promise<void> {
    const meeting = this.meetings.get(chatJid);
    if (!meeting) return;

    // Mark all participants as busy
    for (const agentName of meeting.participants) {
      setAgentStatus(chatJid, agentName, 'busy');
    }

    // Prompt the moderator to present the agenda
    await this.promptAgent(
      chatJid,
      meeting.moderator,
      [
        `[SYSTEM] Meeting started. You are the Moderator.`,
        `Agenda: "${meeting.agenda}"`,
        `Participants: ${meeting.participants.map((p) => `@agent_${p}`).join(', ')}`,
        '',
        `Present the agenda to the group and invite discussion.`,
        `Keep your response concise (2-3 sentences max).`,
      ].join('\n'),
    );
  }

  private async onSummarizing(chatJid: string): Promise<void> {
    const meeting = this.meetings.get(chatJid);
    if (!meeting) return;

    // Build the transcript for the summary prompt
    const transcript = meeting.turnHistory
      .map((t) => {
        const prefix = getAgentPrefix(chatJid, t.agent);
        return `${prefix}: ${t.content}`;
      })
      .join('\n');

    await this.promptAgent(
      chatJid,
      meeting.moderator,
      [
        `[SYSTEM] Meeting concluded. Please summarize the discussion.`,
        '',
        `Agenda: "${meeting.agenda}"`,
        '',
        `Discussion transcript:`,
        transcript,
        '',
        `Provide a concise summary with:`,
        `1. Key points discussed`,
        `2. Decisions made`,
        `3. Action items (if any)`,
      ].join('\n'),
    );

    // Transition to completed after summary is generated
    // The orchestrator will call processAgentResponse which will
    // detect we're in "summarizing" state and trigger completion.
    // For now, auto-transition after a brief delay.
    const timer = setTimeout(async () => {
      this.summarizingTimeouts.delete(chatJid);
      const current = this.meetings.get(chatJid);
      if (current && current.state === 'summarizing') {
        // Use the last turn as the summary
        const lastTurn = current.turnHistory[current.turnHistory.length - 1];
        if (lastTurn) {
          current.summary = lastTurn.content;
        }
        await this.transition(chatJid, 'completed');
      }
    }, 5000);
    this.summarizingTimeouts.set(chatJid, timer);
  }

  private async onCompleted(chatJid: string): Promise<void> {
    const meeting = this.meetings.get(chatJid);
    if (!meeting) return;

    // Mark all participants as idle
    for (const agentName of meeting.participants) {
      setAgentStatus(chatJid, agentName, 'idle');
    }

    // Send meeting summary to the chat
    if (meeting.summary && this.deps) {
      const prefix = getAgentPrefix(chatJid, meeting.moderator);
      await this.deps.sendMessage(
        chatJid,
        [
          `Meeting Summary: "${meeting.agenda}"`,
          '',
          `${prefix}: ${meeting.summary}`,
          '',
          `Total turns: ${meeting.turns} | Duration: ${this.formatDuration(Date.now() - meeting.startTime)}`,
        ].join('\n'),
      );
    }

    // Save meeting log
    this.saveMeetingLog(meeting);

    this.emit('meetingCompleted', {
      chatJid,
      meetingId: meeting.id,
      summary: meeting.summary,
    });

    logger.info(
      { chatJid, meetingId: meeting.id, turns: meeting.turns },
      'Meeting completed',
    );
  }

  private async onCancelled(chatJid: string): Promise<void> {
    // Clear any pending summarizing timeout
    const timer = this.summarizingTimeouts.get(chatJid);
    if (timer) {
      clearTimeout(timer);
      this.summarizingTimeouts.delete(chatJid);
    }

    const meeting = this.meetings.get(chatJid);
    if (!meeting) return;

    // Mark all participants as idle
    for (const agentName of meeting.participants) {
      setAgentStatus(chatJid, agentName, 'idle');
    }

    if (this.deps) {
      await this.deps.sendMessage(chatJid, '[Meeting] Cancelled.');
    }

    this.emit('meetingCancelled', { chatJid, meetingId: meeting.id });

    logger.info({ chatJid, meetingId: meeting.id }, 'Meeting cancelled');
  }

  // -------------------------------------------------------------------------
  // Turn management
  // -------------------------------------------------------------------------

  /**
   * Check if an agent can take a turn in the meeting.
   */
  private canSpeak(chatJid: string, agentName: string): boolean {
    const meeting = this.meetings.get(chatJid);
    if (!meeting || meeting.state !== 'in_progress') return false;

    // Must be a participant
    if (!meeting.participants.includes(agentName)) return false;

    // No consecutive turns (same agent twice in a row)
    const lastTurn = meeting.turnHistory[meeting.turnHistory.length - 1];
    if (lastTurn && lastTurn.agent === agentName) return false;

    // Per-agent turn limit
    const agentTurns = meeting.turnHistory.filter(
      (t) => t.agent === agentName,
    ).length;
    if (agentTurns >= meeting.maxTurnsPerAgent) return false;

    // Total turn limit
    if (meeting.turns >= meeting.maxTurns) return false;

    return true;
  }

  /**
   * Prompt the next agent in round-robin order.
   */
  private async promptNextAgent(chatJid: string): Promise<void> {
    const meeting = this.meetings.get(chatJid);
    if (!meeting || meeting.state !== 'in_progress') return;

    // Find agents that can still speak
    const eligible = meeting.participants.filter((name) =>
      this.canSpeak(chatJid, name),
    );

    if (eligible.length === 0) {
      // No one can speak — summarize
      await this.transition(chatJid, 'summarizing');
      return;
    }

    // Round-robin: pick the agent who spoke least recently
    // (or hasn't spoken at all)
    let nextAgent = eligible[0];
    let lastSpokeAt = Infinity;

    for (const name of eligible) {
      const lastTurn = [...meeting.turnHistory]
        .reverse()
        .find((t) => t.agent === name);
      const spokeAt = lastTurn ? lastTurn.timestamp : 0;
      if (spokeAt < lastSpokeAt) {
        lastSpokeAt = spokeAt;
        nextAgent = name;
      }
    }

    // Build context from recent turns
    const recentTurns = meeting.turnHistory.slice(-5);
    const context = recentTurns
      .map((t) => {
        const prefix = getAgentPrefix(chatJid, t.agent);
        return `${prefix}: ${t.content}`;
      })
      .join('\n');

    const prompt = [
      `[SYSTEM] You are in a meeting about: "${meeting.agenda}"`,
      '',
      `Recent discussion:`,
      context || '(No turns yet)',
      '',
      `Respond concisely to continue the discussion. You are @agent_${nextAgent}.`,
      `Turn ${meeting.turns + 1} of ${meeting.maxTurns}.`,
    ].join('\n');

    await this.promptAgent(chatJid, nextAgent, prompt);
  }

  // -------------------------------------------------------------------------
  // Agent prompting
  // -------------------------------------------------------------------------

  /**
   * Send a prompt to an agent and deliver the response to the meeting.
   * If deps.promptAgent is available, use it. Otherwise, log and skip.
   */
  private async promptAgent(
    chatJid: string,
    agentName: string,
    prompt: string,
  ): Promise<void> {
    const prefix = getAgentPrefix(chatJid, agentName);

    if (this.deps?.promptAgent) {
      try {
        const response = await this.deps.promptAgent(
          chatJid,
          agentName,
          prompt,
        );

        // Record the turn
        if (response) {
          await this.processAgentResponse(chatJid, agentName, response);
        }
      } catch (err) {
        logger.error(
          { err, chatJid, agentName },
          'Failed to prompt agent in meeting',
        );
      }
    } else {
      logger.debug(
        { chatJid, agentName },
        'Meeting agent prompt (no deps, logging only)',
      );
    }
  }

  // -------------------------------------------------------------------------
  // Timeout checking
  // -------------------------------------------------------------------------

  private startTimeoutChecker(): void {
    this.timeoutChecker = setInterval(() => {
      for (const [chatJid, meeting] of this.meetings) {
        if (
          meeting.state === 'in_progress' &&
          Date.now() - meeting.startTime > meeting.maxDuration
        ) {
          logger.info(
            { chatJid, meetingId: meeting.id },
            'Meeting timeout, forcing summarization',
          );
          this.transition(chatJid, 'summarizing').catch((err) => {
            logger.error({ err, chatJid }, 'Error during meeting timeout');
          });
        }
      }
    }, 30_000); // Check every 30 seconds
  }

  private stopTimeoutChecker(): void {
    if (this.timeoutChecker) {
      clearInterval(this.timeoutChecker);
      this.timeoutChecker = null;
    }
  }

  // -------------------------------------------------------------------------
  // Utilities
  // -------------------------------------------------------------------------

  private hashAgenda(agenda: string): string {
    // Simple hash for topic deduplication (not cryptographic)
    let hash = 0;
    const normalized = agenda.toLowerCase().trim();
    for (let i = 0; i < normalized.length; i++) {
      const char = normalized.charCodeAt(i);
      hash = ((hash << 5) - hash + char) | 0;
    }
    return String(hash);
  }

  private formatDuration(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    if (minutes === 0) return `${seconds}s`;
    return `${minutes}m ${seconds % 60}s`;
  }

  private saveMeetingLog(meeting: Meeting): void {
    // Meeting logs are saved to the group's meetings/ directory
    // The actual file write is done via the orchestrator's IPC system
    this.emit('meetingLog', {
      meetingId: meeting.id,
      chatId: meeting.chatId,
      agenda: meeting.agenda,
      participants: meeting.participants,
      turns: meeting.turns,
      duration: Date.now() - meeting.startTime,
      summary: meeting.summary,
      turnHistory: meeting.turnHistory,
    });
  }

  // -------------------------------------------------------------------------
  // Daily count cleanup
  // -------------------------------------------------------------------------

  /**
   * Clean up stale daily counts (older than 2 days).
   * Called periodically to prevent memory leaks.
   */
  cleanupDailyCounts(): void {
    const today = new Date().toISOString().split('T')[0];
    for (const key of this.dailyCounts.keys()) {
      const datePart = key.split(':')[1];
      if (datePart && datePart !== today) {
        this.dailyCounts.delete(key);
      }
    }
  }
}
