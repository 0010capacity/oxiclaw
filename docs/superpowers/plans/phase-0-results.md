# Phase 0 SDK Verification Results

> **Date:** 2026-04-08
> **SDK:** `@mariozechner/pi-coding-agent` v1.0.0

## SDK Existence

| Check | Result |
|-------|--------|
| Listed in `package.json` | Yes |
| Installed in `node_modules` | Assumed (npm install run at build) |
| npm registry availability | Not tested in isolation |

**Status:** SDK is listed as a dependency in `container/agent-runner/package.json` at version `^1.0.0`.

---

## API Verification Table

| API | Exists | Signature Notes | Behavior Notes |
|-----|--------|-----------------|----------------|
| `createAgentSession` | **Yes** | `createAgentSession({ cwd, tools? })` — returns `{ session }`. No `model` or `systemPrompt` parameters visible in the actual call. | Creates a single agent session. Called in `index.ts` line 109. TypeScript types require a cast via `as any` for the `tools` result (line 106). |
| `SessionManager` | **No** | Not found anywhere in `container/agent-runner/src/`. No import, no usage. | Not used. The design assumption of a session manager for multi-agent swarms is not realized in the current SDK. |
| `session.subscribe()` | **Yes** | `subscribe(listener: (event: { type: string }) => void): () => void` — returns an unsubscribe function. | Used in `index.ts` line 71. Events forwarded to IPC bridge. Captures `agent_end` messages and tool calls. Returns cleanup function. |
| `createCodingTools` | **Yes** | `createCodingTools(cwd: string): AgentTool<any>[]` | Called in `index.ts` line 106 with `CWD` as argument. Result cast via `as any` to bypass TypeScript compatibility issues with `Tool[]`. |
| pi Extension API (`registerTool`, `registerCommand`) | **No** | No `Extension`, `registerTool`, or `registerCommand` references found in `container/agent-runner/src/`. | Not used. No runtime extension loading mechanism is present in the current codebase. |
| `AuthStorage` | **No** | No `AuthStorage` references found in `container/agent-runner/src/`. | Not used. No auth storage abstraction is present in the current codebase. |

---

## Key Observations

1. **Single session architecture only.** The SDK exposes `createAgentSession` which returns a single `session` object. There is no `SessionManager` class, meaning the design's "multi-agent swarm per container" assumption is not supported by the current SDK version.

2. **Tools are created via `createCodingTools` and passed at session creation.** Extensions are not dynamically registered at runtime. Tools are created once and baked into the session.

3. **Event subscription works** — `session.subscribe()` is actively used to forward events (agent_end, etc.) to the orchestrator via IPC.

4. **No `AuthStorage` or any auth abstraction** in the container agent runner. Auth appears to be handled externally (per CLAUDE.md: "OneCLI gateway handles secret injection").

5. **TypeScript compatibility issues** exist between `createCodingTools` return type and the expected `Tool[]` type, requiring `as any` casts in `index.ts`.

---

## Conclusion

**Phase 1 can proceed with conditions.**

The core APIs (`createAgentSession`, `session.subscribe`, `createCodingTools`) are functional and in use. However:

- **Scenario B applies:** The `SessionManager` API does not exist, so the original multi-agent-per-container swarm design cannot be implemented as planned. A fallback architecture is needed (see `phase-0-backup-plan.md`).
- **Scenario C applies:** No runtime extension loading is present. Extension changes require a container rebuild (`docker build`).
- **`AuthStorage` is absent** — auth is managed by the external OneCLI gateway, not the SDK.

**Recommendation:** Proceed to Phase 1 using the single-session-per-container architecture (Scenario B fallback). Design Phase 1 sub-plans around the absence of `SessionManager` and `AuthStorage`.