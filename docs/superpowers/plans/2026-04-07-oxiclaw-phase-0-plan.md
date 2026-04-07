# Phase 0: pi-mono SDK 검증

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development.

**Goal:** `@mariozechner/pi-coding-agent`의 실제 API를 검증하고 설계 문서의 가정이 정확한지 확인. 실패 시 대안 설계(BACKUP_PLAN)를 작성.

**Architecture:** 독립 테스트 프로젝트에서 SDK를 설치하고 API를 탐색.

**Tech Stack:** Node.js, TypeScript, pi-mono SDK

---

## 선행 조건

oxiclaw 디렉토리에 nanoclaw가 이미 클론되어 있어야 함.

## Task 1: SDK 설치 및 패키지 존재 확인

**Files:**
- Create: `container/agent-runner/package.json` (테스트용)
- Reference: https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent

- [ ] **Step 1: pi-mono SDK 설치 테스트**

```bash
cd "/Volumes/SATECHI DISK/Code/repos/oxiclaw/container/agent-runner"
npm init -y
npm install @mariozechner/pi-coding-agent
```

Expected: 설치 성공 또는 "package not found" 오류

- [ ] **Step 2: 결과 기록**

설치 결과를 다음 형식으로 `docs/superpowers/plans/phase-0-results.md`에 기록:
- SDK 발견 여부
- 설치된 버전
- 설치 중 에러 메시지

## Task 2: createAgentSession API 검증

**Files:**
- Create: `container/agent-runner/src/test-api.ts`

- [ ] **Step 1: createAgentSession 시그니처 확인**

```typescript
import { createAgentSession } from "@mariozechner/pi-coding-agent";

// TypeScript 타입 확인
type SessionConfig = Parameters<typeof createAgentSession>[0];
console.log("createAgentSession params:", SessionConfig);
```

Run: `npx tsc --noEmit src/test-api.ts`
Expected: 타입 에러 없음 또는 정확한 에러 메시지

- [ ] **Step 2: createAgentSession 호출 테스트**

```typescript
import { createAgentSession } from "@mariozechner/pi-coding-agent";

async function test() {
  const session = createAgentSession({
    cwd: "/tmp/pi-test",
    model: "claude",
    systemPrompt: "You are a test agent."
  });
  console.log("Session created:", typeof session.prompt, typeof session.subscribe);
  await session.prompt("Say hello in one word");
}
test().catch(console.error);
```

Run: `npx ts-node src/test-api.ts`
Expected: 응답 수신 또는 에러

## Task 3: SessionManager API 검증

**Files:**
- Modify: `container/agent-runner/src/test-api.ts`

- [ ] **Step 1: SessionManager 존재 확인**

```typescript
import { SessionManager } from "@mariozechner/pi-coding-agent";
console.log("SessionManager:", typeof SessionManager);
// Expected: function 또는 undefined
```

- [ ] **Step 2: 다중 세션 생성 테스트**

```typescript
import { SessionManager } from "@mariozechner/pi-coding-agent";

const manager = new SessionManager({ cwd: "/tmp/pi-swarm" });
const session1 = manager.create("agent-1");
const session2 = manager.create("agent-2");
console.log("Created sessions:", session1.id, session2.id);
console.log("Same process?", session1 === session2);
```

## Task 4: session.subscribe() API 검증

**Files:**
- Modify: `container/agent-runner/src/test-api.ts`

- [ ] **Step 1: subscribe 메서드 존재 및 동작 확인**

```typescript
const session = createAgentSession({ cwd: "/tmp/pi-test" });

session.subscribe((event) => {
  console.log("Event:", event.type, event.data);
});

const response = await session.prompt("What is 2+2? Answer in one word.");
console.log("Response:", response);
```

Run: `npx ts-node src/test-api.ts`
Expected: streaming event logs → final response

## Task 5: createCodingTools 검증

**Files:**
- Modify: `container/agent-runner/src/test-api.ts`

