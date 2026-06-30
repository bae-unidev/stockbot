/**
 * 레이어 1 — 워치리스트 (하루 1회, 개장 전). 순수 함수.
 * 유동성 필터 후 복합 팩터 z-score 가중합으로 상위 N개 선정(6장).
 */
import { zscore } from '../indicators/index.js';
import type { Symbol } from '../domain/types.js';
import type { StrategyConfig } from './config.js';

/** 한 종목의 팩터 원천 데이터(런타임이 수집해 주입). */
export interface FactorInput {
  symbol: Symbol;
  tradingValue: number; // 유동성(일 거래대금)
  momentum: number | null; // 12-1 모멘텀
  pbr: number | null; // 밸류 (낮을수록 좋음)
  per: number | null; // 밸류 (낮을수록 좋음)
  roe: number | null; // 퀄리티 (높을수록 좋음)
  eventScore: number | null; // event_score (point-in-time, 8장)
  sectorScore: number | null; // 그날 뉴스 기반 섹터 강세도 (8장 확장)
}

export interface RankedSymbol {
  symbol: Symbol;
  score: number;
  components: {
    momentum: number;
    value: number;
    quality: number;
    event: number;
    sector: number;
  };
}

/** 결측은 중립(0)으로 처리하되, z-score 모집단은 값이 있는 종목으로만 구성한다. */
function normalize(
  inputs: FactorInput[],
  pick: (f: FactorInput) => number | null,
  invert = false,
): Map<Symbol, number> {
  const present = inputs.map(pick).filter((v): v is number => v != null);
  const out = new Map<Symbol, number>();
  for (const f of inputs) {
    const raw = pick(f);
    if (raw == null) {
      out.set(f.symbol, 0); // 결측 = 중립
      continue;
    }
    const z = zscore(raw, present);
    out.set(f.symbol, invert ? -z : z);
  }
  return out;
}

export function buildWatchlist(inputs: FactorInput[], config: StrategyConfig): RankedSymbol[] {
  // 1) 유동성 필터
  const liquid = inputs.filter((f) => f.tradingValue >= config.minTradingValue);
  if (liquid.length === 0) return [];

  // 2) 각 팩터 z-score 정규화 (밸류는 낮을수록 좋으므로 invert)
  const mom = normalize(liquid, (f) => f.momentum);
  const pbrZ = normalize(liquid, (f) => f.pbr, true);
  const perZ = normalize(liquid, (f) => f.per, true);
  const value = new Map<Symbol, number>();
  for (const f of liquid) {
    value.set(f.symbol, ((pbrZ.get(f.symbol) ?? 0) + (perZ.get(f.symbol) ?? 0)) / 2);
  }
  const quality = normalize(liquid, (f) => f.roe);
  const event = normalize(liquid, (f) => f.eventScore);
  const sector = normalize(liquid, (f) => f.sectorScore);

  // 3) 가중 합산
  const w = config.factorWeights;
  const ranked: RankedSymbol[] = liquid.map((f) => {
    const components = {
      momentum: mom.get(f.symbol) ?? 0,
      value: value.get(f.symbol) ?? 0,
      quality: quality.get(f.symbol) ?? 0,
      event: event.get(f.symbol) ?? 0,
      sector: sector.get(f.symbol) ?? 0,
    };
    const score =
      components.momentum * w.momentum +
      components.value * w.value +
      components.quality * w.quality +
      components.event * w.event +
      components.sector * w.sector;
    return { symbol: f.symbol, score, components };
  });

  ranked.sort((a, b) => b.score - a.score);
  return ranked.slice(0, config.watchlistSize);
}
