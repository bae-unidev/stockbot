/**
 * 인트라아워 스탑 가드(#3): 시간봉 틱 사이(최대 1시간)에 스탑을 뚫고 내려가는 위험 방어.
 * 보유 종목의 실시간 현재가를 자주(분 단위) 확인해 하드/트레일링 스탑 도달 시 즉시 시장가 청산.
 *
 * 메인 hourly 틱과 동일 Redis 락을 공유해 직렬화(이중 제출 방지). 빠르게 끝나고 즉시 해제.
 * 매분 시작에 브로커 잔고를 DB 로 대사(원장 동기화) → 스탑을 실잔고 기준으로 판단하고,
 * DB positions 가 사실상 실시간 미러가 되어 대시보드가 신선한 포지션을 본다. 시그널(진입)은 하지 않는다.
 */
import type { OrderIntent, Symbol } from '@stockbot/core';
import { acquireTickLock, setCooldown } from '../redis.js';
import type { TickDeps } from './index.js';

const STOPGUARD_LOCK_TTL_MS = 45_000;

export async function runStopGuard(deps: TickDeps, now: number): Promise<void> {
  const { logger, redis, config } = deps;
  const release = await acquireTickLock(redis, 'stockbot:tick:lock', STOPGUARD_LOCK_TTL_MS, `stopguard:${now}`);
  if (!release) return; // 메인 틱이 진행 중 — 거기서 스탑을 처리한다.

  try {
    // 원장 동기화(매분): 브로커 잔고 → DB positions. 대시보드가 ≤1분 신선한 실잔고를 보고,
    // 스탑 판단도 브로커 실잔고 기준으로 한다. 실패 시 기존 DB 포지션으로 진행(보호 경로 유지).
    await deps.orderManager!.reconcile().catch((err) => logger.warn({ err }, 'stop guard reconcile failed — 기존 DB 포지션 사용'));

    const positions = await deps.repos.positions.all();
    if (positions.length === 0) return;

    const intents: OrderIntent[] = [];
    const heldQty = new Map<Symbol, number>();
    for (const p of positions) {
      if (p.quantity <= 0) continue;
      heldQty.set(p.symbol, p.quantity);
      const quote = await deps.ctx.marketData.getQuote(p.symbol, now);
      if (!quote) continue;
      const last = quote.last;

      // 트레일링 앵커 갱신(상향).
      await deps.repos.positions.bumpHighWaterMark(p.symbol, last);
      const hwm = Math.max(p.highWaterMark ?? p.avgPrice, last);
      const hardStop = p.avgPrice * (1 - config.strategy.hardStopPct);
      const trailStop = hwm * (1 - config.strategy.trailingStopPct);

      if (last <= hardStop) {
        intents.push({ symbol: p.symbol, side: 'sell', type: 'market', quantity: p.quantity, reason: `intra-hour hard stop ${hardStop.toFixed(0)} (last ${last.toFixed(0)})` });
      } else if (last <= trailStop) {
        intents.push({ symbol: p.symbol, side: 'sell', type: 'market', quantity: p.quantity, reason: `intra-hour trailing stop ${trailStop.toFixed(0)} (last ${last.toFixed(0)})` });
      }
    }

    if (intents.length === 0) return;

    // 분 단위 멱등키(재시도 시 중복 제출 방지).
    const minuteBucket = Math.floor(now / 60_000);
    const result = await deps.orderManager!.place(intents, `stop${minuteBucket}`);
    const cooldownMs = config.strategy.reentryCooldownBars * 3600_000;
    for (const o of result.placed) {
      await setCooldown(redis, o.symbol, now + cooldownMs);
    }
    await deps.notifier.notify('warn', 'intra-hour stop triggered', {
      liquidated: result.placed.map((o) => ({ symbol: o.symbol, qty: o.quantity })),
      rejected: result.rejected.length,
    });
    logger.warn({ count: result.placed.length }, 'intra-hour stop guard liquidated positions');
  } catch (err) {
    logger.error({ err }, 'stop guard failed');
  } finally {
    await release();
  }
}
