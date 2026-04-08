# Integration Test Checklist

Organized by phase. Each phase should be validated end-to-end before moving to the next.

---

## Phase 1 — Foundation

- [ ] `pi-mono` starts successfully inside the Docker container
- [ ] IPC bridge (`ipc-bridge.ts`) establishes communication between host and container
- [ ] Host sends a basic prompt and receives a response from the agent
- [ ] `HealthChecker` runs on schedule and reports healthy status
- [ ] Container logs show no unhandled rejection / uncaught exceptions on startup
- [ ] Group filesystem mount is present and readable inside container
- [ ] `groups/{name}/CLAUDE.md` is loaded as the agent's system prompt

---

## Phase 2 — Telegram Swarm

### Bot Identity
- [ ] `@oxiclawbot` bot is reachable and responds to `/start`
- [ ] Bot list command (`/bots` or similar) returns all registered agent bots

### Mention Routing
- [ ] `@agent_alpha` mention triggers only the `alpha` agent
- [ ] `@agent_beta` mention triggers only the `beta` agent
- [ ] `@oxiclawbot all` triggers all agents simultaneously (each agent processes independently)
- [ ] Plain message to group (no mention) does NOT trigger any agent

### Response Format
- [ ] Each agent's response has the correct `@agent_*` prefix in the group reply
- [ ] Response latency is under 60 seconds for a simple prompt
- [ ] Mentions to non-existent agents return a clear error / "unknown agent" message

### Persona Loading
- [ ] `persona.md` is loaded as the system prompt for each respective agent
- [ ] Changing `persona.md` takes effect after container restart (not mid-conversation)

### Multi-Agent Independence
- [ ] Two agents can be @mentioned simultaneously; both respond (order may vary)
- [ ] One agent's error does not prevent the other from responding
- [ ] Agents do not share conversation context unless explicitly configured

---

## Phase 3 — Autonomous

### Meeting Lifecycle
- [ ] `/meeting` starts a new meeting session
- [ ] Meeting title and participant list are recorded
- [ ] `Moderator` agent presents the agenda at meeting start
- [ ] Agents take turns in round-robin order (or priority order defined in config)

### Turn Enforcement
- [ ] A second consecutive turn from the same agent is blocked
- [ ] Turn limit is enforced; meeting ends when limit is reached
- [ ] Meeting summary is generated and sent to the Telegram group at end
- [ ] Mid-meeting `/meeting end` cancels gracefully and sends no summary

### Proactive Messages
- [ ] Autonomous agent sends a proactive (unsolicited) message to Telegram
- [ ] Message is sent only when guardrails are satisfied (e.g. not during quiet hours)
- [ ] Guardrail violations are logged but do not crash the agent
- [ ] Proactive messages include correct agent prefix

---

## Phase 4-5 — Multimodal

### Extension Management
- [ ] `/extension list` returns a list of installed extensions with versions
- [ ] `/extension add spotify` installs the `spotify` extension
- [ ] Installation completes without error; container restarts automatically
- [ ] `/extension remove spotify` uninstalls cleanly
- [ ] `/extension add nonexistent` returns a clear error (extension not found)

### Spotify Extension
- [ ] `spotify_play` tool resumes or starts playback
- [ ] `spotify_pause` tool pauses playback
- [ ] `spotify_now_playing` tool returns current track info (title, artist, album)
- [ ] Spotify credentials are NOT logged or exposed in any output

### Zai Extension (Image Generation + TTS)
- [ ] `zai_generate_image` tool accepts a text prompt and returns an image
- [ ] Generated image is delivered to Telegram correctly
- [ ] `tts_speak` tool converts text to audio and delivers to Telegram
- [ ] Both tools work inside a running meeting (as agenda items)

---

## General / Cross-Cutting

### Session Isolation
- [ ] Agent in `main` group cannot read files from `work` group
- [ ] Agent in `work` group cannot read files from `main` group
- [ ] Switching groups mid-session does not bleed context between groups

### Container Restart
- [ ] After host restart, containers start automatically (launchd/systemd)
- [ ] Mounted volumes are preserved across restarts
- [ ] SQLite database survives container restart
- [ ] Scheduled tasks resume on schedule after restart

### Security / Secrets
- [ ] API keys are NOT present in container logs (inspect with `docker logs`)
- [ ] API keys are NOT present in `HealthChecker` output
- [ ] Extension source is validated before installation
- [ ] `/extension add` rejects extensions that request `*` wildcard permissions

### Rate Limiting
- [ ] More than 10 messages per minute to the same group is rate-limited
- [ ] Rate-limit response includes retry-after hint
- [ ] Rate-limit does not affect other groups

### Error Handling
- [ ] Malformed Telegram update does not crash the host process
- [ ] Container OOM does not crash the host process
- [ ] Database write failure is retried and eventually surfaces to `HealthChecker`
