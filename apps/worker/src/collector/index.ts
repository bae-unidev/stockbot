/**
 * Data Collector(5장·7장).
 * - 백필 모드: 야후 시간봉 ~2년 1회 적재(백테스트 전용).
 * - 증분 모드: 장 마감 후 KIS 당일 분봉 → 시간봉 집계 append + KIS 일봉 누적.
 * 모든 봉은 canonical 스키마로 정규화 적재(source/adjusted 태그). collector_state 로 커서 추적.
 */
import { eq, and, inArray } from 'drizzle-orm';
import type { Bar, Symbol, Timeframe } from '@stockbot/core';
import type { DB } from '../db/client.js';
import * as schema from '../db/schema.js';
import type { BarRepo } from '../db/repositories.js';
import { fetchYahooHourly, type Market } from './yahoo.js';
import { aggregateToHourly } from './aggregate.js';
import type { KisMarketDataApi } from '../adapters/kis/market-data.js';
import { tradingDateKey } from '../market/calendar.js';
import type { Logger } from '../logger.js';

export interface SymbolSpec {
  symbol: Symbol;
  market: Market;
}

export class Collector {
  constructor(
    private readonly db: DB,
    private readonly bars: BarRepo,
    private readonly logger: Logger,
    private readonly kis?: KisMarketDataApi,
  ) {}

  /** 야후 시간봉 백필(~2년). 백테스트 전용 데이터. */
  async backfillYahoo(specs: SymbolSpec[], years = 2): Promise<number> {
    const to = new Date();
    const from = new Date(to.getTime() - years * 365 * 86_400_000);
    let total = 0;
    for (let i = 0; i < specs.length; i++) {
      const spec = specs[i]!;
      // 종목 간 간격(야후 레이트리밋 회피).
      if (i > 0) await new Promise((r) => setTimeout(r, 4_000));
      const bars = await fetchYahooHourly(spec.symbol, spec.market, from, to, this.logger);
      if (bars.length) {
        const n = await this.bars.upsertMany(bars);
        await this.setCursor('yahoo', spec.symbol, '60m', bars[bars.length - 1]!.ts);
        total += n;
        this.logger.info({ symbol: spec.symbol, bars: n }, 'yahoo backfill stored');
      } else {
        this.logger.warn({ symbol: spec.symbol }, 'yahoo backfill: 0 bars');
      }
    }
    return total;
  }

  /** 야후 일봉 백필(~수년). 200일선 국면필터용 지수/프록시 시드(백테스트·신호 보조). */
  async backfillYahooDaily(specs: SymbolSpec[], years = 3): Promise<number> {
    const to = new Date();
    const from = new Date(to.getTime() - years * 365 * 86_400_000);
    let total = 0;
    for (let i = 0; i < specs.length; i++) {
      const spec = specs[i]!;
      if (i > 0) await new Promise((r) => setTimeout(r, 4_000));
      const bars = await fetchYahooHourly(spec.symbol, spec.market, from, to, this.logger, '1d', 'D');
      if (bars.length) {
        const n = await this.bars.upsertMany(bars);
        await this.setCursor('yahoo', spec.symbol, 'D', bars[bars.length - 1]!.ts);
        total += n;
        this.logger.info({ symbol: spec.symbol, bars: n }, 'yahoo daily backfill stored');
      } else {
        this.logger.warn({ symbol: spec.symbol }, 'yahoo daily backfill: 0 bars');
      }
    }
    return total;
  }

  /** KIS 일봉 누적(공식). from/to: YYYYMMDD(KST). */
  async accumulateKisDaily(specs: SymbolSpec[], from: string, to: string): Promise<number> {
    if (!this.kis) {
      this.logger.warn('KIS adapter 미주입 — 일봉 누적 스킵');
      return 0;
    }
    let total = 0;
    for (const spec of specs) {
      try {
        const bars = await this.kis.getDailyBars(spec.symbol, from, to, true);
        if (bars.length) {
          total += await this.bars.upsertMany(bars);
          await this.setCursor('kis', spec.symbol, 'D', bars[bars.length - 1]!.ts);
        }
      } catch (err) {
        this.logger.error({ err, symbol: spec.symbol }, 'KIS daily accumulate failed');
      }
    }
    return total;
  }

