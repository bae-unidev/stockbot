/**
 * 워커 엔트리포인트(11장·15장): 크래시 복구 대사 → 스케줄러 기동 → 장중 hourly 틱.
 * 순수 Node + TS 백그라운드 프로세스(웹 프레임워크 미사용, 2장).
 */
import './bootstrap.js';
import { buildContainer, logger } from './container.js';
import { Scheduler } from './scheduler/index.js';
import { runLiveTick, type TickDeps } from './tick/index.js';
import { runStopGuard } from './tick/stop-guard.js';
import { tradingDateKey } from './market/calendar.js';

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

  const scheduler = new Scheduler(
    {
      onHourlyTick: (now) => runLiveTick(tickDeps, now),
      // 매분: 인트라아워 스탑 가드(틱 사이 손절 방어).
      onStopGuard: (now) => runStopGuard(tickDeps, now),
      // 개장 전: 레이어1 워치리스트 산출(모멘텀/밸류/퀄리티/event_score 복합팩터).
      onPreOpen: async (now) => {
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
