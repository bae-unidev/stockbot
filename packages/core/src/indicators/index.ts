/**
 * 지표 순수 함수 (2장·16장).
 * 라이브러리 버전차로 live/backtest 결과가 갈리는 것을 막기 위해 core 에 직접 구현한다.
 * 모든 함수는 입력 배열을 시각 오름차순(과거→현재)으로 가정한다.
 */

/** 단순이동평균. 데이터가 period 미만이면 null. */
export function sma(values: number[], period: number): number | null {
  if (period <= 0 || values.length < period) return null;
  let sum = 0;
  for (let i = values.length - period; i < values.length; i++) sum += values[i]!;
  return sum / period;
}

/**
 * 지수이동평균(전체 시리즈). 첫 EMA 는 첫 period개의 SMA 로 시드.
 * 반환: 각 입력 인덱스에 대응하는 EMA(시드 이전 구간은 null).
 */
export function emaSeries(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (period <= 0 || values.length < period) return out;
  const k = 2 / (period + 1);
  let prev = sma(values.slice(0, period), period)!;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i]! * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** 마지막 EMA 값(없으면 null). */
export function ema(values: number[], period: number): number | null {
  const s = emaSeries(values, period);
  return s.length ? s[s.length - 1]! ?? null : null;
}

/**
 * RSI — Wilder smoothing. 마지막 값 반환.
 * RSI(2) 같은 짧은 기간 평균회귀에 쓰임(6장 레이어3).
 * 데이터가 period+1 미만이면 null.
 */
export function rsi(closes: number[], period: number): number | null {
  if (period <= 0 || closes.length < period + 1) return null;
  let gain = 0;
  let loss = 0;
  // 첫 period 구간 평균 손익
  for (let i = 1; i <= period; i++) {
    const diff = closes[i]! - closes[i - 1]!;
    if (diff >= 0) gain += diff;
    else loss -= diff;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  // Wilder smoothing
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i]! - closes[i - 1]!;
    const g = diff >= 0 ? diff : 0;
    const l = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/**
 * VWAP — 당일 봉들의 거래량 가중 평균가(typical price 기준).
 * bars 는 같은 거래일의 시간봉 묶음이어야 한다(레이어2, 6장).
 */
export function vwap(bars: { high: number; low: number; close: number; volume: number }[]): number | null {
  if (bars.length === 0) return null;
  let pv = 0;
  let vol = 0;
  for (const b of bars) {
    const typical = (b.high + b.low + b.close) / 3;
    pv += typical * b.volume;
    vol += b.volume;
  }
  if (vol === 0) {
    // 거래량 0이면 typical price 단순 평균으로 폴백
    return bars.reduce((a, b) => a + (b.high + b.low + b.close) / 3, 0) / bars.length;
  }
  return pv / vol;
}

/** 표본 표준편차(n-1). */
export function stdev(values: number[]): number {
  const n = values.length;
  if (n < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1);
  return Math.sqrt(variance);
}

/** 한 값을 분포(population)에 대해 z-score 정규화. std=0이면 0. */
export function zscore(value: number, population: number[]): number {
  const n = population.length;
  if (n === 0) return 0;
  const mean = population.reduce((a, b) => a + b, 0) / n;
  const sd = stdev(population);
  if (sd === 0) return 0;
  return (value - mean) / sd;
}

/**
 * ATR(Average True Range) — Wilder smoothing. 변동성 기반 사이징/스탑에 사용.
 * bars 는 시각 오름차순. 데이터가 period+1 미만이면 null. 반환은 가격 단위.
 */
export function atr(
  bars: { high: number; low: number; close: number }[],
  period: number,
): number | null {
  if (period <= 0 || bars.length < period + 1) return null;
  const tr: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const h = bars[i]!.high;
    const l = bars[i]!.low;
    const pc = bars[i - 1]!.close;
    tr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  if (tr.length < period) return null;
  // 첫 ATR = 첫 period TR 평균, 이후 Wilder 평활.
  let prev = tr.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < tr.length; i++) {
    prev = (prev * (period - 1) + tr[i]!) / period;
  }
  return prev;
}

/**
 * 12-1 모멘텀: 12개월 전~1개월 전 수익률(최근 1개월 제외).
 * 일봉 closes 기준, 영업일 근사(약 252거래일/년, 21거래일/월).
 * 데이터 부족 시 null.
 */
export function momentum12_1(dailyCloses: number[]): number | null {
  const oneMonth = 21;
  const twelveMonths = 252;
  if (dailyCloses.length < twelveMonths + 1) return null;
  const last = dailyCloses.length - 1;
  const start = dailyCloses[last - twelveMonths]!;
  const end = dailyCloses[last - oneMonth]!;
  if (start <= 0) return null;
  return end / start - 1;
}
