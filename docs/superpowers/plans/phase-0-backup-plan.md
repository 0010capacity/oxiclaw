# Phase 0 Backup Plan

> **Date:** 2026-04-08
> **Trigger:** Phase 0 SDK verification reveals missing or incompatible APIs

---

## Scenario A: SDK Not on npm

**Condition:** `@mariozechner/pi-coding-agent` is not installable via `npm install` (package not found, network blocked, or version `^1.0.0` does not exist).

**Fallback Options:**

1. **Clone from GitHub directly**
   ```bash
   git clone https://github.com/badlogic/pi-mono.git /path/to/pi-mono
   cd pi-mono/packages/coding-agent
   npm install
   # Reference locally via file: or link:
   ```

2. **Use `openai-agents` SDK as alternative**
   - Requires rewriting the agent runner interface
   - Significantly higher migration cost
   - Not recommended unless GitHub clone also fails

**Decision criteria:** If `npm install @mariozechner/pi-coding-agent` fails with "not found", attempt GitHub clone. Only fall back to `openai-agents` if GitHub is also unreachable.

---

## Scenario B: API Differs from Design (SessionManager absent)

**Condition:** `SessionManager` class does not exist in the SDK. Only `createAgentSession` is available, producing a single session.

**Impact on design:**
- Original plan: one container with multiple agents via `SessionManager`
- Actual SDK: one container = one session = one agent

**Fallback Architecture — Single Session Per Container:**

```
Orchestrator (host)
  └── Container 1 (group A)     → session A (single agent)
  └── Container 2 (group B)    → session B (single agent)
  └── Container N (group N)    → session N (single agent)
```

- Each group gets its own container (status quo, but now explicitly required)
- Swarm/multi-agent within a single group requires multiple containers with a routing layer
- IPC bridge can route between containers if a "hub" agent is needed

**Implementation changes for Phase 1:**
- Remove all `SessionManager` references from design docs
- Treat each container as a single-agent unit
- If swarm behavior is needed for a group, spawn multiple containers and use the orchestrator as a router
- `session.subscribe()` continues to work for event forwarding

---

## Scenario C: No Runtime Extension Loading

**Condition:** pi Extension system (`registerTool`, `registerCommand`, `registerFlag`) is not present. Extensions are baked in at build time or not supported.

**Impact on design:**
- Original plan: load extensions at runtime via `pi.registerTool()`, no rebuild needed
- Actual: extensions must be compiled into the container image

**Fallback Architecture — Build-Time Extension Loading:**

1. **Extension files are copied to `container/skills/` directory**
   ```bash
   cp extension-file.ts container/skills/
   ```

2. **Container build picks up extensions**
   ```bash
   ./container/build.sh   # rebuilds image including new extensions
   ```

3. **`/extension add` CLI becomes a file copy + rebuild trigger**
   - Copies extension source to `container/skills/`
   - Runs `docker build` (or `build.sh`)
   - Notifies orchestrator to restart container

4. **No dynamic loading** — the agent runner does not have `registerTool` or equivalent APIs

**Implementation changes for Phase 1:**
- Extension skill only copies files and triggers rebuild, does not inject at runtime
- Container startup is the "extension load" moment (build time)
- Consider caching the build layer for `container/skills/` to speed up extension-only rebuilds

---

## Summary Matrix

| Scenario | Trigger | Fallback |
|----------|---------|----------|
| A: SDK not on npm | `npm install` fails | Clone from GitHub, then openai-agents |
| B: API differs (no SessionManager) | `SessionManager` not in SDK | Single session per container; multi-container swarm |
| C: No runtime extension loading | `registerTool`/`Extension` not in SDK | Build-time extension loading; `docker build` on extension change |

**Current actual state:** Scenario B and Scenario C both apply. Scenario A is not triggered (SDK is listed and imported). Phase 1 must adopt the fallback architectures for B and C.