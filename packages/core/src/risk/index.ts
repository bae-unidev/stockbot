/**
 * 리스크 규칙 — 순수 함수(주문 직전 강제 검사의 판단부, 5장 Risk Guard).
 * 상태(일일 손실 누적·킬스위치)는 런타임이 주입하고, 여기서는 통과/거부만 판단한다.
 */
import type { OrderIntent, Portfolio } from '../domain/types.js';

export interface RiskState {
  /** 당일 실현+평가 손실 누적 비율(양수=손실). */
  dailyLossPct: number;
  /** 킬스위치 발동 여부. */
  killSwitch: boolean;
}

export interface RiskLimits {
  maxPositions: number;
  perSymbolWeightCap: number;
  dailyLossLimitPct: number;
}

export interface RiskVerdict {
  approved: OrderIntent[];
  rejected: { intent: OrderIntent; reason: string }[];
  /** 이번 검사로 킬스위치를 발동해야 하면 true. */
  tripKillSwitch: boolean;
}

/**
 * 주문 의도 목록을 리스크 규칙으로 필터링한다.
 * - 킬스위치 ON 또는 일일 손실 한도 초과 → 모든 신규 매수 차단(청산 매도는 허용).
 * - 동시 보유 수 / 종목당 비중 캡 초과 매수 차단.
 */
export function applyRiskGuard(
  intents: OrderIntent[],
  ctx: { portfolio: Portfolio; state: RiskState; limits: RiskLimits; priceOf: (s: string) => number | undefined },
): RiskVerdict {
  const approved: OrderIntent[] = [];
  const rejected: { intent: OrderIntent; reason: string }[] = [];

  const equity = ctx.portfolio.equity ?? ctx.portfolio.cash;
  const heldCount = ctx.portfolio.positions.filter((p) => p.quantity > 0).length;
  const held = new Set(ctx.portfolio.positions.filter((p) => p.quantity > 0).map((p) => p.symbol));

  const lossBreached = ctx.state.dailyLossPct >= ctx.limits.dailyLossLimitPct;
  const tripKillSwitch = lossBreached && !ctx.state.killSwitch;
  const halted = ctx.state.killSwitch || lossBreached;

  let projectedNew = 0;
  for (const intent of intents) {
    // 매도(청산)는 항상 허용 — 리스크 축소 방향.
    if (intent.side === 'sell') {
      approved.push(intent);
      continue;
    }
    if (halted) {
      rejected.push({ intent, reason: 'halted: kill-switch or daily loss limit' });
      continue;
    }
    // 동시 보유 수
    const wouldHold = heldCount + projectedNew + (held.has(intent.symbol) ? 0 : 1);
    if (!held.has(intent.symbol) && wouldHold > ctx.limits.maxPositions) {
      rejected.push({ intent, reason: `max positions ${ctx.limits.maxPositions}` });
      continue;
    }
    // 종목당 비중 캡
    const price = intent.limitPrice ?? ctx.priceOf(intent.symbol);
    if (price != null && equity > 0) {
      const weight = (intent.quantity * price) / equity;
      if (weight > ctx.limits.perSymbolWeightCap + 1e-9) {
        rejected.push({ intent, reason: `weight ${(weight * 100).toFixed(1)}% > cap ${(ctx.limits.perSymbolWeightCap * 100).toFixed(0)}%` });
        continue;
      }
    }
    approved.push(intent);
    if (!held.has(intent.symbol)) projectedNew += 1;
  }

  return { approved, rejected, tripKillSwitch };
}
