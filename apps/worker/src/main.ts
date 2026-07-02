/**
 * 워커 엔트리포인트(11장·15장): 크래시 복구 대사 → 스케줄러 기동 → 장중 hourly 틱.
 * 순수 Node + TS 백그라운드 프로세스(웹 프레임워크 미사용, 2장).
 */
import './bootstrap.js';
import { eq } from 'drizzle-orm';
import { buildContainer, logger, type Container } from './container.js';
import { Scheduler } from './scheduler/index.js';
import { runLiveTick, type TickDeps } from './tick/index.js';
import { runStopGuard } from './tick/stop-guard.js';
import { isHoliday, isMarketOpen, tradingDateKey } from './market/calendar.js';
import * as schema from './db/schema.js';

const ymd = (d: Date) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;

/**
 * 부팅 자가복구(재시작/배포 대비): 워커가 개장 후(08:30 워치리스트 크론 이후)나 장중에 떠도
 * 첫 틱이 정상 동작하도록 당일 전제조건을 보장한다. 모든 작업 멱등(upsert/조건부).
 *  1) 유동성 필터용 유니버스 일봉 + 국면용 지수 일봉 최근분 확보
 *  2) 장중이면 당일 시간봉(부분봉이라도) 확보
 *  3) 당일 워치리스트가 없으면 산출
 * 휴장일/비-live/ KIS 미설정이면 스킵.
 */
async function bootstrapToday(c: Container, now: number): Promise<void> {
  if (c.config.runMode !== 'live' || !c.kis) return;
  if (isHoliday(now)) {
    logger.info('bootstrap: 휴장일 — 스킵');
    return;
  }
  const universe = c.config.defaultUniverse;
  const specs = universe.map((symbol) => ({ symbol, market: 'KS' as const }));
  const dailyTargets = c.config.indexSymbol ? [...specs, { symbol: c.config.indexSymbol, market: 'KS' as const }] : specs;

  // 1) 일봉 최근분(유니버스=유동성 필터, 지수=200일선). 최근 ~20거래일 범위 멱등 누적.
  await c.collector.accumulateKisDaily(dailyTargets, ymd(new Date(now - 20 * 86_400_000)), ymd(new Date(now)));

  // 2) 장중이면 당일 시간봉 확보(지표가 당일 데이터를 보게).
  if (isMarketOpen(now)) await c.collector.accumulateKisHourly(specs);

  // 3) 당일 워치리스트가 없으면 산출(개장 후 재시작 대비).
  const day = tradingDateKey(now);
  const rows = await c.db.select({ s: schema.watchlist.symbol }).from(schema.watchlist).where(eq(schema.watchlist.date, day)).limit(1);
  if (rows.length === 0) {
    // 섹터 신호 먼저(없을 때만, Opus 호출 절약), 그 다음 워치리스트.
    await c.sectorSignal.rebuild(now).catch((err) => logger.error({ err }, 'bootstrap: sector signal 실패 — 기존 팩터로'));
    const n = await c.watchlist.rebuild(now, universe);
    logger.info({ day, watchlist: n }, 'bootstrap: 당일 워치리스트 산출');
  } else {
    logger.info({ day }, 'bootstrap: 당일 워치리스트 이미 존재 — 스킵');
  }
}

