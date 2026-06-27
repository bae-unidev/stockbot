/**
 * 리플레이 e2e: 과거 봉 데이터로 **실제 라이브 틱 파이프라인**(runLiveTick)을 가상 시계로 빠르게 돌린다.
 *
 * 백테스트(backtest/runner.ts)는 core 엔진만 직접 호출하지만, 여기서는 OrderManager(멱등·대사·
 * 일별체결 reconcile)·RiskService(킬스위치·일손실)·repos(positions/orders/fills/tick_runs)·Redis 틱락까지
 * 라이브와 똑같이 태운다. KIS 대신 ReplayBroker(접수→다음틱 체결), 현재가/봉은 ReplayMarketData.
 * 결과는 런타임 테이블에 쌓여 대시보드가 "그 날짜의 실매매"처럼 보여준다.
 */
import type { Bar, EngineContext, Symbol } from '@stockbot/core';
import { sql as dsql } from 'drizzle-orm';
import { buildContainer, logger } from '../container.js';
import { runLiveTick, type TickDeps } from '../tick/index.js';
import { ReplayMarketData, VirtualClock } from '../adapters/backtest/replay.js';
import { ReplayBroker } from '../adapters/backtest/replay-broker.js';
import { DbEventData } from '../adapters/live/index.js';
import { OrderManager } from '../order-manager/index.js';
import { isMarketOpen, tradingDateKey } from '../market/calendar.js';
import * as s from '../db/schema.js';

export interface ReplayOptions {
  fromTs: number; // 리플레이 시작(포함)
  toTs: number; // 리플레이 끝(포함)
  initialCash?: number;
  clear?: boolean; // 시작 전 런타임 테이블 비우기(기본 true)
  buildWatchlist?: boolean; // 일자별 워치리스트 산출(기본 true)
}

/** 종목별 (ts,close) 이진탐색 현재가 — 가상 시각의 체결/평가 가격 소스. */
function priceLookup(bars: Bar[]): (asOf: number) => (sym: Symbol) => number | undefined {
  const bySym = new Map<Symbol, { ts: number; close: number }[]>();
  for (const b of bars) {
    if (b.timeframe !== '60m') continue;
    const arr = bySym.get(b.symbol) ?? [];
    arr.push({ ts: b.ts, close: b.close });
    bySym.set(b.symbol, arr);
  }
  for (const arr of bySym.values()) arr.sort((a, b) => a.ts - b.ts);
  return (asOf: number) => (sym: Symbol) => {
    const arr = bySym.get(sym);
    if (!arr?.length) return undefined;
    let lo = 0, hi = arr.length - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid]!.ts <= asOf) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans >= 0 ? arr[ans]!.close : undefined;
  };
}

export async function runReplay(opts: ReplayOptions): Promise<{ ticks: number; finalEquity: number; orders: number; fills: number }> {
  const c = buildContainer();
  const universe = c.config.defaultUniverse;
  const initialCash = opts.initialCash ?? 10_000_000;

  // 1) 봉 적재(지표 워밍업 위해 시작 이전 ~45일 버퍼). ctx.marketData 는 point-in-time ReplayMarketData.
  const warmupFrom = opts.fromTs - 45 * 86_400_000;
  const all: Bar[] = [];
  for (const sym of universe) {
    const rows = await c.repos.bars.getRange(sym, '60m', warmupFrom, opts.toTs);
    all.push(...rows);
  }
  if (all.length === 0) {
    logger.error({ from: tradingDateKey(opts.fromTs), to: tradingDateKey(opts.toTs) }, 'replay: 60m 봉 없음 — 먼저 `pnpm collect backfill-yahoo`');
    await c.shutdown();
    return { ticks: 0, finalEquity: initialCash, orders: 0, fills: 0 };
  }

  // 2) 런타임 테이블 초기화(대시보드가 이 리플레이만 보이도록). bars/symbols/fundamentals/지수일봉 보존.
  if (opts.clear !== false) {
    for (const t of [s.positions, s.orders, s.fills, s.tickRuns, s.riskState, s.watchlist, s.controlCommands]) {
      await c.db.delete(t);
    }
    logger.info('replay: 런타임 테이블 초기화 완료');
  }

  // 3) 리플레이 어댑터 + 가상 시계로 TickDeps 조립(KIS 대신 ReplayBroker).
  const clock = new VirtualClock();
  const replayMd = new ReplayMarketData(all);
  const broker = new ReplayBroker(initialCash);
  const ctx: EngineContext = {
    clock,
    marketData: replayMd,
    eventData: new DbEventData(c.repos.eventScores),
    portfolio: broker as never,
  };
  const orderManager = new OrderManager(broker, c.repos.orders, c.repos.positions, broker, logger, { now: () => clock.now() }, c.repos.fills, broker);
  const priceAt = priceLookup(all);

  const deps: TickDeps = {
    db: c.db,
    redis: c.redis,
    repos: c.repos,
    ctx,
    orderManager,
    risk: c.risk,
    notifier: c.notifier,
    config: c.config,
    logger,
    defaultUniverse: universe,
    indexSymbol: c.config.indexSymbol,
  };

  // 4) 타임라인: 적재된 60m ts 중 [from,to] ∩ 장중.
  const timeline = replayMd.timeline('60m').filter((t) => t >= opts.fromTs && t <= opts.toTs && isMarketOpen(t));
  logger.info({ from: tradingDateKey(opts.fromTs), to: tradingDateKey(opts.toTs), bars: timeline.length }, 'replay 시작');

  let lastDay = '';
  for (const ts of timeline) {
    clock.set(ts);
    broker.setClock(ts);
    broker.setPriceProvider(priceAt(ts));

    const day = tradingDateKey(ts);
    if (opts.buildWatchlist !== false && day !== lastDay) {
      lastDay = day;
      try {
        const n = await c.watchlist.rebuild(ts, universe);
        logger.info({ day, watchlist: n }, 'replay: 워치리스트 산출');
      } catch (err) {
        logger.warn({ day, err: err instanceof Error ? err.message : err }, 'replay: 워치리스트 산출 실패 — 기본 유니버스 사용');
      }
    }

    await runLiveTick(deps, ts);
  }

  const pf = await broker.getPortfolio(opts.toTs);
  const ordRows = (await c.db.execute(dsql`select count(*)::int as n from ${s.orders}`)) as unknown as Array<{ n: number }>;
  const fillRows = (await c.db.execute(dsql`select count(*)::int as n from ${s.fills}`)) as unknown as Array<{ n: number }>;
  const orders = ordRows[0]?.n ?? 0;
  const fills = fillRows[0]?.n ?? 0;
  logger.info({ ticks: timeline.length, finalEquity: Math.round(pf.equity ?? pf.cash), positions: pf.positions.length, cash: Math.round(pf.cash), orders, fills }, 'replay 완료');
  await c.shutdown();
  return { ticks: timeline.length, finalEquity: pf.equity ?? pf.cash, orders, fills };
}
