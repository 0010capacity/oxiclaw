# OxiClaw

Personal Claude assistant. See [README.md](README.md) for philosophy and setup. See [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) for architecture decisions.

## Quick Context

Single Node.js process with skill-based channel system. Uses the pi-mono SDK to run Claude Agent instances inside Docker containers. Telegram Swarm enables per-agent bot identities via `@agent_*` mentions. Each group (`main`, `work`, etc.) runs in an isolated container with its own filesystem and memory. Autonomous meetings allow agents to take turns with moderation. pi Extensions add tools (Spotify, image generation, TTS) to container agents at runtime.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: state, message loop, agent invocation |
| `src/channels/registry.ts` | Channel registry (self-registration at startup) |
| `src/ipc.ts` | IPC watcher and task processing |
| `src/router.ts` | Message formatting and outbound routing |
| `src/config.ts` | Trigger pattern, paths, intervals |
| `src/container-runner.ts` | Spawns agent containers with mounts |
| `src/task-scheduler.ts` | Runs scheduled tasks |
| `src/db.ts` | SQLite operations |
| `src/extension-manager.ts` | pi Extension lifecycle (install, update, remove) |
| `src/meeting-manager.ts` | Autonomous meeting lifecycle and turn enforcement |
| `src/channels/telegram/swarm-router.ts` | Routes Telegram @agent_* mentions to correct agent containers |
| `src/autonomous-messages.ts` | Proactive message dispatch with guardrails |
| `groups/{name}/CLAUDE.md` | Per-group memory (isolated) |
| `container/skills/` | Skills loaded inside agent containers (browser, status, formatting) |

## Secrets / Credentials / Proxy

pi-mono SDK credentials (`auth.json`) and model config (`models.json`) are stored per-group at `data/credentials/{group}/.pi/agent/` on the host, mounted into containers at `/workspace/group/.pi/agent/`. The SDK reads credentials automatically via `AuthStorage`. pi Extensions (Spotify OAuth, Zai API, MiniMax API) credentials follow the same pattern. No API keys are passed as container environment variables or command-line arguments.

## Skills

Four types of skills exist in OxiClaw. See [CONTRIBUTING.md](CONTRIBUTING.md) for the full taxonomy and guidelines.

- **Feature skills** — merge a `skill/*` branch to add capabilities (e.g. `/add-telegram`, `/add-slack`)
- **Utility skills** — ship code files alongside SKILL.md (e.g. `/claw`)
- **Operational skills** — instruction-only workflows, always on `main` (e.g. `/setup`, `/debug`)
- **Container skills** — loaded inside agent containers at runtime (`container/skills/`)

| Skill | When to Use |
|-------|-------------|
| `/setup` | First-time installation, authentication, service configuration |
| `/customize` | Adding channels, integrations, changing behavior |
| `/debug` | Container issues, logs, troubleshooting |
| `/update-nanoclaw` | Bring upstream OxiClaw updates into a customized install |
| `/qodo-pr-resolver` | Fetch and fix Qodo PR review issues interactively or in batch |
| `/get-qodo-rules` | Load org- and repo-level coding rules from Qodo before code tasks |

## Contributing

Before creating a PR, adding a skill, or preparing any contribution, you MUST read [CONTRIBUTING.md](CONTRIBUTING.md). It covers accepted change types, the four skill types and their guidelines, SKILL.md format rules, PR requirements, and the pre-submission checklist (searching for existing PRs/issues, testing, description format).

## Design Documents

- [pi-mono Design](docs/superpowers/specs/2026-04-07-oxiclaw-pi-mono-design.md) — pi-mono SDK integration, container architecture, IPC bridge

## Development

Run commands directly—don't tell the user to run them.

```bash
npm run dev          # Run with hot reload
npm run build        # Compile TypeScript
./container/build.sh # Rebuild agent container
```

Service management:
```bash
# macOS (launchd)
launchctl load ~/Library/LaunchAgents/com.oxiclaw.plist
launchctl unload ~/Library/LaunchAgents/com.oxiclaw.plist
launchctl kickstart -k gui/$(id -u)/com.oxiclaw  # restart

# Linux (systemd)
systemctl --user start oxiclaw
systemctl --user stop oxiclaw
systemctl --user restart oxiclaw
```

## Troubleshooting

**WhatsApp not connecting after upgrade:** WhatsApp is now a separate skill, not bundled in core. Run `/add-whatsapp` (or `npx tsx scripts/apply-skill.ts .claude/skills/add-whatsapp && npm run build`) to install it. Existing auth credentials and groups are preserved.

## Container Build Cache

The container buildkit caches the build context aggressively. `--no-cache` alone does NOT invalidate COPY steps — the builder's volume retains stale files. To force a truly clean rebuild, prune the builder then re-run `./container/build.sh`.