async function main() {
  const c = buildContainer();

  if (c.config.runMode !== 'live') {
    logger.error({ runMode: c.config.runMode }, 'main.ts 는 live 모드 전용입니다. backtest 는 `pnpm backtest`.');
    process.exit(1);
  }
  if (!c.orderManager || !c.kis) {
    logger.error('KIS 자격증명이 없습니다(.env 확인: paper=MOCK_KIS_*, prod=KIS_API_*+KIS_ACCOUNT). live 틱 불가.');
    process.exit(1);
  }
  // 실거래면 기동 시 크게 경고 + 알림(되돌리기 어려운 실주문).
  if (c.config.kis?.env === 'prod') {
    logger.warn('⚠️ 실거래(REAL MONEY) 모드로 기동합니다 — 실제 자금으로 주문이 나갑니다. 리스크 한도/킬스위치 확인.');
    await c.notifier.notify('critical', '⚠️ stockbot 실거래 모드 기동', { account: c.config.kis.account.slice(0, 4) + '****' });
  }

  const tickDeps: TickDeps = {
    db: c.db,
    redis: c.redis,
    repos: c.repos,
    ctx: c.ctx,
    orderManager: c.orderManager,
    risk: c.risk,
    notifier: c.notifier,
    config: c.config,
    logger,
    defaultUniverse: c.config.defaultUniverse,
    indexSymbol: c.config.indexSymbol,
  };

  // 크래시 복구(10장-4): 다른 행동 전에 주문 상태 대사 + 브로커 잔고로 포지션 복원.
  try {
    await c.orderManager.reconcileOrders(tradingDateKey(Date.now()).replace(/-/g, ''));
    await c.orderManager.reconcile();
    logger.info('startup reconciliation complete');
  } catch (err) {
    logger.error({ err }, 'startup reconciliation failed — 계속 진행하나 첫 틱에서 재시도됨');
  }

  // 부팅 자가복구: 재시작/배포가 개장 후에 일어나도 당일 데이터·워치리스트를 보장(실패해도 계속).
  try {
    await bootstrapToday(c, Date.now());
    logger.info('startup bootstrap complete');
  } catch (err) {
    logger.error({ err }, 'startup bootstrap failed — 계속 진행(다음 크론에서 보정)');
  }

  const scheduler = new Scheduler(
    {
      onHourlyTick: async (now) => {
        // 틱 전에 직전 시간봉 수집(장중 신선도). 안 하면 엔진이 직전 완성봉 없이 stale 데이터로 판단.
        const specs = c.config.defaultUniverse.map((symbol) => ({ symbol, market: 'KS' as const }));
        try {
          await c.collector.accumulateKisHourly(specs);
        } catch (err) {
          logger.error({ err }, 'pre-tick hourly collect failed — stale 봉으로 진행될 수 있음');
        }
        await runLiveTick(tickDeps, now);
      },
      // 매분: 인트라아워 스탑 가드(틱 사이 손절 방어).
      onStopGuard: (now) => runStopGuard(tickDeps, now),
      // 개장 전: 레이어1 워치리스트 산출(모멘텀/밸류/퀄리티/event_score 복합팩터).
      onPreOpen: async (now) => {
        // 뉴스 → 섹터 신호 먼저(워치리스트 섹터 팩터 입력), 그 다음 워치리스트.
        await c.sectorSignal.rebuild(now).catch((err) => logger.error({ err }, 'sector signal rebuild failed — 워치리스트는 기존 팩터로'));
        await c.watchlist.rebuild(now, c.config.defaultUniverse);
      },
      onPostClose: async (now) => {
        // 장 마감 후 당일 시간봉 누적 + 펀더멘털/지수일봉 갱신 + 이벤트 점수화.
        const specs = c.config.defaultUniverse.map((symbol) => ({ symbol, market: 'KS' as const }));
        if (specs.length) {
          await c.collector.accumulateKisHourly(specs);
          await c.collector.loadFundamentals(specs, now); // 밸류/퀄리티 팩터 일일 갱신
        }
        // 200일선 국면필터용 지수 일봉 당일분 append(최근 10일 범위로 누락 보정).
        if (c.config.indexSymbol) {
          const fmt = (d: Date) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
          const from = new Date(now - 10 * 86_400_000);
          await c.collector.accumulateKisDaily([{ symbol: c.config.indexSymbol, market: 'KS' }], fmt(from), fmt(new Date(now)));
        }
        if (c.enrichment) await c.enrichment.scorePending();
      },
      // 대시보드 제어 명령(정리/킬스위치) 큐 소비 — 상시 폴링. 장 운영시간 판정은 ControlService 내부에서.
      onControlPoll: c.control ? async (now) => { await c.control!.processPending(now); } : undefined,
    },
    logger,
  );
  scheduler.start();

  // 부팅 직후 대기 중이던 제어 명령 즉시 처리(다운타임 중 눌린 버튼).
  if (c.control) await c.control.processPending().catch((err) => logger.error({ err }, 'startup control poll failed'));

  logger.info({ universe: c.config.defaultUniverse, indexSymbol: c.config.indexSymbol }, 'stockbot worker running (live/paper). Ctrl+C to stop.');

  const stop = async () => {
    logger.info('shutting down…');
    scheduler.stop();
    await c.shutdown();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((err) => {
  logger.error({ err }, 'fatal');
  process.exit(1);
});