- [ ] **Step 1: createCodingTools API 확인**

```typescript
import { createCodingTools } from "@mariozechner/pi-coding-agent";

const tools = createCodingTools("/tmp/pi-test");
console.log("Tools:", Object.keys(tools));
// Expected: read, write, edit, bash 또는 유사한 이름
```

## Task 6: pi Extension 시스템 검증

**Files:**
- Modify: `container/agent-runner/src/test-api.ts`
- Reference: https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent/src/extensions

- [ ] **Step 1: Extension 로딩 방식 확인**

pi-mono가 Extension을 런타임에 동적으로 로드하는지, 빌드 타임에 정적으로 링크하는지 확인.

```typescript
// pi Extension 타입 확인
import type { Extension } from "@mariozechner/pi-coding-agent";

function testExtension(pi: ExtensionAPI) {
  console.log("registerTool:", typeof pi.registerTool);
  console.log("registerCommand:", typeof pi.registerCommand);
  console.log("registerFlag:", typeof pi.registerFlag);
}

// Extension이 어떻게 로드되는지 pi-mono 소스코드 확인
```

**실제 pi-mono 소스코드에서 다음을 확인:**
- `src/index.ts` 또는 `src/agent/session.ts`에서 Extension 로딩 로직
- `src/extensions/` 디렉토리 구조
- Extension 파일의 export 형식

## Task 7: AuthStorage 검증

**Files:**
- Modify: `container/agent-runner/src/test-api.ts`

- [ ] **Step 1: AuthStorage API 확인**

```typescript
import { AuthStorage } from "@mariozechner/pi-coding-agent";

const storage = new AuthStorage();
// 지원 프로바이더 확인
console.log("Available providers:", storage.providers);
```

## Task 8: 백업 계획 작성

**Files:**
- Create: `docs/superpowers/plans/phase-0-backup-plan.md`

Phase 0이 실패할 경우를 대비한 백업 계획:

### Scenario A: pi-mono SDK가 npm에 없거나 설치 실패

**대안:**
- `@mariozechner/pi-coding-agent` 소스를 GitHub에서 직접 클론하여 사용
- 또는 `openai-agents` 등 대안 SDK 탐색

### Scenario B: API가 설계와 다름

**대안:**
- `createAgentSession()` → 단일 세션만 지원 → 1 그룹 = 1 프로세스(컨테이너) 아키텍처 검토
- `SessionManager` 없음 → 컨테이너 내 다중 프로세스로 스웜 구현
- `session.subscribe()` 없음 → 폴링 방식으로 이벤트 감지

### Scenario C: pi Extension 런타임 로딩不支持

**대안:**
- Extension 변경 시 항상 Docker 빌드 + 재시작
- `/extension add` CLI는 파일 복사만 수행, 빌드는 `docker build` 호출

## Task 9: 검증 결과 보고서 작성

**Files:**
- Create: `docs/superpowers/plans/phase-0-results.md`

**결과 템플릿:**

```markdown
# Phase 0 SDK 검증 결과

## SDK 존재 여부
✅ / ❌

## 검증된 API
| API | 존재 | 시그니처 | 동작 |
|-----|------|----------|------|
| createAgentSession | ✅/❌ | ... | ... |
| SessionManager | ✅/❌ | ... | ... |
| session.subscribe() | ✅/❌ | ... | ... |
| createCodingTools | ✅/❌ | ... | ... |
| pi Extension API | ✅/❌ | ... | ... |
| AuthStorage | ✅/❌ | ... | ... |

## 결론
- Phase 1 진행: ✅ 가능 / ⚠️ 조건부 / ❌ 불가
- 백업 계획 적용: [어떤 시나리오가 적용되는지]
```

---

**다음 Phase:** Phase 1 (Foundation) — 이 검증 결과를 바탕으로 `docs/superpowers/specs/2026-04-07-oxiclaw-pi-mono-design.md`를 업데이트하고 Phase 1 서브플랜을 실행.
