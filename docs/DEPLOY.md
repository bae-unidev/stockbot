# 배포 — Railway (그리고 실계좌 전환)

> ⚠️ 이 문서는 **실거래(real-money)** 활성화를 포함합니다. 지금까지 시스템은 **모의투자(paper)로만 검증**됐습니다.
> 강력 권장 순서: **① Railway에 paper로 먼저 띄워 일정 기간 검증 → ② 준비 체크리스트 통과 후 실계좌 전환.**

기존 `Dockerfile.worker` / `Dockerfile.dashboard` 를 Railway 서비스 2개로 올리고 Postgres/Redis 플러그인 + 환경변수만 연결하면 된다.

## 0. 아키텍처(배포 관점)
- **worker** — 스케줄러(node-cron) 상시 프로세스. 부팅 시 `db:migrate` 후 틱 시작. **반드시 1 인스턴스만**(아래 주의).
- **dashboard** — Next.js 읽기 전용 + 명령 큐 producer. 수평 확장 가능.
- **Postgres / Redis** — Railway 플러그인. 워커·대시보드가 공유.

## 1. 서비스 구성 (Railway)
모노레포라 빌드 컨텍스트는 저장소 루트, Dockerfile만 서비스별로 지정한다.

| 서비스 | 설정 |
|---|---|
| worker | New Service → GitHub repo. 변수 `RAILWAY_DOCKERFILE_PATH=Dockerfile.worker`. Root Directory = 저장소 루트. |
| dashboard | New Service → 같은 repo. `RAILWAY_DOCKERFILE_PATH=Dockerfile.dashboard`. 포트 3000 노출(Networking → Generate Domain). |
| Postgres | Add Plugin → PostgreSQL. |
| Redis | Add Plugin → Redis. |

> `worker` 는 헬스체크 포트가 없는 백그라운드 프로세스다. Railway에서 헬스체크를 끄거나 TCP 체크를 두지 말 것(HTTP 200 기대 시 재시작 루프).

## 2. 환경변수 (서비스별)
시크릿은 **Railway Variables에만** 입력. 코드/`.env`/이 문서에 평문 금지. `.env.example` 참고.

**공통(worker+dashboard)** — Railway 레퍼런스 변수로 플러그인 연결:
```
DATABASE_URL = ${{Postgres.DATABASE_URL}}
REDIS_URL    = ${{Redis.REDIS_URL}}
```

**worker 추가:**
```
RUN_MODE=live
KIS_ENV=paper                 # 검증 단계. 실계좌 전환 시에만 prod (아래 §4)
MOCK_KIS_API_KEY=...           # paper 키
MOCK_KIS_API_SECRET=...
MOCK_ACCOUNT=00000000-01
HTS_ID=...
ANTHROPIC_API_KEY=...          # 이벤트 점수화(선택)
DART_API_KEY=...               # 이벤트 수집(선택)
NOTIFIER_WEBHOOK_URL=...        # 슬랙/디스코드 등(웹훅 URL은 시크릿 아님)
WATCHLIST_SYMBOLS=005930,000660,...
INDEX_SYMBOL=069500
BLACKLIST_SYMBOLS=035720,035420
MAX_POSITIONS=8
PER_SYMBOL_WEIGHT_CAP=0.10
MIN_INVESTED_RATIO=0.70
DAILY_LOSS_LIMIT_PCT=0.05
```

## 3. 최초 데이터 시드 (1회)
배포 후 봉/지수/펀더멘털/종목명이 비어 있으면 워커가 매매할 게 없다. Railway 셸(또는 로컬에서 같은 DB를 가리켜) 1회 실행:
```
pnpm collect backfill-yahoo   # 시간봉(백테스트/시드)
pnpm collect yahoo-daily      # 지수 200일선
pnpm collect fundamentals     # 밸류/퀄리티 팩터
pnpm symbols                  # 종목명
pnpm preflight                # 전부 ✅ 확인
```

## ⚠️ 운영 주의
- **워커는 단 1 인스턴스.** in-process node-cron + 인메모리 스케줄이라 2개 뜨면 틱이 중복된다(Redis 틱락이 이중 *주문*은 막지만, 인스턴스를 늘리지 말 것). Railway에서 worker replicas=1 고정.
- **마이그레이션**은 worker 부팅 커맨드(`db:migrate && start`)가 적용. 대시보드는 마이그레이션 안 함.
- **휴장일 캘린더가 근사치**다(`market/calendar.ts` STATIC_HOLIDAYS, "운영 전 확정 필요"). 실거래 전 당해 연도 한국거래소 휴장일을 정확히 갱신할 것.
- **모니터링**: `NOTIFIER_WEBHOOK_URL` 설정 시 틱 실패/주문 거부/킬스위치/인트라아워 스탑 알림. 대시보드 `/` 에서 일자별 확인.
- **롤백**: worker를 멈추면(또는 킬스위치) 신규 매매 중단. 보유분은 청산 규칙/대시보드 "포지션 정리"로.

## 4. 실계좌(real-money) 전환 — 신중히
KIS_ENV=prod 는 **2중 동의**가 있어야만 켜진다(코드 게이트):
```
KIS_ENV=prod
ALLOW_REAL_MONEY=true          # 이게 없으면 prod 는 기동 시 throw
KIS_API_KEY=...                # 실거래 앱키
KIS_API_SECRET=...
KIS_ACCOUNT=00000000-01        # 실계좌
```
- `ALLOW_REAL_MONEY` 없이 `KIS_ENV=prod` 면 워커가 **기동 거부**(실주문 안전장치).
- 실거래 기동 시 로그/알림에 ⚠️ 경고가 뜬다.
- TR_ID/도메인은 prod 자동 선택(`adapters/kis/constants.ts`).

### 실계좌 전환 전 준비 체크리스트
- [ ] Railway에서 **paper로 최소 수 주** 무사고 가동(틱 에러 0, 대사 정합, 주문 거부 사유 정상)
- [ ] **휴장일 캘린더** 당해 연도 정확히 갱신
- [ ] 리스크 한도 실계좌 기준 재확인: `DAILY_LOSS_LIMIT_PCT`, `MAX_POSITIONS`, `PER_SYMBOL_WEIGHT_CAP`, 초기 투입금
- [ ] 소액으로 시작(작은 계좌 잔고)하여 실체결·수수료·세금 실제값 검증
- [ ] `NOTIFIER_WEBHOOK_URL` 실시간 알림 동작 확인 + 킬스위치/포지션정리 버튼 동작 확인(워커 가동 중)
- [ ] 백테스트는 야후 근사 데이터 기반임을 인지(실거래 성과 보장 아님)
- [ ] 토큰/키 회전 정책, 계좌 접근 권한 점검

> 이 봇은 취미용 규칙기반 봇이다. 실거래는 전적으로 본인 책임이며, 위 체크리스트는 최소 안전장치일 뿐 수익을 보장하지 않는다.
