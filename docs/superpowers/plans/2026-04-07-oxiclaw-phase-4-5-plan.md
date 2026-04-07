# Phase 4-5: Multimodal + Integrations

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development.

**Goal:** pi Extension으로 Zai 이미지 생성, TTS, Spotify 제어를 구현. Extension CLI로 설치/제거 관리.

**Architecture:** 각 Extension이 pi Extension API로 pi-mono에 등록. pi Extension에서 Zai/MiniMax API 또는 Spotify Web API를 직접 호출. telegram-native Extension이 결과를 Telegram으로 전송.

**Tech Stack:** Node.js, TypeScript, pi-mono SDK Extension API, Zai API, MiniMax API, Spotify Web API

**전제:** Phase 1 (Foundation) 완료. pi Extension 런타임 로딩 방식 확인.

---

## 선행 조건

1. pi-mono SDK Extension API 시그니처 확인 (Phase 0)
2. pi Extension이 런타임에 동적으로 로드되는지, 빌드 타임에 정적 링크인지 확인 (Phase 0)
   - 동적 로드 → Extension 파일 복사만으로 설치 가능
   - 정적 링크 → Extension 추가 시 Docker 빌드 필요 (백업 계획 적용)

## Task 1: pi Extension 템플릿 작성

**Files:**
- Create: `container/extensions/template.ts`

pi Extension의 표준 구조를 정의하여 이후 모든 Extension의 기반이 됨:

```typescript
// container/extensions/template.ts
import type { Extension } from "@mariozechner/pi-coding-agent";

export default function templateExtension(pi: Extension): void {
  pi.registerTool({
    name: "template_hello",
    label: "Hello",
    description: "Says hello",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Your name" },
      },
      required: ["name"],
    },
    async execute(id, params, signal, onUpdate) {
      return {
        content: [{ type: "text", text: `Hello, ${params.name}!` }],
      };
    },
  });
}
```

## Task 2: telegram-native Extension

**Files:**
- Create: `container/extensions/telegram-native.ts`

```typescript
// container/extensions/telegram-native.ts
import type { Extension } from "@mariozechner/pi-coding-agent";
import fetch from "node-fetch";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN!;
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

export default function telegramNativeExtension(pi: Extension): void {
  // Send text message
  pi.registerTool({
    name: "telegram_send_message",
    label: "Send Telegram Message",
    description: "Send a text message to a Telegram chat",
    parameters: {
      type: "object",
      properties: {
        chat_id: { type: "string", description: "Telegram chat ID" },
        text: { type: "string", description: "Message text (max 4096 chars)" },
        reply_to_message_id: { type: "string" },
      },
      required: ["chat_id", "text"],
    },
    async execute(id, params, signal, onUpdate) {
      const response = await fetch(`${TELEGRAM_API}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: params.chat_id,
          text: params.text,
          reply_to_message_id: params.reply_to_message_id,
          parse_mode: "Markdown",
        }),
      });
      const result = await response.json() as any;
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
      };
    },
  });

  // Send photo
  pi.registerTool({
    name: "telegram_send_photo",
    label: "Send Telegram Photo",
    description: "Send a photo to a Telegram chat",
    parameters: {
      type: "object",
      properties: {
        chat_id: { type: "string" },
        photo: { type: "string", description: "Photo URL or file_id" },
        caption: { type: "string" },
      },
      required: ["chat_id", "photo"],
    },
    async execute(id, params, signal, onUpdate) {
      const response = await fetch(`${TELEGRAM_API}/sendPhoto`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: params.chat_id,
          photo: params.photo,
          caption: params.caption,
        }),
      });
      return {
        content: [{ type: "text", text: JSON.stringify(await response.json()) }],
      };
    },
  });

  // Send voice
  pi.registerTool({
    name: "telegram_send_voice",
    label: "Send Telegram Voice",
    description: "Send a voice message to a Telegram chat",
    parameters: {
      type: "object",
      properties: {
        chat_id: { type: "string" },
        voice: { type: "string", description: "Audio URL or file_id" },
        caption: { type: "string" },
      },
      required: ["chat_id", "voice"],
    },
    async execute(id, params, signal, onUpdate) {
      const response = await fetch(`${TELEGRAM_API}/sendVoice`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: params.chat_id,
          voice: params.voice,
          caption: params.caption,
        }),
      });
      return {
        content: [{ type: "text", text: JSON.stringify(await response.json()) }],
      };
    },
  });
}
```

## Task 3: Zai API 이미지 생성 Extension

**Files:**
- Create: `container/extensions/zai-image.ts`

```typescript
// container/extensions/zai-image.ts
import type { Extension } from "@mariozechner/pi-coding-agent";
import fetch from "node-fetch";
import FormData from "form-data";

