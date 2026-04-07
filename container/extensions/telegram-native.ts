import type { Extension } from "@mariozechner/pi-coding-agent";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN!;
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

interface TelegramParams {
  chat_id: string;
  text?: string;
  photo?: string;
  voice?: string;
  caption?: string;
  reply_to_message_id?: string;
}

/**
 * Telegram-native extension for sending messages directly to Telegram.
 * Provides send_message, send_photo, and send_voice tools.
 */
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
    async execute(id, params: { chat_id: string; text: string; reply_to_message_id?: string }, signal, onUpdate) {
      const response = await fetch(`${TELEGRAM_API}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: params.chat_id,
          text: params.text,
          reply_to_message_id: params.reply_to_message_id,
          parse_mode: "Markdown",
        }),
        signal,
      });
      const result = await response.json() as { ok: boolean; result?: unknown; description?: string };
      if (!result.ok) {
        return {
          content: [{ type: "text", text: `Telegram error: ${result.description || "Unknown error"}` }],
        };
      }
      return {
        content: [{ type: "text", text: `Message sent to ${params.chat_id}` }],
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
    async execute(id, params: { chat_id: string; photo: string; caption?: string }, signal, onUpdate) {
      const response = await fetch(`${TELEGRAM_API}/sendPhoto`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: params.chat_id,
          photo: params.photo,
          caption: params.caption,
        }),
        signal,
      });
      const result = await response.json() as { ok: boolean; description?: string };
      if (!result.ok) {
        return {
          content: [{ type: "text", text: `Telegram error: ${result.description || "Unknown error"}` }],
        };
      }
      return {
        content: [{ type: "text", text: `Photo sent to ${params.chat_id}` }],
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
    async execute(id, params: { chat_id: string; voice: string; caption?: string }, signal, onUpdate) {
      const response = await fetch(`${TELEGRAM_API}/sendVoice`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: params.chat_id,
          voice: params.voice,
          caption: params.caption,
        }),
        signal,
      });
      const result = await response.json() as { ok: boolean; description?: string };
      if (!result.ok) {
        return {
          content: [{ type: "text", text: `Telegram error: ${result.description || "Unknown error"}` }],
        };
      }
      return {
        content: [{ type: "text", text: `Voice message sent to ${params.chat_id}` }],
      };
    },
  });

  // Send audio (general audio file)
  pi.registerTool({
    name: "telegram_send_audio",
    label: "Send Telegram Audio",
    description: "Send an audio file to a Telegram chat",
    parameters: {
      type: "object",
      properties: {
        chat_id: { type: "string" },
        audio: { type: "string", description: "Audio URL or file_id" },
        caption: { type: "string" },
      },
      required: ["chat_id", "audio"],
    },
    async execute(id, params: { chat_id: string; audio: string; caption?: string }, signal, onUpdate) {
      const response = await fetch(`${TELEGRAM_API}/sendAudio`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: params.chat_id,
          audio: params.audio,
          caption: params.caption,
        }),
        signal,
      });
      const result = await response.json() as { ok: boolean; description?: string };
      if (!result.ok) {
        return {
          content: [{ type: "text", text: `Telegram error: ${result.description || "Unknown error"}` }],
        };
      }
      return {
        content: [{ type: "text", text: `Audio sent to ${params.chat_id}` }],
      };
    },
  });

  // Send document
  pi.registerTool({
    name: "telegram_send_document",
    label: "Send Telegram Document",
    description: "Send a document to a Telegram chat",
    parameters: {
      type: "object",
      properties: {
        chat_id: { type: "string" },
        document: { type: "string", description: "Document URL or file_id" },
        caption: { type: "string" },
      },
      required: ["chat_id", "document"],
    },
    async execute(id, params: { chat_id: string; document: string; caption?: string }, signal, onUpdate) {
      const response = await fetch(`${TELEGRAM_API}/sendDocument`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: params.chat_id,
          document: params.document,
          caption: params.caption,
        }),
        signal,
      });
      const result = await response.json() as { ok: boolean; description?: string };
      if (!result.ok) {
        return {
          content: [{ type: "text", text: `Telegram error: ${result.description || "Unknown error"}` }],
        };
      }
      return {
        content: [{ type: "text", text: `Document sent to ${params.chat_id}` }],
      };
    },
  });
}