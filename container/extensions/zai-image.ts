import type { Extension } from "@mariozechner/pi-coding-agent";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN!;
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const ZAI_API_KEY = process.env.ZAI_API_KEY!;
const ZAI_IMAGE_URL = "https://api.zailabs.com/v1/images/generations";

interface ZaiImageParams {
  prompt: string;
  size?: "256x256" | "512x512" | "1024x1024";
  n?: number;
  chat_id?: string;
}

/**
 * Zai API image generation extension.
 * Generates images using Zai AI and optionally sends results to Telegram.
 */
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
          description: "Image size",
        },
        n: { type: "number", default: 1, description: "Number of images to generate" },
        chat_id: { type: "string", description: "Telegram chat_id to send result" },
      },
      required: ["prompt"],
    },
    async execute(id, params: ZaiImageParams, signal, onUpdate) {
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

      const data = await response.json() as {
        data?: Array<{ url?: string }>;
        error?: { message?: string };
      };

      if (!response.ok || data.error) {
        return {
          content: [{ type: "text", text: `Error: ${data.error?.message || "Image generation failed"}` }],
        };
      }

      const imageUrl = data.data?.[0]?.url;
      if (!imageUrl) {
        return {
          content: [{ type: "text", text: "Error: No image URL returned" }],
        };
      }

      // Send to Telegram if chat_id is provided
      if (params.chat_id) {
        const telegramResponse = await fetch(`${TELEGRAM_API}/sendPhoto`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: params.chat_id,
            photo: imageUrl,
            caption: `Generated: ${params.prompt.slice(0, 200)}`,
          }),
          signal,
        });

        const telegramResult = await telegramResponse.json() as { ok: boolean };
        if (telegramResult.ok) {
          return {
            content: [{ type: "text", text: `Image sent to Telegram: ${params.prompt.slice(0, 100)}` }],
          };
        }
      }

      return {
        content: [
          { type: "text", text: `Image generated: ${imageUrl}` },
          { type: "image", url: imageUrl },
        ],
      };
    },
  });
}