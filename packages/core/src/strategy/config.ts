/** 전략 파라미터. 매직넘버 금지(16장) — 전부 여기서 기본값 정의, env/config 로 덮어쓴다. */
export interface StrategyConfig {
  // 레이어 3 — 진입/청산
  rsiPeriod: number; // RSI(2)
  rsiEntry: number; // < 10 진입
  rsiExit: number; // > 70 청산
  emaPeriod: number; // 시간봉 20-EMA
  trailingStopPct: number; // 고정 트레일링 스탑 (-3~5%). trailingMode='fixed'일 때.
  trailingMode: 'fixed' | 'atr'; // 트레일링 방식. atr=샹들리에(고점 − k×ATR)
  trailingAtrMult: number; // 샹들리에 ATR 배수 k (trailingMode='atr'일 때)
  liquidateMinutesBeforeClose: number; // 장 마감 N분 전 전량 청산
  liquidateAtClose: boolean; // false면 마감 전량청산 비활성(오버나잇 보유 허용)
  maxHoldDays: number; // 0=무제한. N>0이면 N일 이상 보유한 종목은 시간기반 강제 청산

  // 코어 stay-invested(다른 알고리즘): 투자비중이 이 값 미만이면 국면통과 종목으로 메움.
  minInvestedRatio: number; // 0.5 = 자산의 최소 50%를 항상 투자

  // 추세 눌림(pullback) 진입(별도 전략): 상승추세 종목이 EMA/VWAP까지 눌렸다 회복하는 시점 매수.
  pullbackEntry: boolean;
  pullbackLookback: number; // 눌림/추세 판정 봉 수
  pullbackBandPct: number; // 최근 저점이 EMA 위 이 비율 이내면 "EMA까지 눌림"으로 인정

  // ── 개선: 청산/사이징/리스크 (오더 전략) ──
  hardStopPct: number; // 진입가 대비 -x% 하드 스탑로스(최우선 청산)
  scaleOutFraction: number; // RSI 1차 회복 시 부분 청산 비율(0.5=절반). 0이면 전량.
  reentryCooldownBars: number; // 청산 후 같은 종목 재진입 금지 봉 수
  atrSizing: boolean; // true면 ATR 변동성 타깃 사이징, false면 고정 비중캡
  atrPeriod: number; // ATR 기간
  atrStopMult: number; // 사이징 시 스탑거리 = atrStopMult * ATR
  riskPerTradePct: number; // 거래당 리스크 = equity * 이 비율

  // 리스크 (6장)
  maxPositions: number; // 동시 보유 최대 종목 수
  perSymbolWeightCap: number; // 종목당 비중 캡 (0.10 = 10%)

  // 이벤트 veto (8장, 레이어2)
  negativeEventVetoThreshold: number; // sentiment <= 이 값이면 진입 차단

  // 레이어 1 — 워치리스트
  watchlistSize: number; // 상위 N개
  minTradingValue: number; // 유동성 필터: 일 거래대금 최소(원)
  factorWeights: {
    momentum: number;
    value: number;
    quality: number;
    event: number; // 노이즈 크므로 작게 시작
  };
}

export const DEFAULT_STRATEGY_CONFIG: StrategyConfig = {
  rsiPeriod: 2,
  // 빈도 튜닝(주 ~3회 거래 목표, 20종목 야후 백테스트 기준)으로 잡은 값.
  //    스윕 결과 0.56회/일(≈2.8회/주) + 수익률 +2.76% / MDD 1.51% 로 가장 양호.
  //    스펙(README 6장) 원값: rsiEntry 10, rsiExit 70, trailingStopPct 0.04.
  rsiEntry: 15, // 깊은 눌림에서만 진입
  rsiExit: 80, // 충분히 회복한 뒤 청산
  emaPeriod: 50, // 스윕 결과 50시간이 최고(+26.5%, 추세를 더 오래 보유)
  trailingStopPct: 0.05, // atr 계산 불가(봉 부족) 시 폴백용
  trailingMode: 'atr', // 낙폭 방어 우선 → 샹들리에 ATR. (MDD 25.8%→17.9%)
  trailingAtrMult: 3.0, // 고점 − 3×ATR
  liquidateMinutesBeforeClose: 30,
  liquidateAtClose: false, // 오버나잇 보유 허용(stay-invested 와 충돌 방지)
  maxHoldDays: 14, // 보유일수 스윕 결과 최고수익(21.3%). 0=무제한 (캡 15일 이하 중 최적)
  minInvestedRatio: 0.7, // 최소 70% 투자(현금 30%) — 샤프 1.03 로 최적

  pullbackEntry: true,
  pullbackLookback: 10,
  pullbackBandPct: 0.02,

  hardStopPct: 0.07,
  scaleOutFraction: 0.5,
  reentryCooldownBars: 3,
  atrSizing: true,
  atrPeriod: 14,
  atrStopMult: 2,
  riskPerTradePct: 0.01,

  maxPositions: 8, // 현금30%+8종목 분산 → 수익 40%·MDD 20.5%·샤프 1.03
  perSymbolWeightCap: 0.1,

  negativeEventVetoThreshold: -0.5,

  watchlistSize: 15,
  minTradingValue: 1_000_000_000, // 10억원
  factorWeights: {
    momentum: 0.35,
    value: 0.25,
    quality: 0.3,
    event: 0.1,
  },
};
