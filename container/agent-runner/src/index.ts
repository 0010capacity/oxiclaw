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
}

async function handlePromptRequest(params: Record<string, unknown>): Promise<PromptResult> {
  const { prompt } = params as { prompt: string };

  if (!currentSession) {
    throw new Error('No active session. Initialize session first.');
  }

  log(`Processing prompt (${prompt.length} chars)`);

  // Collect result from agent_end event
  let finalContent = '';
  const toolCalls: Array<{ name: string; params: Record<string, unknown> }> = [];

  const eventUnsubscribe = currentSession.subscribe((event) => {
    // Forward session events to orchestrator via IPC
    ipcBridge?.sendSessionEvent(SESSION_ID, event.type, event as unknown as Record<string, unknown>);

    // Capture final result from agent_end
    if (event.type === 'agent_end') {
      const endEvent = event as { type: 'agent_end'; messages: Array<{ content?: string; tool_calls?: Array<{ name: string; params: Record<string, unknown> }> }> };
      finalContent = (endEvent.messages[endEvent.messages.length - 1] as { content?: string })?.content || '';
      for (const msg of endEvent.messages) {
        if (msg.tool_calls) {
          toolCalls.push(...msg.tool_calls);
        }
      }
    }
  });

  try {
    await currentSession.prompt(prompt);
  } finally {
    eventUnsubscribe();
  }

  log(`Prompt complete, response: ${finalContent.length} chars, tools: ${toolCalls.length}`);
  return { content: finalContent, toolCalls };
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
  const stdinData = await new Promise<string>((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(''));
    setTimeout(() => resolve(data), 200);
  });

  if (!stdinData.trim()) {
    log('No stdin data, initializing session automatically');
    await handleInitRequest({});
    return;
  }

  const firstLine = stdinData.trim().split('\n')[0];
  try {
    const req: StdinRequest = JSON.parse(firstLine);
    await handleStdinRequest(req);
  } catch (e) {
    log(`Failed to parse stdin JSON: ${e instanceof Error ? e.message : String(e)}`);
    respond(null, undefined, { code: -32700, message: 'Parse error' });
  }
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
        });
        break;
      }

      case 'cancel':
        await handleCancelRequest(req.params);
        respond(req.id ?? null, { ok: true });
        break;

      case 'health_check':
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