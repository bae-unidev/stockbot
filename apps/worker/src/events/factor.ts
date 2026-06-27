/**
 * event_score 팩터 집계(8장). 순수 함수.
 * - Point-in-time: 의사결정 시점(asOf)에 알 수 있던 점수만 사용(look-ahead 금지).
 * - 시간 감쇠: 반감기로 오래된 이벤트는 0 으로 수렴.
 * - 결측 = 중립(0): 뉴스 없음 ≠ 부정.
 * - confidence 가중: 확신도 낮은 점수는 작게 반영.
 * z-score 정규화는 워치리스트 단계(core/buildWatchlist)에서 다른 팩터와 함께 수행한다.
 */
import type { EventScore } from '@stockbot/core';

export interface FactorOptions {
  /** 반감기(ms). 기본 3일. */
  halfLifeMs: number;
}

export const DEFAULT_FACTOR_OPTIONS: FactorOptions = {
  halfLifeMs: 3 * 86_400_000,
};

/**
 * 한 종목의 점수들을 asOf 기준 시간감쇠·confidence 가중 평균으로 합산.
 * 점수가 없으면 null(= 워치리스트에서 중립 처리).
 */
export function aggregateEventScore(
  scores: EventScore[],
  asOf: number,
  opts: FactorOptions = DEFAULT_FACTOR_OPTIONS,
): number | null {
  const eligible = scores.filter((s) => s.publishedAt <= asOf);
  if (eligible.length === 0) return null;

  const lambda = Math.LN2 / opts.halfLifeMs;
  let weightedSum = 0;
  let weightTotal = 0;
  for (const s of eligible) {
    const ageMs = Math.max(0, asOf - s.publishedAt);
    const decay = Math.exp(-lambda * ageMs);
    const w = decay * s.confidence;
    weightedSum += s.sentiment * w;
    weightTotal += w;
  }
  if (weightTotal === 0) return 0;
  return weightedSum / weightTotal;
}
