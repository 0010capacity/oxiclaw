/**
 * Agent Manager for oxiclaw
 *
 * Manages multiple agent containers per Telegram group. Each group can have
 * multiple AI agents, each with their own persona and pi-mono SDK session.
 * This module handles agent registration, session lifecycle, and the mapping
 * between Telegram groups and their agent containers.
 *
 * Design: 1 group = 1 Docker container. Inside the container, pi-mono's
 * SessionManager manages individual agent sessions. The agent-manager at the
 * orchestrator level tracks which containers are running and which agents
 * exist per group.
 */

import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'fs';
import path from 'path';

import { GROUPS_DIR } from './config.js';
import { logger } from './logger.js';
import {
  ensureAgentDir,
  listAgentNames,
  loadPersona,
  loadAllPersonas,
  Persona,
} from './persona-loader.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AgentStatus = 'active' | 'idle' | 'busy' | 'error' | 'stopped';

export interface AgentInfo {
  /** Unique agent name within the group (also used as session ID). */
  name: string;
  /** The group/chat this agent belongs to. */
  chatId: string;
  /** Current agent status. */
  status: AgentStatus;
  /** Absolute path to the agent's working directory. */
  workDir: string;
  /** Whether a container is currently running for this agent's group. */
  hasContainer: boolean;
  /** Last activity timestamp (epoch ms). */
  lastActivity: number;
  /** Loaded persona (may be null if persona.md is missing). */
  persona: Persona | null;
}

export interface AgentGroup {
  /** The chat/group ID. */
  chatId: string;
  /** All agents registered for this group. */
  agents: Map<string, AgentInfo>;
  /** The Docker container ID running for this group (if any). */
  containerId: string | null;
  /** Whether the group container is currently running. */
  containerRunning: boolean;
}

// ---------------------------------------------------------------------------
// In-memory state
// ---------------------------------------------------------------------------

/** Map of chatId → AgentGroup. */
const groups = new Map<string, AgentGroup>();

/** Map of "${chatId}:${agentName}" → status for quick lookup. */
const agentStatusMap = new Map<string, AgentStatus>();

// ---------------------------------------------------------------------------
// Agent registration
// ---------------------------------------------------------------------------

/**
 * Register a new agent for a group.
 *
 * Creates the agent directory, generates a default persona.md if needed,
 * and tracks the agent in memory. Does NOT start a container — containers
 * are started on-demand by the message loop when messages arrive.
 *
 * @returns The created AgentInfo.
 */
export function registerAgent(
  chatId: string,
  agentName: string,
  personaOverrides?: {
    role?: string;
    description?: string;
    expertise?: string[];
    maxTurnsPerMeeting?: number;
  },
): AgentInfo {
  // Validate agent name: alphanumeric + underscore only
  if (!/^[a-zA-Z0-9_]+$/.test(agentName)) {
    throw new Error(
      `Invalid agent name "${agentName}". Use only letters, digits, and underscores.`,
    );
  }

  // Ensure the agent directory and persona.md exist
  const workDir = ensureAgentDir(chatId, agentName, personaOverrides);
  const persona = loadPersona(chatId, agentName);

  // Get or create the group entry
  let group = groups.get(chatId);
  if (!group) {
    group = {
      chatId,
      agents: new Map(),
      containerId: null,
      containerRunning: false,
    };
    groups.set(chatId, group);
  }

  // Check if agent already exists
  const existing = group.agents.get(agentName);
  if (existing) {
    logger.info(
      { chatId, agentName },
      'Agent already registered, updating persona',
    );
    existing.persona = persona;
    return existing;
  }

  const agentInfo: AgentInfo = {
    name: agentName,
    chatId,
    status: 'idle',
    workDir,
    hasContainer: false,
    lastActivity: Date.now(),
    persona,
  };

  group.agents.set(agentName, agentInfo);
  agentStatusMap.set(`${chatId}:${agentName}`, 'idle');

  logger.info(
    { chatId, agentName, role: persona?.role },
    'Agent registered',
  );

  return agentInfo;
}

