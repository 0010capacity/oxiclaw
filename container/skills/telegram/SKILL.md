---
name: telegram
description: Send messages, photos, and files to Telegram via tg CLI or telegram-send
version: "1.0.0"
category: capability
openclaw:
  format-version: "1.0"
  emoji: "📱"
  compatibility:
    - nanoclaw
    - oxiclaw
  requires:
    bins:
      - tg
      - telegram-send
  install:
    - kind: "brew"
      formula: "telegram-send"
      tap: "steipete/tap"
    - kind: "brew"
      formula: "telegram-cli"
      tap: "navanchauhan/telegram"
---

# Telegram Messaging

Use the `tg` CLI or `telegram-send` to send messages and media to Telegram.

## Prerequisites

- Telegram Bot Token (set via `TG_BOT_TOKEN` environment variable)
- For `tg`: working Telegram session with `tg-server.pub` or `telegram-cli` session
- For `telegram-send`: configure with `telegram-send --configure`

## Common Commands

### Using telegram-send

| Action | Command |
|--------|---------|
| Send text | `telegram-send "Hello world"` |
| Send photo | `telegram-send --image /path/to/photo.jpg` |
| Send file | `telegram-send --file /path/to/doc.pdf` |
| Send with caption | `telegram-send --image /path/photo.jpg --caption "Photo caption"` |
| To channel | `telegram-send --channel @channelname "message"` |
| To chat ID | `telegram-send --chat-id 123456 "message"` |

### Using tg CLI

| Action | Command |
|--------|---------|
| Send message | `tg -W <chat_id> "Hello"` |
| Send photo | `tg -W <chat_id> -f /path/photo.jpg "Caption"` |
| Send document | `tg -W <chat_id> -d /path/file.pdf` |

## Finding Chat IDs

```bash
# List recent dialogs
telegram-send --list-dialogs

# Or look in ~/.telegram-cli directory after running tg interactively
```

## Configuration

### telegram-send config (~/.config/telegram-send.ini)
```ini
[telegram]
bot_token = YOUR_BOT_TOKEN_HERE
```

### Environment Variables
- `TG_BOT_TOKEN` — Telegram bot token (required for most operations)

## Usage Examples

### Send a text alert
```bash
telegram-send "Build completed successfully"
```

### Send an image with caption
```bash
telegram-send --image /tmp/screenshot.png --caption "Error screenshot"
```

### Send to a specific chat
```bash
telegram-send --chat-id -1001234567890 "Scheduled report"
```

## Tips

- `telegram-send` is simpler for single messages — prefer it for alerts and notifications
- `tg` is more powerful but requires an active session
- Use `--format markdown` for formatted messages with `telegram-send`
- Bot must be a member of the channel to send to channels
