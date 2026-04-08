/**
 * Persona Loader for oxiclaw
 *
 * Reads persona.md files from group/agent directories and builds system prompts.
 * Supports YAML frontmatter for structured metadata and Markdown body for freeform
 * instructions. Loaded at session creation time and injected as system prompts.
 *
 * File layout:
 *   groups/{chat_id}/agents/{agent_name}/persona.md
 *
 * persona.md format:
 *   ---
 *   role: marketer
 *   description: Handles brand marketing and user growth strategy
 *   tone: Professional but friendly, concise and impactful
 *   expertise: ["brand positioning", "content marketing", "data analysis"]
 *   response_prefix: "[Marketer]"
 *   max_turns_per_meeting: 3
 *   ---
 *   Additional freeform instructions in Markdown...
 */

import { existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync } from 'fs';
import path from 'path';

import { GROUPS_DIR } from './config.js';
import { logger } from './logger.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PersonaFrontmatter {
  role: string;
  description: string;
  tone?: string;
  expertise?: string[];
  response_prefix?: string;
  max_turns_per_meeting?: number;
  /** Additional arbitrary YAML keys are preserved here. */
  [key: string]: unknown;
}

export interface Persona {
  role: string;
  description: string;
  tone: string;
  expertise: string[];
  responsePrefix: string;
  maxTurnsPerMeeting: number;
  /** The raw body after frontmatter (freeform Markdown instructions). */
  body: string;
  /** The assembled system prompt used for session creation. */
  systemPrompt: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_TONE = 'Helpful and professional';
const DEFAULT_MAX_TURNS_PER_MEETING = 3;
const AGENTS_SUBDIR = 'agents';
const PERSONA_FILENAME = 'persona.md';

// ---------------------------------------------------------------------------
// YAML frontmatter parsing (lightweight — avoids a full YAML dependency)
// ---------------------------------------------------------------------------

/**
 * Parse simple YAML frontmatter key-value pairs.
 * Handles:
 *   key: value
 *   key: ["a", "b", "c"]   (string arrays)
 *   key: 3                  (numbers)
 *
 * For complex nested YAML, callers should provide a `yaml` module via
 * `setYamlParser()`. The default parser covers the persona.md spec.
 */
function parseSimpleYaml(raw: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const colonIdx = trimmed.indexOf(':');
    if (colonIdx === -1) continue;

    const key = trimmed.slice(0, colonIdx).trim();
    let value: unknown = trimmed.slice(colonIdx + 1).trim();

    // Strip surrounding quotes
    if (typeof value === 'string') {
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
    }

    // Parse JSON arrays: ["a", "b"]
    if (typeof value === 'string' && value.startsWith('[')) {
      try {
        value = JSON.parse(value as string);
      } catch {
        // Keep as string if unparseable
      }
    }

    // Parse numbers
    if (typeof value === 'string' && /^\d+$/.test(value as string)) {
      value = Number(value);
    }

    result[key] = value;
  }
  return result;
}

// Allow optional injection of a full YAML parser (e.g. `yaml` npm package).
let yamlParser: ((raw: string) => Record<string, unknown>) | null = null;

/**
 * Inject a full YAML parser for complex frontmatter.
 * Call once at startup if the `yaml` package is available.
 *
 * ```ts
 * import { parse as yamlParse } from 'yaml';
 * setYamlParser(yamlParse);
 * ```
 */
export function setYamlParser(parser: (raw: string) => Record<string, unknown>): void {
  yamlParser = parser;
}

// ---------------------------------------------------------------------------
// Core loader
// ---------------------------------------------------------------------------

/**
 * Parse a persona.md file and return a fully resolved `Persona`.
 *
 * @param filePath - Absolute path to the persona.md file.
 * @returns A `Persona` object with defaults applied for missing fields.
 */
export function parsePersonaFile(filePath: string): Persona | null {
  if (!existsSync(filePath)) {
    return null;
  }

  const content = readFileSync(filePath, 'utf-8');

  // Match YAML frontmatter block: ---\n...\n---\n
  const frontmatterRegex = /^---\r?\n([\s\S]+?)\r?\n---\r?\n([\s\S]*)$/;
  const match = content.match(frontmatterRegex);

  let frontmatter: Record<string, unknown>;
  let body: string;

  if (match) {
    const rawFm = match[1];
    body = match[2].trim();
    frontmatter = yamlParser ? yamlParser(rawFm) : parseSimpleYaml(rawFm);
  } else {
    // No frontmatter — the whole file is the system prompt body.
    frontmatter = {};
    body = content.trim();
  }

  const role = String(frontmatter.role || 'assistant');
  const description = String(frontmatter.description || '');
  const tone = String(frontmatter.tone || DEFAULT_TONE);
  const expertise = Array.isArray(frontmatter.expertise)
    ? (frontmatter.expertise as string[])
    : [];
  const responsePrefix = String(
    frontmatter.response_prefix || `[${capitalize(role)}]`,
  );
  const maxTurnsPerMeeting = typeof frontmatter.max_turns_per_meeting === 'number'
    ? frontmatter.max_turns_per_meeting
    : DEFAULT_MAX_TURNS_PER_MEETING;

  // Build the system prompt injected into pi-mono sessions.
  const systemPromptParts: string[] = [];

  systemPromptParts.push(`# Persona: ${capitalize(role)}`);

  if (description) {
    systemPromptParts.push(`Description: ${description}`);
  }
  systemPromptParts.push(`Tone: ${tone}`);

  if (expertise.length > 0) {
    systemPromptParts.push(`Expertise: ${expertise.join(', ')}`);
  }

  systemPromptParts.push(`Response Prefix: ${responsePrefix}`);
  systemPromptParts.push(`Max Turns Per Meeting: ${maxTurnsPerMeeting}`);

  if (body) {
    systemPromptParts.push('');
    systemPromptParts.push(body);
  }

  const systemPrompt = systemPromptParts.join('\n');

  return {
    role,
    description,
    tone,
    expertise,
    responsePrefix,
    maxTurnsPerMeeting,
    body,
    systemPrompt,
  };
}

