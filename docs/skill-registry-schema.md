# OxiClaw Skill Registry Schema

This document describes the skill registry format, directory structure, and install flow for OxiClaw skills.

## Registry Index Format

The registry is a JSON file hosted at a predictable URL (e.g. `https://raw.githubusercontent.com/oxiclaw/skill-registry/main/registry.json`). It uses a npm/package.json-inspired format:

```json
{
  "format-version": "1.0",
  "registry": "oxiclaw",
  "updated_at": "2026-04-08T00:00:00Z",
  "skills": [
    {
      "name": "spotify",
      "version": "1.0.0",
      "description": "Spotify playback via spogo CLI",
      "category": "container-tool",
      "repository": "https://github.com/oxiclaw/skill-spotify",
      "sha": "abc123...",
      "skill_md_path": "SKILL.md",
      "cli_dependencies": ["spogo"]
    }
  ]
}
```

### Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `format-version` | string | Yes | Format version (currently `1.0`). Clients use this to parse fields correctly. |
| `registry` | string | Yes | Registry identifier (e.g. `oxiclaw`). |
| `updated_at` | string (ISO 8601) | Yes | Last update timestamp for the entire registry. |
| `skills` | array | Yes | Array of skill manifests. |

### Skill Manifest Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Unique skill name. Used as directory name under `container/skills/`. |
| `version` | string (semver) | Yes | Version string for the skill. |
| `description` | string | Yes | Human-readable one-line description. |
| `category` | string | Yes | One of: `container-tool`, `channel`, `utility`, `feature`. |
| `repository` | string | Yes | Git URL for the skill repo. |
| `sha` | string | No | Git commit SHA for reproducibility. |
| `skill_md_path` | string | No | Path within the repo to SKILL.md (default: `SKILL.md`). |
| `cli_dependencies` | string[] | No | Host-side CLI tools that must be present for the skill to work. |

## Skill Repository Structure

Each skill is a Git repository containing at minimum a `SKILL.md` file:

```
skill-spotify/
├── SKILL.md           # Required — skill definition and instructions
├── README.md          # Optional — human-readable docs
└── (supporting files if any)
```

### SKILL.md Frontmatter

```markdown
---
name: spotify
version: 1.0.0
description: Spotify playback control via spogo CLI
category: container-tool
---

# /spotify — Spotify Control

Instructions for using the skill...
```

## Categories

| Category | Description |
|----------|-------------|
| `container-tool` | Adds tools callable inside the pi-mono container (e.g. `spogo`, `ffmpeg`). |
| `channel` | Integrates a new messaging channel (Telegram, Slack, etc.). |
| `utility` | General-purpose utility skill for the agent. |
| `feature` | Adds a capability to OxiClaw itself (e.g. `/add-telegram`). |

## Install Flow

1. **User invokes `/skill add <name>`** — either a registry name or a git URL.
2. **Registry lookup** — if given a name, look it up in the registry index to resolve the `repository` URL.
3. **Git clone** — `git clone --depth 1 <repository>` into a temp directory.
4. **SKILL.md discovery** — find `SKILL.md` at root or in subdirectory.
5. **Copy to `container/skills/{name}/`** — copy `SKILL.md` and any supporting files.
6. **Container rebuild** — if the agent container is running, signal a reload (or rebuild on next restart).

## Built-in Skills Location

Built-in skills are stored at `container/skills/{name}/` in the OxiClaw project root. These are bundled with OxiClaw and do not need to be downloaded.

## Per-group Skill Overrides

Skills can be installed per-group by copying to `data/credentials/{group}/.pi/skills/` instead of the built-in `container/skills/`. The container startup script in `container-runner.ts` syncs skills from `container/skills/` into each group's `.pi/skills/` directory on every container start.

## IPC Integration

The skill manager does not require IPC integration for basic `/skill add` and `/skill list` commands — these operate entirely on the host filesystem. For container-side skill listing (via `/capabilities`), the existing `container/skills/` mount already makes skills visible inside containers. No additional IPC handlers are needed.

## Security Notes

- Skills are only installed from trusted registry sources.
- The install process runs `git clone` with `--depth 1` to limit data transfer.
- Per-group skills in `data/credentials/` are isolated between groups.
- Built-in skills under `container/skills/` are read-only mounted into containers.
