# 아키텍처 — 공유 전략 엔진 (Ports & Adapters)

코스피 자동매매 봇의 구현 설계. README 스펙(4장·10장)의 구체화.

## 큰 그림

```
                ┌───────────────────────────────────────────┐
                │ packages/core  (순수, I/O 없음)            │
                │  도메인 타입 · 포트 인터페이스 · 지표       │
                │  전략 엔진(3-레이어) · 리스크 규칙          │
                └───────────────▲───────────────────────────┘
                                │ 포트만 의존 (수동 DI)
        ┌───────────────────────┴───────────────────────────┐
        │ apps/worker  (순수 Node + TS, 웹 프레임워크 없음)  │
        │                                                    │
        │  live 어댑터              backtest 어댑터          │
        │  ├ SystemClock           ├ VirtualClock            │
        │  ├ LiveMarketData(KIS+DB)├ ReplayMarketData        │
        │  ├ LivePortfolio(KIS)    ├ SimBroker(장부)         │
        │  ├ KisOrderGateway       └ SimBroker(체결시뮬)     │
        │  └ DbEventData                                     │
        │                                                    │
        │  Order Manager · Risk Guard · Scheduler · Collector│
        │  Event Ingestion+LLM · Notifier · State Store      │
        └──────────────┬───────────────────────┬────────────┘
                       │                        │
                 Postgres(원장/시세/이벤트)  Redis(토큰·틱락)
                       │
        ┌──────────────┴────────────┐
        │ apps/dashboard (Next.js)   │  읽기 전용 + 폴링
        └────────────────────────────┘
```

## 핵심 불변식 (10장)

| # | 불변식 | 구현 위치 |
|---|---|---|
| 1 | 멱등 주문 | `OrderManager.clientOrderId()` = (tickId, idx, symbol, side) 결정적 생성 |
| 2 | 브로커 = 진실의 원천 | `OrderManager.reconcile()` → KIS 잔고로 `positions` 전량 교체 |
| 3 | 주문 상태 머신 | `OrderStatus`: new→submitted→accepted→(partial)→filled/rejected/canceled |
| 4 | 크래시 복구 | `main.ts` 시작 시 + 매 틱 시작 `reconcile()` |
| 5 | 토큰 수명 | `KisTokenManager` — Redis 캐시 + 만료 전 갱신 + 락(concurrency-safe) |
| 6 | 레이트리밋 | `KisClient` + `bottleneck` (모의계좌 보수적 한도) |
| 7 | 틱 중복 방지 | `acquireTickLock()` — Redis NX+PX, Lua 소유자 검증 해제 |
| 8 | live/backtest 동치 | `runStrategyTick()` 단일 함수 — 두 환경 공유, 내부 분기 없음 |
| 9 | 증권사 중립 | KIS `rt_cd`/`tr_id`/한글약어는 `adapters/kis/*` 안에서만. 포트엔 도메인 타입만 |

## 증권사 교체 지점

`OrderGateway`/`MarketDataPort`/`PortfolioPort` 인터페이스만 구현하면 됨.
KIS → 토스 전환 = `adapters/toss/` 작성 + `container.ts` 한 줄 교체. core·엔진 무수정.

raw→도메인 변환 흐름: `KIS raw 응답 → zod 파싱(schemas.ts) → 도메인 타입 매핑` — 어댑터 내부에 가둠.

## 전략 엔진 (6장, `core/strategy`)

- **레이어1 워치리스트**(`buildWatchlist`, 하루 1회): 유동성 필터 → 모멘텀/밸류/퀄리티/event_score z-score 가중합 → 상위 N.
- **레이어2 국면 필터**(매시간): 지수 200일선 위(`INDEX_SYMBOL`=069500, 일봉 적재 시) + 종목 VWAP·EMA50 위 + 부정이벤트 veto.
- **레이어3 진입/청산**(매시간): 진입 3종(RSI(2)<15 눌림 / 추세 눌림 / 코어 stay-invested). 청산 우선순위 = 최대보유 14일 → 하드스탑 −7% → 샹들리에 ATR 트레일링(고점−3×ATR) → 추세이탈(EMA50 아래). `liquidateAtClose=false`(EOD 청산 비활성).

엔진 입력 = (시각, 워치리스트, 국면, marks, config) + 포트 조회. 출력 = `OrderIntent[]` (부수효과 없음).
하루 동안의 스케줄·틱 흐름은 [LIFECYCLE](./LIFECYCLE.md) 참고.

## 데이터 정합성 (7장)

- 모든 봉은 canonical 스키마(`bars`)로 정규화, `source`/`adjusted` 태그.
- 백테스트 = 야후 2년(근사, 백테스트 전용) + KIS 누적. 실매매 주문/판단 = KIS만.
- point-in-time: `getBars(asOf)`·`getScores(asOf)` 모두 asOf 이하만 노출 — look-ahead 차단.

## 이벤트 → event_score (8장)

수집(DART) → LLM 구조화 점수화(structured output, temperature 0, 고정 루브릭, 원문/모델/프롬프트버전/scored_at 저장)
→ 팩터 집계(`aggregateEventScore`: 시간감쇠 반감기 + confidence 가중 + 결측=중립) → 워치리스트 z-score 합산.
LLM은 점수만 만들고 주문은 규칙 엔진이 결정.
