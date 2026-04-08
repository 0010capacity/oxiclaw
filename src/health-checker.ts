/**
 * HealthChecker for oxiclaw
 *
 * Periodically monitors running container agents via JSON-RPC `health_check`
 * method. Tracks health status in the agent_sessions table and auto-restarts
 * unhealthy containers after a configurable timeout.
 *
 * Heartbeat is independent of Telegram polling — the two concepts are
 * intentionally separated (see design spec section 3.4).
 */

import { logger } from './logger.js';
import {
  getActiveSessions,
  updateAgentSession,
  type AgentSession,
} from './db.js';
import { MeetingManager } from './channels/telegram/meeting-manager.js';

// --- Configuration ---

/** Interval between health check sweeps (default: 60 seconds) */
const DEFAULT_CHECK_INTERVAL_MS = 60_000;

/** Time without a successful health response before marking unhealthy (default: 5 minutes) */
const DEFAULT_UNHEALTHY_TIMEOUT_MS = 5 * 60_000;

/** Maximum consecutive failures before triggering a restart (default: 3) */
const DEFAULT_MAX_FAILURES = 3;

/** Timeout for a single JSON-RPC health_check request (default: 10 seconds) */
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

// --- Types ---

export type HealthStatus = 'healthy' | 'unhealthy' | 'unknown';

export interface HealthCheckResult {
  sessionId: string;
  groupId: string;
  containerId: string | null;
  status: HealthStatus;
  responseTimeMs?: number;
  error?: string;
}

export interface HealthCheckConfig {
  /** Interval between full health check sweeps */
  checkIntervalMs?: number;
  /** Time without response before marking unhealthy */
  unhealthyTimeoutMs?: number;
  /** Max consecutive failures before auto-restart */
  maxFailures?: number;
  /** Per-request timeout */
  requestTimeoutMs?: number;
  /** Called when a container needs to be restarted */
  onRestartNeeded?: (session: AgentSession) => Promise<void>;
  /** Optional custom health check sender (for testing or IPC transport swap) */
  sendHealthCheck?: (containerId: string) => Promise<HealthCheckResponse>;
}

export interface HealthCheckResponse {
  ok: boolean;
  uptime?: number;
  activeSessions?: number;
  error?: string;
}

interface SessionHealthState {
  consecutiveFailures: number;
  lastHealthyAt: number;
  lastCheckAt: number;
}

// --- HealthChecker class ---

export class HealthChecker {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly checkIntervalMs: number;
  private readonly unhealthyTimeoutMs: number;
  private readonly maxFailures: number;
  private readonly requestTimeoutMs: number;
  private readonly onRestartNeeded?: (session: AgentSession) => Promise<void>;
  private readonly sendHealthCheck?: (
    containerId: string,
  ) => Promise<HealthCheckResponse>;

  /** In-memory tracking of per-session failure counts */
  private readonly sessionStates = new Map<string, SessionHealthState>();
  private running = false;

  constructor(config: HealthCheckConfig = {}) {
    this.checkIntervalMs =
      config.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS;
    this.unhealthyTimeoutMs =
      config.unhealthyTimeoutMs ?? DEFAULT_UNHEALTHY_TIMEOUT_MS;
    this.maxFailures = config.maxFailures ?? DEFAULT_MAX_FAILURES;
    this.requestTimeoutMs =
      config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.onRestartNeeded = config.onRestartNeeded;
    this.sendHealthCheck = config.sendHealthCheck;
  }

  /** Start periodic health checks */
  start(): void {
    if (this.running) {
      logger.warn('[health-checker] Already running');
      return;
    }
    this.running = true;
    this.timer = setInterval(() => {
      this.runCheck().catch((err) => {
        logger.error({ err }, '[health-checker] Check sweep failed');
      });
    }, this.checkIntervalMs);

    logger.info(
      { intervalMs: this.checkIntervalMs },
      '[health-checker] Started',
    );
  }