const ZAI_API_KEY = process.env.ZAI_API_KEY!;
const ZAI_IMAGE_URL = "https://api.zailabs.com/v1/images/generations";

export default function zaiImageExtension(pi: Extension): void {
  pi.registerTool({
    name: "zai_generate_image",
    label: "[Zai] Generate Image",
    description: "Generate an image using Zai AI",
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Image description", maxLength: 1000 },
        size: {
          type: "string",
          enum: ["256x256", "512x512", "1024x1024"],
          default: "1024x1024",
        },
        n: { type: "number", default: 1 },
        chat_id: { type: "string", description: "Telegram chat_id to send result" },
      },
      required: ["prompt"],
    },
    async execute(id, params, signal, onUpdate) {
      onUpdate?.({ type: "thinking", content: "Generating image..." });

      const response = await fetch(ZAI_IMAGE_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${ZAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          prompt: params.prompt,
          n: params.n || 1,
          size: params.size || "1024x1024",
        }),
        signal,
      });

      const data = await response.json() as any;

      if (!response.ok) {
        return {
          content: [{ type: "text", text: `Error: ${data.error?.message || "Unknown"}` }],
        };
      }

      // Telegram으로 전송 (chat_id가 제공된 경우)
      if (params.chat_id) {
        // telegram-native 또는 직접 API 호출
        const imageUrl = data.data[0]?.url;
        if (imageUrl) {
          await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendPhoto`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              chat_id: params.chat_id,
              photo: imageUrl,
              caption: `Generated: ${params.prompt}`,
            }),
          });
        }
        return {
          content: [{ type: "text", text: `Image sent to Telegram: ${params.prompt}` }],
        };
      }

      return {
        content: [{ type: "text", text: JSON.stringify(data) }],
      };
    },
  });
}
```

## Task 4: Zai/MiniMax TTS Extension

**Files:**
- Create: `container/extensions/zai-tts.ts`

```typescript
// container/extensions/zai-tts.ts
import type { Extension } from "@mariozechner/pi-coding-agent";
import fetch from "node-fetch";
import { writeFileSync } from "fs";
import { join } from "path";

// Zai TTS
export default function zaiTtsExtension(pi: Extension): void {
  pi.registerTool({
    name: "tts_speak",
    label: "[TTS] Text to Speech",
    description: "Convert text to speech using Zai or MiniMax",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "Text to convert to speech" },
        provider: { type: "string", enum: ["zai", "minimax"], default: "zai" },
        voice: { type: "string", description: "Voice ID (provider-specific)" },
        chat_id: { type: "string", description: "Telegram chat_id to send result" },
      },
      required: ["text"],
    },
    async execute(id, params, signal, onUpdate) {
      const provider = params.provider || "zai";

      if (provider === "zai") {
        return await zaiTts(params.text, params.chat_id, signal);
      } else {
        return await minimaxTts(params.text, params.chat_id, signal);
      }
    },
  });
}

async function zaiTts(text: string, chatId?: string, signal?: AbortSignal) {
  const response = await fetch("https://api.zailabs.com/v1/audio/speech", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.ZAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "tts-1",
      input: text,
      voice: "alloy",
    }),
    signal,
  });

  if (!response.ok) {
    return { content: [{ type: "text", text: `TTS error: ${response.statusText}` }] };
  }

  // Save to temp file and get URL (or directly send to Telegram)
  const buffer = await response.arrayBuffer();
  const tmpPath = join("/tmp", `tts-${Date.now()}.mp3`);

  // For Telegram: get file URL via bot API
  // In practice, upload audio to a CDN and send URL
  if (chatId) {
    // Simplified: send as document
    await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendAudio`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        audio: "https://example.com/tts.mp3", // In practice: upload first
        caption: `TTS: ${text.slice(0, 100)}`,
      }),
    });
  }

  return {
    content: [{ type: "text", text: `Audio generated (${buffer.byteLength} bytes)` }],
  };
}

