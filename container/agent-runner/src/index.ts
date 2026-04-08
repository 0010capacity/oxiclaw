/**
 * OxiClaw Agent Runner
 *
 * Entry point for the pi-mono SDK inside a Docker container.
 * Orchestrator communicates via:
 * - stdin: JSON-RPC 2.0 requests (init, prompt, cancel, health_check)
 * - Unix socket: JSON-RPC 2.0 events (session.events, tool results)
 */

import { createAgentSession, createCodingTools } from '@mariozechner/pi-coding-agent';
import { IPCBridge } from './ipc-bridge.js';
import fs from 'fs';
import os from 'os';
import path from 'path';

const ORCHESTRATOR_SOCKET = process.env.OXICLAW_IPC_SOCKET || '/tmp/oxiclaw-ipc.sock';

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

function log(message: string): void {
  console.error(`[agent-runner] ${message}`);
}

function respond(id: string | number | null, result?: unknown, error?: { code: number; message: string }): void {
  const response: StdinResponse = {
    jsonrpc: '2.0',
    id,
    ...(error ? { error } : { result }),
  };
  process.stdout.write(JSON.stringify(response) + '\n');
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
      const endEvent = event as { type: 'agent_end'; messages: Array<ContentBlock & { content?: string; tool_calls?: Array<{ name: string; params: Record<string, unknown> }> }> };
      finalContent = (endEvent.messages[endEvent.messages.length - 1] as ContentBlock & { content?: string })?.content || '';
      for (const msg of endEvent.messages) {
        if (msg.tool_calls) {
          toolCalls.push(...msg.tool_calls);
        }
        // Extract image content blocks
        if (msg.type === 'image' && msg.url) {
          responseImages.push(msg.url as string);
        }
        // Also check top-level content for image URLs (some models format differently)
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
  // createCodingTools returns AgentTool<any>[], but type signatures differ from Tool[]
  // Use 'any' cast to bypass TypeScript compatibility check
  const tools = createCodingTools(CWD) as any;

  // Create agent session with pi-mono SDK
  // SDK reads credentials from ~/.pi/agent/auth.json and models from ~/.pi/agent/models.json
  // These are mounted by the orchestrator before container start
  const { session } = await createAgentSession({
    cwd: CWD,
    tools,
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

async function readStdinRequests(): Promise<void> {
  let buffer = '';
  let isShuttingDown = false;

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

  const shutdown = (signal: string): void => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    log(`Shutdown signal (${signal}), closing stdin listener`);
    process.stdin.pause();
  };

  process.stdin.setEncoding('utf8');

  // Handle graceful shutdown
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

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

  process.stdin.on('end', () => {
    if (isShuttingDown) return;
    // Process any remaining content in the buffer
    if (buffer.trim()) {
      processLine(buffer.trim());
    }
    // If no session was initialized and stdin ended cleanly, init now
    if (!currentSession) {
      log('Stdin ended, initializing session automatically');
      handleInitRequest({}).catch((err) => {
        log(`Auto-init error: ${err instanceof Error ? err.message : String(err)}`);
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
        // Write response to temp file for orchestrator health checker to poll.
        // Matches the sendHealthCheckViaIPC pattern in health-checker.ts.
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
        // Also respond via stdout for direct callers
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
  try {
    await ipcBridge.connect();
    log('IPC bridge connected');
  } catch (err) {
    log(`IPC bridge connection failed: ${err instanceof Error ? err.message : String(err)}`);
    log('Continuing without IPC bridge');
  }

  await readStdinRequests();

  log('Agent runner finished');
  ipcBridge?.close();
}

main().catch((e) => {
  console.error(`[agent-runner] Fatal: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});