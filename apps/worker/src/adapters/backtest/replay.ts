/**
 * 백테스트 가상 시계 + canonical 봉 리플레이 MarketDataPort(9장).
 * point-in-time: asOf 이하의 봉만 노출(look-ahead 금지) — live 와 동일 계약.
 */
import type { Bar, Clock, MarketDataPort, Quote, Symbol, Timeframe } from '@stockbot/core';

export class VirtualClock implements Clock {
  private ms = 0;
  now(): number {
    return this.ms;
  }
  set(ms: number): void {
    this.ms = ms;
  }
}

export class ReplayMarketData implements MarketDataPort {
  /** symbol|timeframe → 시각 오름차순 봉. */
  private readonly store = new Map<string, Bar[]>();

  constructor(bars: Bar[]) {
    for (const b of bars) {
      const key = `${b.symbol}|${b.timeframe}`;
      const arr = this.store.get(key) ?? [];
      arr.push(b);
      this.store.set(key, arr);
    }
    for (const arr of this.store.values()) arr.sort((a, b) => a.ts - b.ts);
  }

  async getBars(params: { symbol: Symbol; timeframe: Timeframe; asOf: number; limit: number }): Promise<Bar[]> {
    const arr = this.store.get(`${params.symbol}|${params.timeframe}`) ?? [];
    const eligible = arr.filter((b) => b.ts <= params.asOf);
    return eligible.slice(-params.limit);
  }

  async getQuote(symbol: Symbol, asOf: number): Promise<Quote | null> {
    // 가장 가까운 60m 봉 종가를 현재가로 사용.
    for (const tf of ['60m', 'D', '30m', '15m', '5m', '1m'] as Timeframe[]) {
      const arr = this.store.get(`${symbol}|${tf}`);
      if (!arr) continue;
      const eligible = arr.filter((b) => b.ts <= asOf);
      const last = eligible[eligible.length - 1];
      if (last) return { symbol, ts: last.ts, last: last.close };
    }
    return null;
  }

  /** 리플레이할 60m 타임스탬프 축(정렬·중복제거). */
  timeline(timeframe: Timeframe = '60m'): number[] {
    const set = new Set<number>();
    for (const [key, arr] of this.store) {
      if (key.endsWith(`|${timeframe}`)) for (const b of arr) set.add(b.ts);
    }
    return [...set].sort((a, b) => a - b);
  }
}
