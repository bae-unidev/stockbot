# 코스피 자동매매 시스템 — Claude Code 작업 스펙

## 0. 이 문서의 목적
이 문서는 Claude Code가 코스피(KOSPI) 자동매매 시스템을 구현할 때 따라야 할 스펙이다.
아래 기능을 구현하면서 /docs/에 세부 스펙들을 작성한다. 
.env는 읽어도 된다. 계좌에 돈 없고 유출되어도 안전함.

---

## 1. 프로젝트 개요 & 1차 목표
취미용 규칙 기반(rule-based) 자동매매 봇. 코스피 국내 주식, 롱 온리(long-only), 시간봉(hourly) 단위로 판단한다. 추후 분봉으로 판단할 여지를 둔다. 

**1차 목표는 "로컬에서 엔드투엔드로 한 틱(tick)이 정상 동작"하는 것이다.**
- 배포(Railway)는 나중 단계. 지금은 로컬 실행만 목표로 한다.
- 단, 코드와 설정은 처음부터 Railway 컨테이너 배포로 자연스럽게 넘어갈 수 있는 구조로 작성한다(환경변수 분리, 12-factor 지향).

**가장 중요한 설계 원칙 두 가지:**
1. 전략 엔진은 실매매와 백테스팅이 **같은 코드를 공유**한다. (4장)
2. 증권사는 **교체 가능한 어댑터**다. KIS로 시작하되 나중에 토스증권 등으로 갈아끼울 수 있어야 한다. (4장)

---

## 2. 기술 스택 & 런타임 결정

**언어: TypeScript 단일 언어로 유지한다.** 실행되는 시스템(워커·대시보드)에 다른 언어를 섞지 않는다.
- 예외: 펀더멘털 일회성 백필 등 **오프라인 1회성 데이터 준비**에 한해 파이썬 스크립트를 쓸 수 있으나, 이는 배포되는 런타임에 포함하지 않는다. (7장)

**런타임 형태 (중요):**
- **워커(매매 엔진)** = **순수 Node + TS.** 웹 프레임워크(NestJS/Express 등)를 쓰지 않는다. 이건 요청을 받는 API 서버가 아니라 스케줄 기반 백그라운드 프로세스다. 라우트가 없으므로 웹 프레임워크는 무게만 늘린다.
- **DI는 수동 주입**으로 한다. 엔진/모듈은 인터페이스를 생성자 인자나 팩토리 함수로 주입받는다(예: `createTradingEngine({ marketData, orders, clock })`). DI 컨테이너 프레임워크 불필요.
- **대시보드** = **Next.js.** UI + 조회 API를 한 번에 해결하고 Railway 배포도 매끄럽다.
- 워커가 외부 명령(예: 수동 청산)을 받아야 할 필요가 생기면, 그때 워커에 얇은 HTTP 엔드포인트 하나를 추가하거나 Next.js API → DB/큐로 신호를 주는 식으로 붙인다. 처음부터 깔지 않는다.

**라이브러리 선택:**
- 모노레포: pnpm workspaces (`core` 분리). Turborepo는 선택.
- 스케줄러: `node-cron` (in-process)
- ORM: **Drizzle** (SQL 제어·시계열·백테스트 집계에 유리)
- 검증/스키마: **zod** (증권사 응답 + LLM 구조화 출력 파싱 강제)
- HTTP/레이트리밋: 네이티브 `fetch` + `bottleneck`
- Redis: `ioredis`
- 지표(RSI·EMA·VWAP·SMA200·z-score): **core에 순수 함수로 직접 구현** (라이브러리 버전차로 live/backtest 결과가 갈리는 것 방지)
- 시간대/캘린더: `Luxon` (KST·휴장일)
- 로깅: `pino`
- 테스트: `Vitest`
- 차트(대시보드): `lightweight-charts` 또는 Recharts
- LLM: Anthropic SDK + zod 파싱

**저장소:** PostgreSQL(원장·시세·이벤트·점수·백테스트 결과), Redis(토큰 캐시 + 틱 중복실행 락).
**로컬 인프라:** docker-compose로 Postgres + Redis 기동.

---

