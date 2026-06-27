import { describe, expect, it } from 'vitest';
import { atr, ema, momentum12_1, rsi, sma, vwap, zscore } from './index.js';

describe('sma', () => {
  it('averages the last period values', () => {
    expect(sma([1, 2, 3, 4, 5], 5)).toBe(3);
    expect(sma([2, 4, 6], 2)).toBe(5);
  });
  it('returns null when insufficient data', () => {
    expect(sma([1, 2], 3)).toBeNull();
  });
});

describe('ema', () => {
  it('equals sma for a flat series', () => {
    expect(ema([5, 5, 5, 5, 5], 3)).toBeCloseTo(5, 6);
  });
  it('reacts to a recent spike more than sma', () => {
    const series = [5, 5, 5, 5, 5, 20];
    const e = ema(series, 3)!;
    expect(e).toBeGreaterThan(sma(series, 3)!);
  });
});

describe('rsi', () => {
  it('is 100 when only gains', () => {
    expect(rsi([1, 2, 3, 4, 5], 2)).toBe(100);
  });
  it('is low after a sharp drop (mean-reversion entry case)', () => {
    const r = rsi([10, 10, 10, 9, 8], 2)!;
    expect(r).toBeLessThan(20);
  });
  it('returns null when insufficient data', () => {
    expect(rsi([1, 2], 2)).toBeNull();
  });
});

describe('vwap', () => {
  it('weights by volume', () => {
    const v = vwap([
      { high: 10, low: 10, close: 10, volume: 1 },
      { high: 20, low: 20, close: 20, volume: 3 },
    ])!;
    expect(v).toBeCloseTo((10 * 1 + 20 * 3) / 4, 6);
  });
});

describe('zscore', () => {
  it('is 0 at the mean', () => {
    expect(zscore(3, [1, 2, 3, 4, 5])).toBeCloseTo(0, 6);
  });
  it('is positive above the mean', () => {
    expect(zscore(5, [1, 2, 3, 4, 5])).toBeGreaterThan(0);
  });
});

describe('atr', () => {
  it('returns null when insufficient data', () => {
    expect(atr([{ high: 2, low: 1, close: 1.5 }], 14)).toBeNull();
  });
  it('equals the range for constant-range bars', () => {
    const bars = Array.from({ length: 20 }, (_, i) => ({ high: 10 + i + 1, low: 10 + i, close: 10 + i + 0.5 }));
    // 연속 봉이 1.0 폭으로 +1씩 상승 → TR ≈ 1.0, ATR ≈ 1.0
    const a = atr(bars, 14)!;
    expect(a).toBeGreaterThan(0.9);
    expect(a).toBeLessThan(1.6);
  });
});

describe('momentum12_1', () => {
  it('returns null when insufficient history', () => {
    expect(momentum12_1([1, 2, 3])).toBeNull();
  });
  it('computes 12m-1m return on sufficient history', () => {
    const closes = Array.from({ length: 300 }, (_, i) => 100 + i);
    expect(momentum12_1(closes)).not.toBeNull();
  });
});
