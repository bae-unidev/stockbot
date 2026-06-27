/**
 * 통합 틱 루프(11장·15장): 대사→시세→이벤트점수→시그널→리스크→주문→기록 엔드투엔드(모의투자).
 *
 * 핵심 정합성(10장):
 *  - 틱 중복 실행 방지: Redis 락(7).
 *  - 크래시 복구/매 틱 대사: 다른 행동보다 먼저 브로커 잔고로 포지션 복원(2,4).
 *  - live/backtest 동치: 동일 core 엔진 사용. 엔진 내부 분기 없음(8).
 */
import { runStrategyTick, sma, type EngineContext, type PositionMark, type Symbol } from '@stockbot/core';
import { eq } from 'drizzle-orm';
import type Redis from 'ioredis';
import { acquireTickLock, clearCooldown, getCooldowns, setCooldown } from '../redis.js';
import { minutesToClose, tradingDateKey } from '../market/calendar.js';
import * as s from '../db/schema.js';
import type { DB } from '../db/client.js';
import type { Repos } from '../db/repositories.js';
import type { OrderManager } from '../order-manager/index.js';
import type { RiskService } from '../risk/index.js';
import type { Notifier } from '../notifier/index.js';
import type { AppConfig } from '../config/index.js';
import type { Logger } from '../logger.js';

export interface TickDeps {
  db: DB;
  redis: Redis;
  repos: Repos;
  ctx: EngineContext; // live 포트(시세/이벤트/포트폴리오/시계)
  orderManager: OrderManager;
  risk: RiskService;
  notifier: Notifier;
  config: AppConfig;
  logger: Logger;
  /** 워치리스트가 비어있을 때 사용할 기본 유니버스. */
  defaultUniverse: Symbol[];
  /** 국면 필터용 지수 심볼(일봉이 적재돼 있으면 200일선 판정). */
  indexSymbol?: Symbol;
}

const TICK_LOCK_TTL_MS = 5 * 60_000;

