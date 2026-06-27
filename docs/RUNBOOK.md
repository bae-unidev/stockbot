# 운영 런북 — 모의투자(paper) 시작

> 1차는 KIS **모의투자(paper) 전용**. 실계좌 금지(3장). `KIS_ENV=prod` 는 코드에서 차단됨.

## 확정 전략 구성 (2026-06 기준)
- 진입 3종: ① RSI(2)<15 눌림(평균회귀) ② 추세 눌림(EMA/VWAP 되돌림 후 회복) ③ 코어 stay-invested(최소 70% 투자)
- 청산: 하드스탑(−7%, 사실상 안전망) · **샹들리에 ATR 트레일링(고점 − 3×ATR)** · 추세이탈(EMA50 아래) · 최대 보유 14일
- 사이징: ATR 변동성 타깃(거래당 위험 1%), 종목당 비중 10%, 동시 보유 8종목
- 리스크: 일일 손실 한도 5%(킬스위치), 재진입 쿨다운 3봉
- 유니버스: `.env WATCHLIST_SYMBOLS`(코스피 상위 ~50), `BLACKLIST_SYMBOLS` 제외
- 백테스트(야후 2년, 근사): 수익률 +40.3% / MDD 20.5% / 샤프 1.03

대부분 값은 `.env` 또는 `packages/core/src/strategy/config.ts` 에서 조정. 전략 설명·현재값은 대시보드 `/strategy`.
워커가 하루 동안 도는 흐름(켜는 순간 → 장중 국면/매매 → 마감)은 [LIFECYCLE](./LIFECYCLE.md).

## 모의투자 연동 — 시작 절차
```bash
# 0) 사전: .env 에 KIS 모의투자 키 (MOCK_KIS_API_KEY/SECRET/MOCK_ACCOUNT) 설정
pnpm install
pnpm infra:up            # Postgres + Redis
pnpm db:migrate          # 스키마

# 1) 데이터(최초 1회)
pnpm collect backfill-yahoo   # 야후 시간봉 백필(백테스트/워치리스트 시드용, .env 유니버스)
pnpm collect yahoo-daily      # 지수(INDEX_SYMBOL=069500 KODEX200) 일봉 ~3년 → 200일선 국면필터 활성
pnpm collect fundamentals     # KIS 현재가에서 PER/PBR/ROE(EPS÷BPS 근사) 적재(밸류/퀄리티 팩터), 모의계좌 키 필요
pnpm symbols                   # 종목명 시드
#  (이후 펀더멘털/지수일봉은 마감후 크론이 자동 갱신)

# 2) 사전점검 (주문 안 냄, 읽기 전용)
pnpm preflight           # DB·Redis·KIS 토큰/잔고·데이터 체크리스트. 모두 ✅면 진행

# 3) 워치리스트 1회 산출(선택) + 단발 틱
pnpm watchlist           # 레이어1 워치리스트 적재
pnpm tick                # 단발: 대사→시그널→리스크→주문→기록 (모의투자 실주문)

# 4) 상시 가동 + 모니터링
pnpm dev                 # 스케줄러(장중 hourly 틱 + 매분 스탑가드 + 개장전 워치리스트 + 마감후 수집)
pnpm dashboard           # http://localhost:3000
```

> ⚠️ `pnpm tick`/`pnpm dev` 는 **실제 모의계좌에 주문을 제출**합니다. 먼저 `pnpm preflight` 로 ✅ 확인하세요.

## 컨테이너로 상시 가동 (선택)
로컬에서 워커(스케줄러)를 터미널 없이 항상 띄우려면 Docker 앱 프로파일 사용:
```bash
# 인프라만:        docker compose up -d           (= pnpm infra:up) — 매매 시작 안 함
# 앱까지 상시가동:  pnpm app:up                    (worker + dashboard 빌드·기동, restart:unless-stopped)
pnpm app:logs       # 워커 로그 추적
pnpm app:down       # 중지
```
- `worker`/`dashboard`는 compose **`app` 프로파일**이라 `infra:up`/기본 `up`으로는 **안 뜹니다**(실수로 매매 시작 방지). `pnpm app:up` 으로만 기동.
- 워커 컨테이너는 부팅 시 `db:migrate` 후 스케줄러를 띄우고, `restart: unless-stopped` 로 죽으면 자동 재시작 → in-process node-cron(장중 hourly 틱 등)이 끊기지 않음.
- `.env` 가 컨테이너에 주입되며(env_file), DB/Redis 호스트는 컨테이너 네트워크(`postgres`/`redis`)로 자동 설정.
- ⚠️ `pnpm app:up` 은 워커가 **실제 모의계좌에 매매를 시작**합니다. 먼저 `pnpm preflight` ✅ 확인.
- Railway 배포(13단계)는 이 Dockerfile.worker/Dockerfile.dashboard 를 그대로 서비스로 올리고 Postgres/Redis 애드온 + 환경변수만 옮기면 됩니다.

