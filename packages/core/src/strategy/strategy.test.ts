import { describe, expect, it } from 'vitest';
import { buildWatchlist, type FactorInput } from './watchlist.js';
import { runStrategyTick } from './engine.js';
import { DEFAULT_STRATEGY_CONFIG } from './config.js';
import type {
  Bar,
  EngineContext,
  EventScore,
  Portfolio,
  Quote,
  Symbol,
} from '../index.js';

describe('buildWatchlist', () => {
  it('filters illiquid names and ranks by composite score', () => {
    const inputs: FactorInput[] = [
      { symbol: 'A', tradingValue: 5e9, momentum: 0.5, pbr: 0.8, per: 5, roe: 0.2, eventScore: 0.3, sectorScore: 0.2 },
      { symbol: 'B', tradingValue: 5e9, momentum: -0.2, pbr: 3, per: 40, roe: 0.02, eventScore: -0.1, sectorScore: -0.2 },
      { symbol: 'C', tradingValue: 1e6, momentum: 0.9, pbr: 0.5, per: 3, roe: 0.4, eventScore: 0.9, sectorScore: 0.5 }, // illiquid
    ];
    const ranked = buildWatchlist(inputs, DEFAULT_STRATEGY_CONFIG);
    expect(ranked.map((r) => r.symbol)).not.toContain('C');
    expect(ranked[0]!.symbol).toBe('A');
  });
});

// ── in-memory 포트로 엔진 동작 검증 (live/backtest 공유 코드) ──
function makeCtx(opts: {
  now: number;
  bars: Record<Symbol, Bar[]>;
  portfolio: Portfolio;
  scores?: EventScore[];
}): EngineContext {
  return {
    clock: { now: () => opts.now },
    marketData: {
      async getBars({ symbol, asOf, limit }) {
        const all = (opts.bars[symbol] ?? []).filter((b) => b.ts <= asOf);
        return all.slice(-limit);
      },
      async getQuote(symbol, asOf): Promise<Quote | null> {
        const all = (opts.bars[symbol] ?? []).filter((b) => b.ts <= asOf);
        const last = all[all.length - 1];
        return last ? { symbol, ts: last.ts, last: last.close } : null;
      },
    },
    eventData: {
      async getScores({ symbols, asOf }) {
        return (opts.scores ?? []).filter((s) => symbols.includes(s.symbol) && s.publishedAt <= asOf);
      },
    },
    portfolio: { async getPortfolio() { return opts.portfolio; } },
  };
}

function bar(symbol: Symbol, ts: number, close: number): Bar {
  return { symbol, timeframe: '60m', ts, open: close, high: close * 1.01, low: close * 0.99, close, volume: 1000, adjusted: true, source: 'test' };
}

const HOUR = 3600_000;