## 3. 비범위 & 안전 제약 (반드시 준수)
- **실거래 금지 (1차):** 반드시 KIS **모의투자(paper) 계좌**로만 동작시킨다. 실계좌 키는 코드/문서 어디에도 없다. 
- **시크릿 평문 금지:** 모든 비밀값은 `.env`(git 무시)로 관리되나 읽어도 된다. 계좌에 돈 없다. 
- **실매매 데이터는 KIS만:** 야후·공공데이터 등은 지연·비공식이라 백테스트/리서치 전용. 주문/실시간 판단에 쓰지 않는다. (7장)
- **TS 단일 언어:** 런타임에 파이썬 미포함.
- **웹 프레임워크 미사용:** 워커는 순수 Node. 필요하다면 도입한다. 
- **LLM은 주문을 직접 내지 않는다:** 팩터 점수만 생성, 주문 결정은 규칙 엔진. (8장)

---

## 4. 아키텍처 — 공유 전략 엔진 (Ports & Adapters) + 증권사 중립

전략 엔진은 **순수 도메인 로직**으로, 외부 세계(증권사·DB·시계·뉴스)를 직접 건드리지 않고 **추상 인터페이스(포트)**에만 의존한다. 실행 환경이 어댑터를 주입한다. 이렇게 하면 동일 전략 코드가 실매매·백테스트에서 그대로 돌고, 증권사도 갈아끼울 수 있다.

### 포트(인터페이스) — `core`가 정의
- `Clock` — 현재 시각
- `MarketDataPort` — 시세/봉 조회
- `EventDataPort` — 특정 시점까지의 이벤트/점수 조회 (point-in-time)
- `PortfolioPort` — 포지션/현금 조회
- `OrderGateway` — 주문 제출/조회

### 증권사 중립 도메인 타입 (교체 가능성의 핵심)
- `core`에 **증권사 중립 도메인 타입**(`Order`, `Fill`, `Position`, `Bar`, `Quote` 등)을 먼저 정의한다.
- 인터페이스를 **절대 KIS 응답 모양에 맞추지 않는다.** KIS의 `rt_cd`·`tr_id`·한글 약어 필드가 포트로 새어 나오면 토스 전환 시 전부 깨진다.
- 각 어댑터 내부에서 "증권사 응답 → 도메인 타입" 변환을 **가둔다.** 흐름: 증권사 raw 응답 → zod로 파싱/검증 → 도메인 타입으로 매핑. 엔진·주문매니저는 도메인 타입만 본다.
- 증권사 추가 = 새 어댑터(예: `TossOrderGateway`) 작성. 엔진·core는 손대지 않는다.

### 어댑터 — 환경별 구현
| 포트 | 실매매(live) | 백테스트(backtest) |
|---|---|---|
| Clock | 시스템 시계 | 가상 시계(과거 타임스탬프 순차 전진) |
| MarketData | KIS REST | canonical 봉 리플레이 |
| EventData | 실시간 수집 이벤트 | 과거 이벤트(공개시각 기준 point-in-time) |
| Portfolio | KIS 잔고 대사 | 시뮬레이터 내부 장부 |
| OrderGateway | KIS 주문 API | 체결 시뮬레이터(수수료·세금·슬리피지) |

### 전략 엔진의 형태
- 입력: (시각, 시세, 이벤트 점수, 현재 포지션, 기타 전략에 도움이 되는 데이터 일체) → 출력: **주문 의도(intent) 목록**. 부수효과 없음.
- 엔진 내부에서 `Date.now()`/fetch/DB 직접 호출 금지, `if (backtest)` 분기 금지. 전부 포트 경유.

---