/**
 * Unregister an agent from a group.
 *
 * Removes the agent from tracking. Does NOT delete the agent directory
 * or persona.md on disk — that must be done explicitly if desired.
 */
export function unregisterAgent(chatId: string, agentName: string): boolean {
  const group = groups.get(chatId);
  if (!group) return false;

  const removed = group.agents.delete(agentName);
  if (removed) {
    agentStatusMap.delete(`${chatId}:${agentName}`);
    logger.info({ chatId, agentName }, 'Agent unregistered');
  }
  return removed;
}

// ---------------------------------------------------------------------------
// Agent queries
// ---------------------------------------------------------------------------

/**
 * Get info for a specific agent in a group.
 */
export function getAgent(chatId: string, agentName: string): AgentInfo | null {
  const group = groups.get(chatId);
  if (!group) return null;
  return group.agents.get(agentName) || null;
}

/**
 * Get all agents for a group.
 */
export function getGroupAgents(chatId: string): AgentInfo[] {
  const group = groups.get(chatId);
  if (!group) return [];
  return [...group.agents.values()];
}

/**
 * Get active agents for a group (those with status !== 'stopped' && !== 'error').
 */
export function getActiveAgents(chatId: string): AgentInfo[] {
  return getGroupAgents(chatId).filter(
    (a) => a.status !== 'stopped' && a.status !== 'error',
  );
}

/**
 * Get the AgentGroup for a chat, or null if not tracked.
 */
export function getAgentGroup(chatId: string): AgentGroup | null {
  return groups.get(chatId) || null;
}

/**
 * Check if an agent exists for a group.
 */
export function agentExists(chatId: string, agentName: string): boolean {
  const group = groups.get(chatId);
  if (!group) return false;
  return group.agents.has(agentName);
}

// ---------------------------------------------------------------------------
// Agent status management
// ---------------------------------------------------------------------------

/**
 * Update the status of an agent.
 */
export function setAgentStatus(
  chatId: string,
  agentName: string,
  status: AgentStatus,
): void {
  const group = groups.get(chatId);
  if (!group) return;

  const agent = group.agents.get(agentName);
  if (!agent) return;

  agent.status = status;
  agent.lastActivity = Date.now();
  agentStatusMap.set(`${chatId}:${agentName}`, status);

  logger.debug({ chatId, agentName, status }, 'Agent status updated');
}

/**
 * Update last activity timestamp for an agent.
 */
export function touchAgent(chatId: string, agentName: string): void {
  const group = groups.get(chatId);
  if (!group) return;

  const agent = group.agents.get(agentName);
  if (!agent) return;

  agent.lastActivity = Date.now();
}

/**
 * Batch-update statuses for all agents in a group (e.g. when a container stops).
 */
export function setAllAgentStatuses(
  chatId: string,
  status: AgentStatus,
): void {
  const group = groups.get(chatId);
  if (!group) return;

  for (const [name, agent] of group.agents) {
    agent.status = status;
    agentStatusMap.set(`${chatId}:${name}`, status);
  }
}

// ---------------------------------------------------------------------------
// Container tracking
// ---------------------------------------------------------------------------

/**
 * Record that a container is now running for a group.
 */
export function setContainerRunning(
  chatId: string,
  containerId: string,
): void {
  let group = groups.get(chatId);
  if (!group) {
    group = {
      chatId,
      agents: new Map(),
      containerId: null,
      containerRunning: false,
    };
    groups.set(chatId, group);
  }

  group.containerId = containerId;
  group.containerRunning = true;

  // Mark all agents as idle (will be set to busy when they get work)
  for (const [name] of group.agents) {
    setAgentStatus(chatId, name, 'idle');
  }

  logger.info({ chatId, containerId }, 'Container marked as running');
}

/**
 * Record that a container has stopped for a group.
 */