/**
 * Load a persona for a specific agent in a group.
 *
 * @param chatId   - The group/chat identifier (maps to `groups/{chatId}/`).
 * @param agentName - The agent's directory name under `agents/`.
 * @returns The `Persona` object, or `null` if no persona.md exists.
 */
export function loadPersona(chatId: string, agentName: string): Persona | null {
  const personaPath = buildPersonaPath(chatId, agentName);
  return parsePersonaFile(personaPath);
}

/**
 * Load all personas for every agent in a group.
 *
 * @returns A map of agent name → Persona.
 */
export function loadAllPersonas(chatId: string): Map<string, Persona> {
  const agentsDir = path.join(GROUPS_DIR, chatId, AGENTS_SUBDIR);
  const result = new Map<string, Persona>();

  if (!existsSync(agentsDir)) {
    return result;
  }

  for (const entry of readdirSync(agentsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;

    const persona = parsePersonaFile(
      path.join(agentsDir, entry.name, PERSONA_FILENAME),
    );
    if (persona) {
      result.set(entry.name, persona);
    }
  }

  return result;
}

/**
 * Load just the system prompt for a specific agent.
 * Convenience wrapper used during session creation.
 */
export function loadSystemPrompt(chatId: string, agentName: string): string {
  const persona = loadPersona(chatId, agentName);
  if (persona) {
    return persona.systemPrompt;
  }

  // Fallback system prompt when no persona.md exists.
  return `You are ${agentName}, an AI assistant in a swarm team. Respond helpfully and concisely.`;
}

/**
 * Get the response prefix for an agent.
 * Used by the swarm router to format responses with agent identification.
 */
export function getAgentPrefix(chatId: string, agentName: string): string {
  const persona = loadPersona(chatId, agentName);
  return persona?.responsePrefix || `[${capitalize(agentName)}]`;
}

/**
 * Derive a prefix from an agent name alone (no file I/O).
 * Used when persona file is unavailable.
 */
export function getDefaultPrefix(agentName: string): string {
  return `[${capitalize(agentName)}]`;
}

// ---------------------------------------------------------------------------
// Agent directory helpers
// ---------------------------------------------------------------------------

/**
 * Build the absolute path to a persona.md file.
 */
export function buildPersonaPath(chatId: string, agentName: string): string {
  return path.join(GROUPS_DIR, chatId, AGENTS_SUBDIR, agentName, PERSONA_FILENAME);
}

/**
 * List all registered agent names for a group.
 * An agent is "registered" if it has a directory under `agents/`.
 */
export function listAgentNames(chatId: string): string[] {
  const agentsDir = path.join(GROUPS_DIR, chatId, AGENTS_SUBDIR);
  if (!existsSync(agentsDir)) return [];

  return readdirSync(agentsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}

/**
 * Ensure an agent directory exists with a default persona.md.
 * Used when registering a new agent for a group.
 */
export function ensureAgentDir(
  chatId: string,
  agentName: string,
  personaOverrides?: Partial<PersonaFrontmatter>,
): string {
  const agentDir = path.join(GROUPS_DIR, chatId, AGENTS_SUBDIR, agentName);
  mkdirSync(agentDir, { recursive: true });

  const personaPath = path.join(agentDir, PERSONA_FILENAME);
  if (!existsSync(personaPath)) {
    const role = personaOverrides?.role || agentName;
    const description =
      personaOverrides?.description || `AI agent with the role of ${role}.`;
    const expertise = personaOverrides?.expertise || [];
    const maxTurns = personaOverrides?.max_turns_per_meeting || DEFAULT_MAX_TURNS_PER_MEETING;

    const frontmatter = [
      '---',
      `role: ${role}`,
      `description: ${description}`,
      `tone: Helpful and professional`,
      `expertise: ${JSON.stringify(expertise)}`,
      `response_prefix: "[${capitalize(role)}]"`,
      `max_turns_per_meeting: ${maxTurns}`,
      '---',
      '',
      `You are ${capitalize(role)}. Respond clearly and concisely.`,
      '',
    ].join('\n');

    writeFileSync(personaPath, frontmatter);
    logger.info({ chatId, agentName }, 'Created default persona.md');
  }

  return agentDir;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function capitalize(s: string): string {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}
