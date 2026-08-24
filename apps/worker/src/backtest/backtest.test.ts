import { describe, expect, it } from 'vitest';
import { LIVE_INTRA_BAR_STOPS, runBacktest } from './runner.js';
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

/**
 * 완만한 상승추세 + 주기적 '아래꼬리'(종가는 추세대로, 저가만 −10%) 60m 봉.
 * 시간봉 종가만 보는 엔진에는 스탑이 안 걸리지만, 봉 내부(저가)를 보는 가드에는 걸린다 —
 * 라이브에서 분단위 트레일링이 승자를 털어낸 상황을 재현하는 픽스처.
 */
function wickyUptrend(symbol: string, n: number): Bar[] {
  const bars: Bar[] = [];
  const base = Date.UTC(2025, 0, 2, 0, 0, 0);
  let price = 1000;
  for (let i = 0; i < n; i++) {
    price *= 1.005;
    const wick = i > 60 && i % 10 === 0;
    bars.push({
      symbol,
      timeframe: '60m',
      ts: base + i * HOUR,
      open: price,
      high: price * 1.005,
      low: wick ? price * 0.9 : price * 0.995,
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

  // 봉 내부 스탑 시뮬(라이브 stop-guard 대응): 아래꼬리가 있으면 trailing 켠 쪽만 청산이 발동하고,
  // LIVE 설정(trailing:'off')에서는 봉 내부 트레일링 청산이 하나도 없어야 한다.
  it('simulates intra-bar stops: wicks trigger trailing only when enabled', async () => {
    const bars = wickyUptrend('005930', 120);
    const cfg = { ...DEFAULT_STRATEGY_CONFIG, minTradingValue: 0 };
    const withTrail = await runBacktest({
      bars,
      config: cfg,
      initialCash: 10_000_000,
      intraBarStops: { hwmFromHigh: true, trailing: 'fixed', hardStop: true },
    });
    const live = await runBacktest({ bars, config: cfg, initialCash: 10_000_000, intraBarStops: LIVE_INTRA_BAR_STOPS });
    const trailCount = (r: typeof withTrail) => r.trades.filter((t) => t.reason?.startsWith('intra-bar trailing')).length;
    expect(trailCount(withTrail)).toBeGreaterThan(0);
    expect(trailCount(live)).toBe(0);
    // 봉 내부 청산은 스탑가 이하로 체결된다(종가 체결이 아님).
    const wickExit = withTrail.trades.find((t) => t.reason?.startsWith('intra-bar trailing'))!;
    const barAtExit = bars.find((b) => b.ts === wickExit.ts)!;
    expect(wickExit.price).toBeLessThan(barAtExit.close);
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
