# Phase 2: Telegram Swarm

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development.

**Goal:** Telegram 그룹에서 `@agent_*` mention으로 에이전트를 활성화하고, 각 에이전트가 독립적인 세션으로 응답하는 스웜 시스템.

**Architecture:** 오케스트레이터의 Swarm Router가 정규식으로 mention을 파싱하여 해당 세션에 메시지를 전달. pi-mono SessionManager가 다중 세션을 관리.

**Tech Stack:** Node.js, TypeScript, grammY (nanoclaw 기존), Docker, pi-mono SDK

**전제:** Phase 1 (Foundation) 완료.

---

## 선행 조건

1. pi-mono SDK가 agent-runner에서 정상 동작
2. IPC bridge로 오케스트레이터 ↔ pi-mono 통신 가능
3. SessionManager로 다중 세션 생성/관리 가능 (Phase 0 검증)

## Task 1: nanoclaw add-telegram 스킬 분석

**Files:**
- Reference: `nanoclaw` 원본의 `.claude/skills/add-telegram/`
- Reference: `nanoclaw` 원본의 `.claude/skills/add-telegram-swarm/`

- [ ] **Step 1: 기존 Telegram 채널 스킬 확인**

```bash
cat .claude/skills/add-telegram/index.ts
ls .claude/skills/add-telegram/
```

nanoclaw의 Telegram 채널이 grammY 기반으로 구현되어 있는지 확인.

- [ ] **Step 2: Telegram Swarm 스킬 확인 (있을 경우)**

```bash
cat .claude/skills/add-telegram-swarm/index.ts
ls .claude/skills/add-telegram-swarm/
```

풀 봇(pool bot) 아키텍처가 있는지, mention 라우팅 로직이 있는지 확인.

## Task 2: Telegram Bot 기본 연동

**Files:**
- Create: `src/channels/telegram/bot.ts`
- Reference: nanoclaw의 `src/channels/` 구조

- [ ] **Step 1: Telegram Bot 핸들러 기본 구조**

```typescript
// src/channels/telegram/bot.ts
import { Bot, Context } from "grammy";
import { registerChannel } from "../registry";

export interface TelegramChannelConfig {
  botToken: string;
  pollingTimeout: number;
}

const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN!);

bot.on("message", async (ctx: Context) => {
  const text = ctx.message?.text;
  if (!text) return;

  // Log message to SQLite
  const chatId = String(ctx.chat.id);
  const messageId = ctx.message.message_id;
  const sender = ctx.from?.username || ctx.from?.first_name || "unknown";

  db.prepare(`
    INSERT INTO messages (chat_id, message_id, sender, text, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(chatId, messageId, sender, text, Date.now());

  // Emit to IPC watchdog
  ipc.emit("telegram:message", { chatId, messageId, sender, text });
});

bot.on("edited_message", async (ctx: Context) => {
  // Handle edits if needed
});

export async function startTelegramBot(): Promise<void> {
  await bot.api.setMyCommands([
    { command: "meeting", description: "Start an agent meeting" },
    { command: "extension", description: "Manage extensions" },
  ]);
  await bot.start({ allowedUpdates: ["message", "edited_message"] });
  console.log("[telegram] Bot started");
}
```

- [ ] **Step 2: Bot API Rate Limit 처리 추가**

```typescript
// src/channels/telegram/rate-limiter.ts
// Telegram: ~30 msg/sec, ~20 msg/min per group
// 에이전트 응답 속도가 rate limit에 도달하지 않도록 큐잉
```

- [ ] **Step 3: Privacy mode 설정 확인**

Telegram BotFather에서 privacy mode가 비활성화되어 있는지 확인하는 문서/설정 추가.

## Task 3: Swarm Router (mention 파싱)

**Files:**
- Create: `src/channels/telegram/swarm-router.ts`

- [ ] **Step 1: mention 정규식 파싱**

```typescript
// src/channels/telegram/swarm-router.ts

// mention 패턴: @agent_{name} (Telegram entity가 아닌 plain text에서 파싱)
const AGENT_MENTION_REGEX = /@agent_(\w+)/g;
const ALL_AGENTS_PATTERN = /@oxiclawbot\s+all/i;

// 메시지에서 에이전트 이름 추출
function parseMention(text: string): string[] {
  const agents: string[] = [];
  let match;
  while ((match = AGENT_MENTION_REGEX.exec(text)) !== null) {
    agents.push(match[1]);
  }
  // @oxiclawbot all → 전체 에이전트
  if (ALL_AGENTS_PATTERN.test(text)) {
    agents.push("all");
  }
  return [...new Set(agents)];
}

