# 런타임 라이프사이클 — 워커가 하루 동안 어떻게 도는가

`pnpm dev`(또는 `pnpm app:up`)로 워커를 켜두면 도는 흐름. 시간은 전부 **KST**(cron 은 `timezone: 'Asia/Seoul'` 로 등록). 매매 전략·파라미터 설명은 대시보드 `/strategy`, 확정 구성은 [RUNBOOK](./RUNBOOK.md).

## 0. 켜는 순간 — `main.ts` (매매 시작이 아님)

켜자마자 주문하지 않는다. 두 가지만 한다.

1. **크래시 복구 대사**(다른 행동보다 먼저, 브로커=진실의 원천 / 불변식 2·4)
   - `reconcileOrders(오늘)` → KIS 일별체결조회로 주문 상태머신 전진 + 체결 적재
   - `reconcile()` → KIS 잔고로 `positions` 테이블 복원 (껐다 켠 사이/주말에 바뀐 잔고 동기화)
2. **스케줄러 등록** — node-cron 4개를 KST 로 걸고 대기. 로그: `scheduler started (KST)`.

| 시각(KST, 평일) | 훅 | 역할 | 진입 |
|---|---|---|---|
| 08:30 | `onPreOpen` | 레이어1 워치리스트 산출 | — |
| 매시 정각 09~15시 | `onHourlyTick` → `runLiveTick` | **메인 매매 틱**(국면+진입/청산) | ✔ |
| 매분 09~15시 | `onStopGuard` | 분단위 스탑 방어 | ✘(청산만) |
| 16:00 | `onPostClose` | 마감 후 데이터 적재 | — |

매시/매분 훅은 실행 시 `isMarketOpen(now)` 을 다시 확인해 휴장·장외면 스킵한다.

## 1. 개장 전 08:30 — `onPreOpen` (레이어1: 후보 선정)

`WatchlistService.rebuild` 이 유니버스(48종목)를 복합팩터로 랭킹해 그날의 `watchlist` 테이블에 적재.

- 팩터 가중: **모멘텀 0.35 · 밸류(PER/PBR) 0.25 · 퀄리티(ROE) 0.30 · event_score 0.10**
- 여기 쓰는 PER/PBR/ROE 는 **전날 16:00 에 KIS 로 적재해 둔 펀더멘털** → 펀더멘털·이벤트는 **하루 시차**로 반영된다.
- 주문은 내지 않는다. "오늘 살펴볼 리스트"만 만든다. 첫 09시 틱 전에 반드시 완료돼 있어야 함.

## 2. 장중 매시 정각 — `onHourlyTick` → `runLiveTick` (레이어2·3)

09·10·…·15시 정각 1회. 전체가 Redis 락(`stockbot:tick:lock`, TTL 5분)으로 직렬화(불변식 7). 8단계:

1. **대사** — `reconcileOrders` + `reconcile` → 잔고/포지션/`equity` 확정
2. **리스크** — `startDay`(당일 기준자산 고정) + `updateDailyLoss` → 킬스위치(일일 −5% 초과 시 당일 신규매수 차단)
3. **트레일링 앵커** — 보유 종목 현재가로 `highWaterMark`(고점) 상향 + `marks`(고점·부분청산·진입시각) 구성
4. **국면 판정** — `resolveRegime`: 지수 `INDEX_SYMBOL`(069500 KODEX200) 일봉이 **200일선 위인지**. 일봉<200 또는 미설정이면 보수적 true(차단 안 함)
5. **core 엔진** — `runStrategyTick`(live·backtest 동일 함수, 불변식 8). 청산을 먼저, 진입을 나중에 판정
6. **리스크 가드** — `risk.guard` 로 비중캡/현금/킬스위치 최종 검증
7. **주문(멱등)** — 매도 먼저, 매수 나중. `clientOrderId`=(tickId,idx,symbol,side) 결정키로 중복 차단(불변식 1). 체결 후 쿨다운/`scaled_out` 갱신
8. **기록** — `tick_runs` 에 진단·국면·체결 저장(대시보드 노출)