## 5. 모듈
- **core (공유)** — 전략 엔진, 팩터 계산, 리스크 규칙, 포트 인터페이스, **증권사 중립 도메인 타입**, 지표 순수 함수.
- **Scheduler** — 거래소 운영시간/휴장일 인지, 장중 hourly 틱 트리거 (KST).
- **KIS Adapter** — REST 래퍼(토큰 발급/캐시/갱신, 레이트리밋 스로틀링, 에러 타입 분리) + MarketData/Portfolio/OrderGateway live 구현. raw→도메인 변환을 내부에 가둠.
- **Data Collector** — 시세 백필/누적(야후 시간봉 백필, KIS 일봉·시간봉 누적), canonical 봉으로 정규화 저장. (7장)
- **Event Ingestion / Enrichment (LLM)** — 이벤트 수집 + 점수화. (8장)
- **Risk Guard / Kill Switch** — 주문 직전 강제 검사(일일 손실 한도, 동시 보유 수, 종목당 비중 캡).
- **Order Manager** — 멱등 주문, 상태 머신, 대사, 크래시 복구. (10장)
- **Backtest Engine** — canonical 봉을 core 엔진에 리플레이, 체결 시뮬, 결과 저장. (9장)
- **State Store** — Postgres repository.
- **Dashboard (Next.js)** — 실매매 모니터링 + 백테스트 결과 조회.
- **Notifier** — 틱 실패/주문 거부/킬스위치 알림(웹훅, URL은 환경변수).

> 모든 외부 연동 모듈은 어댑터로 만들고, core/엔진에는 수동 DI로 주입한다.

---

## 6. 전략 스펙 (3-레이어, 빈도 분리형, 초기, 이후 개선)

### 레이어 1 — 워치리스트 (하루 1회, 개장 전)
- 유동성 필터(거래대금) 후, 복합 팩터 점수로 상위 N개(기본 10~20개) 선정. 각 팩터 z-score 정규화 후 가중 합산:
  - 모멘텀: 12-1 모멘텀
  - 밸류: 낮은 PBR/PER
  - 퀄리티: 높은 ROE
  - **event_score: LLM 기반 이벤트/감성 팩터(8장). 노이즈가 크므로 작은 가중치로 시작.**

### 레이어 2 — 국면 필터 (매시간, 매수 허용 조건)
- 일봉: 지수가 200일선 위(개장 시 1회 고정)
- 장중: 종목 가격이 VWAP 위 AND 시간봉 20-EMA 위
- 보유/후보 종목에 중대 부정 이벤트 발생 시 진입 차단(veto).

### 레이어 3 — 진입/청산 (매시간)
- 진입: 시간봉 RSI(2) < 10 AND 레이어 2 통과
- 청산(먼저 도달): RSI(2) > 70 회복 / 트레일링 스탑 -3~5% / 장 마감 30분 전 전량 청산

### 리스크(기본값, config/env로 분리)
- 동시 보유 최대 종목 수(기본 5), 종목당 비중 캡(기본 10%), 일일 손실 한도→당일 중단.

---

## 7. 데이터 소스 & 수집/누적

**원칙: 소스를 용도로 분리하고, 무엇으로 받든 내부 canonical 봉 스키마로 정규화해 한 곳에 적재한다.** 수정주가 기준을 통일한다.

| 용도 | 소스 | 비고 |
|---|---|---|
| 실매매(주문·실시간) | **KIS만** | 공식·체결 가능, 유일하게 신뢰 |
| 시간봉 백테스트 백필 | **야후(60m, 최대 ~2년)** | 비공식, **백테스트 전용**, .KS/.KQ |
| 시간봉 누적(앞으로) | **KIS 당일분봉 → 시간봉 집계** | 장 마감 후 일배치, 누적될수록 깊어짐 |
| 일봉 | KIS 또는 공공데이터포털(금융위, 공식·T+1) | TS로 직접 조회 |
| 펀더멘털(PBR·PER·DIV) | pykrx(파이썬) **일회성 오프라인 백필** 또는 KIS 제공분 | 런타임 미포함, 결과만 적재 |

### TS 단일 언어 유지 방침
- 시간봉·일봉은 **야후(TS: `yahoo-finance2` 또는 chart JSON 직접) + KIS**로 받아 런타임을 TS로 유지.
- 야후는 비공식 API이므로 **try/catch + 에러 로깅 필수**, 결과는 근사치로 취급.
- 펀더멘털은 TS로 받기 어려우면 pykrx 일회성 스크립트로 백필해 `fundamentals` 테이블에 적재만 한다. 운영 시스템은 그 테이블만 읽는다.

