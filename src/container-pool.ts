/**
 * Container Pool for OxiClaw
 *
 * Manages a pool of reusable agent containers.
 * Key design decisions:
 *
 * 1. Pre-warm idle containers during startup/idle so they're ready before
 *    messages arrive. A warm container can accept a new prompt immediately;
 *    a cold one wastes 5-30s spinning up.
 *
 * 2. Keep stdin open so the container stays alive after the initial prompt.
 *    agent-runner polls /workspace/ipc/input/ for new messages and the
 *    _close sentinel for graceful shutdown.
 *
 * 3. Separate container lifecycle from prompt lifecycle:
 *    - Container spawns once per group JID (or pool size)
 *    - Each prompt sends a JSON-RPC prompt request via stdin
 *    - The container processes prompts sequentially, sending responses via stdout
 *
 * 4. Two idle strategies:
 *    - Active idle: container is alive with a session, polling for messages
 *    - Dormant idle: container exited but the pool entry is kept warm for reuse
 *      (dormant containers still incur memory overhead; consider container
 *       pause/freeze if memory pressure is high)
 */

import { ChildProcess, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  CONTAINER_IMAGE,
  DATA_DIR,
  IDLE_TIMEOUT,
  IPC_POLL_INTERVAL,
  TIMEZONE,
} from './config.js';
import { buildVolumeMounts, type VolumeMount } from './container-mounts.js';
import { logger } from './logger.js';
import {
  CONTAINER_RUNTIME_BIN,
  hostGatewayArgs,
  readonlyMountArgs,
  stopContainer,
} from './container-runtime.js';
import { RegisteredGroup } from './types.js';

// Re-export snapshot helpers from container-runner so callers don't need a second import
export {
  writeTasksSnapshot,
  writeGroupsSnapshot,
  type AvailableGroup,
} from './container-runner.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PooledContainer {
  groupJid: string;
  groupFolder: string;
  process: ChildProcess;
  containerName: string;
  isReady: boolean; // init RPC has completed
  isIdle: boolean; // waiting for IPC input
  lastUsed: number; // timestamp of last prompt
  pendingPromptResolve?: (output: ContainerOutput) => void;
  pendingPromptReject?: (err: Error) => void;
}

export interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
  images?: string[];
}

export interface PooledContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  script?: string;
  images?: string[];
}

// ---------------------------------------------------------------------------
// JSON-RPC protocol helpers (shared with container-runner.ts)
// ---------------------------------------------------------------------------

let rpcRequestId = 0;
function nextRpcId(): number {
  return ++rpcRequestId;
}

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | null;
  result?: unknown;
  error?: { code: number; message: string };
}

// ---------------------------------------------------------------------------
// Container args builder
// ---------------------------------------------------------------------------

async function buildContainerArgsForPool(
  mounts: VolumeMount[],
  containerName: string,
  group: RegisteredGroup,
): Promise<string[]> {
  const args: string[] = ['run', '-i', '--name', containerName];

  args.push('-e', `TZ=${TIMEZONE}`);
  args.push('-e', 'XDG_CONFIG_HOME=/workspace/group');
  args.push('-e', `AGENT_SESSION_ID=${containerName}`);
  args.push(...hostGatewayArgs());

  const hostUid = process.getuid?.();
  const hostGid = process.getgid?.();
  if (hostUid != null && hostUid !== 0 && hostUid !== 1000) {
    args.push('--user', `${hostUid}:${hostGid}`);
    args.push('-e', 'HOME=/home/node');
  }

  for (const mount of mounts) {
    if (mount.readonly) {
      args.push(...readonlyMountArgs(mount.hostPath, mount.containerPath));
    } else {
      args.push('-v', `${mount.hostPath}:${mount.containerPath}`);
    }
  }

  args.push(CONTAINER_IMAGE);

  return args;
}

// ---------------------------------------------------------------------------
// ContainerPool
// ---------------------------------------------------------------------------

export class ContainerPool {
  /** Active containers keyed by group JID (one container per group). */
  private activeContainers = new Map<string, PooledContainer>();

  /** Standby containers that have completed init but are not assigned yet. */
  private standbyContainers: PooledContainer[] = [];

  private readonly projectRoot: string;
  private readonly DATA_DIR: string;
  private readonly poolSize: number;
  private ipcPollInterval: number;
  private shuttingDown = false;

