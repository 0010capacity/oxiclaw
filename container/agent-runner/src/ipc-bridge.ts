/**
 * IPC Bridge for OxiClaw Agent Runner
 *
 * Provides bidirectional JSON-RPC 2.0 communication between the pi-mono agent
 * runtime (inside a Docker container) and the Node.js orchestrator (host).
 *
 * Transport: Unix domain socket (newline-delimited JSON-RPC 2.0).
 * The orchestrator owns the socket server; the agent runner connects as a client.
 *
 * Usage from index.ts:
 *   const bridge = new IPCBridge('/tmp/oxiclaw-ipc.sock');
 *   await bridge.connect();
 *   bridge.sendSessionEvent('default', 'thinking', { text: '...' });
 *   bridge.on('message', (msg) => { ... });
 *   bridge.close();
 */

import { createConnection, Socket } from 'net';
import { EventEmitter } from 'events';
import { existsSync } from 'fs';
import { stat } from 'fs/promises';

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 type definitions
// ---------------------------------------------------------------------------

/** JSON-RPC 2.0 request (has a method and optional params). */
export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

/** JSON-RPC 2.0 success response. */
export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result: unknown;
}

/** JSON-RPC 2.0 error response. */
export interface JsonRpcError {
  jsonrpc: '2.0';
  id: string | number | null;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

/** Any JSON-RPC 2.0 message (request, success response, or error response). */
export type JsonRpcMessage = JsonRpcRequest | JsonRpcResponse | JsonRpcError;

// ---------------------------------------------------------------------------
// Event types emitted by IPCBridge
// ---------------------------------------------------------------------------

export interface SessionEventParams {
  session_id: string;
  event: string;
  data: Record<string, unknown>;
}

export interface IPCBridgeEvents {
  /** Emitted for every incoming JSON-RPC message from the orchestrator. */
  message: (msg: JsonRpcMessage) => void;
  /** Emitted when the socket connection is established. */
  connected: () => void;
  /** Emitted when the socket is closed or the connection is lost. */
  disconnected: () => void;
  /** Emitted on socket errors. */
  error: (err: Error) => void;
}

// ---------------------------------------------------------------------------
// IPCBridge
// ---------------------------------------------------------------------------

const CONNECT_RETRY_DELAY_MS = 500;
const MAX_CONNECT_RETRIES = 10;

export class IPCBridge extends EventEmitter {
  private socket: Socket | null = null;
  private connected = false;
  private buffer = '';
  private readonly socketPath: string;

