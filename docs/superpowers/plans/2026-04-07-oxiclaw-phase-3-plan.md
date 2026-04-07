# Phase 3: Autonomous Features

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development.

**Goal:** `/meeting` 명령으로 자율 회의를 트리거하고, Moderator가 안건을 제시한 후 각 에이전트가 협업하는 시스템. 능동적 메시징(규칙 기반 + AI 판단).

**Architecture:** Meeting Manager가 회의 상태 머신을 관리. Moderator 세션이 안건을 제시하고 다른 에이전트의 응답을 조정. HealthChecker가 세션 건강 상태를 모니터링.

**Tech Stack:** Node.js, TypeScript, pi-mono SDK, Telegram Bot API

**전제:** Phase 2 (Telegram Swarm) 완료.

---

## 선행 조건

1. Telegram 스웜mention 라우팅 동작 확인
2. 다중 에이전트 세션이 독립적으로 동작
3. 각 세션의 `session.subscribe()`가 이벤트를IPC bridge로 전달

## Task 1: Meeting Manager — 상태 머신

**Files:**
- Create: `src/channels/telegram/meeting-manager.ts`

**상태:**
```typescript
type MeetingState = "idle" | "scheduled" | "in_progress" | "summarizing" | "completed" | "cancelled";
```

```typescript
// src/channels/telegram/meeting-manager.ts

interface Meeting {
  id: string;
  chatId: string;
  state: MeetingState;
  agenda: string;
  moderator: string;  // Moderator agent name
  participants: string[];
  turns: number;
  maxTurns: number;    // default: 15
  startTime: number;
  maxDuration: number; // default: 10 min
  turnHistory: Turn[];
  createdAt: number;
}

interface Turn {
  agent: string;
  content: string;
  timestamp: number;
}

const MEETING_STATES = {
  MAX_TURNS: 15,
  MAX_TURNS_PER_AGENT: 3,
  MAX_DURATION_MS: 10 * 60 * 1000, // 10분
  COOLDOWN_SAME_TOPIC_MS: 60 * 60 * 1000, // 1시간
  DAILY_LIMIT: 5,
} as const;
```

```typescript
export class MeetingManager {
  private meetings: Map<string, Meeting> = new Map(); // chatId → Meeting
  private cooldowns: Map<string, number> = new Map(); // topic → last trigger time

  // 상태 천이
  async transition(chatId: string, newState: MeetingState): Promise<void> {
    const meeting = this.meetings.get(chatId);
    if (!meeting) throw new Error(`No meeting in progress for ${chatId}`);

    meeting.state = newState;

    switch (newState) {
      case "in_progress":
        await this.startRound(chatId);
        break;
      case "summarizing":
        await this.startSummary(chatId);
        break;
      case "completed":
        await this.sendMeetingSummary(chatId);
        this.meetings.delete(chatId);
        break;
      case "cancelled":
        this.meetings.delete(chatId);
        break;
    }
  }

  // 회의 시작
  async startMeeting(chatId: string, agenda: string, participants: string[]): Promise<void> {
    const id = `meeting-${Date.now()}`;
    const meeting: Meeting = {
      id,
      chatId,
      state: "idle",
      agenda,
      moderator: participants[0] || "developer",
      participants,
      turns: 0,
      maxTurns: MEETING_STATES.MAX_TURNS,
      startTime: Date.now(),
      maxDuration: MEETING_STATES.MAX_DURATION_MS,
      turnHistory: [],
      createdAt: Date.now(),
    };
    this.meetings.set(chatId, meeting);

    // Moderator에게 안건 제시
    await this.promptModerator(chatId, agenda);
    await this.transition(chatId, "in_progress");
  }

  private async promptModerator(chatId: string, agenda: string): Promise<void> {
    const meeting = this.meetings.get(chatId)!;
    await ipc.send({
      jsonrpc: "2.0",
      id: `meeting-${Date.now()}`,
      method: "prompt",
      params: {
        session_id: meeting.moderator,
        chat_id: chatId,
        prompt: `[SYSTEM] Meeting started. Your role is Moderator. Agenda: "${agenda}". Present the agenda to the group and invite discussion.`,
        is_meeting: true,
        participants: meeting.participants,
      },
    });
  }
}
```

## Task 2: /meeting 명령어 핸들러

**Files:**
- Modify: `src/channels/telegram/meeting-manager.ts`

```typescript
// /meeting 핸들러 등록
bot.command("meeting", async (ctx) => {
  const args = ctx.message?.text.replace("/meeting", "").trim();
  if (!args) {
    await ctx.reply("Usage: /meeting <agenda>\n/m meeting Discuss Q3 strategy");
    return;
  }

  const chatId = String(ctx.chat.id);
  const agents = db.prepare(`
    SELECT session_id FROM agent_sessions WHERE chat_id = ? AND status = 'active'
  `).all(chatId) as Array<{ session_id: string }>;

  if (agents.length < 2) {
    await ctx.reply("Need at least 2 agents for a meeting.");
    return;
  }

  await meetingManager.startMeeting(
    chatId,
    args,
    agents.map((a) => a.session_id)
  );

  await ctx.reply(`[Meeting] Started: "${args}"`);
});
```

