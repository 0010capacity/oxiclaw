# Phase 1: Foundation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development.

**Goal:** nanoclaw 기반 위에 pi-mono SDK를集成하고 기본 메시지 라우팅이 동작하는 상태까지.

**Architecture:** container/agent-runner를 Claude Agent SDK에서 pi-mono SDK로 교체. IPC bridge로 오케스트레이터와 통신. HealthChecker로 세션 건강 상태 확인.

**Tech Stack:** Node.js, TypeScript, Docker, pi-mono SDK, better-sqlite3

**전제:** Phase 0 SDK 검증 완료.

---

## 선행 조건

1. nanoclaw가 oxiclaw 디렉토리에 클론 + git 초기화 완료
2. Phase 0 SDK 검증 완료 (pi-mono API가 설계와 호환됨이 확인)

## Task 1: nanoclaw 초기 설정

**Files:**
- Reference: `docs/superpowers/plans/phase-0-results.md` (SDK 검증 결과)

- [ ] **Step 1: nanoclaw shallow clone**

```bash
cd "/Volumes/SATECHI DISK/Code/repos/oxiclaw"

# 이미 클론되어 있다면 이 단계 스킵
# 아래는 처음부터 시작하는 경우
rm -rf .git .tmp_nanoclaw
git clone --depth 1 https://github.com/qwibitai/nanoclaw.git .tmp_nanoclaw
rsync -av --exclude='.git' .tmp_nanoclaw/ ./
rm -rf .tmp_nanoclaw
```

- [ ] **Step 2: git 초기화**

```bash
git init
git add .
git commit -m "feat: fork nanoclaw as oxiclaw"
git remote add upstream https://github.com/qwibitai/nanoclaw.git
```

- [ ] **Step 3: 기존 Claude Agent SDK 코드 확인**

```bash
cat container/agent-runner/src/index.ts
cat container/agent-runner/src/ipc-mcp-stdio.ts
```

Run: 파일 내용을 확인하여 다음을 파악:
- 현재 Agent SDK 초기화 방식
- 현재 IPC 통신 패턴
- 툴 정의 방식

- [ ] **Step 4: 의존성 설치 확인**

```bash
cd container/agent-runner
npm install
npm ls @anthropic/agent-sdk
```

## Task 2: container/agent-runner/package.json 교체

**Files:**
- Modify: `container/agent-runner/package.json`

- [ ] **Step 1: Claude Agent SDK 제거 + pi-mono 추가**

```json
{
  "name": "oxiclaw-agent-runner",
  "version": "1.0.0",
  "dependencies": {
    "@mariozechner/pi-coding-agent": "^1.0.0",
    "@modelcontextprotocol/sdk": "^1.0.0",
    "typescript": "^5.3.0"
  }
}
```

Run: `cd container/agent-runner && npm install`
Expected: pi-mono SDK 설치 성공

## Task 3: ipc-bridge.ts 신규 작성

**Files:**
- Create: `container/agent-runner/src/ipc-bridge.ts`

**IPC 프로토콜**: JSON-RPC 2.0 over Unix socket (오케스트레이터 ↔ pi-mono 양방향)

```typescript
// container/agent-runner/src/ipc-bridge.ts
import { createServer, Socket } from "net";
import { EventEmitter } from "events";

interface IPCMessage {
  jsonrpc: "2.0";
  id?: string;
  method: string;
  params: Record<string, unknown>;
}

export class IPCBridge extends EventEmitter {
  private server: ReturnType<typeof createServer>;
  private sessions: Map<string, unknown> = new Map();

  constructor(private socketPath: string) {
    super();
    this.server = createServer(this.handleConnection.bind(this));
  }

  start(): Promise<void> {
    return new Promise((resolve) => {
      this.server.listen(this.socketPath, () => {
        console.log("[ipc-bridge] Listening on", this.socketPath);
        resolve();
      });
    });
  }

  private handleConnection(socket: Socket): void {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      // newline-delimited JSON messages
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg: IPCMessage = JSON.parse(line);
          this.handleMessage(msg, socket);
        } catch (e) {
          console.error("[ipc-bridge] Parse error:", e);
        }
      }
    });
  }

  private handleMessage(msg: IPCMessage, socket: Socket): void {
    this.emit("message", msg);
    // Send response
    if (msg.id) {
      const response = { jsonrpc: "2.0", id: msg.id, result: { ok: true } };
      socket.write(JSON.stringify(response) + "\n");
    }
  }

  send(message: IPCMessage): void {
    // Used by pi-mono to send events to orchestrator
    this.emit("send", message);
  }

  close(): void {
    this.server.close();
  }
}
```