  constructor(socketPath: string) {
    super();
    this.socketPath = socketPath;
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Connect to the orchestrator's Unix domain socket.
   *
   * Retries up to MAX_CONNECT_RETRIES times if the socket file does not exist
   * yet (the orchestrator may still be starting up).
   */
  async connect(): Promise<void> {
    let attempts = 0;

    while (attempts < MAX_CONNECT_RETRIES) {
      if (existsSync(this.socketPath)) {
        try {
          const stats = await stat(this.socketPath);
          if (!stats.isSocket()) {
            throw new Error(`Path exists but is not a socket: ${this.socketPath}`);
          }
        } catch (err) {
          throw new Error(
            `Cannot stat socket path: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      } else {
        attempts++;
        if (attempts >= MAX_CONNECT_RETRIES) {
          throw new Error(
            `Socket not found after ${MAX_CONNECT_RETRIES} retries: ${this.socketPath}`,
          );
        }
        await this.sleep(CONNECT_RETRY_DELAY_MS);
        continue;
      }

      // Socket file exists -- attempt connection
      return new Promise<void>((resolve, reject) => {
        const sock = createConnection(this.socketPath, () => {
          this.socket = sock;
          this.connected = true;
          this.setupSocketHandlers(sock);
          this.emit('connected');
          resolve();
        });

        sock.once('error', (err: Error) => {
          attempts++;
          if (attempts >= MAX_CONNECT_RETRIES) {
            reject(
              new Error(
                `Failed to connect to ${this.socketPath} after ${MAX_CONNECT_RETRIES} attempts: ${err.message}`,
              ),
            );
          } else {
            // Retry after a short delay
            this.sleep(CONNECT_RETRY_DELAY_MS).then(() => {
              this.connect().then(resolve).catch(reject);
            });
          }
        });
      });
    }

    // Should not reach here, but satisfy the type checker
    throw new Error(`Failed to connect to ${this.socketPath}`);
  }

  /**
   * Send a JSON-RPC 2.0 request or notification to the orchestrator.
   *
   * @param method - The JSON-RPC method name.
   * @param params - Optional parameters object.
   * @param id     - Optional request ID. If omitted, the message is a
   *                 notification (no response expected).
   */
  send(method: string, params?: Record<string, unknown>, id?: string | number | null): void {
    const msg: JsonRpcRequest = {
      jsonrpc: '2.0',
      ...(id !== undefined ? { id } : {}),
      method,
      ...(params ? { params } : {}),
    };
    this.writeRaw(JSON.stringify(msg));
  }

  /**
   * Send a JSON-RPC 2.0 success response to the orchestrator.
   */
  sendResult(id: string | number | null, result: unknown): void {
    const msg: JsonRpcResponse = { jsonrpc: '2.0', id, result };
    this.writeRaw(JSON.stringify(msg));
  }

  /**
   * Send a JSON-RPC 2.0 error response to the orchestrator.
   */
  sendError(id: string | number | null, code: number, message: string, data?: unknown): void {
    const msg: JsonRpcError = {
      jsonrpc: '2.0',
      id,
      error: { code, message, ...(data !== undefined ? { data } : {}) },
    };
    this.writeRaw(JSON.stringify(msg));
  }

  /**
   * High-level helper: emit a `session.event` notification to the orchestrator.
   *
   * Used to forward pi-mono agent events (thinking, streaming text, tool calls,
   * agent_end, etc.) back to the host.
   */
  sendSessionEvent(
    sessionId: string,
    eventType: string,
    data: Record<string, unknown>,
  ): void {
    this.send('session.event', {
      session_id: sessionId,
      event: eventType,
      data,
    });
  }

  /**
   * Close the IPC bridge and release the socket.
   */
  close(): void {
    if (this.socket) {
      try {
        this.socket.destroy();
      } catch {
        // Swallow -- socket may already be closed
      }
      this.socket = null;
      this.connected = false;
      this.emit('disconnected');
    }
  }

  /**
   * Whether the bridge currently has an active socket connection.
   */
  get isConnected(): boolean {
    return this.connected && this.socket !== null;
  }

  // -----------------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------------

  /**
   * Wire up data, close, and error handlers on the connected socket.
   */
  private setupSocketHandlers(sock: Socket): void {
    sock.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString('utf8');
      this.processBuffer();
    });

    sock.on('close', () => {
      this.connected = false;
      this.socket = null;
      this.emit('disconnected');
    });

    sock.on('error', (err: Error) => {
      this.emit('error', err);
    });
  }

  /**
   * Parse complete newline-delimited JSON-RPC messages from the read buffer.
   */
  private processBuffer(): void {
    // Split on newlines -- each line is one JSON-RPC message
    const lines = this.buffer.split('\n');
    // Keep the last incomplete fragment in the buffer
    this.buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const msg = JSON.parse(trimmed) as JsonRpcMessage;
        this.emit('message', msg);
      } catch {
        // Log but do not crash on malformed messages
        console.error(
          `[ipc-bridge] Failed to parse incoming message: ${trimmed.slice(0, 200)}`,
        );
      }
    }
  }

  /**
   * Write a raw JSON string to the socket (appends newline delimiter).
   */
  private writeRaw(payload: string): void {
    if (!this.socket || !this.connected) {
      console.error('[ipc-bridge] Cannot send -- not connected');
      return;
    }
    try {
      this.socket.write(payload + '\n');
    } catch (err) {
      console.error(
        `[ipc-bridge] Write error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