  constructor(
    projectRoot: string,
    _GROUPS_DIR: string,
    DATA_DIR: string,
    poolSize = 1,
  ) {
    this.projectRoot = projectRoot;
    this.DATA_DIR = DATA_DIR;
    this.poolSize = poolSize;
    this.ipcPollInterval = IPC_POLL_INTERVAL;
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Send a prompt to a container (reuse idle or spawn new).
   * Returns when the container sends its JSON-RPC response via stdout.
   */
  async sendPrompt(
    group: RegisteredGroup,
    input: PooledContainerInput,
  ): Promise<ContainerOutput> {
    let container = this.activeContainers.get(input.chatJid);

    if (container && container.isReady && container.process.stdin?.writable) {
      // Reuse existing container
      logger.debug(
        { group: group.name, containerName: container.containerName },
        'PooledContainer: reusing active container',
      );
      return this.sendPromptToContainer(container, input);
    }

    // Spawn or reuse standby
    if (this.standbyContainers.length > 0) {
      const standby = this.standbyContainers.shift()!;
      // Re-assign to this group
      standby.groupJid = input.chatJid;
      standby.groupFolder = input.groupFolder;
      this.activeContainers.set(input.chatJid, standby);
      logger.debug(
        { group: group.name, containerName: standby.containerName },
        'PooledContainer: promoting standby container',
      );
      return this.sendPromptToContainer(standby, input);
    }

    // Spawn new container
    container = await this.spawnContainer(
      group,
      input.chatJid,
      input.groupFolder,
    );
    this.activeContainers.set(input.chatJid, container);
    return this.sendPromptToContainer(container, input);
  }

  /**
   * Get the stdin handle for a group's container.
   * Used by health checker to send stdin-based health check requests.
   */
  getStdin(groupJid: string): NodeJS.WritableStream | null {
    const container = this.activeContainers.get(groupJid);
    return container?.process.stdin ?? null;
  }

  /**
   * Get the container name for a group's container.
   */
  getContainerName(groupJid: string): string | null {
    const container = this.activeContainers.get(groupJid);
    return container?.containerName ?? null;
  }

  /**
   * Mark a container as idle (finished processing).
   * If a _close sentinel has been written, shut it down.
   */
  markIdle(groupJid: string): void {
    const container = this.activeContainers.get(groupJid);
    if (!container) return;

    // Check if _close sentinel was written while this container was processing
    const inputDir = path.join(
      this.DATA_DIR,
      'ipc',
      container.groupFolder,
      'input',
    );
    const closeSentinel = path.join(inputDir, '_close');
    if (fs.existsSync(closeSentinel)) {
      logger.debug(
        { groupJid },
        'PooledContainer: _close sentinel found, shutting down',
      );
      this.destroyContainer(container);
      this.activeContainers.delete(groupJid);
      return;
    }

    container.isIdle = true;
    logger.debug(
      { groupJid, containerName: container.containerName },
      'PooledContainer: marked idle',
    );
  }

  /**
   * Pre-warm a container for a group so it's ready before messages arrive.
   * The container initializes its session and enters idle-waiting state.
   */
  prewarm(group: RegisteredGroup, groupJid: string): void {
    if (this.activeContainers.has(groupJid)) {
      logger.debug(
        { groupJid },
        'PooledContainer: already active, skipping prewarm',
      );
      return;
    }

    // Check if already in standby
    const alreadyStandby = this.standbyContainers.some(
      (c) => c.groupFolder === group.folder,
    );
    if (alreadyStandby) {
      logger.debug(
        { groupJid, folder: group.folder },
        'PooledContainer: already in standby',
      );
      return;
    }

    // Spawn a warm container
    this.spawnContainer(group, groupJid, group.folder)
      .then((container) => {
        // Put in standby pool — it will be assigned on next sendPrompt
        this.standbyContainers.push(container);
        logger.debug(
          { groupJid, containerName: container.containerName },
          'PooledContainer: prewarmed (standby)',
        );
      })
      .catch((err) => {
        logger.error({ groupJid, err }, 'PooledContainer: prewarm failed');
      });
  }

  /**
   * Signal a group's container to shut down by writing the _close sentinel.
   */
  closeContainer(groupJid: string): void {
    const container = this.activeContainers.get(groupJid);
    if (!container) {
      // Also check standby pool
      const idx = this.standbyContainers.findIndex(
        (c) => c.groupJid === groupJid,
      );
      if (idx >= 0) {
        this.destroyContainer(this.standbyContainers[idx]);
        this.standbyContainers.splice(idx, 1);
      }
      return;
    }

    // Write _close sentinel so the container shuts down cleanly
    const inputDir = path.join(
      this.DATA_DIR,
      'ipc',
      container.groupFolder,
      'input',
    );
    try {
      fs.mkdirSync(inputDir, { recursive: true });
      fs.writeFileSync(path.join(inputDir, '_close'), '');
      logger.debug(
        { groupJid, containerName: container.containerName },
        'PooledContainer: _close sentinel written',
      );
    } catch (err) {
      logger.warn(
        { groupJid, err },
        'PooledContainer: failed to write _close sentinel',
      );
      this.destroyContainer(container);
    }
  }

  /**
   * Restart a group's container: kill and remove, then prewarm.
   */
  restartGroup(group: RegisteredGroup, groupJid: string): void {
    const container = this.activeContainers.get(groupJid);
    if (container) {
      this.destroyContainer(container);
      this.activeContainers.delete(groupJid);
    }
    this.prewarm(group, groupJid);
  }

  /** Shut down all containers in the pool. */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;

    const activeContainers = Array.from(this.activeContainers.values());
    this.activeContainers.clear();

    for (const container of [...activeContainers, ...this.standbyContainers]) {
      this.destroyContainer(container);
    }
    this.standbyContainers = [];

    logger.info(
      { activeCount: activeContainers.length },
      'ContainerPool shut down',
    );
  }