async function minimaxTts(text: string, chatId?: string, signal?: AbortSignal) {
  // MiniMax TTS API 연동 (Zai와 유사한 패턴)
  const response = await fetch("https://api.minimax.chat/v1/t2a_v2", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.MINIMAX_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "speech-02-hd",
      text,
      stream: false,
    }),
    signal,
  });

  return {
    content: [{ type: "text", text: JSON.stringify(await response.json()) }],
  };
}
```

## Task 5: Spotify Web API Extension

**Files:**
- Create: `container/extensions/spotify.ts`

```typescript
// container/extensions/spotify.ts
import type { Extension } from "@mariozechner/pi-coding-agent";
import fetch from "node-fetch";
import { readFileSync } from "fs";
import { join } from "path";

// OAuth 2.0 with user token management
const TOKENS_DIR = process.env.SPOTIFY_TOKENS_DIR || "/app/secrets/spotify";

function getSpotifyToken(userId: string): string | null {
  try {
    return readFileSync(join(TOKENS_DIR, `${userId}.json`), "utf-8")
      .then(JSON.parse)
      .then((data) => data.access_token);
  } catch {
    return null;
  }
}

export default function spotifyExtension(pi: Extension): void {
  pi.registerTool({
    name: "spotify_play",
    label: "[Spotify] Play",
    description: "Play a track or playlist on Spotify",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Track name or playlist URI" },
        device_id: { type: "string" },
      },
    },
    async execute(id, params, signal) {
      const token = getSpotifyToken(params.user_id || "default");
      if (!token) {
        return { content: [{ type: "text", text: "Spotify not connected. Run /extension spotify connect" }] };
      }

      // Search for track
      const searchRes = await fetch(
        `https://api.spotify.com/v1/search?q=${encodeURIComponent(params.query)}&type=track`,
        { headers: { Authorization: `Bearer ${token}` }, signal }
      );
      const searchData = await searchRes.json() as any;
      const trackUri = searchData.tracks?.items[0]?.uri;

      if (!trackUri) {
        return { content: [{ type: "text", text: `Track not found: ${params.query}` }] };
      }

      // Start playback
      await fetch("https://api.spotify.com/v1/me/player/play", {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({ uris: [trackUri], device_id: params.device_id }),
      });

      return {
        content: [{ type: "text", text: `▶ Now playing: ${searchData.tracks.items[0].name}` }],
      };
    },
  });

  pi.registerTool({
    name: "spotify_pause",
    label: "[Spotify] Pause",
    description: "Pause Spotify playback",
    async execute(id, params, signal) {
      const token = getSpotifyToken(params.user_id || "default");
      if (!token) return { content: [{ type: "text", text: "Spotify not connected" }] };

      await fetch("https://api.spotify.com/v1/me/player/pause", {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}` },
      });

      return { content: [{ type: "text", text: "⏸ Paused" }] };
    },
  });

  pi.registerTool({
    name: "spotify_now_playing",
    label: "[Spotify] Now Playing",
    description: "Get current playback status",
    async execute(id, params, signal) {
      const token = getSpotifyToken(params.user_id || "default");
      if (!token) return { content: [{ type: "text", text: "Spotify not connected" }] };

      const res = await fetch("https://api.spotify.com/v1/me/player/currently-playing", {
        headers: { Authorization: `Bearer ${token}` },
        signal,
      });

      if (res.status === 204) {
        return { content: [{ type: "text", text: "Nothing playing" }] };
      }

      const data = await res.json() as any;
      return {
        content: [{
          type: "text",
          text: `▶ ${data.item.name} — ${data.item.artists.map((a: any) => a.name).join(", ")}`,
        }],
      };
    },
  });

  pi.registerTool({
    name: "spotify_next",
    label: "[Spotify] Next",
    async execute(id, params, signal) {
      const token = getSpotifyToken(params.user_id || "default");
      if (!token) return { content: [{ type: "text", text: "Spotify not connected" }] };

      await fetch("https://api.spotify.com/v1/me/player/next", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });

      return { content: [{ type: "text", text: "⏭ Skipped" }] };
    },
  });

  pi.registerTool({
    name: "spotify_volume",
    label: "[Spotify] Volume",
    description: "Set volume (0-100)",
    parameters: {
      type: "object",
      properties: {
        volume_percent: { type: "number", minimum: 0, maximum: 100 },
      },
      required: ["volume_percent"],
    },
    async execute(id, params, signal) {
      const token = getSpotifyToken(params.user_id || "default");
      if (!token) return { content: [{ type: "text", text: "Spotify not connected" }] };

      await fetch("https://api.spotify.com/v1/me/player/volume", {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({ volume_percent: params.volume_percent }),
      });

      return { content: [{ type: "text", text: `🔊 Volume set to ${params.volume_percent}%` }] };
    },
  });
}
```

## Task 6: pi-mcp-client Extension (선택적 MCP)

**Files:**
- Create: `container/extensions/pi-mcp-client.ts`

```typescript
// container/extensions/pi-mcp-client.ts
import type { Extension } from "@mariozechner/pi-coding-agent";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { parseArgs } from "util";

interface MCPServerConfig {
  [name: string]: string;
}

export default function piMCPClientExtension(pi: Extension): void {
  // Parse --mcp flag or MCP_SERVERS env var
  const mcpServers = parseMCPConfig();

  for (const [name, commandLine] of Object.entries(mcpServers)) {
    const { command, args } = parseCommandLine(commandLine);

    const transport = new StdioClientTransport({ command, args });
    const client = new Client({ name, version: "1.0" }, { capabilities: {} });

    (async () => {
      await client.connect(transport);

      // Register MCP tools as pi tools
      const tools = await client.listTools();
      for (const tool of tools.tools) {
        pi.registerTool({
          name: `mcp_${name}_${tool.name}`,
          label: `[MCP:${name}] ${tool.name}`,
          description: tool.description,
          parameters: tool.inputSchema,
          async execute(id, params, signal, onUpdate) {
            const result = await client.callTool(
              { name: tool.name, arguments: params },
              signal
            );
            return { content: [{ type: "text", text: JSON.stringify(result) }] };
          },
        });
      }
    })().catch((e) => {
      console.error(`[mcp-client] Failed to connect to ${name}:`, e);
    });
  }
}

function parseMCPConfig(): MCPServerConfig {
  const env = process.env.MCP_SERVERS;
  if (!env) return {};
  try {
    return JSON.parse(env);
  } catch {
    return {};
  }
}

function parseCommandLine(cmd: string): { command: string; args: string[] } {
  const { values } = parseArgs({ args: cmd.split(" "), options: {}, allowPositionals: true });
  const positional = values._ as string[];
  return { command: positional[0], args: positional.slice(1) };
}
```

## Task 7: Extension CLI — extension-manager.ts

**Files:**
- Create: `src/extension-manager.ts`

```bash
/extension list          # 설치된 Extension 목록
/extension add spotify   # Extension 설치
/extension remove spotify # Extension 제거
```

```typescript
// src/extension-manager.ts
import { copyFileSync, existsSync, readdirSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";

const GLOBAL_EXTENSIONS = join(__dirname, "../container/extensions");
const GROUPS_EXTENSIONS_BASE = join(__dirname, "../groups");

const AVAILABLE_EXTENSIONS = [
  "spotify",
  "z-image",
  "z-tts",
  "minimax-tts",
  "github",
  "notion",
  "mcp-client",
];

export function listExtensions(groupId?: string): string[] {
  if (groupId) {
    const groupDir = join(GROUPS_EXTENSIONS_BASE, groupId, "extensions");
    if (!existsSync(groupDir)) return [];
    return readdirSync(groupDir).filter((f) => f.endsWith(".ts"));
  }
  return AVAILABLE_EXTENSIONS;
}

export function addExtension(groupId: string, name: string): void {
  // Validate
  if (!AVAILABLE_EXTENSIONS.includes(name)) {
    throw new Error(`Unknown extension: ${name}. Available: ${AVAILABLE_EXTENSIONS.join(", ")}`);
  }

  // Copy global extension to group-specific extensions
  const src = join(GLOBAL_EXTENSIONS, `${name}.ts`);
  const dst = join(GROUPS_EXTENSIONS_BASE, groupId, "extensions", `${name}.ts`);

  if (!existsSync(src)) {
    throw new Error(`Extension source not found: ${src}`);
  }

  copyFileSync(src, dst);
  console.log(`[extension-manager] Added ${name} to group ${groupId}`);

  // Trigger container restart for this group
  triggerContainerRestart(groupId);
}

export function removeExtension(groupId: string, name: string): void {
  const dst = join(GROUPS_EXTENSIONS_BASE, groupId, "extensions", `${name}.ts`);
  if (existsSync(dst)) {
    unlinkSync(dst);
    console.log(`[extension-manager] Removed ${name} from group ${groupId}`);
    triggerContainerRestart(groupId);
  }
}

function triggerContainerRestart(groupId: string): void {
  // Signal orchestrator to restart this group's container
  // Implementation: write to sentinel file or IPC
  const sentinel = join(GROUPS_EXTENSIONS_BASE, groupId, ".restart");
  writeFileSync(sentinel, String(Date.now()));
}
```

- [ ] **Step 1: Telegram 명령어 등록**

```typescript
// src/channels/telegram/extension-commands.ts
bot.command("extension", async (ctx) => {
  const args = ctx.message?.text.replace("/extension", "").trim().split(" ");
  const subcommand = args?.[0];
  const name = args?.[1];

  if (subcommand === "list") {
    const extensions = extensionManager.listExtensions();
    await ctx.reply(`📦 Extensions:\n${extensions.map((e) => `- ${e}`).join("\n")}`);
  } else if (subcommand === "add" && name) {
    extensionManager.addExtension(String(ctx.chat.id), name);
    await ctx.reply(`✅ Extension ${name} added. Restarting...`);
  } else if (subcommand === "remove" && name) {
    extensionManager.removeExtension(String(ctx.chat.id), name);
    await ctx.reply(`🗑 Extension ${name} removed. Restarting...`);
  } else {
    await ctx.reply("Usage: /extension list|add|remove <name>");
  }
});
```

## Task 8: .env.example 업데이트

**Files:**
- Modify: `.env.example`

```bash
# Telegram
TELEGRAM_BOT_TOKEN=your_telegram_bot_token

# LLM Providers (pi-mono AuthStorage)
ANTHROPIC_API_KEY=
OPENAI_API_KEY=
ZAI_API_KEY=
MINIMAX_API_KEY=

# Spotify OAuth
SPOTIFY_CLIENT_ID=
SPOTIFY_CLIENT_SECRET=
SPOTIFY_TOKENS_DIR=/app/secrets/spotify

# MCP Servers (optional)
MCP_SERVERS={"filesystem":"npx -y @modelcontextprotocol/server-filesystem /workspace"}

# Extensions
ENABLE_TELEGRAM_NATIVE=true
ENABLE_MULTIMODAL=true
```

---

**완료 조건:** `/extension add spotify`로 Spotify Extension이 설치되고, Spotify 툴이 에이전트에서 사용 가능한 상태.
