import fs from 'fs';
import path from 'path';

import {
  ASSISTANT_NAME,
  DATA_DIR,
  DEFAULT_TRIGGER,
  getTriggerPattern,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  MAX_MESSAGES_PER_PROMPT,
  POLL_INTERVAL,
  TIMEZONE,
} from './config.js';
import './channels/index.js';
import {
  getChannelFactory,
  getRegisteredChannelNames,
} from './channels/registry.js';
import { getSwarmRouter } from './channels/telegram/bot.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  cleanupOrphans,
  ensureContainerRuntimeRunning,
} from './container-runtime.js';
import { addExtension, listExtensions } from './extension-manager.js';
import {
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  deleteSession,
  getAllTasks,
  getLastBotMessageTimestamp,
  getMessagesSince,
  getNewMessages,
  getRouterState,
  initDatabase,
  setRegisteredGroup,
  setRouterState,
  setSession,
  storeChatMetadata,
  storeMessage,
  createAgentSession,
  endAgentSession,
  updateAgentSession,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { startIpcWatcher } from './ipc.js';
import { findChannel, formatMessages, formatOutbound } from './router.js';
import {
  restoreRemoteControl,
  startRemoteControl,
  stopRemoteControl,
} from './remote-control.js';
import {
  isSenderAllowed,
  isTriggerAllowed,
  loadSenderAllowlist,
  shouldDropMessage,
} from './sender-allowlist.js';
import { startHealthChecker } from './health-checker.js';
import { startSessionCleanup } from './session-cleanup.js';
import {
  initAutonomousMessages,
  getAutonomousMessageManager,
} from './autonomous-messages.js';
import {
  discoverAgents,
  getActiveAgents,
  setAgentStatus,
  setContainerRunning,
  touchAgent,
} from './agent-manager.js';
import { loadSystemPrompt } from './persona-loader.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { Channel, NewMessage, RegisteredGroup } from './types.js';
import { logger } from './logger.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

let lastTimestamp = '';
let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
let messageLoopRunning = false;

const channels: Channel[] = [];
const queue = new GroupQueue();

function loadState(): void {
  lastTimestamp = getRouterState('last_timestamp') || '';
  const agentTs = getRouterState('last_agent_timestamp');
  try {
    lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
  } catch {
    logger.warn('Corrupted last_agent_timestamp in DB, resetting');
    lastAgentTimestamp = {};
  }
  sessions = getAllSessions();
  registeredGroups = getAllRegisteredGroups();
  logger.info(
    { groupCount: Object.keys(registeredGroups).length },
    'State loaded',
  );
}

/**
 * Return the message cursor for a group, recovering from the last bot reply
 * if lastAgentTimestamp is missing (new group, corrupted state, restart).
 */
function getOrRecoverCursor(chatJid: string): string {
  const existing = lastAgentTimestamp[chatJid];
  if (existing) return existing;

  const botTs = getLastBotMessageTimestamp(chatJid, ASSISTANT_NAME);
  if (botTs) {
    logger.info(
      { chatJid, recoveredFrom: botTs },
      'Recovered message cursor from last bot reply',
    );
    lastAgentTimestamp[chatJid] = botTs;
    saveState();
    return botTs;
  }
  return '';
}

function saveState(): void {
  setRouterState('last_timestamp', lastTimestamp);
  setRouterState('last_agent_timestamp', JSON.stringify(lastAgentTimestamp));
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(group.folder);
  } catch (err) {
    logger.warn(
      { jid, folder: group.folder, err },
      'Rejecting group registration with invalid folder',
    );
    return;
  }

  registeredGroups[jid] = group;
  setRegisteredGroup(jid, group);

  // Create group folder
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  // Copy CLAUDE.md template into the new group folder so agents have
  // identity and instructions from the first run.  (Fixes #1391)
  const groupMdFile = path.join(groupDir, 'CLAUDE.md');
  if (!fs.existsSync(groupMdFile)) {
    const templateFile = path.join(
      GROUPS_DIR,
      group.isMain ? 'main' : 'global',
      'CLAUDE.md',
    );
    if (fs.existsSync(templateFile)) {
      let content = fs.readFileSync(templateFile, 'utf-8');
      if (ASSISTANT_NAME !== 'Andy') {
        content = content.replace(/^# Andy$/m, `# ${ASSISTANT_NAME}`);
        content = content.replace(/You are Andy/g, `You are ${ASSISTANT_NAME}`);
      }
      fs.writeFileSync(groupMdFile, content);
      logger.info({ folder: group.folder }, 'Created CLAUDE.md from template');
    }
  }

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
}

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
export function getAvailableGroups(): import('./container-runner.js').AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));

  return chats
    .filter((c) => c.jid !== '__group_sync__' && c.is_group)
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}