describe('runStrategyTick', () => {
  it('liquidates all positions near close (highest priority)', async () => {
    const ctx = makeCtx({
      now: 1000 * HOUR,
      bars: {},
      portfolio: { cash: 0, positions: [{ symbol: 'A', quantity: 10, avgPrice: 100 }] },
    });
    const decision = await runStrategyTick(ctx, {
      asOf: 1000 * HOUR,
      watchlist: ['A'],
      indexAbove200dma: true,
      minutesToClose: 20,
      marks: {},
      config: { ...DEFAULT_STRATEGY_CONFIG, liquidateAtClose: true },
    });
    expect(decision.intents).toHaveLength(1);
    expect(decision.intents[0]).toMatchObject({ symbol: 'A', side: 'sell', quantity: 10 });
  });

  it('blocks all entries when index below 200dma', async () => {
    // 가격을 하락시켜 RSI(2) 낮게 → 진입 후보지만 국면 차단되어야 함.
    const base = 100 * HOUR;
    const bars = Array.from({ length: 30 }, (_, i) => bar('A', base + i * HOUR, 100 - i));
    const ctx = makeCtx({ now: base + 29 * HOUR, bars: { A: bars }, portfolio: { cash: 1_000_000, positions: [] } });
    const decision = await runStrategyTick(ctx, {
      asOf: base + 29 * HOUR,
      watchlist: ['A'],
      indexAbove200dma: false,
      minutesToClose: 240,
      marks: {},
      config: DEFAULT_STRATEGY_CONFIG,
    });
    expect(decision.intents).toHaveLength(0);
  });

  it('scales out half on first RSI recovery, then exits the rest on second', async () => {
    const base = 100 * HOUR;
    const bars = Array.from({ length: 10 }, (_, i) => bar('A', base + i * HOUR, 100 + i * 2));
    const ctx = makeCtx({ now: base + 9 * HOUR, bars: { A: bars }, portfolio: { cash: 0, positions: [{ symbol: 'A', quantity: 10, avgPrice: 100 }] } });
    const cfg = { ...DEFAULT_STRATEGY_CONFIG, scaleOutFraction: 0.5, minInvestedRatio: 0 };
    // 1차: 부분 청산(절반)
    const first = await runStrategyTick(ctx, { asOf: base + 9 * HOUR, watchlist: [], indexAbove200dma: true, minutesToClose: 240, marks: { A: { highWaterMark: 118 } }, config: cfg });
    const sell1 = first.intents.find((i) => i.side === 'sell')!;
    expect(sell1.quantity).toBe(5);
    expect(first.diagnostics['A']).toBe('exit:rsi-partial');
    // 2차: 이미 scaledOut → 전량 청산
    const ctx2 = makeCtx({ now: base + 9 * HOUR, bars: { A: bars }, portfolio: { cash: 0, positions: [{ symbol: 'A', quantity: 5, avgPrice: 100 }] } });
    const second = await runStrategyTick(ctx2, { asOf: base + 9 * HOUR, watchlist: [], indexAbove200dma: true, minutesToClose: 240, marks: { A: { highWaterMark: 118, scaledOut: true } }, config: cfg });
    expect(second.intents.find((i) => i.side === 'sell')!.quantity).toBe(5);
    expect(second.diagnostics['A']).toBe('exit:rsi');
  });

  it('enters on a trend pullback: uptrend dips to EMA then resumes', async () => {
    const base = 300 * HOUR;
    const closes = Array.from({ length: 80 }, (_, i) => 100 + i); // 우상향(EMA 상승)
    const bars = closes.map((cl, i) => bar('A', base + i * HOUR, cl));
    bars[73] = { ...bars[73]!, low: 100 }; // 최근 봉이 EMA 부근까지 꼬리(눌림)
    const now = base + 79 * HOUR;
    const ctx = makeCtx({ now, bars: { A: bars }, portfolio: { cash: 1_000_000, positions: [] } });
    const decision = await runStrategyTick(ctx, {
      asOf: now,
      watchlist: ['A'],
      indexAbove200dma: true,
      minutesToClose: 240,
      marks: {},
      config: { ...DEFAULT_STRATEGY_CONFIG, minInvestedRatio: 0 }, // 코어 top-up 배제 → pullback만 검증
    });
    expect(decision.diagnostics['A']).toBe('entry:pullback');
    expect(decision.intents.find((i) => i.side === 'buy')!.reason).toContain('pullback');
  });

  it('exits on a fixed trailing stop (high-water-mark −5%)', async () => {
    const base = 400 * HOUR;
    const bars = [130, 128, 125, 122, 120].map((c, i) => bar('A', base + i * HOUR, c));
    const now = base + 4 * HOUR;
    const ctx = makeCtx({ now, bars: { A: bars }, portfolio: { cash: 0, positions: [{ symbol: 'A', quantity: 10, avgPrice: 100 }] } });
    const decision = await runStrategyTick(ctx, {
      asOf: now, watchlist: [], indexAbove200dma: true, minutesToClose: 240,
      marks: { A: { highWaterMark: 130 } },
      config: { ...DEFAULT_STRATEGY_CONFIG, trailingMode: 'fixed', trailingStopPct: 0.05 },
    });
    expect(decision.diagnostics['A']).toBe('exit:trailing'); // 130*0.95=123.5, last 120 ≤ → 청산
  });

  it('exits on a chandelier ATR trailing stop (hwm − k×ATR)', async () => {
    const base = 500 * HOUR;
    const flat = Array.from({ length: 19 }, () => 130);
    const bars = [...flat, 115].map((c, i) => bar('A', base + i * HOUR, c)); // 평탄 후 급락
    const now = base + 19 * HOUR;
    const ctx = makeCtx({ now, bars: { A: bars }, portfolio: { cash: 0, positions: [{ symbol: 'A', quantity: 10, avgPrice: 100 }] } });
    const decision = await runStrategyTick(ctx, {
      asOf: now, watchlist: [], indexAbove200dma: true, minutesToClose: 240,
      marks: { A: { highWaterMark: 130 } },
      config: { ...DEFAULT_STRATEGY_CONFIG, trailingMode: 'atr', trailingAtrMult: 3 },
    });
    expect(decision.diagnostics['A']).toBe('exit:trailing'); // hwm130 − 3×ATR > last 115
  });

  it('triggers a hard stop-loss when price falls below entry*(1-hardStopPct)', async () => {
    const base = 100 * HOUR;
    // 평탄 후 급락: 마지막 종가가 진입가(100) 대비 -10% → 하드스탑(-7%) 발동
    const prices = [100, 100, 100, 100, 88];
    const bars = prices.map((p, i) => bar('A', base + i * HOUR, p));
    const ctx = makeCtx({ now: base + 4 * HOUR, bars: { A: bars }, portfolio: { cash: 0, positions: [{ symbol: 'A', quantity: 10, avgPrice: 100 }] } });
    const decision = await runStrategyTick(ctx, { asOf: base + 4 * HOUR, watchlist: [], indexAbove200dma: true, minutesToClose: 240, marks: { A: { highWaterMark: 100 } }, config: DEFAULT_STRATEGY_CONFIG });
    expect(decision.diagnostics['A']).toBe('exit:hardstop');
    expect(decision.intents.find((i) => i.side === 'sell')!.quantity).toBe(10);
  });

  it('core layer tops up to the minimum invested ratio without an RSI dip', async () => {
    const base = 100 * HOUR;
    // 상승 시리즈 → 가격이 VWAP·EMA 위(국면 통과)지만 RSI 높음(눌림 아님). EMA50 + 당일 다봉 위해 80봉.
    const bars = Array.from({ length: 80 }, (_, i) => bar('A', base + i * HOUR, 100 + i));
    const now = base + 79 * HOUR;
    const ctx = makeCtx({ now, bars: { A: bars }, portfolio: { cash: 1_000_000, positions: [] } });
    const decision = await runStrategyTick(ctx, {
      asOf: now,
      watchlist: ['A'],
      indexAbove200dma: true,
      minutesToClose: 240,
      marks: {},
      config: { ...DEFAULT_STRATEGY_CONFIG, minInvestedRatio: 0.5 },
    });
    const buy = decision.intents.find((i) => i.side === 'buy');
    expect(buy).toBeTruthy();
    expect(buy!.reason).toContain('core top-up');
    expect(decision.diagnostics['A']).toBe('entry:core');
  });

  it('force-exits a position held longer than maxHoldDays', async () => {
    const base = 1000 * HOUR;
    const bars = Array.from({ length: 30 }, (_, i) => bar('A', base + i * HOUR, 100 + i)); // 상승(스탑 미발동)
    const now = base + 29 * HOUR;
    const entryTs = now - 16 * 86_400_000; // 16일 전 진입
    const ctx = makeCtx({ now, bars: { A: bars }, portfolio: { cash: 0, positions: [{ symbol: 'A', quantity: 10, avgPrice: 100 }] } });
    const decision = await runStrategyTick(ctx, {
      asOf: now,
      watchlist: [],
      indexAbove200dma: true,
      minutesToClose: 240,
      marks: { A: { highWaterMark: 129, entryTs } },
      config: { ...DEFAULT_STRATEGY_CONFIG, maxHoldDays: 15 },
    });
    expect(decision.diagnostics['A']).toBe('exit:max-hold');
    expect(decision.intents.find((i) => i.side === 'sell')!.quantity).toBe(10);
  });

  it('blocks re-entry while a symbol is in cooldown', async () => {
    const base = 100 * HOUR;
    const bars = Array.from({ length: 30 }, (_, i) => bar('A', base + i * HOUR, 100 - i));
    const now = base + 29 * HOUR;
    const ctx = makeCtx({ now, bars: { A: bars }, portfolio: { cash: 1_000_000, positions: [] } });
    const decision = await runStrategyTick(ctx, { asOf: now, watchlist: ['A'], indexAbove200dma: true, minutesToClose: 240, marks: {}, cooldownUntil: { A: now + HOUR }, config: DEFAULT_STRATEGY_CONFIG });
    expect(decision.diagnostics['A']).toBe('no-entry: cooldown');
    expect(decision.intents).toHaveLength(0);
  });
});