### Collector 동작
- **백필 모드:** 야후 시간봉 ~2년 + (일봉) 장기 구간을 페이지네이션해 1회 적재.
- **증분 모드:** 매 장 마감 후 KIS로 당일 분봉을 시간봉으로 집계해 append. `collector_state`로 소스·종목·타임프레임별 마지막 적재 지점을 추적.
- 모든 적재 봉에 `source` 태그와 `adjusted` 여부를 기록.

### 일관성 리스크 (반드시 인지)
- 백테스트(야후)와 실매매(KIS)는 수정주가·타임스탬프·거래량이 다를 수 있다. canonical 정규화로 흡수하되, **시간봉 백테스트 깊이 = 야후 2년 + KIS 누적분**이며 야후 구간은 근사치임을 전제로 한다.

---

## 8. 이벤트 수집 + LLM Enrichment → event_score 팩터

**원칙: LLM은 트리거가 아니라 팩터를 만든다.** 점수(피처)만 생성, 주문 결정은 규칙 엔진.

- **수집:** Open DART(공시) 신규 폴링, 네이버 뉴스(보조). 각 이벤트에 **published_at** 기록.
- **점수화:** 헤드라인/공시 요지 → `{sentiment, event_type, 관련종목, confidence}` 구조화 추출. 고정 스케일 강제(예: [-1,+1]), structured output + 낮은 temperature + 고정 루브릭. **원문 출력·파싱점수·모델명·프롬프트 버전·scored_at 저장.**
- **팩터 집계(중요):**
  - **Point-in-time:** 의사결정 시점에 알 수 있던 점수만 사용(look-ahead 금지).
  - **정규화:** z-score/순위로 다른 팩터와 같은 단위로 합산.
  - **시간 감쇠:** 반감기로 오래된 이벤트는 0 수렴.
  - **결측 = 중립(0):** 뉴스 없음 ≠ 부정.
  - **보수적 가중치 + 기여도 검증:** 포함/미포함 백테스트 비교로 실제 기여 확인 후 비중 확대.

---

## 9. 백테스팅 엔진
**core 전략 엔진을 그대로 재사용.** 백테스터는 어댑터와 루프만 제공한다.
- 데이터 리플레이: canonical 봉/이벤트를 가상 시계 순서로 엔진에 주입.
- 체결 시뮬: OrderGateway 백테스트 어댑터가 주문 의도를 체결로 변환하되 **수수료·세금·슬리피지** 반영.
- 결정성: 같은 입력 → 같은 결과(난수는 시드 고정).
- Point-in-time 일관성: 이벤트 점수도 published_at 기준 노출. live와 동일 규칙.
- 결과: 자산곡선, 거래 내역, 지표(수익률·MDD·샤프·승률·턴오버), 파라미터/기간 메타 → 저장.

---

## 10. 핵심 정합성 요구사항 (실매매라서 가장 중요)
1. **멱등성:** 모든 주문에 클라이언트 고유키. 재시도 시 중복 주문 원천 차단.
2. **브로커가 진실의 원천:** 주문 후 잔고/체결 조회로 대사.
3. **주문 상태 머신:** 제출→접수→(부분체결)→완전체결/거부/취소.
4. **크래시 복구:** 재시작 시 다른 행동 전에 브로커 상태로 포지션 복원. 매 틱 시작에도 대사.
5. **토큰 수명:** KIS 토큰 24h, 만료시각과 함께 Redis 캐시·만료 전 갱신·concurrency-safe.
6. **레이트리밋:** 스로틀링. 모의투자 계좌는 제한 더 낮음.
7. **틱 중복 실행 방지:** Redis 락.
8. **live/backtest 동치성:** 전략 엔진은 두 환경에서 동일 코드. 엔진 내부 분기 금지.
9. **증권사 중립:** KIS 전용 필드는 어댑터 밖으로 새지 않는다.

---

