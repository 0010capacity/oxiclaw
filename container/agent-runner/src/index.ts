/**
 * OxiClaw Agent Runner
 *
 * Entry point for the pi-mono SDK inside a Docker container.
 * Orchestrator communicates via:
 * - stdin: JSON-RPC 2.0 requests (init, prompt, cancel, health_check)
 * - Unix socket: JSON-RPC 2.0 events (session.events, tool results)
 *
 * Key design decisions for container reuse:
 * - stdin stays OPEN between prompts so the container can receive multiple prompts
 * - Do NOT call stdin.end() after prompt — it kills the container prematurely
 * - Do NOT auto-init on stdin 'end' event — the orchestrator controls lifecycle
 * - Poll /workspace/ipc/input/ for follow-up messages and _close sentinel
 * - SIGTERM triggers graceful shutdown (orchestrator writes _close sentinel)
 */

import { createAgentSession, createCodingTools, AuthStorage } from '@mariozechner/pi-coding-agent';
import { IPCBridge } from './ipc-bridge.js';
import fs from 'fs';
import os from 'os';
import path from 'path';

const ORCHESTRATOR_SOCKET = process.env.OXICLAW_IPC_SOCKET || '/tmp/oxiclaw-ipc.sock';
const IPC_INPUT_DIR = '/workspace/ipc/input';
const POLL_INTERVAL_MS = 1000;

const CWD = process.env.AGENT_CWD || '/workspace/group';
const SESSION_ID = process.env.AGENT_SESSION_ID || 'default';

interface StdinRequest {
  jsonrpc: '2.0';
  id?: string | number;
  method: string;
  params: Record<string, unknown>;
}

interface StdinResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
}

interface AgentSession {
  subscribe(listener: (event: { type: string }) => void): () => void;
  prompt(text: string, options?: { expandPromptTemplates?: boolean; images?: unknown[] }): Promise<void>;
}

let currentSession: AgentSession | null = null;
let ipcBridge: IPCBridge | null = null;
let isShuttingDown = false;

function log(message: string): void {
  console.error(`[agent-runner] ${message}`);
}

function respond(id: string | number | null, result?: unknown, error?: { code: number; message: string }): void {
  const response: StdinResponse = {
    jsonrpc: '2.0',
    id,
    ...(error ? { error } : { result }),
  };
  // Use writeSync via fs to ensure the full response is flushed to the stdout
  // pipe immediately. Regular write() may buffer partial data when stdout is
  // a Docker pipe, causing the host to receive truncated JSON-RPC messages.
  const payload = JSON.stringify(response) + '\n';
  try {
    fs.writeSync(1, payload);
  } catch {
    process.stdout.write(payload);
  }
}

interface PromptResult {
  content: string;
  toolCalls: Array<{ name: string; params: Record<string, unknown> }>;
  images?: string[];
}

async function handlePromptRequest(params: Record<string, unknown>): Promise<PromptResult> {
  const { prompt, images } = params as { prompt: string; images?: string[] };

  if (!currentSession) {
    throw new Error('No active session. Initialize session first.');
  }

  log(`Processing prompt (${prompt.length} chars, images: ${images?.length || 0})`);

  // Collect result from agent_end event
  let finalContent = '';
  const toolCalls: Array<{ name: string; params: Record<string, unknown> }> = [];
  const responseImages: string[] = [];

  // Content block type for image responses
  interface ContentBlock { type: string; text?: string; url?: string; [key: string]: unknown }

  const eventUnsubscribe = currentSession.subscribe((event) => {
    // Forward session events to orchestrator via IPC
    ipcBridge?.sendSessionEvent(SESSION_ID, event.type, event as unknown as Record<string, unknown>);

    // Capture final result from agent_end
    if (event.type === 'agent_end') {
      const endEvent = event as { type: 'agent_end'; messages: Array<ContentBlock & { content?: string | unknown[]; tool_calls?: Array<{ name: string; params: Record<string, unknown> }> }> };
      const lastMessage = endEvent.messages[endEvent.messages.length - 1] as ContentBlock & { content?: string | unknown[] };
      const rawContent = lastMessage?.content;

      if (typeof rawContent === 'string') {
        finalContent = rawContent;
      } else if (Array.isArray(rawContent)) {
        const textBlocks = (rawContent as Array<{ type: string; text?: string }>)
          .filter(b => b.type === 'text' && b.text)
          .map(b => b.text as string);
        finalContent = textBlocks.join('\n');
      }
      for (const msg of endEvent.messages) {
        if (msg.tool_calls) {
          toolCalls.push(...msg.tool_calls);
        }
        if (msg.type === 'image' && msg.url) {
          responseImages.push(msg.url as string);
        }
        if (typeof msg.content === 'string' && msg.content.startsWith('data:image/')) {
          responseImages.push(msg.content);
        }
      }
    }
  });

  try {
    await currentSession.prompt(prompt, { images: images || [] });
  } finally {
    eventUnsubscribe();
  }

  log(`Prompt complete, response: ${finalContent.length} chars, tools: ${toolCalls.length}, images: ${responseImages.length}`);
  return { content: finalContent, toolCalls, images: responseImages.length > 0 ? responseImages : undefined };
}