// 예시
// "@oxiclawbot @agent_marketer marketing strategy?" → ["marketer"]
// "@oxiclawbot @agent_developer @agent_designer work on X" → ["developer", "designer"]
// "@oxiclawbot all review the plan" → ["all"]
```

- [ ] **Step 2: 세션 ID 결정**

```typescript
function resolveSessionId(mention: string, chatId: string): string {
  if (mention === "all") {
    return "swarm"; // special: trigger all agents
  }
  return mention; // agent name = session id
}
```

- [ ] **Step 3: 메시지 → 세션 매핑 + 응답 라우팅**

```typescript
// swarm-router.ts
export async function routeMessage(
  chatId: string,
  sender: string,
  text: string,
  messageId: number
): Promise<void> {
  const mentions = parseMention(text);

  if (mentions.length === 0) {
    // no mention — ignore or handle as default agent
    return;
  }

  for (const mention of mentions) {
    const sessionId = resolveSessionId(mention, chatId);

    // session이 존재하는지 확인
    const session = db.prepare(`
      SELECT session_id FROM agent_sessions WHERE session_id = ?
    `).get(sessionId);

    if (!session) {
      // Unknown agent — send error message
      await bot.api.sendMessage(chatId, `Unknown agent: @agent_${mention}`, {
        reply_to_message_id: messageId,
      });
      continue;
    }

    // IPC로 pi-mono 세션에 메시지 전달
    await ipc.send({
      jsonrpc: "2.0",
      id: `msg-${Date.now()}`,
      method: "prompt",
      params: {
        session_id: sessionId,
        chat_id: chatId,
        message_id: messageId,
        prompt: stripMention(text),
        sender,
      },
    });
  }
}
```

- [ ] **Step 4: 응답 처리 — pi-mono → Telegram**

pi-mono 세션에서 응답이 오면 Telegram으로 전송:

```typescript
// swarm-router.ts
ipc.on("session.response", async (data) => {
  const { session_id, content } = data;

  // 에이전트 이름으로 접두어 결정
  const prefix = getAgentPrefix(session_id);
  const formatted = formatResponse(content, prefix);

  await bot.api.sendMessage(data.chat_id, formatted, {
    reply_to_message_id: data.message_id,
  });
});
```

## Task 4: persona.md 시스템

**Files:**
- Create: `src/persona-loader.ts`
- Reference: `groups/{chat_id}/agents/{agent_name}/persona.md`

- [ ] **Step 1: persona.md 로더**

```typescript
// src/persona-loader.ts
import { readFileSync } from "fs";
import { join } from "path";
import yaml from "yaml";

export interface Persona {
  role: string;
  description: string;
  tone: string;
  expertise: string[];
  response_prefix: string;
  max_turns_per_meeting: number;
}

export function loadPersona(chatId: string, agentName: string): string {
  const personaPath = join(
    process.env.GROUPS_DIR || "./groups",
    chatId,
    "agents",
    agentName,
    "persona.md"
  );

  const content = readFileSync(personaPath, "utf-8");

  // Parse YAML frontmatter
  const match = content.match(/^---\n([\s\S]+?)\n---\n([\s\S]+)$/);
  if (!match) {
    // No frontmatter — use content as system prompt
    return content;
  }

  const frontmatter = yaml.parse(match[1]);
  const body = match[2];

  // Build system prompt
  return [
    `# Persona: ${frontmatter.role}`,
    `Description: ${frontmatter.description}`,
    `Tone: ${frontmatter.tone}`,
    `Expertise: ${frontmatter.expertise.join(", ")}`,
    ``,
    body,
  ].join("\n");
}

