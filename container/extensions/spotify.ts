import type { Extension } from "@mariozechner/pi-coding-agent";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

const TOKENS_DIR = process.env.SPOTIFY_TOKENS_DIR || "/app/secrets/spotify";

interface SpotifyConfig {
  access_token: string;
  refresh_token?: string;
  expires_at?: number;
}

function getSpotifyToken(userId: string): string | null {
  try {
    const tokenPath = join(TOKENS_DIR, `${userId}.json`);
    if (!existsSync(tokenPath)) return null;

    const data = JSON.parse(readFileSync(tokenPath, "utf-8")) as SpotifyConfig;

    // Check if token is expired
    if (data.expires_at && Date.now() > data.expires_at) {
      // Token expired, would need refresh
      return null;
    }

    return data.access_token;
  } catch {
    return null;
  }
}

/**
 * Spotify Web API extension.
 * Provides play, pause, next, volume, and now_playing tools.
 */
export default function spotifyExtension(pi: Extension): void {
  // Play track or playlist
  pi.registerTool({
    name: "spotify_play",
    label: "[Spotify] Play",
    description: "Play a track or playlist on Spotify",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Track name or playlist name to search for" },
        device_id: { type: "string", description: "Specific device ID to play on" },
        user_id: { type: "string", description: "User ID (defaults to 'default')" },
      },
    },
    async execute(
      id,
      params: { query?: string; device_id?: string; user_id?: string },
      signal,
      onUpdate
    ) {
      const token = getSpotifyToken(params.user_id || "default");
      if (!token) {
        return {
          content: [{ type: "text", text: "Spotify not connected. Run /extension spotify connect" }],
        };
      }

      if (!params.query) {
        // Resume playback
        const response = await fetch("https://api.spotify.com/v1/me/player/play", {
          method: "PUT",
          headers: { Authorization: `Bearer ${token}` },
          body: JSON.stringify({ device_id: params.device_id }),
          signal,
        });

        if (response.status === 204) {
          return { content: [{ type: "text", text: "▶ Resumed playback" }] };
        }
        return { content: [{ type: "text", text: "Failed to resume playback" }] };
      }

      // Search for track
      onUpdate?.({ type: "thinking", content: "Searching for track..." });

      const searchRes = await fetch(
        `https://api.spotify.com/v1/search?q=${encodeURIComponent(params.query)}&type=track&limit=1`,
        { headers: { Authorization: `Bearer ${token}` }, signal }
      );

      const searchData = (await searchRes.json()) as {
        tracks?: { items: Array<{ uri: string; name: string; artists: Array<{ name: string }> }> };
      };
      const track = searchData.tracks?.items[0];

      if (!track) {
        return { content: [{ type: "text", text: `Track not found: ${params.query}` }] };
      }

      // Start playback
      await fetch("https://api.spotify.com/v1/me/player/play", {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          uris: [track.uri],
          device_id: params.device_id,
        }),
        signal,
      });

      const artistNames = track.artists.map((a) => a.name).join(", ");
      return {
        content: [{ type: "text", text: `▶ Now playing: ${track.name} — ${artistNames}` }],
      };
    },
  });

  // Pause playback
  pi.registerTool({
    name: "spotify_pause",
    label: "[Spotify] Pause",
    description: "Pause Spotify playback",
    parameters: {
      type: "object",
      properties: {
        user_id: { type: "string", description: "User ID (defaults to 'default')" },
      },
    },
    async execute(id, params: { user_id?: string }, signal) {
      const token = getSpotifyToken(params.user_id || "default");
      if (!token) return { content: [{ type: "text", text: "Spotify not connected" }] };

      await fetch("https://api.spotify.com/v1/me/player/pause", {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}` },
        signal,
      });

      return { content: [{ type: "text", text: "⏸ Paused" }] };
    },
  });

  // Get now playing
  pi.registerTool({
    name: "spotify_now_playing",
    label: "[Spotify] Now Playing",
    description: "Get current playback status",
    parameters: {
      type: "object",
      properties: {
        user_id: { type: "string", description: "User ID (defaults to 'default')" },
      },
    },
    async execute(id, params: { user_id?: string }, signal) {
      const token = getSpotifyToken(params.user_id || "default");
      if (!token) return { content: [{ type: "text", text: "Spotify not connected" }] };

      const res = await fetch("https://api.spotify.com/v1/me/player/currently-playing", {
        headers: { Authorization: `Bearer ${token}` },
        signal,
      });

      if (res.status === 204 || res.status === 200 && !res.headers.get("content-type")?.includes("application/json")) {
        return { content: [{ type: "text", text: "Nothing playing" }] };
      }

      const data = (await res.json()) as {
        item?: {
          name: string;
          artists: Array<{ name: string }>;
          album?: { images?: Array<{ url: string }> };
        };
        is_playing?: boolean;
      };

      if (!data.item) {
        return { content: [{ type: "text", text: "Nothing playing" }] };
      }

      const artistNames = data.item.artists.map((a) => a.name).join(", ");
      const status = data.is_playing ? "▶" : "⏸";
      return {
        content: [
          {
            type: "text",
            text: `${status} ${data.item.name} — ${artistNames}`,
          },
        ],
      };
    },
  });

  // Next track
  pi.registerTool({
    name: "spotify_next",
    label: "[Spotify] Next",
    description: "Skip to next track",
    parameters: {
      type: "object",
      properties: {
        user_id: { type: "string", description: "User ID (defaults to 'default')" },
      },
    },
    async execute(id, params: { user_id?: string }, signal) {
      const token = getSpotifyToken(params.user_id || "default");
      if (!token) return { content: [{ type: "text", text: "Spotify not connected" }] };

      await fetch("https://api.spotify.com/v1/me/player/next", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        signal,
      });

      return { content: [{ type: "text", text: "⏭ Skipped" }] };
    },
  });

  // Previous track
  pi.registerTool({
    name: "spotify_previous",
    label: "[Spotify] Previous",
    description: "Go to previous track",
    parameters: {
      type: "object",
      properties: {
        user_id: { type: "string", description: "User ID (defaults to 'default')" },
      },
    },
    async execute(id, params: { user_id?: string }, signal) {
      const token = getSpotifyToken(params.user_id || "default");
      if (!token) return { content: [{ type: "text", text: "Spotify not connected" }] };

      await fetch("https://api.spotify.com/v1/me/player/previous", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        signal,
      });

      return { content: [{ type: "text", text: "⏮ Previous" }] };
    },
  });

  // Set volume
  pi.registerTool({
    name: "spotify_volume",
    label: "[Spotify] Volume",
    description: "Set volume (0-100)",
    parameters: {
      type: "object",
      properties: {
        volume_percent: {
          type: "number",
          minimum: 0,
          maximum: 100,
          description: "Volume level (0-100)",
        },
        device_id: { type: "string", description: "Device ID" },
        user_id: { type: "string", description: "User ID (defaults to 'default')" },
      },
      required: ["volume_percent"],
    },
    async execute(
      id,
      params: { volume_percent: number; device_id?: string; user_id?: string },
      signal
    ) {
      const token = getSpotifyToken(params.user_id || "default");
      if (!token) return { content: [{ type: "text", text: "Spotify not connected" }] };

      await fetch("https://api.spotify.com/v1/me/player/volume", {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({ volume_percent: params.volume_percent, device_id: params.device_id }),
        signal,
      });

      return { content: [{ type: "text", text: `🔊 Volume set to ${params.volume_percent}%` }] };
    },
  });

  // Shuffle
  pi.registerTool({
    name: "spotify_shuffle",
    label: "[Spotify] Shuffle",
    description: "Toggle shuffle mode",
    parameters: {
      type: "object",
      properties: {
        state: { type: "boolean", description: "true to enable shuffle, false to disable" },
        user_id: { type: "string", description: "User ID (defaults to 'default')" },
      },
      required: ["state"],
    },
    async execute(id, params: { state: boolean; user_id?: string }, signal) {
      const token = getSpotifyToken(params.user_id || "default");
      if (!token) return { content: [{ type: "text", text: "Spotify not connected" }] };

      await fetch("https://api.spotify.com/v1/me/player/shuffle", {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({ state: params.state }),
        signal,
      });

      return {
        content: [{ type: "text", text: params.state ? "🔀 Shuffle enabled" : "🔀 Shuffle disabled" }],
      };
    },
  });

  // Repeat
  pi.registerTool({
    name: "spotify_repeat",
    label: "[Spotify] Repeat",
    description: "Set repeat mode (track, context, or off)",
    parameters: {
      type: "object",
      properties: {
        state: { type: "string", enum: ["track", "context", "off"], description: "Repeat mode" },
        user_id: { type: "string", description: "User ID (defaults to 'default')" },
      },
      required: ["state"],
    },
    async execute(id, params: { state: "track" | "context" | "off"; user_id?: string }, signal) {
      const token = getSpotifyToken(params.user_id || "default");
      if (!token) return { content: [{ type: "text", text: "Spotify not connected" }] };

      await fetch("https://api.spotify.com/v1/me/player/repeat", {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({ state: params.state }),
        signal,
      });

      return {
        content: [
          {
            type: "text",
            text: `🔁 Repeat mode: ${params.state}`,
          },
        ],
      };
    },
  });
}