async function handleInitRequest(_params: Record<string, unknown>): Promise<void> {
  log(`Initializing session: cwd=${CWD}`);

  // Close existing session
  currentSession = null;

  // Create coding tools scoped to the working directory
  const tools = createCodingTools(CWD) as any;

  // Create agent session with pi-mono SDK
  // SDK reads credentials from XDG_CONFIG_HOME/pi/agent/auth.json
  const authStorage = AuthStorage.create('/workspace/group/pi/agent/auth.json');
  const { session } = await createAgentSession({
    cwd: CWD,
    tools,
    authStorage,
  });

  currentSession = session as unknown as AgentSession;
  log('Session initialized successfully');
}

async function handleCancelRequest(_params: Record<string, unknown>): Promise<void> {
  if (!currentSession) {
    throw new Error('No active session');
  }
  log('Cancel requested — session will end after current turn');
}

/**
 * Poll /workspace/ipc/input/ for new message files and _close sentinel.
 * This is the mechanism the orchestrator uses to send follow-up messages
 * without killing the container.
 */
async function pollIpcInput(): Promise<void> {
  try {
    if (!fs.existsSync(IPC_INPUT_DIR)) return;

    const files = fs.readdirSync(IPC_INPUT_DIR).filter(f => f.endsWith('.json'));
    for (const file of files.sort()) {
      const filePath = path.join(IPC_INPUT_DIR, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        if (data.type === 'message' && typeof data.text === 'string') {
          log(`IPC input: forwarding message (${data.text.length} chars) as prompt`);
          // Forward as a new prompt request
          try {
            const result = await handlePromptRequest({ prompt: data.text });
            // Respond via stdout
            respond(null, {
              session_id: SESSION_ID,
              content: result.content,
              tool_calls: result.toolCalls,
              images: result.images,
            });
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            respond(null, undefined, { code: -32603, message });
          }
        }
      } catch (err) {
        log(`IPC input parse error: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        fs.unlinkSync(filePath);
      }
    }

    // Check for _close sentinel
    const closeSentinel = path.join(IPC_INPUT_DIR, '_close');
    if (fs.existsSync(closeSentinel)) {
      log('_close sentinel received, initiating graceful shutdown');
      fs.unlinkSync(closeSentinel);
      triggerShutdown();
    }
  } catch (err) {
    log(`IPC input poll error: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Schedule next poll unless shutting down
  if (!isShuttingDown) {
    setTimeout(() => pollIpcInput(), POLL_INTERVAL_MS);
  }
}

/**
 * Trigger graceful shutdown. Called by _close sentinel or SIGTERM.
 */
function triggerShutdown(): void {
  if (isShuttingDown) return;
  isShuttingDown = true;
  log('Agent runner shutting down gracefully');
  ipcBridge?.close();
  process.exit(0);
}

async function readStdinRequests(): Promise<void> {
  let buffer = '';

  const processLine = (line: string): void => {
    if (!line.trim()) return;
    try {
      const req: StdinRequest = JSON.parse(line);
      handleStdinRequest(req).catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        log(`Request error: ${message}`);
        respond(null, undefined, { code: -32603, message });
      });
    } catch (e) {
      log(`Failed to parse stdin JSON: ${e instanceof Error ? e.message : String(e)}`);
      respond(null, undefined, { code: -32700, message: 'Parse error' });
    }
  };

  process.stdin.setEncoding('utf8');

  // Handle graceful shutdown via signals
  process.on('SIGTERM', () => {
    log('SIGTERM received');
    triggerShutdown();
  });
  process.on('SIGINT', () => {
    log('SIGINT received');
    triggerShutdown();
  });

  process.stdin.on('data', (chunk: string) => {
    if (isShuttingDown) return;
    buffer += chunk;
    // Process all complete lines (newline-delimited JSON-RPC)
    let newlineIndex: number;
    while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      processLine(line);
    }
  });

  // NOTE: Do NOT handle stdin 'end' by auto-initing or exiting.
  // stdin.end() is called by the old container-runner.ts after the first prompt,
  // but with the new pool, stdin stays open. If the container is being
  // killed externally, SIGTERM/SIGINT will handle it.
  // The 'end' event here is just a safety net for non-pool scenarios.
  process.stdin.on('end', () => {
    if (isShuttingDown) return;
    log('stdin ended (safety fallback — initializing session if needed)');
    // Auto-init if no session exists — this handles the race where stdin closes
    // before the orchestrator sends init (Docker entrypoint tsc, pipe drain, etc.)
    if (!currentSession) {
      handleInitRequest({}).then(() => {
        log('Auto-init after stdin end complete');
      }).catch((err) => {
        log(`Auto-init error after stdin end: ${err instanceof Error ? err.message : String(err)}`);
      });
    }
  });

  process.stdin.on('error', () => {
    log('Stdin error, continuing...');
  });
}

async function handleStdinRequest(req: StdinRequest): Promise<void> {
  try {
    switch (req.method) {
      case 'init':
        await handleInitRequest(req.params);
        respond(req.id ?? null, { ok: true, session_id: SESSION_ID });
        break;

      case 'prompt': {
        const result = await handlePromptRequest(req.params);
        respond(req.id ?? null, {
          session_id: SESSION_ID,
          content: result.content,
          tool_calls: result.toolCalls,
          images: result.images,
        });
        break;
      }

      case 'cancel':
        await handleCancelRequest(req.params);
        respond(req.id ?? null, { ok: true });
        break;

      case 'health_check':
        const tmpDir = fs.realpathSync(os.tmpdir());
        const respFile = path.join(tmpDir, `oxiclaw-health-${SESSION_ID}-resp.json`);
        const respContent = JSON.stringify({
          ok: true,
          active: currentSession !== null,
          timestamp: new Date().toISOString(),
        });
        try {
          fs.writeFileSync(respFile, respContent);
          log(`Health check response written to ${respFile}`);
        } catch (writeErr) {
          log(`Health check response write failed: ${writeErr instanceof Error ? writeErr.message : String(writeErr)}`);
        }
        respond(req.id ?? null, {
          session_id: SESSION_ID,
          active: currentSession !== null,
          timestamp: new Date().toISOString(),
        });
        break;

      default:
        respond(req.id ?? null, undefined, { code: -32601, message: `Unknown method: ${req.method}` });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`Request error: ${message}`);
    respond(req.id ?? null, undefined, { code: -32603, message });
  }
}

async function main(): Promise<void> {
  log(`Starting OxiClaw agent runner (session=${SESSION_ID}, cwd=${CWD})`);

  ipcBridge = new IPCBridge(ORCHESTRATOR_SOCKET);
  if (!fs.existsSync(ORCHESTRATOR_SOCKET)) {
    log(`IPC bridge socket not found (${ORCHESTRATOR_SOCKET}), skipping connect`);
  } else {
    try {
      await ipcBridge.connect();
      log('IPC bridge connected');
    } catch (err) {
      log(`IPC bridge connection failed: ${err instanceof Error ? err.message : String(err)}`);
      log('Continuing without IPC bridge');
    }
  }

  // Start IPC input polling for follow-up messages
  setTimeout(() => pollIpcInput(), POLL_INTERVAL_MS);

  // Read stdin requests (init, prompt, cancel, health_check)
  await readStdinRequests();

  log('Agent runner finished');
  ipcBridge?.close();
}

main().catch((e) => {
  console.error(`[agent-runner] Fatal: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
