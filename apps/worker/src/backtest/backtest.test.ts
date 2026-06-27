import { describe, expect, it } from 'vitest';
import { runBacktest } from './runner.js';
import { DEFAULT_STRATEGY_CONFIG, type Bar } from '@stockbot/core';

const HOUR = 3600_000;

/** 톱니파(상승-급락 반복) 60m 봉 — 평균회귀 진입/청산이 발생하도록. */
function sawtooth(symbol: string, n: number): Bar[] {
  const bars: Bar[] = [];
  const base = Date.UTC(2025, 0, 2, 0, 0, 0); // KST 09:00 근처
  let price = 1000;
  for (let i = 0; i < n; i++) {
    // 5봉 상승 후 1봉 급락 패턴
    price *= i % 6 === 5 ? 0.9 : 1.01;
    bars.push({
      symbol,
      timeframe: '60m',
      ts: base + i * HOUR,
      open: price,
      high: price * 1.005,
      low: price * 0.995,
      close: price,
      volume: 10000,
      adjusted: true,
      source: 'test',
    });
  }
  return bars;
}

describe('runBacktest', () => {
  it('runs end-to-end and produces an equity curve + metrics', async () => {
    const bars = sawtooth('005930', 120);
    const result = await runBacktest({
      bars,
      config: { ...DEFAULT_STRATEGY_CONFIG, watchlistSize: 5, minTradingValue: 0 },
      initialCash: 10_000_000,
    });
    expect(result.equityCurve.length).toBeGreaterThan(0);
    expect(Number.isFinite(result.metrics.totalReturn)).toBe(true);
    expect(result.metrics.maxDrawdown).toBeGreaterThanOrEqual(0);
  });

  it('is deterministic: same input → same result (9장)', async () => {
    const bars = sawtooth('005930', 120);
    const cfg = { ...DEFAULT_STRATEGY_CONFIG, minTradingValue: 0 };
    const a = await runBacktest({ bars, config: cfg, initialCash: 10_000_000 });
    const b = await runBacktest({ bars, config: cfg, initialCash: 10_000_000 });
    expect(a.metrics).toEqual(b.metrics);
    expect(a.trades.length).toEqual(b.trades.length);
  });
});
