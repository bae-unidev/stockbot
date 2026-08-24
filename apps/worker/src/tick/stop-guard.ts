/**
 * 인트라아워 스탑 가드(#3): 시간봉 틱 사이(최대 1시간)에 스탑을 뚫고 내려가는 위험 방어.
 * 보유 종목의 실시간 현재가를 분 단위로 확인해 **하드 스탑**(진입가 −hardStopPct) 도달 시 즉시 청산.
 *
 * ⚠️ 트레일링 스탑은 여기서 판정하지 않는다 — 시간봉 틱(엔진)에서만 판정한다.
 * 분 단위 현재가로 트레일링을 보면 봉 내부 노이즈에 전부 걸려 승자를 조기 청산한다.
 * 실측(2026-06-30~08-24 모의투자): 가드 트레일링 청산 55건 −153,732원 vs 엔진(시간봉) 트레일링
 * 청산 12건 +658,160원(승률 100%). 봉 내부 스탑을 모델링한 백테스트(2024-06~2026-08, 72종목)에서도
 * 가드 트레일링 유지 −27.8% / 하드스탑만 +39.9%. 하드스탑은 갭·급락 방어라 남긴다(비용 거의 없음).
 *
 * 메인 hourly 틱과 동일 Redis 락을 공유해 직렬화(이중 제출 방지). 빠르게 끝나고 즉시 해제.
 * 매분 시작에 브로커 잔고를 DB 로 대사(원장 동기화) → 스탑을 실잔고 기준으로 판단하고,
 * DB positions 가 사실상 실시간 미러가 되어 대시보드가 신선한 포지션을 본다. 시그널(진입)은 하지 않는다.
 */
import type { OrderIntent } from '@stockbot/core';
import { acquireTickLock, setCooldown } from '../redis.js';
import * as schema from '../db/schema.js';
import type { TickDeps } from './index.js';

const STOPGUARD_LOCK_TTL_MS = 45_000;

export async function runStopGuard(deps: TickDeps, now: number): Promise<void> {
  const { logger, redis, config } = deps;
  const release = await acquireTickLock(redis, 'stockbot:tick:lock', STOPGUARD_LOCK_TTL_MS, `stopguard:${now}`);
  if (!release) return; // 메인 틱이 진행 중 — 거기서 스탑을 처리한다.

  try {
    // 원장 동기화(매분): 브로커 잔고 → DB positions + 계좌 스냅샷(현금/총자산). 대시보드가 ≤1분 신선한
    // 실잔고를 보고, 스탑 판단도 브로커 실잔고 기준. 실패 시 기존 DB 포지션으로 진행(보호 경로 유지).
    const pf = await deps.orderManager!.reconcile().catch((err) => {
      logger.warn({ err }, 'stop guard reconcile failed — 기존 DB 포지션 사용');
      return null;
    });
    if (pf) {
      await deps.db
        .insert(schema.accountSnapshots)
        .values({ ts: new Date(now), equity: pf.equity ?? pf.cash, cash: pf.cash })
        .onConflictDoNothing();
    }

    const positions = await deps.repos.positions.all();
    if (positions.length === 0) return;

    const intents: OrderIntent[] = [];
    for (const p of positions) {
      if (p.quantity <= 0) continue;
      const quote = await deps.ctx.marketData.getQuote(p.symbol, now);
      if (!quote) continue;
      const last = quote.last;

      // 트레일링 앵커(고점)는 계속 상향 갱신한다 — 판정은 시간봉 틱의 엔진이 한다.
      // (앵커를 봉 고가/실시간 고점으로 잡는 편이 종가로 잡는 것보다 백테스트상 유리: +39.9% vs +36.3%)
      await deps.repos.positions.bumpHighWaterMark(p.symbol, last);

      const hardStop = p.avgPrice * (1 - config.strategy.hardStopPct);
      if (last <= hardStop) {
        intents.push({ symbol: p.symbol, side: 'sell', type: 'market', quantity: p.quantity, reason: `intra-hour hard stop ${hardStop.toFixed(0)} (last ${last.toFixed(0)})` });
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