export function getAgentPrefix(agentName: string): string {
  // Derive prefix from persona.md or fallback
  return `[${capitalize(agentName)}]`;
}
```

- [ ] **Step 2: 세션 생성 시 persona 주입**

```typescript
// container/agent-runner/src/index.ts 수정
const systemPrompt = loadPersona(chatId, sessionId);
const session = createAgentSession({
  cwd: path.join(groupsDir, chatId, "agents", sessionId),
  model,
  systemPrompt,  // ← persona 내용 주입
  tools,
});
```

## Task 5: 응답 포맷 — 에이전트 식별 접두어

**Files:**
- Modify: `src/channels/telegram/swarm-router.ts`

모든 에이전트 응답에 에이전트 이름 접두어를 붙임:

```typescript
function formatResponse(content: string, prefix: string): string {
  // 이미 접두어가 있으면 중복 방지
  if (content.startsWith(prefix)) return content;
  return `${prefix} ${content}`;
}
```

## Task 6: mention-all 처리

**Files:**
- Modify: `src/channels/telegram/swarm-router.ts`

- [ ] **Step 1: 전체 에이전트 동시 응답**

```typescript
if (mentions.includes("all")) {
  const allAgents = db.prepare(`
    SELECT session_id FROM agent_sessions WHERE chat_id = ? AND status = 'active'
  `).all(chatId) as Array<{ session_id: string }>;

  // 모든 에이전트 세션에 병렬로 메시지 전달
  await Promise.all(
    allAgents.map((agent) =>
      ipc.send({
        jsonrpc: "2.0",
        id: `msg-${Date.now()}-${agent.session_id}`,
        method: "prompt",
        params: {
          session_id: agent.session_id,
          chat_id: chatId,
          message_id: messageId,
          prompt: stripMention(text),
          sender,
          swarm_context: allAgents.map((a) => a.session_id), // 다른 에이전트 목록 공유
        },
      })
    )
  );
}
```

## Task 7: 에이전트 세션 생성/관리 API

**Files:**
- Create: `src/agent-manager.ts`

- [ ] **Step 1: 에이전트 등록**

```typescript
// POST /api/agents or CLI command
export async function registerAgent(
  chatId: string,
  agentName: string,
  personaPath?: string
): Promise<void> {
  // Create directory
  const agentDir = path.join(groupsDir, chatId, "agents", agentName);
  mkdirSync(agentDir, { recursive: true });

  // Create default persona.md if not exists
  const personaFile = path.join(agentDir, "persona.md");
  if (!existsSync(personaFile)) {
    writeFileSync(personaFile, `# Persona: ${agentName}\n\nYour role is ${agentName}.\n`);
  }

  // Register in SQLite
  db.prepare(`
    INSERT OR REPLACE INTO agent_sessions
    (session_id, chat_id, agent_name, status, last_activity, created_at)
    VALUES (?, ?, ?, 'active', ?, ?)
  `).run(agentName, chatId, agentName, Date.now(), Date.now());

  // Start pi-mono session for this agent
  await startAgentSession(chatId, agentName);
}
```

- [ ] **Step 2: 에이전트 목록 조회**

```typescript
export function listAgents(chatId: string): Agent[] {
  return db.prepare(`
    SELECT session_id, agent_name, status, last_activity
    FROM agent_sessions WHERE chat_id = ?
  `).all(chatId) as Agent[];
}
```

## Task 8: Telegram Swarm End-to-End 테스트

**Files:**
- Test (manual)

- [ ] **Step 1: Telegram 테스트 봇 생성**

BotFather에서 새 봇 생성 후 토큰을 `.env`에 저장:
```
TELEGRAM_BOT_TOKEN=123456:ABC-DEF...
```

- [ ] **Step 2: 에이전트 등록**

```bash
# 테스트 그룹에 개발자 에이전트 등록
curl -X POST http://localhost:3000/api/agents \
  -H "Content-Type: application/json" \
  -d '{"chatId": "test-chat", "agentName": "developer", "persona": "..."}'
```

- [ ] **Step 3: mention 테스트**

Telegram 그룹에서:
```
@oxiclawbot @agent_developer 안녕, 너는 어떤 역할이야?
```

Expected: 개발자 에이전트가 "[Developer] 저는 ..." 형식으로 응답

- [ ] **Step 4: mention-all 테스트**

```
@oxiclawbot all 우리 팀 소개해줘
```

Expected: 각 에이전트가 순차 또는 병렬로 응답

## Task 9: nanoclaw add-telegram-swarm 스킬 적용 검토

**Files:**
- Reference: nanoclaw 원본 `.claude/skills/add-telegram-swarm/`

- [ ] **Step 1: 풀 봇 vs 단일 봇 결정**

nanoclaw의 swarm 스킬이 여러 봇 토큰을 사용하는 풀 봇 구조라면:
- **현재 설계와 충돌**: 단일 봇 + mention 파싱 방식 vs 풀 봇 방식
- **결정 필요**: 어느 방식이 더 적합한가?

| 방식 | 장점 | 단점 |
|------|------|------|
| 단일 봇 + mention | 단순, 비용 절감 | 모든 응답이 같은 봇에서 옴 |
| 풀 봇 | 시각적 구분 가능 | 각 에이전트마다 봇 필요, UX 복잡 |

**초기 구현**: 단일 봇 + mention (비용/관리 단순성 우선)
**향후**: 필요 시 풀 봇 방식으로 마이그레이션 가능

---

**완료 조건:** Telegram 그룹에서 `@agent_*` mention으로 특정 에이전트를 활성화하고 응답을 받을 수 있는 상태.
