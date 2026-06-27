/**
 * live 환경 포트 구현 — core 포트(Clock/MarketData/EventData/Portfolio)를 KIS+DB 로 충족.
 *
 * 설계 메모: 시간봉/일봉 "히스토리"는 canonical 봉 저장소(DB, collector 가 KIS·야후로 적재)에서 읽고,
 * 최신 현재가(quote)는 KIS REST 에서 받는다. 둘 다 KIS 계열 소스이므로 "live=KIS" 원칙과 일치하며,
 * point-in-time(asOf 이하만 조회)으로 look-ahead 를 차단한다.
 */
import type {
  Bar,
  Clock,
  EventDataPort,
  EventScore,
  MarketDataPort,
  Portfolio,
  PortfolioPort,
  Quote,
  Symbol,
  Timeframe,
} from '@stockbot/core';
import type { BarRepo, EventScoreRepo } from '../../db/repositories.js';
import type { KisMarketDataApi } from '../kis/market-data.js';
import type { KisPortfolioApi } from '../kis/portfolio.js';
import type { Logger } from '../../logger.js';

export class SystemClock implements Clock {
  now(): number {
    return Date.now();
  }
}

export class LiveMarketData implements MarketDataPort {
  constructor(
    private readonly bars: BarRepo,
    private readonly kis: KisMarketDataApi,
    private readonly logger: Logger,
  ) {}

  async getBars(params: { symbol: Symbol; timeframe: Timeframe; asOf: number; limit: number }): Promise<Bar[]> {
    return this.bars.getBars(params.symbol, params.timeframe, params.asOf, params.limit);
  }

  async getQuote(symbol: Symbol, asOf: number): Promise<Quote | null> {
    // 과거 시점 quote 요청이면 canonical 종가로 폴백(백테스트성 조회 방어).
    if (asOf < Date.now() - 5 * 60_000) {
      const bars = await this.bars.getBars(symbol, '60m', asOf, 1);
      const b = bars[0];
      return b ? { symbol, ts: b.ts, last: b.close } : null;
    }
    try {
      return await this.kis.getQuote(symbol);
    } catch (err) {
      this.logger.warn({ err, symbol }, 'KIS quote failed, falling back to last canonical bar');
      const bars = await this.bars.getBars(symbol, '60m', asOf, 1);
      const b = bars[0];
      return b ? { symbol, ts: b.ts, last: b.close } : null;
    }
  }
}

export class LivePortfolio implements PortfolioPort {
  constructor(private readonly kis: KisPortfolioApi) {}

  async getPortfolio(_asOf: number): Promise<Portfolio> {
    return this.kis.getPortfolio();
  }
}

export class DbEventData implements EventDataPort {
  constructor(private readonly scores: EventScoreRepo) {}

  async getScores(params: { symbols: Symbol[]; asOf: number }): Promise<EventScore[]> {
    return this.scores.getScores(params.symbols, params.asOf);
  }
}