export async function runLiveTick(deps: TickDeps, now: number): Promise<void> {
  const { logger, redis } = deps;
  const lockKey = 'stockbot:tick:lock';
  const token = `${process.pid}:${now}`;
  const release = await acquireTickLock(redis, lockKey, TICK_LOCK_TTL_MS, token);
  if (!release) {
    logger.warn('tick skipped: another tick holds the lock');
    return;
  }

  // 틱 시작 시각 = 논리 시각(now). 라이브=실시간, 리플레이=가상 과거시각이라 대시보드가 그 날짜로 보인다.
  const tickId = await deps.repos.tickRuns.start(now);
  let intentsCount = 0;
  let ordersCount = 0;
  try {
    // 1) 대사(브로커=진실의 원천). 다른 행동보다 먼저.
    //    주문 상태머신 전진 + 체결 적재 → 포지션 잔고 대사 순.
    await deps.orderManager.reconcileOrders(tradingDateKey(now).replace(/-/g, ''));
    const pf = await deps.orderManager.reconcile();
    const equity = pf.equity ?? pf.cash;

    // 2) 리스크: 당일 기준 자산 고정 + 손실률 갱신.
    await deps.risk.startDay(now, equity);
    await deps.risk.updateDailyLoss(now, equity);

    // 3) 보유 종목 트레일링 앵커(HWM) 갱신 + marks 구성(scaledOut 포함).
    const positions = await deps.repos.positions.all();
    const heldQty = new Map(positions.map((p) => [p.symbol, p.quantity]));
    const marks: Record<Symbol, PositionMark> = {};
    for (const p of positions) {
      const quote = await deps.ctx.marketData.getQuote(p.symbol, now);
      if (quote) await deps.repos.positions.bumpHighWaterMark(p.symbol, quote.last);
      marks[p.symbol] = { highWaterMark: Math.max(p.highWaterMark ?? p.avgPrice, quote?.last ?? p.avgPrice), scaledOut: p.scaledOut, entryTs: p.entryTs ?? undefined };
    }

    // 4) 워치리스트 + 국면 + 재진입 쿨다운.
    const watchlist = await resolveWatchlist(deps, now);
    const indexAbove200dma = await resolveRegime(deps, now);
    const cooldownUntil = await getCooldowns(deps.redis, [...new Set([...watchlist, ...positions.map((p) => p.symbol)])]);

    // 5) 시그널(core 엔진 — live/backtest 공유).
    const decision = await runStrategyTick(deps.ctx, {
      asOf: now,
      watchlist,
      indexAbove200dma,
      minutesToClose: minutesToClose(now),
      marks,
      cooldownUntil,
      config: deps.config.strategy,
    });
    intentsCount = decision.intents.length;

    // 6) 리스크 가드.
    const priceCache = new Map<Symbol, number | undefined>();
    const priceOf = (sym: Symbol): number | undefined => priceCache.get(sym);
    for (const intent of decision.intents) {
      if (!priceCache.has(intent.symbol)) {
        const q = await deps.ctx.marketData.getQuote(intent.symbol, now);
        priceCache.set(intent.symbol, q?.last);
      }
    }
    const verdict = await deps.risk.guard(now, decision.intents, pf, priceOf);

    // 7) 주문(멱등). 청산 매도 우선, 그다음 매수.
    if (verdict.approved.length) {
      const result = await deps.orderManager.place(verdict.approved, tickId);
      ordersCount = result.placed.length;
      // 체결 의도에 따른 상태 갱신: 부분청산→scaled_out, 전량청산→쿨다운, 매수→쿨다운 해제.
      const cooldownMs = deps.config.strategy.reentryCooldownBars * 3600_000;
      for (const o of result.placed) {
        if (o.side === 'sell') {
          const before = heldQty.get(o.symbol) ?? 0;
          if (o.quantity < before) await deps.repos.positions.setScaledOut(o.symbol, true);
          else await setCooldown(deps.redis, o.symbol, now + cooldownMs);
        } else {
          await clearCooldown(deps.redis, o.symbol);
        }
      }
      for (const r of result.rejected) {
        await deps.notifier.notify('warn', 'order rejected', { symbol: r.intent.symbol, reason: r.reason });
      }
    }

    // 8) 기록.
    await deps.repos.tickRuns.finish(tickId, {
      status: 'ok',
      intentsCount,
      ordersCount,
      equity,
      cash: pf.cash,
      detail: { diagnostics: decision.diagnostics, indexAbove200dma, watchlist, rejected: verdict.rejected },
    });
    logger.info({ tickId, intentsCount, ordersCount, equity }, 'tick complete');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await deps.repos.tickRuns.finish(tickId, { status: 'error', intentsCount, ordersCount, error: msg });
    await deps.notifier.notify('critical', 'tick failed', { tickId, error: msg });
    logger.error({ err, tickId }, 'tick failed');
  } finally {
    await release();
  }
}

/** 오늘 워치리스트(DB) → 없으면 기본 유니버스 + 보유 종목. */
async function resolveWatchlist(deps: TickDeps, now: number): Promise<Symbol[]> {
  const date = tradingDateKey(now);
  const rows = await deps.db
    .select({ symbol: s.watchlist.symbol })
    .from(s.watchlist)
    .where(eq(s.watchlist.date, date))
    .orderBy(s.watchlist.rank);
  const fromDb = rows.map((r) => r.symbol);
  const held = (await deps.repos.positions.all()).map((p) => p.symbol);
  const base = fromDb.length ? fromDb : deps.defaultUniverse;
  const blacklist = deps.config.blacklist;
  // 진입 후보에서 블랙리스트 제외(보유 중인 블랙리스트 종목은 청산은 정상 처리됨).
  return [...new Set([...base, ...held])].filter((s) => !blacklist.includes(s));
}

/** 지수 일봉이 200일선 위인지. 데이터 부족/미설정이면 보수적으로 true(진입 차단 안 함)하되 로깅. */
async function resolveRegime(deps: TickDeps, now: number): Promise<boolean> {
  if (!deps.indexSymbol) return true;
  const bars = await deps.repos.bars.getBars(deps.indexSymbol, 'D', now, 220);
  const closes = bars.map((b) => b.close);
  const ma = sma(closes, 200);
  if (ma == null) {
    deps.logger.warn({ index: deps.indexSymbol, have: closes.length }, 'regime: <200 daily bars, defaulting to true');
    return true;
  }
  return closes[closes.length - 1]! > ma;
}
