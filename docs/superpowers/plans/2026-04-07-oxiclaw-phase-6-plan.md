# Phase 6: Polish

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development.

**Goal:** 문서화, Extension 마켓플레이스 아키텍처 정의, 최종 통합 테스트, README 업데이트.

**전제:** Phase 3 (Autonomous) + Phase 4-5 (Multimodal) 완료.

---

## 선행 조건

Phase 3과 Phase 4-5가 모두 완료되어야 함.

## Task 1: Extension 마켓플레이스 아키텍처 정의

**Files:**
- Create: `docs/extension-marketplace.md`

```markdown
# oxiclaw Extension Registry — Architecture

## Overview
Extension은 TypeScript 파일로 배포. Registry는 Extension의 메타데이터와 소스 URL을 관리.

## Extension Manifest Schema
```json
{
  "name": "spotify",
  "version": "1.0.0",
  "description": "Spotify playback control",
  "author": "oxiclaw",
  "repository": "https://github.com/oxiclaw/extension-spotify",
  "entry": "spotify.ts",
  "dependencies": {
    "spotify-web-api-node": "^5.0.0"
  },
  "permissions": ["audio"]
}
```

## Registry API
- GET /extensions → Extension 목록
- GET /extensions/:name → Extension 메타데이터
- GET /extensions/:name/download → Extension 소스 다운로드

## Installation Flow
1. `/extension add spotify`
2. 오케스트레이터가 Registry API에서 메타데이터 획득
3. 소스 다운로드 → groups/{chat_id}/extensions/
4. 컨테이너 재시작

## Phase 6에서 할 일: 정의만, 구현 X (향후 과제)
```

## Task 2: README.md 업데이트

**Files:**
- Modify: `README.md`

```markdown
# oxiclaw

Telegram Swarm AI Agent Platform — powered by pi-mono SDK.

## Quick Start

```bash
# Clone
git clone https://github.com/yourname/oxiclaw.git
cd oxiclaw

# nanoclaw base setup
# (see docs/superpowers/plans/phase-0-plan.md)

# Install dependencies
npm install

# Configure environment
cp .env.example .env
# Edit .env with your API keys

# Run
npm run dev
```

## Features

- **Telegram Swarm**: Multiple AI agents in one group, mention-based activation
- **Autonomous Meetings**: AI-powered team discussions with meeting summaries
- **Multimodal**: Image generation, TTS via Zai/MiniMax
- **Spotify Control**: Music playback via Spotify Web API
- **pi Extensions**: Plugin system with Extension CLI
- **Multi-Provider**: Claude, OpenAI, Groq, Zai, and more

## Architecture

```
Telegram → Node.js Orchestrator → pi-mono Container → pi Extensions
                                    ├── SessionManager (swarm)
                                    └── telegram-native (Telegram API)
```

## Extension System

```bash
/extension list       # Show available extensions
/extension add spotify  # Install Spotify extension
/extension remove spotify # Remove
```

## Documentation

- [Design Spec](docs/superpowers/specs/2026-04-07-oxiclaw-pi-mono-design.md)
- [Master Plan](docs/superpowers/plans/2026-04-07-oxiclaw-master-plan.md)
- [Phase 0: SDK Verification](docs/superpowers/plans/phase-0-pi-mono-sdk-verification.md)
- [Phase 1: Foundation](docs/superpowers/plans/phase-1-foundation.md)
- [Phase 2: Telegram Swarm](docs/superpowers/plans/phase-2-telegram-swarm.md)
- [Phase 3: Autonomous](docs/superpowers/plans/phase-3-autonomous.md)
- [Phase 4-5: Multimodal](docs/superpowers/plans/phase-4-5-multimodal-integrations.md)
- [Phase 6: Polish](docs/superpowers/plans/phase-6-polish.md)
```

## Task 3: CLAUDE.md 작성

**Files:**
- Create: `CLAUDE.md` (프로젝트 루트)