## Task 3: 회의 진행 — 발언권 순환

**Files:**
- Modify: `src/channels/telegram/meeting-manager.ts`

```typescript
// 발언권 없는 에이전트 추적 (연속 발언 방지)
const consecutiveTurns: Map<string, number> = new Map();

private canSpeak(chatId: string, agent: string): boolean {
  const meeting = this.meetings.get(chatId);
  if (!meeting) return false;

  // 연속 발언 금지
  const lastTurn = meeting.turnHistory[meeting.turnHistory.length - 1];
  if (lastTurn?.agent === agent) return false;

  // 에이전트별 최대 턴 수
  const agentTurns = meeting.turnHistory.filter((t) => t.agent === agent).length;
  if (agentTurns >= MEETING_STATES.MAX_TURNS_PER_AGENT) return false;

  return true;
}

private async processAgentResponse(chatId: string, agent: string, content: string): Promise<void> {
  const meeting = this.meetings.get(chatId);
  if (!meeting || meeting.state !== "in_progress") return;

  // 발언권 체크
  if (!this.canSpeak(chatId, agent)) {
    console.log(`[meeting] ${agent} cannot speak (turn limit or consecutive)`);
    return;
  }

  // 발언 기록
  meeting.turnHistory.push({ agent, content, timestamp: Date.now() });
  meeting.turns++;

  // Telegram에 에이전트 응답 전송
  const prefix = getAgentPrefix(agent);
  await bot.api.sendMessage(chatId, `${prefix} ${content}`);

  // 종료 조건 체크
  if (meeting.turns >= meeting.maxTurns) {
    await this.transition(chatId, "summarizing");
    return;
  }

  if (Date.now() - meeting.startTime > meeting.maxDuration) {
    await ctx.reply("[Meeting] Time limit reached. Summarizing...");
    await this.transition(chatId, "summarizing");
    return;
  }
}
```

## Task 4: Moderator 요약

**Files:**
- Modify: `src/channels/telegram/meeting-manager.ts`

```typescript
private async startSummary(chatId: string): Promise<void> {
  const meeting = this.meetings.get(chatId)!;

  // 회의록 작성 프롬프트
  const summaryPrompt = `[SYSTEM] Meeting concluded. Please summarize the discussion on "${meeting.agenda}" based on the following turns:

${meeting.turnHistory.map((t) => `[${t.agent}]: ${t.content}`).join("\n")}

Provide a concise summary and key decisions.`;

  await ipc.send({
    jsonrpc: "2.0",
    id: `meeting-summary-${Date.now()}`,
    method: "prompt",
    params: {
      session_id: meeting.moderator,
      chat_id: chatId,
      prompt: summaryPrompt,
    },
  });
}

private async sendMeetingSummary(chatId: string): Promise<void> {
  const meeting = this.meetings.get(chatId)!;
  // 마지막 Moderator 응답을 회의록으로 Telegram에 전송
  const lastTurn = meeting.turnHistory[meeting.turnHistory.length - 1];
  if (lastTurn) {
    await bot.api.sendMessage(
      chatId,
      `📋 **회의록: ${meeting.agenda}**\n\n${lastTurn.content}`,
      { parse_mode: "Markdown" }
    );
  }
}
```

## Task 5: 능동적 메시징 — AI 판단 트리거

**Files:**
- Create: `src/autonomous-messages.ts`

```typescript
// src/autonomous-messages.ts

interface ProactiveMessage {
  sessionId: string;
  chatId: string;
  topic: string;
  timestamp: number;
}

// 가드레일
const PROACTIVE_COOLDOWN_MS = 60 * 60 * 1000; // 1시간
const DAILY_LIMIT_PER_GROUP = 10;

export class AutonomousMessageManager {
  private recentMessages: ProactiveMessage[] = [];
  private dailyCounts: Map<string, number> = new Map();

  // AI 판단 결과 처리
  async handleAICheck(sessionId: string, chatId: string, response: string): Promise<void> {
    // response에서 "능동적 메시지 필요" 판단 키워드 감지
    // 실제 구현: LLM 응답 후처리 또는 별도 판단 세션
    const needsProactive = this.detectProactiveNeed(response);
    if (!needsProactive) return;

    const topic = this.extractTopic(response);

    // 가드레일 체크
    if (!this.checkGuardrails(chatId, topic)) {
      console.log(`[autonomous] Blocked by guardrails: ${topic}`);
      return;
    }

    // telegram-native.send_message 호출 (이것은 pi Extension이 아님)
    // 오케스트레이터에서 직접 Telegram API 호출
    await this.sendProactiveMessage(chatId, response, topic);
  }

  private detectProactiveNeed(response: string): boolean {
    // 간단한 키워드 기반 또는 별도 AI 판단
    const keywords = ["더 논의", "논의 필요", "추가 확인", "계속 진행", "follow up"];
    return keywords.some((k) => response.includes(k));
  }

  private checkGuardrails(chatId: string, topic: string): boolean {
    // Cooldown 체크
    const cooldownKey = `${chatId}:${topic}`;
    const lastSent = this.recentMessages.find(
      (m) => m.chatId === chatId && m.topic === topic
    );
    if (lastSent && Date.now() - lastSent.timestamp < PROACTIVE_COOLDOWN_MS) {
      return false;
    }

    // 일일 상한 체크
    const today = new Date().toISOString().split("T")[0];
    const key = `${chatId}:${today}`;
    const count = this.dailyCounts.get(key) || 0;
    if (count >= DAILY_LIMIT_PER_GROUP) return false;

    return true;
  }

  private async sendProactiveMessage(
    chatId: string,
    content: string,
    topic: string
  ): Promise<void> {
    await bot.api.sendMessage(chatId, `💡 ${content}`, { parse_mode: "Markdown" });

    this.recentMessages.push({
      sessionId: "",
      chatId,
      topic,
      timestamp: Date.now(),
    });

    // 일일 카운트 증가
    const today = new Date().toISOString().split("T")[0];
    const key = `${chatId}:${today}`;
    this.dailyCounts.set(key, (this.dailyCounts.get(key) || 0) + 1);

    // SQLite에 로그 기록
    db.prepare(`
      INSERT INTO proactive_messages (chat_id, topic, content, created_at)
      VALUES (?, ?, ?, ?)
    `).run(chatId, topic, content, Date.now());
  }
}
```

