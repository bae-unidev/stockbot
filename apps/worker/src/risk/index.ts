/**
 * Risk Guard 런타임(5장·6장): core 의 순수 applyRiskGuard 에 상태(일일손실·킬스위치)를 공급하고,
 * 결과를 risk_state 에 반영한다. 일일 손실 한도 초과 시 당일 중단(킬스위치).
 */
import { applyRiskGuard, type OrderIntent, type Portfolio, type RiskLimits, type RiskVerdict } from '@stockbot/core';
import { tradingDateKey } from '../market/calendar.js';
import type { RiskStateRepo } from '../db/repositories.js';
import type { Notifier } from '../notifier/index.js';
import type { Logger } from '../logger.js';

export class RiskService {
  constructor(
    private readonly repo: RiskStateRepo,
    private readonly limits: RiskLimits,
    private readonly notifier: Notifier,
    private readonly logger: Logger,
  ) {}

  /** 장 시작 시 1회: 당일 기준 자산(startEquity) 고정. */
  async startDay(asOf: number, equity: number): Promise<void> {
    const date = tradingDateKey(asOf);
    const existing = await this.repo.get(date);
    if (!existing || existing.startEquity == null) {
      await this.repo.upsert(date, { startEquity: equity, dailyLossPct: 0, killSwitch: false });
      this.logger.info({ date, startEquity: equity }, 'risk: day started');
    }
  }

  /** 현재 자산으로 일일 손실률 갱신. 한도 초과 시 킬스위치 발동. */
  async updateDailyLoss(asOf: number, equity: number): Promise<{ dailyLossPct: number; killSwitch: boolean }> {
    const date = tradingDateKey(asOf);
    const state = await this.repo.get(date);
    const startEquity = state?.startEquity ?? equity;
    const dailyLossPct = startEquity > 0 ? Math.max(0, (startEquity - equity) / startEquity) : 0;
    let killSwitch = state?.killSwitch ?? false;
    if (!killSwitch && dailyLossPct >= this.limits.dailyLossLimitPct) {
      killSwitch = true;
      await this.notifier.notify('critical', 'Kill switch tripped: daily loss limit', { date, dailyLossPct, limit: this.limits.dailyLossLimitPct });
    }
    await this.repo.upsert(date, { dailyLossPct, killSwitch });
    return { dailyLossPct, killSwitch };
  }

  /** 킬스위치 수동 토글(대시보드 제어). on=당일 신규매수 차단, off=해제. */
  async setKillSwitch(asOf: number, on: boolean): Promise<void> {
    const date = tradingDateKey(asOf);
    await this.repo.upsert(date, { killSwitch: on });
    this.logger.warn({ date, killSwitch: on }, on ? 'kill switch ENABLED (manual)' : 'kill switch released (manual)');
    await this.notifier.notify(on ? 'critical' : 'warn', on ? 'Kill switch enabled (manual)' : 'Kill switch released (manual)', { date });
  }

  /** 주문 의도에 리스크 규칙 적용(주문 직전 강제 검사). */
  async guard(
    asOf: number,
    intents: OrderIntent[],
    portfolio: Portfolio,
    priceOf: (s: string) => number | undefined,
  ): Promise<RiskVerdict> {
    const date = tradingDateKey(asOf);
    const state = await this.repo.get(date);
    const verdict = applyRiskGuard(intents, {
      portfolio,
      state: { dailyLossPct: state?.dailyLossPct ?? 0, killSwitch: state?.killSwitch ?? false },
      limits: this.limits,
      priceOf,
    });
    if (verdict.tripKillSwitch) {
      await this.repo.upsert(date, { killSwitch: true });
      await this.notifier.notify('critical', 'Kill switch tripped during guard', { date });
    }
    if (verdict.rejected.length) {
      this.logger.warn({ rejected: verdict.rejected.map((r) => ({ symbol: r.intent.symbol, reason: r.reason })) }, 'risk guard rejected intents');
    }
    return verdict;
  }
}