## 11. 데이터 모델 (초안)
- `bars` — **canonical 봉**: symbol, timeframe(D/60m 등), ts, OHLCV, adjusted, source
- `fundamentals` — symbol, date, per, pbr, roe, div
- `collector_state` — source, symbol, timeframe, 마지막 적재 지점/커서
- `watchlist` — 날짜별 종목·팩터 점수(event_score 포함)
- `events` — 종목, 출처(DART/뉴스), 유형, 원문/요지, **published_at**, 수집시각
- `event_scores` — event_id, sentiment, event_type, confidence, 원문 출력, 모델명, 프롬프트 버전, **scored_at**
- `orders` — 멱등키, 종목, 방향, 수량, 가격, 상태, 브로커 주문번호, 타임스탬프
- `fills` — 체결 내역(부분체결 포함)
- `positions` — 현재 보유(대사 결과)
- `tick_runs` — 틱 실행 로그
- `risk_state` — 일일 손실 누적, 킬스위치 상태
- `backtest_runs` / `backtest_trades` / `backtest_equity` / `backtest_metrics` — 백테스트 결과

---

## 12. 로컬 개발 환경
- `docker-compose.yml`로 Postgres + Redis 기동.
- DB 마이그레이션(Drizzle).
- 스크립트: `dev`(워커), `collect`(시세 백필/누적), `backtest`, `dashboard`. (펀더멘털 백필 파이썬 스크립트는 `scripts/`에 분리, 운영 미포함)
- README에 로컬 셋업 순서 명시.

---

## 13. 대시보드 (Next.js)
- **실매매 모니터링:** 포지션, 당일 주문/체결, 실현·평가 손익, 틱 로그, 킬스위치 상태, 최근 이벤트·점수.
- **백테스트 결과:** 실행 목록, 자산곡선 차트, 거래 내역, 요약 지표, 실행 간 비교(예: event_score 포함 vs 미포함).
- 1차는 읽기 전용 + 폴링.

---

## 14. 구현 단계 (이 순서대로, 멈추지 않고 한번에 모두 구현)
1. **셋업** — 모노레포(`core` 분리), TS/lint/format, docker-compose, `.env`, Drizzle 마이그레이션 스캐폴딩, README.
2. **core 포트·도메인 타입** — 증권사 중립 타입(Order/Fill/Position/Bar/Quote)과 포트 인터페이스 정의. 수동 DI 구조, 더미 어댑터로 컴파일 확인.
3. **KIS Adapter + 토큰 관리** — 모의투자 토큰/잔고/시세, 스로틀러, raw→도메인 변환. 실모의계좌 조회 1건 성공.
4. **State Store + 데이터 모델** — 테이블/마이그레이션/repository.
5. **Data Collector** — 야후 시간봉 백필 + KIS 일봉/시간봉 누적, canonical 봉 정규화 적재. (펀더멘털은 필요 시 일회성 백필)
6. **Order Manager (집중)** — 멱등 주문, 상태 머신, 대사, 복구. 모의투자 1주 매수→체결→매도 왕복.
7. **Strategy Engine (core)** — 3-레이어 순수 함수 + 지표 + 단위 테스트.
8. **Backtest Engine** — 가상 시계 + canonical 리플레이 + 체결 시뮬 + 결과 저장. core 재사용 확인.
9. **Event Ingestion + Enrichment(LLM)** — 수집·점수화, point-in-time event_score 팩터 생성.
10. **Risk Guard + Scheduler** — 리스크/킬스위치, 장중·휴장일 인지 hourly 틱.
11. **통합 틱 루프(live)** — 대사→시세→이벤트점수→시그널→리스크→주문→기록 엔드투엔드(모의투자).
12. **Dashboard(Next.js)** — 실매매 + 백테스트 결과 조회.
13. **(나중) Railway 배포** — 컨테이너화, 환경변수 이전, 상시 워커/cron.

---

## 15. 완료 기준
- 로컬 docker-compose로 인프라가 뜨고 워커(순수 Node)가 모의투자 계좌에 붙는다.
- 한 틱이 대사→시그널→(조건 충족 시)주문→기록까지 무사 완주.
- **동일 전략 엔진**으로 실매매 틱과 백테스트가 모두 동작(엔진 내부 분기 없음).
- canonical 봉이 야후 백필 + KIS 누적으로 적재되고, 백테스트가 자산곡선·지표를 산출해 대시보드에 보인다.
- event_score가 point-in-time으로 산출되고, 포함/미포함 백테스트 비교 가능.
- 주문 재시도해도 이중 체결 없음. 워커 강제 종료 후 재시작 시 포지션 복원.
- 증권사 어댑터 교체 지점이 명확(KIS 외 어댑터를 추가해도 엔진·core 무수정).