- [ ] **Step 2: IPC bridge 유닛 테스트 작성**

- Create: `container/agent-runner/src/__tests__/ipc-bridge.test.ts`

```typescript
import { IPCBridge } from "../ipc-bridge";
import { createClient } from "net";
import { promises as fs } from "fs";
import { tmpdir } from "os";
import { join } from "path";

describe("IPCBridge", () => {
  const socketPath = join(tmpdir(), "test-ipc-bridge.sock");

  afterEach(async () => {
    try { await fs.unlink(socketPath); } catch {}
  });

  it("starts and listens on socket path", async () => {
    const bridge = new IPCBridge(socketPath);
    await bridge.start();
    const stats = await fs.stat(socketPath);
    expect(stats.isSocket()).toBe(true);
    bridge.close();
  });

  it("receives JSON-RPC messages from client", async () => {
    const bridge = new IPCBridge(socketPath);
    await bridge.start();
    const messages: unknown[] = [];
    bridge.on("message", (msg) => messages.push(msg));

    await new Promise<void>((resolve) => {
      const client = createClient();
      client.on("connect", () => {
        client.write(JSON.stringify({ jsonrpc: "2.0", id: "1", method: "test", params: {} }) + "\n");
        setTimeout(() => { client.end(); resolve(); }, 50);
      });
      client.connect(socketPath);
    });

    await new Promise((r) => setTimeout(r, 100));
    expect(messages).toHaveLength(1);
    expect((messages[0] as any).id).toBe("1");
    bridge.close();
  });
});
```

Run: `npm test -- src/__tests__/ipc-bridge.test.ts`
Expected: PASS (또는 컴파일 에러 — 그 경우 타입 정의 먼저 작성)

## Task 4: container/agent-runner/src/index.ts 재작성

**Files:**
- Modify: `container/agent-runner/src/index.ts`

- [ ] **Step 1: 현재 index.ts의 Agent SDK 초기화 코드 분석**

현재 파일의 `new Agent({...})` 패턴을 확인하고 pi-mono 버전으로 교체.

```typescript
// container/agent-runner/src/index.ts
import { createAgentSession, SessionManager } from "@mariozechner/pi-coding-agent";
import { IPCBridge } from "./ipc-bridge";
import { createCodingTools } from "@mariozechner/pi-coding-agent";
import * as path from "path";

// Read configuration from environment / mounted config
const cwd = process.env.AGENT_CWD || "/app/workspace";
const sessionId = process.env.AGENT_SESSION_ID || "default";
const model = process.env.AGENT_MODEL || "claude";
const systemPrompt = process.env.AGENT_SYSTEM_PROMPT || "";

async function main() {
  // Initialize IPC bridge
  const bridge = new IPCBridge("/tmp/oxiclaw-ipc.sock");
  await bridge.start();

  // Create coding tools scoped to cwd
  const tools = createCodingTools(cwd);

  // Create agent session
  const session = createAgentSession({
    cwd,
    model,
    systemPrompt,
    tools,
  });

  // Stream session events to orchestrator via IPC
  session.subscribe((event) => {
    bridge.send({
      jsonrpc: "2.0",
      method: "session.event",
      params: {
        session_id: sessionId,
        event: event.type,
        data: event.data,
      },
    });
  });

  // Handle IPC messages from orchestrator
  bridge.on("message", async (msg) => {
    if (msg.method === "prompt") {
      const result = await session.prompt(msg.params.prompt);
      bridge.send({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          session_id: sessionId,
          content: result,
        },
      });
    }
  });

  console.log("[agent-runner] Started session:", sessionId);
}

main().catch((e) => {
  console.error("[agent-runner] Fatal:", e);
  process.exit(1);
});
```

- [ ] **Step 2: 컴파일 확인**

Run: `cd container/agent-runner && npx tsc --noEmit src/index.ts src/ipc-bridge.ts`
Expected: 컴파일 에러 없음 또는 명확한 에러 목록

## Task 5: Dockerfile 업데이트

**Files:**
- Modify: `container/Dockerfile`

- [ ] **Step 1: 기존 Dockerfile 분석**

```bash
cat container/Dockerfile
```

- [ ] **Step 2: pi-mono SDK 설치로 교체**