## Task 6: 규칙 기반 트리거 — 크론 통합

**Files:**
- Modify: `src/autonomous-messages.ts`
- Reference: nanoclaw의 `src/task-scheduler.ts` (기존 cron-parser 활용)

```typescript
// autonomous-messages.ts에 규칙 기반 트리거 추가

// 규칙 예시
interface Rule {
  id: string;
  chatId: string;
  schedule: string; // cron expression
  prompt: string;
  enabled: boolean;
}

// 기존 task-scheduler.ts의 cron 스케줄러 활용
// 이미 cron-parser 기반으로 구현되어 있으므로 재사용
import { TaskScheduler } from "./task-scheduler";

const scheduler = new TaskScheduler();
scheduler.on("task", async (task: Rule) => {
  if (task.type === "proactive") {
    await proactiveManager.triggerByRule(task);
  }
});
```

## Task 7: HealthChecker 통합

**Files:**
- Modify: `src/health-checker.ts` (Phase 1에서 생성됨)

Phase 1에서 작성한 HealthChecker에 회의 중 세션 감지 추가:

```typescript
// 회의 중 세션은 정상으로 간주 — 회의 타임아웃은 Meeting Manager가 처리
private async checkSession(session: { session_id: string; last_activity: number }): Promise<void> {
  const meeting = meetingManager.getActiveMeeting(session.chatId);
  if (meeting) {
    // 회의 중 — Moderator가 응답하지 않을 때만 체크
    const meetingElapsed = Date.now() - meeting.startTime;
    if (meetingElapsed > meeting.maxDuration) {
      meetingManager.transition(session.chatId, "cancelled");
      await bot.api.sendMessage(session.chatId, "[Meeting] Timeout. Meeting cancelled.");
    }
    return;
  }

  // 일반 세션 health check
  if (Date.now() - session.last_activity > SESSION_TIMEOUT) {
    this.restartSession(session.session_id);
  }
}
```

## Task 8: SQLite 스키마 업데이트

**Files:**
- Modify: `src/db.ts` 또는 마이그레이션

```sql
-- 회의 로그
CREATE TABLE IF NOT EXISTS meetings (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  agenda TEXT NOT NULL,
  moderator TEXT NOT NULL,
  participants TEXT NOT NULL,  -- JSON array
  turns INTEGER DEFAULT 0,
  status TEXT DEFAULT 'active',
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  summary TEXT
);

-- 능동적 메시지 로그
CREATE TABLE IF NOT EXISTS proactive_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  topic TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- 회의 턴 로그
CREATE TABLE IF NOT EXISTS meeting_turns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  meeting_id TEXT NOT NULL,
  agent TEXT NOT NULL,
  content TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  FOREIGN KEY (meeting_id) REFERENCES meetings(id)
);
```

## Task 9: End-to-End 회의 테스트

**Files:**
- Test (manual)

- [ ] **Step 1: 2개 에이전트 등록 확인**

```
@oxiclawbot @agent_developer hello
@oxiclawbot @agent_designer hello
```

- [ ] **Step 2: /meeting 명령 테스트**

```
/meeting 우리 프로젝트 아키텍처 리뷰하자
```

Expected:
1. Meeting started 메시지
2. Moderator(developer)가 안건 제시
3. Designer가 응답
4. Developer가 응답
5. (15턴 또는 10분 후) Moderator가 요약
6. 회의록 전송

- [ ] **Step 3: 순환 방지 확인**

```
# A가 말한 직후 A가 다시 말하려고 시도 → 차단
```

- [ ] **Step 4: 능동적 메시지 테스트**

LLM 응답에 "더 논의 필요" 키워드 포함 → 능동적 메시지 발송 확인

---

**완료 조건:** `/meeting` 명령으로 자율 회의가 시작되고,Moderator가 협업하면서 회의록이 Telegram으로 전송되는 상태.