  /** 장 마감 후 KIS 당일 분봉 → 시간봉 집계 append(증분). */
  async accumulateKisHourly(specs: SymbolSpec[]): Promise<number> {
    if (!this.kis) {
      this.logger.warn('KIS adapter 미주입 — 시간봉 누적 스킵');
      return 0;
    }
    let total = 0;
    for (const spec of specs) {
      try {
        const minutes = await this.kis.getTodayMinuteBars(spec.symbol);
        const hourly = aggregateToHourly(minutes, spec.symbol, 'kis');
        if (hourly.length) {
          total += await this.bars.upsertMany(hourly);
          await this.setCursor('kis', spec.symbol, '60m', hourly[hourly.length - 1]!.ts);
        }
      } catch (err) {
        this.logger.error({ err, symbol: spec.symbol }, 'KIS hourly accumulate failed');
      }
    }
    return total;
  }

  /**
   * KIS 현재가 응답에서 PER/PBR/ROE(EPS/BPS 근사) 적재. 날짜키=오늘(KST).
   * 밸류/퀄리티 팩터 입력(8장). 모의계좌 키 필요.
   */
  async loadFundamentals(specs: SymbolSpec[], asOf = Date.now()): Promise<number> {
    if (!this.kis) {
      this.logger.warn('KIS adapter 미주입 — 펀더멘털 적재 스킵');
      return 0;
    }
    const date = tradingDateKey(asOf);
    let stored = 0;
    for (const spec of specs) {
      try {
        const f = await this.kis.getFundamentals(spec.symbol);
        if (!f || (f.per == null && f.pbr == null && f.roe == null)) {
          this.logger.warn({ symbol: spec.symbol }, 'fundamentals: 값 없음 — 스킵');
          continue;
        }
        await this.db
          .insert(schema.fundamentals)
          .values({ symbol: spec.symbol, date, per: f.per, pbr: f.pbr, roe: f.roe, div: null })
          .onConflictDoUpdate({
            target: [schema.fundamentals.symbol, schema.fundamentals.date],
            set: { per: f.per, pbr: f.pbr, roe: f.roe },
          });
        stored += 1;
        this.logger.info({ symbol: spec.symbol, per: f.per, pbr: f.pbr, roe: f.roe }, 'fundamentals stored');
      } catch (err) {
        this.logger.error({ err, symbol: spec.symbol }, 'KIS fundamentals load failed');
      }
    }
    return stored;
  }

  /** 특정 소스의 봉 삭제(데모/합성 데이터 정리용). 삭제 행 수는 추적하지 않음. */
  async clearBySources(sources: string[]): Promise<void> {
    if (sources.length === 0) return;
    await this.db.delete(schema.bars).where(inArray(schema.bars.source, sources));
    await this.db.delete(schema.collectorState).where(inArray(schema.collectorState.source, sources));
    this.logger.info({ sources }, 'cleared bars by source');
  }

  private async setCursor(source: string, symbol: Symbol, timeframe: Timeframe, lastTs: number): Promise<void> {
    await this.db
      .insert(schema.collectorState)
      .values({ source, symbol, timeframe, lastTs: new Date(lastTs), updatedAt: new Date() })
      .onConflictDoUpdate({
        target: [schema.collectorState.source, schema.collectorState.symbol, schema.collectorState.timeframe],
        set: { lastTs: new Date(lastTs), updatedAt: new Date() },
      });
  }

  async getCursor(source: string, symbol: Symbol, timeframe: Timeframe): Promise<number | null> {
    const rows = await this.db
      .select()
      .from(schema.collectorState)
      .where(
        and(
          eq(schema.collectorState.source, source),
          eq(schema.collectorState.symbol, symbol),
          eq(schema.collectorState.timeframe, timeframe),
        ),
      )
      .limit(1);
    return rows[0]?.lastTs ? rows[0].lastTs.getTime() : null;
  }

  /** 합성 봉 시드(데모/테스트용) — 실데이터 없이 백테스트/틱을 돌려볼 때. */
  async seedSynthetic(symbol: Symbol, hours: number): Promise<number> {
    const base = Date.now() - hours * 3600_000;
    let price = 50_000;
    const bars: Bar[] = [];
    for (let i = 0; i < hours; i++) {
      // 상승 추세 + 주기적 2봉 눌림(평균회귀 진입 조건에 부합): 9봉 주기 중 2봉 -3.5%, 그 외 +1.3%.
      const phase = i % 9;
      price *= phase === 6 || phase === 7 ? 0.965 : 1.013;
      bars.push({
        symbol,
        timeframe: '60m',
        ts: base + i * 3600_000,
        open: price,
        high: price * 1.004,
        low: price * 0.996,
        close: price,
        volume: 100_000 + i,
        adjusted: true,
        source: 'synthetic',
      });
    }
    const n = await this.bars.upsertMany(bars);
    await this.setCursor('synthetic', symbol, '60m', bars[bars.length - 1]!.ts);
    return n;
  }
}

export { aggregateToHourly };
export type { Market };
