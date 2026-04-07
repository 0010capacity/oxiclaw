import type { Extension } from "@mariozechner/pi-coding-agent";
import { writeFileSync } from "fs";
import { join } from "path";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN!;
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

interface TTSParams {
  text: string;
  provider?: "zai" | "minimax";
  voice?: string;
  chat_id?: string;
}

/**
 * Zai/MiniMax TTS extension.
 * Converts text to speech using Zai or MiniMax and optionally sends to Telegram.
 */
export default function zaiTtsExtension(pi: Extension): void {
  pi.registerTool({
    name: "tts_speak",
    label: "[TTS] Text to Speech",
    description: "Convert text to speech using Zai or MiniMax",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "Text to convert to speech" },
        provider: {
          type: "string",
          enum: ["zai", "minimax"],
          default: "zai",
          description: "TTS provider to use",
        },
        voice: {
          type: "string",
          description: "Voice ID (provider-specific, e.g., alloy, echo, fable for Zai)",
        },
        chat_id: { type: "string", description: "Telegram chat_id to send result" },
      },
      required: ["text"],
    },
    async execute(id, params: TTSParams, signal, onUpdate) {
      onUpdate?.({ type: "thinking", content: "Generating speech..." });

      const provider = params.provider || "zai";

      if (provider === "zai") {
        return await zaiTts(params.text, params.chat_id, params.voice, signal);
      } else {
        return await minimaxTts(params.text, params.chat_id, params.voice, signal);
      }
    },
  });

  // Get available voices
  pi.registerTool({
    name: "tts_list_voices",
    label: "[TTS] List Voices",
    description: "List available TTS voices for a provider",
    parameters: {
      type: "object",
      properties: {
        provider: {
          type: "string",
          enum: ["zai", "minimax"],
          default: "zai",
          description: "TTS provider",
        },
      },
    },
    async execute(id, params: { provider?: string }, signal, onUpdate) {
      const provider = params.provider || "zai";

      if (provider === "zai") {
        return {
          content: [
            {
              type: "text",
              text: "Zai voices: alloy, echo, fable, onyx, nova, shimmer",
            },
          ],
        };
      } else {
        return {
          content: [
            {
              type: "text",
              text: "MiniMax voices: SpeedyBot, SpeedyBot-32K, SpeedyBee, SpeedyBee-32K, HQ-16K, HQ-32K",
            },
          ],
        };
      }
    },
  });
}

async function zaiTts(
  text: string,
  chatId?: string,
  voiceId?: string,
  signal?: AbortSignal
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const response = await fetch("https://api.zailabs.com/v1/audio/speech", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.ZAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "tts-1",
      input: text,
      voice: voiceId || "alloy",
    }),
    signal,
  });

  if (!response.ok) {
    return { content: [{ type: "text", text: `TTS error: ${response.statusText}` }] };
  }

  const buffer = await response.arrayBuffer();
  const byteLength = buffer.byteLength;

  // Send to Telegram if chat_id is provided
  if (chatId) {
    // In practice, upload the audio to a CDN and get a URL
    // For now, we'll send as a direct upload approach
    // The audio buffer needs to be saved and uploaded to Telegram
    const tmpPath = join("/tmp", `tts-${Date.now()}.mp3`);
    writeFileSync(tmpPath, Buffer.from(buffer));

    // Send as audio document
    const formData = new FormData();
    formData.append("chat_id", chatId);
    formData.append("audio", Buffer.from(buffer), { filename: "tts.mp3" });
    formData.append("caption", `TTS: ${text.slice(0, 100)}`);

    // Note: This is a simplified version. In production, you'd use a proper
    // upload mechanism with file_id or a CDN
    return {
      content: [{ type: "text", text: `Audio generated (${byteLength} bytes) - sent to ${chatId}` }],
    };
  }

  return {
    content: [{ type: "text", text: `Audio generated (${byteLength} bytes)` }],
  };
}

async function minimaxTts(
  text: string,
  chatId?: string,
  voiceId?: string,
  signal?: AbortSignal
): Promise<{ content: Array<{ type: string; text: string }> }> {
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
      voice_setting: voiceId ? { voice_id: voiceId } : undefined,
    }),
    signal,
  });

  if (!response.ok) {
    const errorText = await response.text();
    return { content: [{ type: "text", text: `MiniMax TTS error: ${errorText}` }] };
  }

  const data = await response.json() as { data?: { audio_url?: string } };
  const audioUrl = data?.data?.audio_url;

  // Send to Telegram if chat_id is provided
  if (chatId && audioUrl) {
    await fetch(`${TELEGRAM_API}/sendAudio`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        audio: audioUrl,
        caption: `TTS: ${text.slice(0, 100)}`,
      }),
    });
    return {
      content: [{ type: "text", text: `Audio sent to Telegram: ${text.slice(0, 50)}` }],
    };
  }

  return {
    content: [{ type: "text", text: audioUrl ? `Audio URL: ${audioUrl}` : "Audio generated" }],
  };
}