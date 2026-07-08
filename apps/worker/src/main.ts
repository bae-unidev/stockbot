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
import { isHoliday, tradingDateKey } from './market/calendar.js';
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
  const day = tradingDateKey(now);
  const rows = await c.db.select({ s: schema.watchlist.symbol }).from(schema.watchlist).where(eq(schema.watchlist.date, day)).limit(1);

  // 당일 워치리스트가 이미 있으면(개장전 08:30 산출됨) 재시작 시 무거운 재수집 스킵 → 빠른 기동.
  // KIS 초당 한도 때문에 74종목 일봉/시간봉 재수집이 부팅을 지연·레이트리밋 폭주시키던 문제 방지.
  if (rows.length > 0) {
    logger.info({ day }, 'bootstrap: 당일 워치리스트 존재 — 재수집 스킵(빠른 기동)');
    return;
  }

  // 워치리스트가 없을 때만(첫 기동/개장 후 최초): 일봉 확보 → 섹터신호 → 워치리스트 산출.
  const dailyTargets = c.config.indexSymbol ? [...universe, c.config.indexSymbol] : universe;
  await c.collector.accumulateKisDaily(dailyTargets.map((symbol) => ({ symbol, market: 'KS' as const })), ymd(new Date(now - 20 * 86_400_000)), ymd(new Date(now)));
  await c.sectorSignal.rebuild(now).catch((err) => logger.error({ err }, 'bootstrap: sector signal 실패 — 기존 팩터로'));
  const n = await c.watchlist.rebuild(now, universe);
  logger.info({ day, watchlist: n }, 'bootstrap: 당일 워치리스트 산출');
}

async function main() {
  const c = buildContainer();

  if (c.config.runMode !== 'live') {
    logger.error({ runMode: c.config.runMode }, 'main.ts 는 live 모드 전용입니다. backtest 는 `pnpm backtest`.');
    process.exit(1);
  }
  if (!c.orderManager || !c.kis) {
    logger.error('KIS 모의투자 자격증명이 없습니다(.env 의 MOCK_KIS_* 확인). live 틱 불가.');
    process.exit(1);
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

  const scheduler = new Scheduler(
    {
      onHourlyTick: async (now) => {
        logger.info('onHourlyTick: 시작(사전수집→틱)'); // 관측
        // 틱 전 직전 시간봉 수집(장중 신선도) — 틱이 실제 평가하는 종목(워치리스트+보유)만, 최대 ~20종목.
        // 원칙: 수집은 best-effort. 절대 틱을 막지 않는다(레이트리밋으로 hang 시 타임아웃 후 그냥 진행).
        //  - 74 유니버스 폴백 금지(레이트리밋 폭탄). 대상 없으면 수집 스킵.
        try {
          const day = tradingDateKey(now);
          const wl = await c.db.select({ sym: schema.watchlist.symbol }).from(schema.watchlist).where(eq(schema.watchlist.date, day));
          const held = (await c.repos.positions.all()).map((p) => p.symbol);
          const targets = [...new Set([...wl.map((r) => r.sym), ...held])].slice(0, 20);
          if (targets.length) {
            const specs = targets.map((symbol) => ({ symbol, market: 'KS' as const }));
            await Promise.race([
              c.collector.accumulateKisHourly(specs),
              new Promise((_, rej) => setTimeout(() => rej(new Error('pre-tick collect timeout')), 25_000)),
            ]);
          }
        } catch (err) {
          logger.warn({ err: err instanceof Error ? err.message : err }, 'pre-tick hourly collect skipped/timeout — 기존 봉으로 틱 진행');
        }
        // 수집 성공/실패/타임아웃과 무관하게 틱은 항상 실행.
        logger.info('onHourlyTick: runLiveTick 호출'); // 관측
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
  logger.info({ universe: c.config.defaultUniverse, indexSymbol: c.config.indexSymbol }, 'stockbot worker running (live/paper). Ctrl+C to stop.');

  // 부팅 자가복구는 스케줄러 기동 후 백그라운드로(무거운 74종목 수집이 스케줄러 기동을 막지 않게).
  // 이게 await 였을 때 부팅이 ~30분 걸려 그동안 매시 틱을 다 놓쳤음.
  void bootstrapToday(c, Date.now())
    .then(() => logger.info('startup bootstrap complete'))
    .catch((err) => logger.error({ err }, 'startup bootstrap failed — 다음 크론에서 보정'));

  // 부팅 직후 대기 중이던 제어 명령 즉시 처리(다운타임 중 눌린 버튼).
  if (c.control) await c.control.processPending().catch((err) => logger.error({ err }, 'startup control poll failed'));

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