## 대시보드 운영 제어 (실시간)
대시보드 메인(`/`)의 **운영 제어** 패널:
- **포지션 정리**: 보유 전 종목 시장가 청산(봇은 계속 가동 → 다음 틱 재진입 가능).
- **🚨 킬스위치**: 당일 신규매수 중단 + 전 종목 시장가 청산. **킬스위치 해제** 로 당일 재가동.
- 동작 방식: 버튼은 `control_commands` 큐에 **의도만 적재**하고, 워커가 10초 주기로 폴링해 `OrderManager`(멱등)·`RiskService` 경유로 실행한다. **대시보드는 브로커(KIS)를 직접 만지지 않는다**(단일 매매 권한·읽기전용 원칙 유지). 명령 id 기반 결정적 주문키라 폴링이 겹쳐도 이중 청산 없음.
- **장 운영시간 게이트는 워커(`ControlService`)가 판정**(거래소 캘린더). 장외엔 KIS로 주문을 던지지 않는다: `flatten`은 `skipped`(미실행), `kill`은 킬스위치만 ON·청산 보류. `kill_off`는 장외에도 즉시 가능. → 명령 정책이 워커 한 곳에 모임(대시보드/코어에 분산 없음).
- ⚠️ **워커가 떠 있어야 실행됨**(`pnpm dev`/`pnpm app:up`). 워커가 없으면 명령은 계속 `pending`. 다운타임 중 누른 명령은 워커 부팅 직후 1회 처리.
- 워커 없이 큐를 **수동 1회 처리**: `pnpm control` (대기 명령을 즉시 실행/정리, 스케줄러 불필요). 장외면 위 게이트가 그대로 적용.
- 킬스위치는 **거래일별**(`risk_state.date`) 상태 — 다음 거래일 개장 시 `startDay`가 새 날짜로 초기화하므로, 휴장일에 켠 킬스위치가 다음 영업일 매매를 막지 않는다. 당일 해제는 "킬스위치 해제" 버튼/`kill_off`.
- KPI 스트립(총자산·현금·투자비중·당일 실현손익·평가손익·보유수)은 직전 틱의 계좌 스냅샷(`tick_runs.equity/cash`) + 체결 기반 일별 실현손익으로 표시.

## 점검 포인트
- **틱 로그**: 대시보드 또는 `tick_runs`. `status=error` 면 `error` 컬럼 확인.
- **포지션/평가손익**: 대시보드 실매매 모니터링(현재가는 KIS 실시간 호가).
- **킬스위치**: 일일 손실 5% 초과 시 당일 매수 중단(`risk_state.kill_switch`). 다음 거래일 자동 초기화.
- **토큰**: KIS 24h, Redis `kis:token:paper:*`, 만료 전 자동 갱신.
- **알림**: `NOTIFIER_WEBHOOK_URL` 설정 시 틱 실패/주문 거부/킬스위치/인트라아워 스탑.

## 리플레이 e2e (과거 데이터로 실주문 파이프라인 검증)
`pnpm replay <YYYY-MM-DD> [endYYYY-MM-DD] [--cash N] [--keep] [--no-watchlist]`
- 과거 60m 봉으로 **실제 라이브 틱 파이프라인**(`runLiveTick`: 대사→국면→엔진→리스크→주문→일별체결 reconcile→기록)을 **가상 시계로 빠르게** 돌린다. KIS 대신 `ReplayBroker`(접수→다음틱 체결, FillSource 구현), 현재가/봉은 `ReplayMarketData`. 1시간 안 기다리고 즉시 진행.
- 백테스트(`pnpm backtest`)는 core 엔진만 돌리지만, 리플레이는 **OrderManager(멱등·대사)·RiskService·repos·Redis 틱락까지 라이브와 동일 코드**를 태운다 → 라이브 배선 버그 검출용.
- 결과는 런타임 테이블(positions/orders/fills/tick_runs/risk_state)에 쌓여 **대시보드(/)가 그 날짜의 실매매처럼** 보여준다(헤더 "세션 YYYY-MM-DD"). 기본적으로 시작 전 런타임 테이블을 비운다(`--keep` 로 보존, bars/symbols/fundamentals/지수일봉은 항상 보존).
- 예) `pnpm replay 2026-06-23` (하루) · `pnpm replay 2026-06-22 2026-06-23` (기간). 봉이 없으면 먼저 `pnpm collect backfill-yahoo`.
- ⚠️ 워커(`pnpm dev`)가 떠 있는 동안엔 같은 Redis 틱락을 쓰므로 리플레이를 따로 돌리지 말 것(락 충돌).

## 유지보수 명령
- `pnpm preflight` — 연동 사전점검(읽기 전용)
- `pnpm replay <date>` — 과거 데이터로 라이브 파이프라인 e2e 리플레이(위 참조)
- `pnpm control` — 제어 명령 큐 1회 수동 처리(워커 미가동 시)
- `pnpm reset` — 런타임/백테스트 데이터 비움(bars·symbols·fundamentals 보존). 클린 재시작용.
- `pnpm backtest [--label X] [--compare-events]` — 백테스트
- `pnpm paramsweep <param> <v1> <v2> ...` — 단일 파라미터 민감도 (예: `pnpm paramsweep maxHoldDays 5 10 14`)

## 장애 대응
| 증상 | 원인 후보 | 조치 |
|---|---|---|
| preflight ❌ KIS | 키 오류/만료, 네트워크 | `.env` MOCK_KIS_* 확인, 모의투자 키 재발급 |
| 틱이 안 돎 | 휴장/장외, Redis 락 잔류 | `isMarketOpen` 확인; 락 `stockbot:tick:lock` TTL(5분) 대기 |
| 주문 거부 | 잔고/레이트리밋/비중캡 | `orders.status=rejected` + 사유, 리스크 가드 로그 |
| 포지션 불일치 | 대사 실패 | 다음 틱 자동 재대사(브로커=진실). 수동: `pnpm tick` |

## 안전 제약
- 실거래 금지(paper만). 실계좌 키는 코드/문서에 두지 않는다.
- 비공식 소스(야후)는 백테스트 전용. 주문/실시간 판단엔 KIS만.
- 되돌리기 어려운 작업은 사람 확인 후.
