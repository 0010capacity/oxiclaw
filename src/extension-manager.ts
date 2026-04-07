import { copyFileSync, existsSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";

const GLOBAL_EXTENSIONS = join(__dirname, "../../container/extensions");
const GROUPS_EXTENSIONS_BASE = join(__dirname, "../../groups");

export const AVAILABLE_EXTENSIONS = [
  "spotify",
  "telegram-native",
  "zai-image",
  "zai-tts",
  "pi-mcp-client",
  "template",
];

/**
 * List installed extensions for a group or all available extensions.
 */
export function listExtensions(groupId?: string): string[] {
  if (groupId) {
    const groupDir = join(GROUPS_EXTENSIONS_BASE, groupId, "extensions");
    if (!existsSync(groupDir)) return [];
    return readdirSync(groupDir)
      .filter((f) => f.endsWith(".ts"))
      .map((f) => f.replace(/\.ts$/, ""));
  }
  return AVAILABLE_EXTENSIONS;
}

/**
 * Add an extension to a group.
 */
export function addExtension(groupId: string, name: string): void {
  // Validate extension name
  if (!AVAILABLE_EXTENSIONS.includes(name)) {
    throw new Error(
      `Unknown extension: ${name}. Available: ${AVAILABLE_EXTENSIONS.join(", ")}`
    );
  }

  // Ensure group extensions directory exists
  const groupExtDir = join(GROUPS_EXTENSIONS_BASE, groupId, "extensions");
  if (!existsSync(groupExtDir)) {
    mkdirSync(groupExtDir, { recursive: true });
  }

  // Copy global extension to group-specific extensions
  const src = join(GLOBAL_EXTENSIONS, `${name}.ts`);
  const dst = join(groupExtDir, `${name}.ts`);

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
  const dst = join(GROUPS_EXTENSIONS_BASE, groupId, "extensions", `${name}.ts`);
  if (existsSync(dst)) {
    unlinkSync(dst);
    console.log(`[extension-manager] Removed ${name} from group ${groupId}`);
    triggerContainerRestart(groupId);
  }
}

/**
 * Get extension info for display.
 */
export function getExtensionInfo(name: string): { name: string; description: string; tools: string[] } | null {
  const info: Record<string, { description: string; tools: string[] }> = {
    "telegram-native": {
      description: "Send messages, photos, and voice to Telegram",
      tools: ["telegram_send_message", "telegram_send_photo", "telegram_send_voice", "telegram_send_audio", "telegram_send_document"],
    },
    "zai-image": {
      description: "Generate images using Zai AI",
      tools: ["zai_generate_image"],
    },
    "zai-tts": {
      description: "Convert text to speech using Zai or MiniMax",
      tools: ["tts_speak", "tts_list_voices"],
    },
    spotify: {
      description: "Control Spotify playback",
      tools: ["spotify_play", "spotify_pause", "spotify_next", "spotify_previous", "spotify_now_playing", "spotify_volume", "spotify_shuffle", "spotify_repeat"],
    },
    "pi-mcp-client": {
      description: "Bridge MCP servers as pi tools",
      tools: ["mcp_* (dynamic based on configured servers)"],
    },
    template: {
      description: "Example extension template",
      tools: ["template_hello"],
    },
  };

  return info[name] ? { name, ...info[name] } : null;
}

/**
 * Trigger container restart by writing to a sentinel file.
 */
function triggerContainerRestart(groupId: string): void {
  const sentinel = join(GROUPS_EXTENSIONS_BASE, groupId, ".restart");
  writeFileSync(sentinel, String(Date.now()));
  console.log(`[extension-manager] Triggered restart for group ${groupId}`);
}