```dockerfile
# 기존: npm install @anthropic/agent-sdk
# 변경:
RUN npm install @mariozechner/pi-coding-agent \
                 @modelcontextprotocol/sdk

# pi Extension 디렉토리 복사
COPY extensions/ /app/extensions/
```

- [ ] **Step 3: Docker build 테스트**

Run: `cd container && docker build -t oxiclaw-test .`
Expected: 빌드 성공

## Task 6: HealthChecker 구현

**Files:**
- Create: `src/health-checker.ts`

```typescript
// src/health-checker.ts
import db from "./db";

const HEARTBEAT_INTERVAL = 60_000; // 60초
const SESSION_TIMEOUT = 5 * 60_000; // 5분

export class HealthChecker {
  private timer: ReturnType<typeof setInterval> | null = null;

  start(): void {
    this.timer = setInterval(() => this.check(), HEARTBEAT_INTERVAL);
    console.log("[health-checker] Started");
  }

  private async check(): Promise<void> {
    const sessions = db.prepare(`
      SELECT session_id, last_activity
      FROM agent_sessions
      WHERE status = 'active'
    `).all() as Array<{ session_id: string; last_activity: number }>;

    const now = Date.now();
    for (const session of sessions) {
      if (now - session.last_activity > SESSION_TIMEOUT) {
        console.warn(`[health-checker] Session ${session.session_id} timed out`);
        // Signal container-runner to restart this session
        // Implementation: write to sentinel file or send IPC message
        this.restartSession(session.session_id);
      }
    }
  }

  private restartSession(sessionId: string): void {
    // TODO: Signal container to restart specific session
    console.log(`[health-checker] Restarting session: ${sessionId}`);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
```

## Task 7: 기존 채널 스키마에 agent_sessions 테이블 추가

**Files:**
- Modify: `src/db.ts` 또는 `src/schema.sql`

```sql
CREATE TABLE IF NOT EXISTS agent_sessions (
  session_id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  status TEXT DEFAULT 'active',  -- active, idle, busy, error
  last_activity INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  container_id TEXT
);
```

Run: 마이그레이션 적용 확인

## Task 8: End-to-End 기본 동작 확인

**Files:**
- Integration test (manual)

- [ ] **Step 1: Docker 빌드**

```bash
cd container && docker build -t oxiclaw/agent:latest .
```

- [ ] **Step 2: 컨테이너 실행 + 간단한 메시지 테스트**

```bash
docker run --rm \
  -e AGENT_SESSION_ID=test \
  -e AGENT_CWD=/app/workspace \
  -v $(pwd)/groups/test:/app/workspace \
  oxiclaw/agent:latest \
  node src/index.ts
```

- [ ] **Step 3: 동작 확인 체크리스트**

- [ ] pi-mono 세션이 시작되는가?
- [ ] IPC bridge가 Unix socket에 바인딩되는가?
- [ ] stdin/stdout 통신이 동작하는가?
- [ ] 툴(read/write)이 정상 동작하는가?
- [ ] session.subscribe()가 이벤트를Emit하는가?

## Task 9: nanoclaw 기존 IPC 패턴 비교 분석

**Files:**
- Reference: `container/agent-runner/src/ipc-mcp-stdio.ts`

기존 IPC 패턴(nanoclaw)과 새로 작성한 ipc-bridge.ts의 차이를 분석하고 필요시 ipc-bridge.ts를 수정.

```
기존: JSON 파일 IPC + sentinel 파일 (_close)
신규: Unix socket + JSON-RPC 2.0
```

**결정**: 오케스트레이터(node.js)가 Unix socket 서버가 되고 pi-mono가 클라이언트가 되는 것이 더 자연스러우므로 구조 반대가 필요할 수 있음. Phase 0 SDK 검증 결과를 바탕으로 조정.

## Task 10: 설계 문서 업데이트

**Files:**
- Modify: `docs/superpowers/specs/2026-04-07-oxiclaw-pi-mono-design.md`

Phase 1 구현 결과를 바탕으로:
- 실제 SDK API 시그니처로 6.1 SDK 비교 테이블 업데이트
- Phase 0에서 발견된 API 불일치를 문서에 반영
- IPC 프로토콜 상세 내용 추가

---

**완료 조건:** Docker 컨테이너가 pi-mono SDK로 실행되고, IPC 통신으로 오케스트레이터와 메시지를 주고받을 수 있는 상태.
