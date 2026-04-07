# oxiclaw 구현 — 마스터 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement each sub-plan.

**Goal:** Telegram 스웜 AI 에이전트 플랫폼을 nanoclaw 기반으로 구축. Claude Agent SDK → pi-mono SDK 전환 + Telegram Swarm + 자율 회의 + 멀티모달 + pi Extension.

**Architecture:** 1 그룹 = 1 Docker 컨테이너, 내부는 pi-mono SessionManager. 오케스트레이터(Node.js)가 메시지를 라우팅하고, pi-mono 에이전트가 응답. Extension은 전역/그룹별로 파일 복사로 설치.

**병렬 실행 전략:**
- Phase 0: SDK 검증 — 선행 (모든 Phase의 전제)
- Phase 1: Foundation — Phase 0 완료 후 실행 (또는 Phase 0와 병렬 시동)
- Phase 2: Telegram Swarm — Phase 1 의존 (Foundation 완료 필요)
- Phase 3: Autonomous — Phase 2 의존
- Phase 4-5: Multimodal + Integrations — Phase 1 의존 (Foundation 완료 시 독립 실행 가능)
- Phase 6: Polish — Phase 3-5 완료 후

**병렬 세션 가이드:**
- Phase 0: 1개 세션 (순차 검증)
- Phase 1: 1개 세션 (Foundation)
- Phase 2: 1개 세션 (Swarm)
- Phase 3: 1개 세션 (Autonomous)
- Phase 4-5: 1개 세션 (Multimodal + Integrations, Phase 1 완료 후 독립 실행 가능)
- Phase 6: 1개 세션 (Polish)

**총 필요한 병렬 세션 수**: 최대 4개 동시 (Phase 1-2 병렬 불가, Phase 4-5는 Phase 1 완료 후 3과 병렬 가능)

---

## 서브플랜 목록

| 서브플랜 | 파일 | 전제 | 병렬 가능 |
|---|---|---|---|
| Phase 0: SDK 검증 | `phase-0-pi-mono-sdk-verification.md` | 없음 | — |
| Phase 1: Foundation | `phase-1-foundation.md` | Phase 0 완료 | Phase 0와 병렬 시동 가능 |
| Phase 2: Telegram Swarm | `phase-2-telegram-swarm.md` | Phase 1 완료 | Phase 3, 4-5와 병렬 |
| Phase 3: Autonomous Features | `phase-3-autonomous.md` | Phase 2 완료 | Phase 4-5와 병렬 |
| Phase 4-5: Multimodal + Integrations | `phase-4-5-multimodal-integrations.md` | Phase 1 완료 | Phase 3와 병렬 |
| Phase 6: Polish | `phase-6-polish.md` | Phase 3-5 완료 | — |

## nanoclaw 초기 설정 (모든 세션 공통 선행 작업)

모든 병렬 세션이 실행하기 전에 **한 번만** 수행:

```bash
cd "/Volumes/SATECHI DISK/Code/repos/oxiclaw"

# nanoclaw shallow clone (히스토리 폐기)
git clone --depth 1 https://github.com/qwibitai/nanoclaw.git .tmp_nanoclaw
rsync -av --exclude='.git' .tmp_nanoclaw/ ./
rm -rf .tmp_nanoclaw

# git 초기화
git init
git add .
git commit -m "Initial commit: fork nanoclaw as oxiclaw"
git remote add upstream https://github.com/qwibitai/nanoclaw.git

# 의존성 설치
npm install
```

**이 작업은 `phase-1-foundation` 서브플랜의 첫 번째 태스크에 포함되어 있으므로 별도 실행 불필요.**

## 서브플랜 실행 순서

### 세션 1: Phase 0 (SDK 검증)
1. `phase-0-pi-mono-sdk-verification.md` 실행
2. 결과를 design doc에 반영
3. Phase 1 세션에 결과 공유

### 세션 2-3: Phase 1 + Phase 4-5 병렬 (Phase 0 완료 후)
- Phase 0가 완료되고 pi-mono SDK가 유효함이 확인되면:
  - Phase 1 세션: `phase-1-foundation.md` 실행
  - Phase 4-5 세션: `phase-4-5-multimodal-integrations.md` 실행

### 세션 4: Phase 2 (Phase 1 완료 후)
- Phase 1 완료 후: `phase-2-telegram-swarm.md` 실행

### 세션 5: Phase 3 (Phase 2 완료 후)
- Phase 2 완료 후: `phase-3-autonomous.md` 실행

### 세션 6: Phase 6 (Phase 3-5 완료 후)
- `phase-6-polish.md` 실행

## 디자인 문서

- 설계 문서: `docs/superpowers/specs/2026-04-07-oxiclaw-pi-mono-design.md`
- 병렬 실행 시 각 서브플랜은 설계 문서를 참조하여 독립적으로 구현
