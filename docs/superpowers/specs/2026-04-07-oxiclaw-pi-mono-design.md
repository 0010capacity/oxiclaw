# oxiclaw: Telegram Swarm Messaging AI Agent — 설계 문서 (v3)

> **버전 관리**: v2 → v3으로 개정.
> **변경 사유**: 4개 축 검토 에이전트의 피드백 반영 (Phase 0 추가, 하트비트 수정, mention 방식 명확화, 컨테이너 경계 명시, IPC 프로토콜 명시, 회의 상태 머신, Docker 마운트 테이블, persona.md 명세)

## 1. 개요

**oxiclaw**은 [nanoclaw](https://github.com/qwibitai/nanoclaw)를 기반으로 한 **Telegram 스웜 AI 어시스턴트** 플랫폼이다. 하나의 Telegram 그룹에 여러 AI 에이전트가 공존하며, 각 에이전트는 고유한 페르소나/역할을 가진다. 에이전트는 사용자의 질문에 반응할 뿐 아니라, **자율적으로 다른 에이전트와 회의**를 진행하거나 **사용자에게 먼저 메시지를 전달**한다.

**핵심 기술 스택 변경**: Claude Agent SDK → pi-mono SDK + pi Extension.

## 2. 핵심 철학

- **단순성**: nano — 필요한 것만. 기능 추가는 Extension으로.
- **격리**: 모든 에이전트 실행은 컨테이너(Docker/LXC) 내에서. 1 그룹 = 1 컨테이너.
- **확장성**: pi Extension으로 모든 외부 서비스 연동. MCP는 필요 시 선택적 추가.
- **자율성**: 에이전트가 능동적으로 행동 (규칙 기반 + AI 판단).
- **오픈소스**: MIT 라이선스. Anthropmic 전용이 아닌 범용 LLM 지원.

## 3. 아키텍처

### 3.1 전체 흐름

```
[Telegram Group / DM]
        │
        ▼
[Node.js 오케스트레이터]
        │
   ┌────┴────┐
   ▼         ▼
[SQLite]  [IPC Watchdog + HealthChecker]
              │
              ▼
      [pi-mono SDK 세션들]  ← 1 그룹 = 1 컨테이너, 내부는 SessionManager
      ┌────┼────┐
      ▼    ▼    ▼
   [Agent][Agent][Agent]    ← 각자 다른 페르소나
      │    │    │
      └────┼────┘
           ▼
    [pi Extensions]
    - telegram-native (항상 활성)
    - multimodal (항상 활성)
    - spotify (선택)
    - pi-mcp-client (선택)
```

### 3.2 계층별 책임

| 계층 | 책임 | 기술 |
|------|------|------|
| **Telegram Bot API** | 메시지 수신/전송, polling, webhook | Node.js (grammY — nanoclaw 기존) |
| **오케스트레이터 (Node.js)** | 상태 관리, 크론, 그룹 라우팅, 스웜 조정, HealthChecker | TypeScript, better-sqlite3 |
| **에이전트 런타임 (Container)** | LLM 인터랙션, 툴 실행, 세션 관리 | pi-mono SDK |
| **pi Extensions** | 외부 API (멀티모달, Telegram原生) | pi Extension API |
| **격리 (Container)** | 파일시스템 격리, 보안 | Docker / LXC |

### 3.3 컨테이너 경계 모델: 1 그룹 = 1 컨테이너

**선택한 모델**: 하나의 Docker 컨테이너가 하나의 Telegram 그룹 전체를 담당한다. 컨테이너 내부에서 pi-mono의 `SessionManager`가 각 에이전트 세션을 관리한다.

**파일시스템 격리**: `createCodingTools(cwd)`로 각 에이전트의 작업 디렉토리를 제한한다. 하지만 이것은 애플리케이션 수준의 제약이므로, `workspace/`는 의도적으로 공유 디렉토리로 둔다.

**대안 (1 에이전트 = 1 컨테이너)**: 더 강력한 격리이지만 IPC 복잡도와 리소스 오버헤드가 크므로 우선 도입하지 않는다.

### 3.4 HealthChecker 컴포넌트

Telegram long polling은 **수동적 대기**일 뿐 에이전트 세션의 건강 상태를 확인하지 않는다. 오케스트레이터에 별도의 `HealthChecker`를 둔다:

```typescript
// src/health-checker.ts
// 60초마다 각 세션의 마지막 활동 타임스탬프 확인
// 타임아웃 시: 세션 재시작 또는 컨테이너 재시작 신호
```

**하트비트 ≠ Telegram polling**: 두 개념을 분리한다.

## 4. 스웜 아키텍처

### 4.1 에이전트 활성화: 정규식 파싱 기반

**핵심 수정**: Telegram은 `@agent_marketer` 같은 문자열을 mention entity로 인식하지 않는다 (실제 Telegram 계정이 아니므로). 따라서 오케스트레이터에서 **정규식으로 파싱**한다.

```
"@oxiclawbot @agent_marketer 지금 마케팅 전략이 뭐야?"
  → 정규식 /@agent_(\w+)/ 로 "marketer" 추출
  → marketer 세션에 메시지 전달
```

**감지 대상**: 오케스트레이터의 메시지 파싱 레이어에서 `message.text`를 스캔하여 `/@agent_(\w+)/` 패턴 매칭.

**에이전트 식별 접두어**: 응답 메시지에 `[Developer]`, `[Designer]` 등의 접두어를 붙여 사용자가 응답자를 구분할 수 있게 한다.

**privacy mode**: BotFather에서 privacy mode를 비활성화해야 모든 메시지를 수신할 수 있다.

### 4.2 mention-all

`@oxiclawbot all` → 전체 에이전트가 공통 컨텍스트로 각 세션 응답.

### 4.3 에이전트별 세션 격리

```
groups/{chat_id}/
├── CLAUDE.md
├── agents/
│   └── {agent_name}/
│       ├── persona.md   # 페르소나 정의 (see 4.5)
│       └── session.jsonl # pi-mono 세션 히스토리
├── workspace/           # 공유 작업 디렉토리 (의도적 공유)
└── meetings/           # 회의 로그
```

## 4.4 스웜 mention 라우팅

**nanoclaw의 `add-telegram-swarm` 스킬 참고**: 풀 봇(pool bot) 아키텍처를 제공한다. 각 서브에이전트가 `sender` 파라미터로 메시지를 보내면 호스트가 풀 봇을 할당하는 구조. Phase 2에서 어느 방식(multiple bots vs single bot + mention routing)을 선택할지 결정한다.

## 4.5 persona.md 명세

```markdown
# Persona: Marketing Agent

role: marketer
description:，负责品牌营销和用户增长策略。
tone: 专业但亲切，简洁有力
expertise: ["品牌定位", "内容营销", "数据分析"]
response_prefix: "[마케터]"
max_turns_per_meeting: 3
```

**로딩 시점**: 세션 생성 시 `session.prompt(systemMessage)`에 persona.md 내용을 시스템 프롬프트로 주입.
**형식**: YAML frontmatter + Markdown 본문.
**핫 리로드**: 파일 변경 시 세션 컨텍스트에는 즉시 반영되지 않으며, 다음 세션 생성 시 반영.

## 5. 자율 회의 시스템

### 5.1 회의 상태 머신

```
idle
  │
  ▼ (규칙/AI 트리거)
scheduled ──→ in_progress ──→ summarizing ──→ completed
                  │                │
                  ▼ (타임아웃/강제)   ▼ (완료)
               cancelled         idle
```

**상태 정의**:
- `idle`: 기본 대기 상태
- `scheduled`: 회의 예약됨 (크론 또는 미래 시간)
- `in_progress`: 회의 진행 중
- `summarizing`: Moderator가 요약 작성 중
- `completed`: 회의 완료, 회의록 전송
- `cancelled`: 타임아웃 또는 강제 종료

### 5.2 회의 안전장치

| 안전장치 | 값 |
|----------|------|
| 최대 발언 턴 수 | 에이전트당 3턴, 총 15턴 |
| 회의 최대 시간 | 10분 |
| 연속 발언 금지 | 같은 에이전트가 2번 연속 발언 불가 |
| 종료 조건 | 턴 수 소진, 타임아웃, Moderator 판단 |
| 강제 종료 | `/meeting cancel` 또는 Moderator 판단 |

### 5.3 회의 흐름

```
1. 회의 시작 (규칙/AI 트리거)
2. 오케스트레이터가 Moderator 세션에安건 전달
3. 상태: in_progress
4. 각 에이전트가 상태 머신 규칙에 따라 응답
5. Moderator가 상태 summarizing 전환 후 요약
6. telegram-native로 회의록 전송
7. 상태: completed → idle
```

### 5.4 AI 판단 기반 회의 트리거

**구현**: 에이전트가 `session.prompt()` 응답 후, 오케스트레이터가 응답을 분석하여 "논의 필요" 판단 시 `/meeting`을 내부 트리거. 에이전트가 직접 `telegram.send_message`를 호출하는 것이 아님.

**가드레일**:
- 동일 주제 cooldown: 1시간
- 일일 회의 상한: 그룹당 하루 5회
- 발송 로그 SQLite에 기록 (중복 방지)

## 6. 데이터 흐름

### 6.1 일반 메시지 처리

```
1. Telegram 메시지 수신
2. 오케스트레이터가 message.text 정규식 파싱 → @agent_* 추출
3. SQLite에 메시지 기록
4. IPC watchdog가 메시지 감지
5. 해당 에이전트의 pi-mono 세션에 전달
6. session.subscribe() 이벤트 → IPC bridge → watchdog
7. 오케스트레이터가 응답 수신 → Telegram 전송
```

### 6.2 능동적 메시징 흐름

```
1. HealthChecker가 주기적으로 세션 상태 확인
2. AI 판단 ("이 주제를 더 논의해야 한다") 감지
3. cooldown/상한선 체크
4. telegram-native.send_message()로 사용자 그룹에 메시지 전송
5. SQLite에 발송 로그 기록
```

## 7. IPC 프로토콜

### 7.1 전송 계층

**NanoClaw → pi-mono**: JSON-RPC 2.0 over stdin/stdout (기존 stdio 패턴 재사용)
**NanoClaw ← pi-mono**: JSON-RPC 2.0 over Unix socket

**nanoclaw 기존 패턴 재사용**: `container/agent-runner/src/ipc-mcp-stdio.ts`의 JSON 파일 IPC + 원자적 쓰기(temp→rename) + sentinel 파일 패턴.

### 7.2 메시지 포맷

```typescript
// 오케스트레이터 → pi-mono
{
  jsonrpc: "2.0",
  id: "msg-123",
  method: "prompt",
  params: {
    session_id: "marketer",
    prompt: "사용자 메시지",
    context: { chat_id: "123", thread_id: "abc" }
  }
}

// pi-mono → 오케스트레이터
{
  jsonrpc: "2.0",
  id: "msg-123",
  result: {
    session_id: "marketer",
    content: "응답 텍스트",
    tool_calls: [{ name: "telegram_send", params: {...} }]
  }
}

// 세션 이벤트 (subscription)
{
  jsonrpc: "2.0",
  method: "session.event",
  params: {
    session_id: "marketer",
    event: "thinking",
    data: "분석 중..."
  }
}
```

## 8. Docker 마운트 매핑

| 호스트 경로 | 컨테이너 경로 | 모드 | 설명 |
|---|---|---|---|
| `groups/{chat_id}/` | `/app/data/groups/{chat_id}/` | rw | 세션 데이터, 회의 로그 |
| `container/extensions/` | `/app/extensions/global/` | ro | 전역 Extension |
| `groups/{chat_id}/extensions/` | `/app/extensions/group/` | ro | 그룹별 Extension |
| — | `/app/workspace/{chat_id}/` | tmpfs | 임시 작업 공간 |
| `.env` 또는 secrets | `/app/secrets/` | ro | API 키 (Docker secret) |

## 9. pi Extension 아키텍처

### 9.1 왜 git branch 방식이 아닌가

nanoclaw의 git branch 배포 방식(git merge upstream/skill/{name})은 Claude Code CLI의 `.claude/skills/` 체계에 맞는 설계였으나, pi-mono SDK에서는 불필요한 제약이다.

### 9.2 Extension 시스템

```
extensions/                      # 전역 Extension
├── telegram-native.ts          # 항상 활성
├── multimodal.ts               # 항상 활성
├── spotify.ts                 # 선택적
└── pi-mcp-client.ts          # 선택적

groups/{chat_id}/extensions/   # 그룹별 Extension (마운트)
```

### 9.3 Extension CLI

```bash
/extension list          # 설치된 Extension 목록
/extension add spotify   # 파일 복사 + 컨테이너 재시작
/extension remove spotify # 파일 삭제 + 컨테이너 재시작
```

### 9.4 pi Extension 런타임 로딩

pi-mono SDK가 빌드 타임에 Extension을 로드하는지, 런타임에 동적 로드하는지는 **Phase 0 SDK 검증**에서 확인한다. 동적 로드가不支持라면 Extension 변경 시 컨테이너 빌드/재시작이 필요하며, Phase 1에서 이를 반영한다.

### 9.5 Extension vs MCP 선택 가이드

| 상황 | Approach |
|------|----------|
| Telegram Bot API 호출 | pi Extension |
| 이미지/TTS 생성 (Zai/MiniMax) | pi Extension |
| Spotify, GitHub, Notion | pi Extension |
| 기존 복잡한 MCP 서버 활용 | pi-mcp-client Extension |
| 복잡한 리소스/프롬프트 템플릿 | MCP |

## 10. 주요 컴포넌트

### 10.1 container/agent-runner (pi-mono SDK 통합)

```
src/index.ts          — createAgentSession() + SessionManager 초기화
src/ipc-bridge.ts     — NanoClaw IPC ↔ pi event/RPC 스트릿지 (JSON-RPC 2.0)
```

### 10.2 HealthChecker (오케스트레이터)

**위치**: `src/health-checker.ts`

60초마다 각 세션의 마지막 활동 타임스탬프 확인. 5분 이상 무응답 시 세션 재시작 시도.

### 10.3 Swarm Router (오케스트레이터)

**위치**: `src/channels/telegram/swarm-router.ts`

정규식 `/@agent_(\w+)/`로 메시지 파싱 → 해당 세션에 전달. mention-all 처리.

### 10.4 Meeting Manager (오케스트레이터)

**위치**: `src/channels/telegram/meeting-manager.ts`

상태 머신 관리, Moderator 세션 조정, 안전장치 Enforcement.

## 11. Migration 체크리스트

- [ ] Phase 0: pi-mono SDK API 검증
- [ ] `container/agent-runner/src/index.ts` 재작성
- [ ] `container/agent-runner/src/ipc-bridge.ts` 신규 작성 (JSON-RPC 2.0)
- [ ] `container/agent-runner/package.json` 의존성 교체
- [ ] `container/Dockerfile` 패키지 설치 변경
- [ ] AuthStorage vs OneCLI Agent Vault credential 관리
- [ ] 툴 동작 확인 (read/write/edit/bash)
- [ ] 스웜 세션 격리 동작 확인
- [ ] 메시지 스트리밍 동작 확인
- [ ] 크론 스케줄링 동작 확인

## 12. 파일 구조

```
oxiclaw/
├── src/
│   ├── index.ts
│   ├── channels/
│   │   └── telegram/
│   │       ├── bot.ts              # Telegram Bot API
│   │       ├── swarm-router.ts     # mention → 에이전트 라우팅
│   │       └── meeting-manager.ts  # 회의 상태 머신
│   ├── container-runner.ts         # pi-mono SDK 사용
│   ├── ipc.ts
│   ├── router.ts
│   ├── health-checker.ts           # 하트비트 (Telegram polling ≠ 하트비트)
│   ├── autonomous-messages.ts     # 능동적 메시징
│   └── extension-manager.ts       # Extension 설치/제거 관리
├── container/
│   ├── Dockerfile
│   ├── build.sh
│   ├── agent-runner/
│   │   ├── package.json
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   └── ipc-bridge.ts
│   │   └── tsconfig.json
│   └── extensions/
│       ├── telegram-native.ts
│       ├── multimodal.ts
│       ├── spotify.ts
│       └── pi-mcp-client.ts
├── groups/
│   └── {chat_id}/
│       ├── CLAUDE.md
│       ├── agents/
│       │   └── {agent_name}/
│       │       ├── persona.md
│       │       └── session.jsonl
│       ├── extensions/
│       ├── workspace/
│       └── meetings/
├── CLAUDE.md
├── README.md
├── package.json
└── .env.example
```

## 13. 구현 순서

### Phase 0: SDK 검증 (모든 Phase의 전제)
1. pi-mono SDK 설치 + API 탐색
2. `createAgentSession`/`SessionManager`/`createCodingTools`/`session.subscribe` 동작 확인
3. pi Extension 런타임 로딩 확인
4. 다중 세션 동시 실행 테스트
5. AuthStorage + 다중 프로바이더 테스트
6. **백업 계획**: API가 기대와 다를 경우 대안 설계

### Phase 1: Foundation
1. nanoclaw shallow clone → git init (히스토리 폐기)
2. container/agent-runner 의존성 교체 (Claude Agent SDK → pi-mono)
3. `index.ts` → `createAgentSession()` 마이그레이션
4. `ipc-bridge.ts` 작성 (JSON-RPC 2.0)
5. Dockerfile 업데이트
6. HealthChecker 구현
7. 기본 동작 확인

### Phase 2: Telegram Swarm
1. Telegram Bot 기본 연동 (grammY — nanoclaw 기존)
2. Swarm Router (정규식 mention 파싱)
3. 스웜 세션 관리 (SessionManager)
4. persona.md 시스템
5. 에이전트 응답 접두어 포맷
6. mention-all 처리

### Phase 3: Autonomous Features
1. Meeting Manager (상태 머신)
2. `/meeting` 명령어 핸들러
3. Moderator 세션 관리
4. 회의 안전장치 (타임아웃, 최대 발언 수, 순환 방지)
5. 능동적 메시징 + 가드레일
6. AI 판단 기반 회의 트리거

### Phase 4: Multimodal
1. Zai 이미지 생성 Extension
2. TTS Extension (Zai/MiniMax)
3. Telegram sendPhoto / sendVoice 연동
4. Multi-provider 추상화

### Phase 5: Integrations
1. Spotify Web API Extension (OAuth 2.0)
2. Extension CLI 완전 구현
3. 그룹별 Extension 마운트

### Phase 6: Polish
1. Extension 마켓플레이스 아키텍처 정의
2. 문서 및 README 업데이트

> **OpenClaw 통합 레퍼런스**: https://openclaw.ai/integrations
