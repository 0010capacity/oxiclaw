import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const GLOBAL_EXTENSIONS = path.join(__dirname, '../../container/extensions');
const GROUPS_EXTENSIONS_BASE = path.join(__dirname, '../../groups');

/**
 * Validate a groupId to prevent path traversal attacks.
 * Rejects paths with "..", leading "/", backslashes, or empty strings.
 */
function validateGroupId(groupId: string): void {
  if (
    !groupId ||
    groupId.includes('..') ||
    groupId.startsWith('/') ||
    groupId.includes('\\') ||
    groupId.includes(':') ||
    groupId.includes('\0')
  ) {
    throw new Error(`Invalid groupId: "${groupId}"`);
  }
}

export const AVAILABLE_EXTENSIONS = [
  // CLI-based skills (spotify, telegram, tts) are now SKILL.md-based in container/skills/
  'zai-image',
  'zai-tts',
  'pi-mcp-client',
  'template',
  'skill-manager',
];

/**
 * List installed extensions for a group or all available extensions.
 */
export function listExtensions(groupId?: string): string[] {
  if (groupId) {
    validateGroupId(groupId);
    const groupDir = path.join(GROUPS_EXTENSIONS_BASE, groupId, 'extensions');
    if (!existsSync(groupDir)) return [];
    return readdirSync(groupDir)
      .filter((f) => f.endsWith('.ts'))
      .map((f) => f.replace(/\.ts$/, ''));
  }
  return AVAILABLE_EXTENSIONS;
}

/**
 * Add an extension to a group.
 */
export function addExtension(groupId: string, name: string): void {
  validateGroupId(groupId);

  // Validate extension name
  if (!AVAILABLE_EXTENSIONS.includes(name)) {
    throw new Error(
      `Unknown extension: ${name}. Available: ${AVAILABLE_EXTENSIONS.join(', ')}`,
    );
  }

  // Ensure group extensions directory exists
  const groupExtDir = path.join(GROUPS_EXTENSIONS_BASE, groupId, 'extensions');
  if (!existsSync(groupExtDir)) {
    mkdirSync(groupExtDir, { recursive: true });
  }

  // Copy global extension to group-specific extensions
  const src = path.join(GLOBAL_EXTENSIONS, `${name}.ts`);
  const dst = path.join(groupExtDir, `${name}.ts`);

  if (!existsSync(src)) {
    throw new Error(`Extension source not found: ${src}`);
  }

  copyFileSync(src, dst);
  console.log(`[extension-manager] Added ${name} to group ${groupId}`);

  // Trigger container restart for this group
  triggerContainerRestart(groupId);
}

/**
 * Remove an extension from a group.
 */
export function removeExtension(groupId: string, name: string): void {
  validateGroupId(groupId);
  const dst = path.join(
    GROUPS_EXTENSIONS_BASE,
    groupId,
    'extensions',
    `${name}.ts`,
  );
  if (existsSync(dst)) {
    unlinkSync(dst);
    console.log(`[extension-manager] Removed ${name} from group ${groupId}`);
    triggerContainerRestart(groupId);
  }
}

/**
 * Get extension info for display.
 */
export function getExtensionInfo(
  name: string,
): { name: string; description: string; tools: string[] } | null {
  const info: Record<string, { description: string; tools: string[] }> = {
    'zai-image': {
      description: 'Generate images using Zai AI',
      tools: ['zai_generate_image'],
    },
    'zai-tts': {
      description: 'Convert text to speech using Zai or MiniMax',
      tools: ['tts_speak', 'tts_list_voices'],
    },
    // spotify and telegram-native are now SKILL.md-based skills in container/skills/
    'pi-mcp-client': {
      description: 'Bridge MCP servers as pi tools',
      tools: ['mcp_* (dynamic based on configured servers)'],
    },
    template: {
      description: 'Example extension template',
      tools: ['template_hello'],
    },
  };

  return info[name] ? { name, ...info[name] } : null;
}

/**
 * Trigger container restart by writing to a sentinel file.
 */
function triggerContainerRestart(groupId: string): void {
  validateGroupId(groupId);
  const sentinel = path.join(GROUPS_EXTENSIONS_BASE, groupId, '.restart');
  writeFileSync(sentinel, String(Date.now()));
  console.log(`[extension-manager] Triggered restart for group ${groupId}`);
}