export function setContainerStopped(chatId: string): void {
  const group = groups.get(chatId);
  if (!group) return;

  group.containerId = null;
  group.containerRunning = false;

  // Mark all agents as stopped
  for (const [name] of group.agents) {
    setAgentStatus(chatId, name, 'stopped');
  }

  logger.info({ chatId }, 'Container marked as stopped');
}

/**
 * Check if a group has a running container.
 */
export function isContainerRunning(chatId: string): boolean {
  const group = groups.get(chatId);
  return group?.containerRunning === true;
}

// ---------------------------------------------------------------------------
// Initialization / discovery
// ---------------------------------------------------------------------------

/**
 * Discover all existing agents by scanning the groups directory.
 *
 * Called at startup to repopulate in-memory state from disk.
 * Reads `groups/{chat_id}/agents/` directories.
 */
export function discoverAgents(): void {
  if (!existsSync(GROUPS_DIR)) {
    logger.info('No groups directory found, skipping agent discovery');
    return;
  }

  const chatDirs = readdirSync(GROUPS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  for (const chatId of chatDirs) {
    const agentNames = listAgentNames(chatId);
    if (agentNames.length === 0) continue;

    let group = groups.get(chatId);
    if (!group) {
      group = {
        chatId,
        agents: new Map(),
        containerId: null,
        containerRunning: false,
      };
      groups.set(chatId, group);
    }

    for (const agentName of agentNames) {
      // Only register if not already tracked (avoid overwriting runtime state)
      if (group.agents.has(agentName)) continue;

      const workDir = path.join(
        GROUPS_DIR, chatId, 'agents', agentName,
      );
      const persona = loadPersona(chatId, agentName);

      const agentInfo: AgentInfo = {
        name: agentName,
        chatId,
        status: 'stopped', // Not running until container starts
        workDir,
        hasContainer: false,
        lastActivity: 0,
        persona,
      };

      group.agents.set(agentName, agentInfo);
      agentStatusMap.set(`${chatId}:${agentName}`, 'stopped');
    }

    logger.info(
      { chatId, agentCount: agentNames.length },
      'Discovered agents for group',
    );
  }

  const totalAgents = [...groups.values()].reduce(
    (sum, g) => sum + g.agents.size,
    0,
  );
  logger.info(
    { groupCount: groups.size, totalAgents },
    'Agent discovery complete',
  );
}

/**
 * Get a summary of all groups and their agents for debugging/display.
 */
export function getAgentsSummary(): Array<{
  chatId: string;
  agents: Array<{ name: string; status: AgentStatus; role: string }>;
  containerRunning: boolean;
}> {
  const summary: Array<{
    chatId: string;
    agents: Array<{ name: string; status: AgentStatus; role: string }>;
    containerRunning: boolean;
  }> = [];

  for (const [chatId, group] of groups) {
    summary.push({
      chatId,
      agents: [...group.agents.values()].map((a) => ({
        name: a.name,
        status: a.status,
        role: a.persona?.role || a.name,
      })),
      containerRunning: group.containerRunning,
    });
  }

  return summary;
}

// ---------------------------------------------------------------------------
// Meeting helpers
// ---------------------------------------------------------------------------

/**
 * Get agents eligible to participate in a meeting.
 * Filters out stopped/error agents and returns at least those with personas.
 */
export function getMeetingParticipants(chatId: string): AgentInfo[] {
  return getActiveAgents(chatId).filter((a) => a.status !== 'busy');
}

/**
 * Select a moderator for a meeting.
 * Defaults to the first active agent, but could be overridden.
 */
export function selectModerator(chatId: string): AgentInfo | null {
  const active = getActiveAgents(chatId);
  if (active.length === 0) return null;

  // Prefer the first agent with a persona that mentions "moderator"
  const moderator = active.find(
    (a) =>
      a.persona?.role?.toLowerCase().includes('moderator') ||
      a.persona?.role?.toLowerCase().includes('lead'),
  );
  return moderator || active[0];
}