  /** Stop periodic health checks */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.running = false;
    logger.info('[health-checker] Stopped');
  }

  /** Whether the checker is currently running */
  isRunning(): boolean {
    return this.running;
  }

  /** Run a single health check sweep across all active sessions */
  async runCheck(): Promise<HealthCheckResult[]> {
    const sessions = getActiveSessions();
    const results: HealthCheckResult[] = [];

    for (const session of sessions) {
      try {
        const result = await this.checkSession(session);
        results.push(result);
      } catch (err) {
        logger.error(
          { err, sessionId: session.id },
          '[health-checker] Unexpected error checking session',
        );
        results.push({
          sessionId: session.id,
          groupId: session.group_id,
          containerId: session.container_id,
          status: 'unknown',
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return results;
  }

  /** Check a single session's health */
  private async checkSession(
    session: AgentSession,
  ): Promise<HealthCheckResult> {
    const now = Date.now();
    const state = this.getOrCreateState(session.id);
    state.lastCheckAt = now;

    // Skip sessions that are part of an active meeting — the meeting
    // coordinator is responsible for keeping those containers alive.
    const meetingManager = MeetingManager.getInstance();
    if (meetingManager) {
      const activeMeeting = meetingManager.getActiveMeeting(session.group_id);
      if (activeMeeting) {
        logger.debug(
          { sessionId: session.id, groupId: session.group_id, meetingId: activeMeeting.id },
          '[health-checker] Session has active meeting — skipping health check',
        );
        return {
          sessionId: session.id,
          groupId: session.group_id,
          containerId: session.container_id,
          status: 'healthy',
          responseTimeMs: 0,
        };
      }
    }

    try {
      const response = await this.performHealthCheck(session.container_id ?? '');

      if (response.ok) {
        // Reset failure count on success
        state.consecutiveFailures = 0;
        state.lastHealthyAt = now;

        // Update DB
        updateAgentSession(session.id, {
          last_health_check: new Date(now).toISOString(),
          status: 'active',
        });

        return {
          sessionId: session.id,
          groupId: session.group_id,
          containerId: session.container_id,
          status: 'healthy',
          responseTimeMs: now - state.lastCheckAt,
        };
      }

      // Response received but not OK — count as failure
      state.consecutiveFailures++;
      return this.handleUnhealthySession(session, state, response.error);
    } catch (err) {
      // No response or transport error
      state.consecutiveFailures++;
      const errorMsg = err instanceof Error ? err.message : String(err);
      return this.handleUnhealthySession(session, state, errorMsg);
    }
  }

  /** Handle an unhealthy session: mark status and potentially restart */
  private handleUnhealthySession(
    session: AgentSession,
    state: SessionHealthState,
    error?: string,
  ): HealthCheckResult {
    const shouldRestart =
      state.consecutiveFailures >= this.maxFailures ||
      Date.now() - state.lastHealthyAt > this.unhealthyTimeoutMs;

    const status: HealthStatus = shouldRestart ? 'unhealthy' : 'unknown';

    // Update DB with health check timestamp and degraded status
    updateAgentSession(session.id, {
      last_health_check: new Date().toISOString(),
      status: shouldRestart ? 'error' : 'active',
    });

    if (shouldRestart) {
      logger.warn(
        {
          sessionId: session.id,
          groupId: session.group_id,
          containerId: session.container_id,
          consecutiveFailures: state.consecutiveFailures,
          error,
        },
        '[health-checker] Session unhealthy — triggering restart',
      );

      // Trigger restart callback (non-blocking)
      if (this.onRestartNeeded) {
        this.onRestartNeeded(session).catch((err) => {
          logger.error(
            { err, sessionId: session.id },
            '[health-checker] Restart callback failed',
          );
        });
      }

      // Reset state after restart trigger so we don't keep re-triggering
      state.consecutiveFailures = 0;
    }

    return {
      sessionId: session.id,
      groupId: session.group_id,
      containerId: session.container_id,
      status,
      error,
    };
  }

  /** Send a JSON-RPC health_check to a container */
  private async performHealthCheck(
    containerId: string,
  ): Promise<HealthCheckResponse> {
    // Use custom sender if provided (for testing or IPC transport swap)
    if (this.sendHealthCheck) {
      return this.sendHealthCheck(containerId);
    }

    // Default: send JSON-RPC health_check via IPC sentinel file pattern
    // This matches the existing IPC protocol in oxiclaw
    return this.sendHealthCheckViaIPC(containerId);
  }

  /**
   * Default health check transport: write a JSON-RPC request to the IPC
   * input directory and wait for a response file.
   *
   * The container's IPC bridge reads from /workspace/ipc/input/ and writes
   * responses to /workspace/ipc/messages/.
   */
  private async sendHealthCheckViaIPC(
    containerId: string,
  ): Promise<HealthCheckResponse> {
    const fs = await import('fs');
    const path = await import('path');
    const os = await import('os');

    const tmpDir = fs.realpathSync(os.tmpdir());
    const requestFile = path.join(
      tmpDir,
      `oxiclaw-health-${containerId}.json`,
    );
    const responseFile = path.join(
      tmpDir,
      `oxiclaw-health-${containerId}-resp.json`,
    );

    const requestId = `health-${Date.now()}`;
    const request = {
      jsonrpc: '2.0',
      id: requestId,
      method: 'health_check',
      params: {},
    };

    // Clean up any stale response file
    try {
      fs.unlinkSync(responseFile);
    } catch {
      // ignore
    }

    // Write request atomically
    const tmpRequest = `${requestFile}.tmp`;
    fs.writeFileSync(tmpRequest, JSON.stringify(request) + '\n');
    fs.renameSync(tmpRequest, requestFile);

    // Wait for response with timeout
    const startTime = Date.now();
    return new Promise((resolve, reject) => {
      const checkInterval = setInterval(() => {
        if (Date.now() - startTime > this.requestTimeoutMs) {
          clearInterval(checkInterval);
          // Clean up request file
          try {
            fs.unlinkSync(requestFile);
          } catch {
            // ignore
          }
          reject(new Error('Health check request timed out'));
          return;
        }

        try {
          if (fs.existsSync(responseFile)) {
            clearInterval(checkInterval);
            const content = fs.readFileSync(responseFile, 'utf-8');
            // Clean up response file
            try {
              fs.unlinkSync(responseFile);
            } catch {
              // ignore
            }
            const response = JSON.parse(content);
            resolve(response.result as HealthCheckResponse);
          }
        } catch {
          // Response file might be partially written; retry next interval
        }
      }, 500);
    });
  }

  /** Get or create tracking state for a session */
  private getOrCreateState(sessionId: string): SessionHealthState {
    let state = this.sessionStates.get(sessionId);
    if (!state) {
      state = {
        consecutiveFailures: 0,
        lastHealthyAt: Date.now(),
        lastCheckAt: Date.now(),
      };
      this.sessionStates.set(sessionId, state);
    }
    return state;
  }

  /** Clear tracking state for a specific session (call when session ends) */
  clearSessionState(sessionId: string): void {
    this.sessionStates.delete(sessionId);
  }

  /** Get current health state snapshot for all tracked sessions */
  getHealthSnapshot(): Map<string, SessionHealthState> {
    return new Map(this.sessionStates);
  }
}

// --- Singleton for convenience ---

let instance: HealthChecker | null = null;

/**
 * Start the global health checker instance.
 * Safe to call multiple times — returns existing instance if already started.
 */
export function startHealthChecker(
  config?: HealthCheckConfig,
): HealthChecker {
  if (instance) {
    return instance;
  }
  instance = new HealthChecker(config);
  instance.start();
  return instance;
}

/** Stop the global health checker instance */
export function stopHealthChecker(): void {
  if (instance) {
    instance.stop();
    instance = null;
  }
}

/** Get the global health checker instance (null if not started) */
export function getHealthChecker(): HealthChecker | null {
  return instance;
}