### 엔진 청산 우선순위 (높→낮, `engine.ts`)

1. **EOD 전량청산** — `liquidateAtClose=false` 라 현재 비활성
2. **최대보유 14일**(`maxHoldDays`) 초과 → 시장가 청산
3. **하드스탑 −7%**(`hardStopPct`, 진입가 기준)
4. **샹들리에 ATR 트레일링**(고점 − 3×ATR, `trailingMode=atr`/`trailingAtrMult=3`)
5. stay-invested 모드(현금 30% → ON)이므로 **추세이탈(가격 < EMA50)일 때만** 청산. 그 외엔 보유 유지 = 승자를 RSI 로 성급히 던지지 않음(과매매 방지)
   - (순수 전술 모드 `minInvestedRatio=0` 였다면: RSI(2)>80 에서 부분→전량 청산)

### 엔진 진입 게이트 (순서대로 통과해야 매수)

1. 지수 **200일선 아래면 신규진입 전면 차단**(청산 로직은 정상). ← 국면 필터의 핵심
2. 슬롯 = `maxPositions(8) − 보유수`. 0이면 진입 없음
3. 종목별: **재진입 쿨다운(3봉)** · **부정 이벤트 veto**(`negativeEventVetoThreshold`) 통과
4. **장중 국면**: 가격이 `VWAP 위` AND `EMA50 위`
5. 통과 후 **진입 3종 중 하나**:
   - **전술(평균회귀)**: RSI(2) < 15(`rsiEntry`) 눌림
   - **추세 눌림(pullback)**: EMA 우상향 + 최근 저점이 EMA 까지 눌림 + 직전봉 대비 반등
   - **코어 stay-invested**: 투자비중 < 70%(`minInvestedRatio`)면 국면 통과 종목으로 부족분 채움
6. 사이징: ATR 변동성 타깃(거래당 위험 1%, `riskPerTradePct`) → 종목당 비중캡 10%(`perSymbolWeightCap`) → 현금 잔량 순 상한

## 3. 장중 매분 — `onStopGuard` (틱 사이 1시간 갭 방어)

메인 틱은 1시간 간격 → 그 사이 급락 방어용. 매분:

- **메인 틱과 같은 Redis 락 공유** → 메인 틱 진행 중이면 스킵(거기서 처리)
- **대사·시그널·진입 안 함.** 마지막 대사된 보유분의 현재가만 확인
- 하드스탑(−7%)/트레일링 스탑 도달 시 **즉시 시장가 청산**(분 단위 멱등키로 중복 제출 차단)

순수 방어 전용 경로.

## 4. 장 마감 16:00 — `onPostClose` (다음 거래일 입력 적재)

매매가 아니라 **다음 날 입력 데이터**를 갱신:

1. `accumulateKisHourly` — 당일 분봉 → 시간봉 집계 append(지표용 봉 누적)
2. `loadFundamentals` — KIS 현재가에서 PER/PBR/ROE(EPS÷BPS 근사) 갱신 → **다음날 08:30 워치리스트가 사용**
3. 지수 일봉(069500) KIS 당일분 append(최근 10일 범위) → 200일선 최신 유지
4. `enrichment.scorePending` — 대기 이벤트 LLM 점수화 → event_score 팩터/veto 반영

## 하루 사이클 요약

```
16:00 마감수집 ─► (다음날) 08:30 워치리스트 ─► 09~15시 매시 틱 + 매분 가드 ─► 16:00 마감수집 ─► …
```

- **펀더멘털·이벤트 = 하루 시차**: 마감 후 적재분은 다음 거래일 워치리스트부터 반영.
- 월요일 첫 장: 직전(금) 마감 적재분을 08:30 워치리스트가 사용. 그날 16:00 수집분은 화요일부터.
- 첫날 확인 포인트: 08:30 `watchlist rebuilt` 로그 → 09시 첫 `tick complete` 로그 → 대시보드 `tick_runs`.
