/** 백테스트 입력 로더(공용) — backtest/sweep CLI 가 공유. */
import { and, asc, eq, inArray, lte } from 'drizzle-orm';
import type { Bar, EventScore, Timeframe } from '@stockbot/core';
import type { DB } from '../db/client.js';
import * as s from '../db/schema.js';

export async function loadBars(db: DB, symbols: string[], timeframe: Timeframe): Promise<Bar[]> {
  const rows = await db
    .select()
    .from(s.bars)
    .where(symbols.length ? and(eq(s.bars.timeframe, timeframe), inArray(s.bars.symbol, symbols)) : eq(s.bars.timeframe, timeframe))
    .orderBy(asc(s.bars.ts));
  return rows.map((r) => ({
    symbol: r.symbol,
    timeframe: r.timeframe as Timeframe,
    ts: r.ts.getTime(),
    open: r.open,
    high: r.high,
    low: r.low,
    close: r.close,
    volume: r.volume,
    adjusted: r.adjusted,
    source: r.source,
  }));
}

export async function loadEventScores(db: DB, symbols: string[], toTs: number): Promise<EventScore[]> {
  if (symbols.length === 0) return [];
  const rows = await db
    .select()
    .from(s.eventScores)
    .where(and(inArray(s.eventScores.symbol, symbols), lte(s.eventScores.publishedAt, new Date(toTs))));
  return rows.map((r) => ({
    symbol: r.symbol,
    sentiment: r.sentiment,
    eventType: r.eventType ?? 'unknown',
    confidence: r.confidence,
    publishedAt: r.publishedAt.getTime(),
    scoredAt: r.scoredAt.getTime(),
  }));
}