---

## 16. 코딩 원칙
- core 전략 로직은 순수 함수 + 단위 테스트. I/O와 철저히 분리(포트 경유).
- 엔진 내부 `Date.now()`/fetch/DB 직접 호출 금지, backtest 분기 금지.
- 증권사 전용 필드(KIS rt_cd/tr_id/한글약어)는 어댑터 안에서만. 포트엔 도메인 타입만.
- DI는 수동 주입(생성자/팩토리). 웹 프레임워크·DI 컨테이너 미사용.
- 실패는 조용히 넘기지 말고 로깅 + 알림(특히 주문/대사). 비공식 소스(야후)는 반드시 에러 핸들링.
- 설정·시크릿은 환경변수. 매직넘버 금지.

---

## 부록 A — 로컬 셋업 & 실행 순서

> 구현 상태: 14장 1~12단계 구현 완료(로컬 엔드투엔드). 13단계(Railway 배포)는 미착수.
> 세부 설계는 `docs/ARCHITECTURE.md`, 운영 절차는 `docs/RUNBOOK.md` 참고.

### 사전 요구
- Node 20+, pnpm 9+ (`corepack enable && corepack prepare pnpm@9.15.0 --activate`)
- Docker (로컬 Postgres + Redis)

### 1) 인프라 + 의존성
```bash
cp .env.example .env        # MOCK_KIS_* 등 실제 모의투자 값 채우기
pnpm install
pnpm infra:up               # docker compose: postgres + redis
pnpm db:migrate             # Drizzle 마이그레이션 적용
```

### 2) 데이터 적재
```bash
# 실데이터 없이 빠르게 돌려보기(합성 봉)
pnpm collect seed 005930

# 또는 실제 백필 (야후 시간봉 ~2년, 백테스트 전용)
pnpm collect backfill-yahoo 005930 000660
pnpm collect kis-daily 005930      # KIS 일봉 누적(모의계좌 키 필요)
```

### 3) 백테스트
```bash
pnpm backtest --label "baseline"   # canonical 60m 봉 리플레이 → backtest_* 저장
```

### 4) 실매매 틱(모의투자)
```bash
pnpm tick                          # 단발 틱(대사→시그널→리스크→주문→기록)
pnpm dev                           # 스케줄러 상시 가동(장중 hourly, KST)
```

### 5) 대시보드
```bash
pnpm dashboard                     # http://localhost:3000
```

### 워크스페이스
- `packages/core` — 증권사 중립 도메인 타입·포트·지표·전략 엔진·리스크(순수, 단위 테스트).
- `apps/worker` — KIS 어댑터, State Store(Drizzle), Collector, Order Manager, Backtest, Events/LLM, Scheduler, 통합 틱 루프, CLI.
- `apps/dashboard` — Next.js 읽기 전용 모니터링 + 백테스트 조회.

### 환경변수 요약 (`.env.example` 참고)
`RUN_MODE`, `KIS_ENV`(paper 고정), `MOCK_KIS_API_KEY/SECRET/MOCK_ACCOUNT`, `DATABASE_URL`, `REDIS_URL`,
`ANTHROPIC_API_KEY`·`LLM_MODEL`·`EVENT_PROMPT_VERSION`(이벤트 점수화), `DART_API_KEY`(공시 수집),
`WATCHLIST_SYMBOLS`(기본 유니버스), `INDEX_SYMBOL`(200일선 국면), `NOTIFIER_WEBHOOK_URL`,
`MAX_POSITIONS`·`PER_SYMBOL_WEIGHT_CAP`·`DAILY_LOSS_LIMIT_PCT`.


Open API Key 관리
API Key
tsck_live_weeXmMX5J0hrm24Pza1LiO
Secret Key
tssk_live_fVUtwZTX61pvEcxfVmyetEKHUomwOLXij5A0UT8JL8RA
Secret Key는 지금만 복사할 수 있어요. 안전한 곳에 보관해주세요.
발급일
2026.06.30 22:46
만료일
2027.06.30 22:46