/** @internal - exported for testing */
export function _setRegisteredGroups(
  groups: Record<string, RegisteredGroup>,
): void {
  registeredGroups = groups;
}

/**
 * Process all pending messages for a group.
 * Called by the GroupQueue when it's this group's turn.
 */
async function processGroupMessages(chatJid: string): Promise<boolean> {
  const group = registeredGroups[chatJid];
  if (!group) return true;

  const channel = findChannel(channels, chatJid);
  if (!channel) {
    logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
    return true;
  }

  const isMainGroup = group.isMain === true;

  const missedMessages = getMessagesSince(
    chatJid,
    getOrRecoverCursor(chatJid),
    ASSISTANT_NAME,
    MAX_MESSAGES_PER_PROMPT,
  );

  if (missedMessages.length === 0) return true;

  // For non-main groups, check if trigger is required and present
  if (!isMainGroup && group.requiresTrigger !== false) {
    const triggerPattern = getTriggerPattern(group.trigger);
    const allowlistCfg = loadSenderAllowlist();
    const hasTrigger = missedMessages.some(
      (m) =>
        triggerPattern.test(m.content.trim()) &&
        (m.is_from_me || isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
    );
    if (!hasTrigger) return true;
  }

  const prompt = formatMessages(missedMessages, TIMEZONE);

  // Advance cursor so the piping path in startMessageLoop won't re-fetch
  // these messages. Save the old cursor so we can roll back on error.
  const previousCursor = lastAgentTimestamp[chatJid] || '';
  lastAgentTimestamp[chatJid] =
    missedMessages[missedMessages.length - 1].timestamp;
  saveState();

  logger.info(
    { group: group.name, messageCount: missedMessages.length },
    'Processing messages',
  );

  // Track idle timer for closing stdin when agent is idle
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug(
        { group: group.name },
        'Idle timeout, closing container stdin',
      );
      queue.closeStdin(chatJid);
    }, IDLE_TIMEOUT);
  };

  await channel.setTyping?.(chatJid, true);
  let hadError = false;
  let outputSentToUser = false;

  const output = await runAgent(group, prompt, chatJid, async (result) => {
    // Streaming output callback — called for each agent result
    if (result.result) {
      const raw =
        typeof result.result === 'string'
          ? result.result
          : JSON.stringify(result.result);
      // Strip <internal>...</internal> blocks — agent uses these for internal reasoning
      const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
      logger.info({ group: group.name }, `Agent output: ${raw.length} chars`);
      if (text) {
        await channel.sendMessage(chatJid, text);
        outputSentToUser = true;
      }
      // Check for autonomous message triggers after each agent response
      const autoManager = getAutonomousMessageManager();
      if (autoManager) {
        const sessionId = `group-${group.folder}`;
        await autoManager.handleAgentResponse(sessionId, chatJid, text);
      }
      // Only reset idle timer on actual results, not session-update markers (result: null)
      resetIdleTimer();
    }

    if (result.status === 'success') {
      queue.notifyIdle(chatJid);
    }

    if (result.status === 'error') {
      hadError = true;
    }
  });

  await channel.setTyping?.(chatJid, false);
  if (idleTimer) clearTimeout(idleTimer);

  if (output === 'error' || hadError) {
    // If we already sent output to the user, don't roll back the cursor —
    // the user got their response and re-processing would send duplicates.
    if (outputSentToUser) {
      logger.warn(
        { group: group.name },
        'Agent error after output was sent, skipping cursor rollback to prevent duplicates',
      );
      return true;
    }
    // Roll back cursor so retries can re-process these messages
    lastAgentTimestamp[chatJid] = previousCursor;
    saveState();
    logger.warn(
      { group: group.name },
      'Agent error, rolled back message cursor for retry',
    );
    return false;
  }

  return true;
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<'success' | 'error'> {
  const isMain = group.isMain === true;
  const sessionId = sessions[group.folder];

  // Update tasks snapshot for container to read (filtered by group)
  const tasks = getAllTasks();
  writeTasksSnapshot(
    group.folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      script: t.script || undefined,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  // Update available groups snapshot (main group only can see all groups)
  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(
    group.folder,
    isMain,
    availableGroups,
    new Set(Object.keys(registeredGroups)),
  );

  // Wrap onOutput to track session ID from streamed results
  const wrappedOnOutput = onOutput
    ? async (output: ContainerOutput) => {
        if (output.newSessionId) {
          sessions[group.folder] = output.newSessionId;
          setSession(group.folder, output.newSessionId);
        }
        await onOutput(output);
      }
    : undefined;

  // Track agent session in SQLite for health checker monitoring
  // Declared outside try so catch block can also end the session
  const agentSessionId = `agent-${group.folder}-${Date.now()}`;
  createAgentSession({
    id: agentSessionId,
    group_id: group.folder,
    container_id: group.folder, // Use group folder as container ID for lookup
    metadata: { chatJid, isMain },
  });

  try {
    let registeredContainerName: string | null = null;
    const output = await runContainerAgent(
      group,
      {
        prompt,
        sessionId,
        groupFolder: group.folder,
        chatJid,
        isMain,
        assistantName: ASSISTANT_NAME,
      },
      (proc, containerName) => {
        registeredContainerName = containerName;
        queue.registerProcess(chatJid, proc, containerName, group.folder);
      },
      wrappedOnOutput,
    );

    // Update session with container name for health check lookup
    if (registeredContainerName) {
      updateAgentSession(agentSessionId, {
        container_id: registeredContainerName,
      });
    }

    // End the agent session
    endAgentSession(agentSessionId);

    if (output.newSessionId) {
      sessions[group.folder] = output.newSessionId;
      setSession(group.folder, output.newSessionId);
    }

    if (output.status === 'error') {
      // Detect stale/corrupt session — clear it so the next retry starts fresh.
      // The session .jsonl can go missing after a crash mid-write, manual
      // deletion, or disk-full. The existing backoff in group-queue.ts
      // handles the retry; we just need to remove the broken session ID.
      const isStaleSession =
        sessionId &&
        output.error &&
        /no conversation found|ENOENT.*\.jsonl|session.*not found/i.test(
          output.error,
        );

      if (isStaleSession) {
        logger.warn(
          { group: group.name, staleSessionId: sessionId, error: output.error },
          'Stale session detected — clearing for next retry',
        );
        delete sessions[group.folder];
        deleteSession(group.folder);
      }

      logger.error(
        { group: group.name, error: output.error },
        'Container agent error',
      );
      return 'error';
    }

    // Check for restart sentinel (skill install triggered)
    const restartFile = path.join(
      DATA_DIR,
      'sessions',
      group.folder,
      '.restart-skill',
    );
    if (fs.existsSync(restartFile)) {
      try {
        fs.unlinkSync(restartFile);
      } catch {
        /* ignore */
      }
      logger.info(
        { group: group.name },
        'Restarting container for skill update',
      );
      queue.restartGroup(chatJid);
    }

    return 'success';
  } catch (err) {
    endAgentSession(agentSessionId);
    logger.error({ group: group.name, err }, 'Agent error');
    return 'error';
  }
}

async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;

  logger.info(`OxiClaw running (default trigger: ${DEFAULT_TRIGGER})`);

  while (true) {
    try {
      const jids = Object.keys(registeredGroups);
      const { messages, newTimestamp } = getNewMessages(
        jids,
        lastTimestamp,
        ASSISTANT_NAME,
      );

      if (messages.length > 0) {
        logger.info({ count: messages.length }, 'New messages');

        // Advance the "seen" cursor for all messages immediately
        lastTimestamp = newTimestamp;
        saveState();

        // Deduplicate by group
        const messagesByGroup = new Map<string, NewMessage[]>();
        for (const msg of messages) {
          const existing = messagesByGroup.get(msg.chat_jid);
          if (existing) {
            existing.push(msg);
          } else {
            messagesByGroup.set(msg.chat_jid, [msg]);
          }
        }

        for (const [chatJid, groupMessages] of messagesByGroup) {
          const group = registeredGroups[chatJid];
          if (!group) continue;

          const channel = findChannel(channels, chatJid);
          if (!channel) {
            logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
            continue;
          }

          const isMainGroup = group.isMain === true;
          const needsTrigger = !isMainGroup && group.requiresTrigger !== false;

          // For non-main groups, only act on trigger messages.
          // Non-trigger messages accumulate in DB and get pulled as
          // context when a trigger eventually arrives.
          if (needsTrigger) {
            const triggerPattern = getTriggerPattern(group.trigger);
            const allowlistCfg = loadSenderAllowlist();
            const hasTrigger = groupMessages.some(
              (m) =>
                triggerPattern.test(m.content.trim()) &&
                (m.is_from_me ||
                  isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
            );
            if (!hasTrigger) continue;
          }

          // Pull all messages since lastAgentTimestamp so non-trigger
          // context that accumulated between triggers is included.
          const allPending = getMessagesSince(
            chatJid,
            getOrRecoverCursor(chatJid),
            ASSISTANT_NAME,
            MAX_MESSAGES_PER_PROMPT,
          );
          const messagesToSend =
            allPending.length > 0 ? allPending : groupMessages;
          const formatted = formatMessages(messagesToSend, TIMEZONE);

          if (queue.sendMessage(chatJid, formatted)) {
            logger.debug(
              { chatJid, count: messagesToSend.length },
              'Piped messages to active container',
            );
            lastAgentTimestamp[chatJid] =
              messagesToSend[messagesToSend.length - 1].timestamp;
            saveState();
            // Show typing indicator while the container processes the piped message
            channel
              .setTyping?.(chatJid, true)
              ?.catch((err) =>
                logger.warn({ chatJid, err }, 'Failed to set typing indicator'),
              );
          } else {
            // No active container — enqueue for a new one
            queue.enqueueMessageCheck(chatJid);
          }
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

/**
 * Startup recovery: check for unprocessed messages in registered groups.
 * Handles crash between advancing lastTimestamp and processing messages.
 */
function recoverPendingMessages(): void {
  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    const pending = getMessagesSince(
      chatJid,
      getOrRecoverCursor(chatJid),
      ASSISTANT_NAME,
      MAX_MESSAGES_PER_PROMPT,
    );
    if (pending.length > 0) {
      logger.info(
        { group: group.name, pendingCount: pending.length },
        'Recovery: found unprocessed messages',
      );
      queue.enqueueMessageCheck(chatJid);
    }
  }
}

function ensureContainerSystemRunning(): void {
  ensureContainerRuntimeRunning();
  cleanupOrphans();
}

async function main(): Promise<void> {
  ensureContainerSystemRunning();
  initDatabase();
  logger.info('Database initialized');
  loadState();

  // Auto-install skill-manager pi Extension for all registered groups.
  // This gives container agents LLM-callable tools for skill management.
  for (const [_jid, group] of Object.entries(registeredGroups)) {
    const extensions = listExtensions(group.folder);
    if (!extensions.includes('skill-manager')) {
      try {
        addExtension(group.folder, 'skill-manager');
        logger.info(
          { group: group.folder },
          'Auto-installed skill-manager extension',
        );
        // Trigger container restart so the new extension is picked up
        const restartFile = path.join(
          DATA_DIR,
          'sessions',
          group.folder,
          '.restart-skill',
        );
        fs.mkdirSync(path.dirname(restartFile), { recursive: true });
        fs.writeFileSync(restartFile, '');
      } catch (err) {
        logger.warn(
          { err, group: group.folder },
          'Failed to auto-install skill-manager',
        );
      }
    }
  }

  restoreRemoteControl();

  // Discover existing agents from disk at startup
  discoverAgents();

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    await queue.shutdown(10000);
    for (const ch of channels) await ch.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Handle /remote-control and /remote-control-end commands
  async function handleRemoteControl(
    command: string,
    chatJid: string,
    msg: NewMessage,
  ): Promise<void> {
    const group = registeredGroups[chatJid];
    if (!group?.isMain) {
      logger.warn(
        { chatJid, sender: msg.sender },
        'Remote control rejected: not main group',
      );
      return;
    }

    const channel = findChannel(channels, chatJid);
    if (!channel) return;

    if (command === '/remote-control') {
      const result = await startRemoteControl(
        msg.sender,
        chatJid,
        process.cwd(),
      );
      if (result.ok) {
        await channel.sendMessage(chatJid, result.url);
      } else {
        await channel.sendMessage(
          chatJid,
          `Remote Control failed: ${result.error}`,
        );
      }
    } else {
      const result = stopRemoteControl();
      if (result.ok) {
        await channel.sendMessage(chatJid, 'Remote Control session ended.');
      } else {
        await channel.sendMessage(chatJid, result.error);
      }
    }
  }

  // Channel callbacks (shared by all channels)
  const channelOpts = {
    onMessage: (chatJid: string, msg: NewMessage) => {
      // Remote control commands — intercept before storage
      const trimmed = msg.content.trim();
      if (trimmed === '/remote-control' || trimmed === '/remote-control-end') {
        handleRemoteControl(trimmed, chatJid, msg).catch((err) =>
          logger.error({ err, chatJid }, 'Remote control command error'),
        );
        return;
      }

      // Sender allowlist drop mode: discard messages from denied senders before storing
      if (!msg.is_from_me && !msg.is_bot_message && registeredGroups[chatJid]) {
        const cfg = loadSenderAllowlist();
        if (
          shouldDropMessage(chatJid, cfg) &&
          !isSenderAllowed(chatJid, msg.sender, cfg)
        ) {
          if (cfg.logDenied) {
            logger.debug(
              { chatJid, sender: msg.sender },
              'sender-allowlist: dropping message (drop mode)',
            );
          }
          return;
        }
      }
      storeMessage(msg);
    },
    onChatMetadata: (
      chatJid: string,
      timestamp: string,
      name?: string,
      channel?: string,
      isGroup?: boolean,
    ) => storeChatMetadata(chatJid, timestamp, name, channel, isGroup),
    registeredGroups: () => registeredGroups,
  };

  // Create and connect all registered channels.
  // Each channel self-registers via the barrel import above.
  // Factories return null when credentials are missing, so unconfigured channels are skipped.
  for (const channelName of getRegisteredChannelNames()) {
    const factory = getChannelFactory(channelName)!;
    const channel = factory(channelOpts);
    if (!channel) {
      logger.warn(
        { channel: channelName },
        'Channel installed but credentials missing — skipping. Check .env or re-run the channel skill.',
      );
      continue;
    }
    channels.push(channel);
    await channel.connect();
  }
  if (channels.length === 0) {
    logger.fatal('No channels connected');
    process.exit(1);
  }

  // Start subsystems (independently of connection handler)
  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    queue,
    onProcess: (groupJid, proc, containerName, groupFolder) =>
      queue.registerProcess(groupJid, proc, containerName, groupFolder),
    sendMessage: async (jid, rawText) => {
      const channel = findChannel(channels, jid);
      if (!channel) {
        logger.warn({ jid }, 'No channel owns JID, cannot send message');
        return;
      }
      const text = formatOutbound(rawText);
      if (text) await channel.sendMessage(jid, text);
    },
  });
  startIpcWatcher({
    sendMessage: (jid, text) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      return channel.sendMessage(jid, text);
    },
    sendFile: (jid, filePath, caption) => {
      const channel = findChannel(channels, jid);
      if (!channel?.sendFile)
        throw new Error(`Channel does not support sendFile`);
      return channel.sendFile(jid, filePath, caption);
    },
    registeredGroups: () => registeredGroups,
    registerGroup,
    syncGroups: async (force: boolean) => {
      await Promise.all(
        channels
          .filter((ch) => ch.syncGroups)
          .map((ch) => ch.syncGroups!(force)),
      );
    },
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag, rj) =>
      writeGroupsSnapshot(gf, im, ag, rj),
    onTasksChanged: () => {
      const tasks = getAllTasks();
      const taskRows = tasks.map((t) => ({
        id: t.id,
        groupFolder: t.group_folder,
        prompt: t.prompt,
        script: t.script || undefined,
        schedule_type: t.schedule_type,
        schedule_value: t.schedule_value,
        status: t.status,
        next_run: t.next_run,
      }));
      for (const group of Object.values(registeredGroups)) {
        writeTasksSnapshot(group.folder, group.isMain === true, taskRows);
      }
    },
  });
  startSessionCleanup();
  initAutonomousMessages({
    sendMessage: async (jid: string, text: string) => {
      const channel = findChannel(channels, jid);
      if (!channel) {
        logger.warn(
          { jid },
          'No channel owns JID, cannot send autonomous message',
        );
        return;
      }
      const formatted = formatOutbound(text);
      if (formatted) await channel.sendMessage(jid, formatted);
    },
    promptAgent: async () => {
      // promptAgent is not used for autonomous messages — responses arrive via
      // handleAgentResponse which is called by the orchestrator's message flow.
      return '';
    },
  });
  startHealthChecker({
    sendHealthCheck: async (containerId: string) => {
      // Transport: write JSON-RPC request to a temp file, container writes response
      // to another temp file which we poll. This is the same pattern as the
      // built-in sendHealthCheckViaIPC but triggered via stdin so the container
      // knows it's a health check (vs. task IPC files).
      const tmpDir = fs.realpathSync(process.env.TMPDIR || '/tmp');
      const requestFile = path.join(
        tmpDir,
        `oxiclaw-health-${containerId}.json`,
      );
      const responseFile = path.join(
        tmpDir,
        `oxiclaw-health-${containerId}-resp.json`,
      );

      const requestId = `health-${Date.now()}`;
      const request = {
        jsonrpc: '2.0',
        id: requestId,
        method: 'health_check',
        params: {},
      };

      // Clean up stale response file
      try {
        fs.unlinkSync(responseFile);
      } catch {
        /* ignore */
      }

      // Write request atomically
      const tmpRequest = `${requestFile}.tmp`;
      fs.writeFileSync(tmpRequest, JSON.stringify(request) + '\n');
      fs.renameSync(tmpRequest, requestFile);

      // Also send via stdin so container processes it immediately
      const stdin = queue.getStdin(
        Object.keys(registeredGroups).find(
          (jid) => queue.getContainerName(jid) === containerId,
        ) || '',
      );
      if (stdin) {
        try {
          stdin.write(JSON.stringify(request) + '\n');
        } catch {
          /* stdin may not be writable */
        }
      }

      // Poll for response file with timeout
      return new Promise<import('./health-checker.js').HealthCheckResponse>(
        (resolve, reject) => {
          const deadline = Date.now() + 10_000;
          const pollInterval = setInterval(() => {
            if (Date.now() > deadline) {
              clearInterval(pollInterval);
              try {
                fs.unlinkSync(requestFile);
              } catch {
                /* ignore */
              }
              reject(new Error('Health check request timed out'));
              return;
            }
            try {
              if (fs.existsSync(responseFile)) {
                clearInterval(pollInterval);
                const content = fs.readFileSync(responseFile, 'utf-8');
                try {
                  fs.unlinkSync(responseFile);
                } catch {
                  /* ignore */
                }
                try {
                  fs.unlinkSync(requestFile);
                } catch {
                  /* ignore */
                }
                const response = JSON.parse(content);
                resolve(
                  response as import('./health-checker.js').HealthCheckResponse,
                );
              }
            } catch {
              /* poll continues */
            }
          }, 500);
        },
      );
    },
    onRestartNeeded: async (session) => {
      logger.warn(
        {
          sessionId: session.id,
          groupId: session.group_id,
          containerId: session.container_id,
        },
        '[health-checker] Container restart needed but not fully implemented — session marked as error',
      );
      // TODO: Implement proper container restart by:
      // 1. Storing session metadata (prompt, sessionId) when creating sessions
      // 2. Looking up the last prompt from session metadata here
      // 3. Calling runContainerAgent with the stored prompt to restart
    },
  });
  queue.setProcessMessagesFn(processGroupMessages);
  recoverPendingMessages();

  // Register SwarmRouter onRoute handler for agent mention routing
  const swarmRouter = getSwarmRouter();
  if (swarmRouter) {
    swarmRouter.onRoute(async (msg) => {
      logger.info(
        {
          agentName: msg.agentName,
          chatJid: msg.chatJid,
          isAll: msg.isAllMention,
        },
        'SwarmRouter routing message to pi-mono container via IPC',
      );

      const group = registeredGroups[msg.chatJid];
      if (!group) {
        logger.warn(
          { chatJid: msg.chatJid },
          'Swarm route: group not registered',
        );
        return;
      }

      // Build the full prompt with sender context and agent mention
      const fullPrompt = `[To: @agent_${msg.agentName}]\nFrom: ${msg.sender}\n\n${msg.prompt}`;

      // Load the agent's persona system prompt
      const systemPrompt = loadSystemPrompt(msg.chatJid, msg.agentName);

      // Combine system prompt + user prompt for the container
      const containerPrompt = `${systemPrompt}\n\n---\nUser message:\n${fullPrompt}`;

      // For mention-all, route to all active agents in parallel
      // For single agent, route to just that agent
      const agentNames = msg.isAllMention
        ? getActiveAgents(msg.chatJid).map((a) => a.name)
        : [msg.agentName];

      const results = await Promise.allSettled(
        agentNames.map((agentName) => {
          // Mark agent as busy
          setAgentStatus(msg.chatJid, agentName, 'busy');
          touchAgent(msg.chatJid, agentName);

          return runContainerAgent(
            group,
            {
              prompt: containerPrompt,
              sessionId: agentName,
              groupFolder: group.folder,
              chatJid: msg.chatJid,
              isMain: group.isMain === true,
              assistantName: ASSISTANT_NAME,
            },
            (_proc, _containerName) => {
              // Register process with the group queue so it can be tracked
              // The swarm router uses ephemeral containers, not queue-managed ones,
              // so this is a no-op for swarm routing (queue checks for existing containers)
              setContainerRunning(msg.chatJid, _containerName);
            },
            async (output) => {
              // Streaming output callback — deliver each result to Telegram as it arrives
              if (output.result) {
                const text = output.result
                  .replace(/<internal>[\s\S]*?<\/internal>/g, '')
                  .trim();
                if (text) {
                  await swarmRouter!.deliverResponse(
                    msg.chatJid,
                    agentName,
                    text,
                    msg.messageId,
                  );
                }
                // Check for autonomous message triggers after each agent response
                const autoManager = getAutonomousMessageManager();
                if (autoManager) {
                  const sessionId = `swarm-${msg.chatJid}-${agentName}`;
                  await autoManager.handleAgentResponse(
                    sessionId,
                    msg.chatJid,
                    text,
                  );
                }
              }
              if (output.status === 'success') {
                setAgentStatus(msg.chatJid, agentName, 'idle');
              }
              if (output.status === 'error') {
                setAgentStatus(msg.chatJid, agentName, 'error');
                logger.error(
                  { agentName, chatJid: msg.chatJid, error: output.error },
                  'Swarm agent error',
                );
                // Send error message to Telegram
                await swarmRouter!.deliverResponse(
                  msg.chatJid,
                  agentName,
                  `Error: ${output.error || 'Unknown error'}`,
                  msg.messageId,
                );
              }
            },
          )
            .then(async (output) => {
              // Final cleanup after container exits
              // Note: setContainerStopped is NOT called here — swarm containers are
              // ephemeral and not managed by the group queue. Calling it would mark
              // ALL agents in the group as stopped, corrupting status in mention-all
              // scenarios where other agents are still running.
              setAgentStatus(msg.chatJid, agentName, 'idle');

              // If there was a final result not already sent via streaming (result is null on success after streaming)
              if (output.status === 'error') {
                logger.error(
                  { agentName, chatJid: msg.chatJid, error: output.error },
                  'Swarm agent container error',
                );
              }
            })
            .catch((err) => {
              // Handle promise rejection (container spawn failure, etc.)
              setAgentStatus(msg.chatJid, agentName, 'error');
              // Note: setContainerStopped not called — see comment in .then() block above
              logger.error(
                { agentName, chatJid: msg.chatJid, err },
                'Swarm agent container spawn error',
              );
              swarmRouter!
                .deliverResponse(
                  msg.chatJid,
                  agentName,
                  `Error: ${err instanceof Error ? err.message : String(err)}`,
                  msg.messageId,
                )
                .catch((e) =>
                  logger.error(
                    { err: e },
                    'Failed to deliver error to Telegram',
                  ),
                );
            });
        }),
      );

      // Log any failed agent routes
      for (const [i, r] of results.entries()) {
        if (r.status === 'rejected') {
          logger.error(
            { agentName: agentNames[i], reason: r.reason },
            'Swarm route promise rejected',
          );
        }
      }
    });
  } else {
    logger.debug(
      'SwarmRouter not initialized yet (Telegram channel may not be connected)',
    );
  }
  startMessageLoop().catch((err) => {
    logger.fatal({ err }, 'Message loop crashed unexpectedly');
    process.exit(1);
  });
}

// Guard: only run when executed directly, not when imported by tests
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start OxiClaw');
    process.exit(1);
  });
}