  // -----------------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------------

  /**
   * Spawn a new container, send init, and wait for init response.
   * The container stays alive (stdin open) until closed.
   */
  private async spawnContainer(
    group: RegisteredGroup,
    groupJid: string,
    groupFolder: string,
  ): Promise<PooledContainer> {
    const isMain = group.isMain === true;
    const mounts = buildVolumeMounts(this.projectRoot, group, isMain);

    const safeName = groupFolder.replace(/[^a-zA-Z0-9-]/g, '-');
    const containerName = `oxiclaw-${safeName}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

    const containerArgs = await buildContainerArgsForPool(
      mounts,
      containerName,
      group,
    );

    logger.debug(
      { group: group.name, containerName, mountCount: mounts.length },
      'PooledContainer: spawning',
    );

    const container = spawn(CONTAINER_RUNTIME_BIN, containerArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const pooled: PooledContainer = {
      groupJid,
      groupFolder,
      process: container,
      containerName,
      isReady: false,
      isIdle: false,
      lastUsed: Date.now(),
    };

    // Parse init response from stdout
    let initLineBuffer = '';
    let initResolved = false;

    const initRequest: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: nextRpcId(),
      method: 'init',
      params: {},
    };

    // Track stderr for error reporting
    let stderr = '';

    container.stderr.on('data', (data) => {
      const chunk = data.toString();
      const lines = chunk.trim().split('\n');
      for (const line of lines) {
        if (line) logger.debug({ container: groupFolder }, line);
      }
      stderr += chunk;
    });

    container.on('error', (err) => {
      logger.error(
        { group: group.name, containerName, err },
        'Container spawn error',
      );
      if (pooled.pendingPromptReject) {
        pooled.pendingPromptReject(err);
        pooled.pendingPromptResolve = undefined;
        pooled.pendingPromptReject = undefined;
      }
    });

    container.on('close', (code) => {
      logger.debug(
        { group: group.name, containerName, code },
        'PooledContainer: container closed',
      );
      // Remove from active containers if still registered
      if (this.activeContainers.get(groupJid) === pooled) {
        this.activeContainers.delete(groupJid);
      }
      // Reject any pending prompt with a fresh error
      if (pooled.pendingPromptReject) {
        pooled.pendingPromptReject(
          new Error(`Container exited unexpectedly (code ${code})`),
        );
        pooled.pendingPromptResolve = undefined;
        pooled.pendingPromptReject = undefined;
      }
    });

    // Send init request BEFORE waiting for response
    container.stdin.write(JSON.stringify(initRequest) + '\n');

    // Wait for init response before returning — with timeout so we don't hang forever
    const INIT_TIMEOUT_MS = 60_000;
    let resolveInit: () => void;
    let rejectInit: (err: Error) => void;
    const initTimeout = setTimeout(() => {
      if (!initResolved) {
        logger.warn(
          { group: group.name, containerName },
          'PooledContainer: init timeout, forcing init',
        );
        initResolved = true;
        pooled.isReady = true;
        resolveInit();
      }
    }, INIT_TIMEOUT_MS);

    await new Promise<void>((_resolveInit, _rejectInit) => {
      resolveInit = _resolveInit;
      rejectInit = _rejectInit;
      container.stdout.on('data', (data) => {
        const chunk = data.toString();
        initLineBuffer += chunk;
        if (initResolved) return;
        const lines = initLineBuffer.split('\n');
        initLineBuffer = lines.pop() || '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const msg = JSON.parse(trimmed) as JsonRpcResponse;
            if ('id' in msg && msg.id === initRequest.id) {
              initResolved = true;
              clearTimeout(initTimeout);
              if (msg.error) {
                rejectInit(new Error('Init failed: ' + msg.error.message));
              } else {
                pooled.isReady = true;
                logger.debug(
                  { group: group.name, containerName },
                  'PooledContainer: init complete',
                );
                resolveInit();
              }
            }
          } catch {
            // Not JSON yet, continue buffering
          }
        }
      });
    }).catch((err) => {
      clearTimeout(initTimeout);
      // If init fails, destroy the container and propagate
      this.destroyContainer(pooled);
      throw err;
    });

    return pooled;
  }

  /**
   * Send a prompt JSON-RPC request to a container and wait for the response.
   * The container stays alive (stdin open) after the prompt completes.
   */
  private sendPromptToContainer(
    container: PooledContainer,
    input: PooledContainerInput,
  ): Promise<ContainerOutput> {
    return new Promise((resolve, reject) => {
      const promptRequest: JsonRpcRequest = {
        jsonrpc: '2.0',
        id: nextRpcId(),
        method: 'prompt',
        params: {
          prompt: input.prompt,
          session_id: input.sessionId || 'default',
          group_folder: input.groupFolder,
          chat_jid: input.chatJid,
          is_main: input.isMain,
          is_scheduled_task: input.isScheduledTask || false,
          assistant_name: input.assistantName,
          script: input.script,
          images: input.images || [],
        },
      };

      logger.debug(
        { containerName: container.containerName, promptRpcId: promptRequest.id },
        'PooledContainer: sending prompt',
      );

      container.lastUsed = Date.now();
      container.isIdle = false;
      container.pendingPromptResolve = resolve;
      container.pendingPromptReject = reject;

      // Parse responses from stdout
      let lineBuffer = '';

      const handleData = (data: Buffer) => {
        const chunk = data.toString();
        logger.debug(
          {
            containerName: container.containerName,
            chunkLen: chunk.length,
            preview: JSON.stringify(chunk.slice(0, 220)),
          },
          'PooledContainer: stdout chunk',
        );
        lineBuffer += chunk;
        const lines = lineBuffer.split('\n');
        lineBuffer = lines.pop() || '';

        const tryResolveFromJson = (jsonText: string): boolean => {
          try {
            const msg = JSON.parse(jsonText) as JsonRpcResponse;
            if ('id' in msg && msg.id != null) {
              logger.debug(
                {
                  containerName: container.containerName,
                  parsedRpcId: msg.id,
                  expectedRpcId: promptRequest.id,
                },
                'PooledContainer: parsed RPC response',
              );
            }

            if ('id' in msg && msg.id != null && msg.id === promptRequest.id) {
              // Remove handler to prevent double-calling
              container.process.stdout?.off('data', handleData);

              const result = msg.result as
                | {
                    session_id?: string;
                    content?: string;
                    tool_calls?: Array<{
                      name: string;
                      params: Record<string, unknown>;
                    }>;
                    images?: string[];
                  }
                | undefined;

              const output: ContainerOutput = {
                status: msg.error ? 'error' : 'success',
                result: msg.error ? null : result?.content || null,
                newSessionId: result?.session_id,
                images: result?.images,
                error: msg.error?.message,
              };

              resolve(output);
              container.pendingPromptResolve = undefined;
              container.pendingPromptReject = undefined;
              return true;
            }
          } catch {
            // Not complete JSON yet
          }
          return false;
        };

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          if (tryResolveFromJson(trimmed)) return;
        }

        // Fallback: some environments may emit a full JSON response without a
        // trailing newline. Try parsing the current buffer as a complete JSON object.
        const buffered = lineBuffer.trim();
        if (buffered && tryResolveFromJson(buffered)) {
          lineBuffer = '';
          return;
        }
      };

      // IMPORTANT: attach stdout handler BEFORE writing prompt to avoid races
      // where very fast responses arrive before listener registration.
      container.process.stdout?.on('data', handleData);

      // Write prompt to stdin (DO NOT call stdin.end() — keep container alive)
      if (!container.process.stdin?.writable) {
        container.process.stdout?.off('data', handleData);
        reject(new Error('Container stdin not writable'));
        return;
      }
      container.process.stdin.write(JSON.stringify(promptRequest) + '\n');
    });
  }

  /**
   * Destroy a container gracefully, then forcibly if needed.
   */
  private destroyContainer(container: PooledContainer): void {
    try {
      stopContainer(container.containerName);
    } catch {
      // Already stopped or not found
      try {
        container.process.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }
  }
}
