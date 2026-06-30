/**
 * 레이어1 워치리스트(6장, 하루 1회 개장 전) — 런타임 배선.
 * 후보 유니버스 → 팩터(모멘텀/밸류/퀄리티/event_score) 조립 → core buildWatchlist 로 랭킹 → watchlist 테이블 적재.
 * 여기서 LLM event_score 가 복합팩터로 전략에 들어간다(8장). veto 경로는 엔진이 별도 처리.
 */
import { buildWatchlist, momentum12_1, type FactorInput, type StrategyConfig, type Symbol } from '@stockbot/core';
import { and, desc, eq, lte } from 'drizzle-orm';
import { aggregateEventScore } from '../events/factor.js';
import { sectorOf } from '../sectors.js';
import { tradingDateKey } from '../market/calendar.js';
import * as s from '../db/schema.js';
import type { DB } from '../db/client.js';
import type { BarRepo, EventScoreRepo } from '../db/repositories.js';
import type { Logger } from '../logger.js';

export class WatchlistService {
  constructor(
    private readonly db: DB,
    private readonly bars: BarRepo,
    private readonly eventScores: EventScoreRepo,
    private readonly config: StrategyConfig,
    private readonly logger: Logger,
  ) {}

  /** 후보 유니버스로 워치리스트를 산출해 당일 watchlist 테이블에 적재. 선정 종목 수 반환. */
  async rebuild(asOf: number, universe: Symbol[]): Promise<number> {
    if (universe.length === 0) {
      this.logger.warn('watchlist: 후보 유니버스 비어있음(WATCHLIST_SYMBOLS 미설정) — 스킵');
      return 0;
    }
    // 당일 섹터 신호 1회 로드(종목별 섹터 점수 매핑용).
    const date = tradingDateKey(asOf);
    const sectorRows = await this.db
      .select({ sector: s.sectorSignals.sector, score: s.sectorSignals.score })
      .from(s.sectorSignals)
      .where(eq(s.sectorSignals.date, date));
    const sectorScores = new Map(sectorRows.map((r) => [r.sector, r.score]));

    const inputs: FactorInput[] = [];
    for (const symbol of universe) {
      inputs.push(await this.factorsFor(symbol, asOf, sectorScores));
    }
    const ranked = buildWatchlist(inputs, this.config);

    await this.db.transaction(async (tx) => {
      await tx.delete(s.watchlist).where(eq(s.watchlist.date, date));
      if (ranked.length === 0) return;
      await tx.insert(s.watchlist).values(
        ranked.map((r, i) => ({ date, symbol: r.symbol, rank: i + 1, score: r.score, components: r.components })),
      );
    });
    this.logger.info({ date, candidates: universe.length, selected: ranked.length, top: ranked.slice(0, 5).map((r) => r.symbol) }, 'watchlist rebuilt');
    return ranked.length;
  }

  private async factorsFor(symbol: Symbol, asOf: number, sectorScores: Map<string, number>): Promise<FactorInput> {
    // 모멘텀: 일봉 종가.
    const dailyBars = await this.bars.getBars(symbol, 'D', asOf, 300);
    const dailyCloses = dailyBars.map((b) => b.close);
    const momentum = momentum12_1(dailyCloses);

    // 거래량 급증: 최근 2일 평균 거래량 / 직전 ~20일 평균(없거나 부족하면 null=중립).
    const vols = dailyBars.map((b) => b.volume);
    let volumeSurge: number | null = null;
    if (vols.length >= 22) {
      const recent = (vols[vols.length - 1]! + vols[vols.length - 2]!) / 2;
      const base = vols.slice(-22, -2).reduce((a, v) => a + v, 0) / 20;
      if (base > 0) volumeSurge = recent / base;
    }

    // 유동성: 최근 일봉 거래대금(close*volume) 근사. 일봉 없으면 60m 폴백.
    let tradingValue = 0;
    const lastDaily = dailyBars[dailyBars.length - 1];
    if (lastDaily) tradingValue = lastDaily.close * lastDaily.volume;
    else {
      const intraday = await this.bars.getBars(symbol, '60m', asOf, 1);
      const b = intraday[0];
      if (b) tradingValue = b.close * b.volume;
    }

    // 펀더멘털: asOf 이하 최신 1건.
    const fund = await this.db
      .select()
      .from(s.fundamentals)
      .where(and(eq(s.fundamentals.symbol, symbol), lte(s.fundamentals.date, tradingDateKey(asOf))))
      .orderBy(desc(s.fundamentals.date))
      .limit(1);
    const f = fund[0];

    // event_score: point-in-time 시간감쇠 집계(8장).
    const scores = await this.eventScores.getScores([symbol], asOf);
    const eventScore = aggregateEventScore(scores, asOf);

    // 섹터 신호: 종목 섹터 → 당일 섹터 점수(없으면 null = 중립).
    const sector = sectorOf(symbol);
    const sectorScore = sector ? sectorScores.get(sector) ?? null : null;

    return {
      symbol,
      tradingValue,
      momentum,
      pbr: f?.pbr ?? null,
      per: f?.per ?? null,
      roe: f?.roe ?? null,
      eventScore,
      sectorScore,
      volumeSurge,
    };
  }
}
