---
name: spotify
description: Spotify playback control via spogo CLI (preferred) or spotify_player
version: "1.0.0"
category: capability
openclaw:
  format-version: "1.0"
  emoji: "🎵"
  compatibility:
    - nanoclaw
    - oxiclaw
  requires:
    bins:
      - spogo
      - spotify_player
  install:
    - kind: "brew"
      formula: "spogo"
      tap: "steipete/tap"
---

# Spotify Playback

Use the `spogo` CLI for Spotify control inside containers. Fall back to `spotify_player` if spogo is unavailable.

## Prerequisites

- Spotify Premium account
- Authentication via cookie import: `spogo auth import --browser chrome`

## Common Commands

| Action | spogo | spotify_player |
|--------|-------|----------------|
| Search | `spogo search track "query"` | `spotify_player search "query"` |
| Play | `spogo play` | `spotify_player playback play` |
| Pause | `spogo pause` | `spotify_player playback pause` |
| Next | `spogo next` | `spotify_player playback next` |
| Previous | `spogo prev` | `spotify_player playback previous` |
| Status | `spogo status` | - |
| Devices | `spogo device list`, `spogo device set "<name>"` | `spotify_player connect` |
| Like | - | `spotify_player like` |
| Volume | `spogo volume <0-100>` | - |
| Shuffle | `spogo shuffle on\|off` | - |
| Repeat | `spogo repeat track\|context\|off` | - |

## Usage Examples

### Play a track by name
```bash
spogo play "Stairway to Heaven"
```

### Check what's playing
```bash
spogo status
```

### Control volume
```bash
spogo volume 50
```

### Switch to a specific device
```bash
spogo device list
spogo device set "Living Room Speaker"
```

## Configuration

- Config folder: `~/.config/spotify-player`
- For Spotify Connect, set `client_id` in config

## Tips

- `spogo` is preferred — it has a simpler interface and better device management
- Use `spogo --help` to see all available commands
- For TUI mode, just run `spogo` without arguments