```markdown
# oxiclaw

## Project Overview
Telegram Swarm AI Agent Platform. Based on nanoclaw, powered by pi-mono SDK.

## Key Architecture Decisions
- 1 group = 1 Docker container, 1 container = 1 SessionManager (multiple agent sessions)
- pi Extension > MCP (MCP only for existing complex servers)
- Telegram mention = regex parsing (@agent_*), not native Telegram mention entity
- HealthChecker = independent from Telegram polling (polling is for receiving messages)

## Important Files
- `src/health-checker.ts` — session health monitoring
- `src/channels/telegram/swarm-router.ts` — mention parsing + routing
- `src/channels/telegram/meeting-manager.ts` — meeting state machine
- `src/extension-manager.ts` — Extension install/remove
- `container/agent-runner/src/ipc-bridge.ts` — JSON-RPC IPC bridge
- `container/extensions/` — pi Extensions (telegram-native, multimodal, spotify, etc.)

## Design Doc
`docs/superpowers/specs/2026-04-07-oxiclaw-pi-mono-design.md`

## Implementation Plans
`docs/superpowers/plans/`

## Commands
- `npm run dev` — start in development mode
- `cd container && docker build -t oxiclaw/agent .` — build agent container
```

## Task 4: 최종 통합 테스트 체크리스트

**Files:**
- Create: `docs/testing/checklist.md`

```markdown
# oxiclaw Integration Test Checklist

## Phase 1: Foundation
- [ ] pi-mono agent starts in Docker
- [ ] IPC bridge communicates with orchestrator
- [ ] Basic prompt/response works
- [ ] HealthChecker runs on schedule

## Phase 2: Telegram Swarm
- [ ] Telegram bot receives messages
- [ ] @agent_* mention triggers correct agent session
- [ ] @oxiclawbot all triggers all agents
- [ ] Agent responses have correct prefix
- [ ] persona.md is loaded as system prompt
- [ ] Multiple agents respond independently

## Phase 3: Autonomous
- [ ] /meeting starts a meeting
- [ ] Moderator presents agenda
- [ ] Agents take turns (consecutive turns blocked)
- [ ] Turn limit enforces meeting end
- [ ] Meeting summary is sent to Telegram
- [ ] Proactive messages are sent (with guardrails)
- [ ] Cron-triggered proactive messages work

## Phase 4-5: Multimodal
- [ ] /extension list shows available extensions
- [ ] /extension add spotify installs the extension
- [ ] spotify_play works
- [ ] spotify_now_playing works
- [ ] zai_generate_image works (with Telegram send)
- [ ] tts_speak works (with Telegram send)

## General
- [ ] Session isolation maintained
- [ ] Container restart doesn't lose session data
- [ ] API keys not exposed in logs
- [ ] Rate limiting prevents Telegram flood
```

## Task 5: API 키 보안 검토

**Files:**
- Review: 모든 소스 파일

- [ ] **Step 1: API 키 하드코딩 검사**

```bash
grep -r "API_KEY" container/agent-runner/src/ --include="*.ts"
grep -r "TELEGRAM_BOT_TOKEN" container/ --include="*.ts"
```

Expected: 환경 변수 또는 process.env만 사용. 하드코딩 없음.

- [ ] **Step 2: Docker secrets 적용 확인**

```bash
cat container/Dockerfile | grep -E "secret|SECRET|ENV"
```

API 키가 Docker secrets로 주입되는지 확인.

## Task 6: CI/CD 기본 설정 (선택적)

**Files:**
- Create: `.github/workflows/ci.yml`

```yaml
name: CI

on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "20"
      - run: npm install
      - run: npm test
      - run: cd container && docker build -t oxiclaw/agent .
```

## Task 7: 최종 설계 문서 동기화

**Files:**
- Modify: `docs/superpowers/specs/2026-04-07-oxiclaw-pi-mono-design.md`

Phase 1-5 구현 결과를 바탕으로 설계 문서 최종 업데이트:
- 실제 구현과 다른 부분 수정
- Phase 체크리스트 완료 상태 표시
- Architecture diagram을 실제 파일 구조로 정렬

---

**완료 조건:** README, CLAUDE.md, 문서가 완성적이고, 통합 테스트 체크리스트가 존재하는 상태.
