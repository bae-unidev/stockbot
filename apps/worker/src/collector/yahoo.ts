/**
 * 야후 시간봉 백필(7장) — 비공식 API. 백테스트 전용, 근사치로 취급.
 * yahoo-finance2 v2 는 deprecated + "Too Many Requests" 빈발이라, 차트 JSON 을 직접 호출한다(7장 허용).
 * 반드시 try/catch + 에러 로깅(16장). 429 시 지수 백오프 재시도.
 */
import { z } from 'zod';
import type { Bar, Symbol, Timeframe } from '@stockbot/core';
import type { Logger } from '../logger.js';

export type Market = 'KS' | 'KQ'; // KOSPI | KOSDAQ

export function toYahooSymbol(symbol: Symbol, market: Market): string {
  return `${symbol}.${market}`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const ChartResponse = z.object({
  chart: z.object({
    error: z.unknown().nullable(),
    result: z
      .array(
        z.object({
          timestamp: z.array(z.number()).optional(),
          indicators: z.object({
            quote: z
              .array(
                z.object({
                  open: z.array(z.number().nullable()).optional(),
                  high: z.array(z.number().nullable()).optional(),
                  low: z.array(z.number().nullable()).optional(),
                  close: z.array(z.number().nullable()).optional(),
                  volume: z.array(z.number().nullable()).optional(),
                }),
              )
              .optional(),
            adjclose: z.array(z.object({ adjclose: z.array(z.number().nullable()) })).optional(),
          }),
        }),
      )
      .nullable(),
  }),
});

/**
 * 야후 60m 봉 백필(차트 JSON 직접). 최대 ~730일. 실패 시 빈 배열 + 에러 로깅.
 */
export async function fetchYahooHourly(
  symbol: Symbol,
  market: Market,
  from: Date,
  to: Date,
  logger: Logger,
  interval: '60m' | '1d' = '60m',
  timeframe: Timeframe = '60m',
): Promise<Bar[]> {
  const ySym = toYahooSymbol(symbol, market);
  const p2 = Math.floor(to.getTime() / 1000);
  // 60m 인터벌만 ~730일 한도(715일로 클램프). 일봉은 수년치 가능.
  const p1 = interval === '60m' ? Math.max(Math.floor(from.getTime() / 1000), p2 - 715 * 86_400) : Math.floor(from.getTime() / 1000);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ySym)}?period1=${p1}&period2=${p2}&interval=${interval}`;
  const backoffMs = [0, 3_000, 8_000, 18_000];

  for (let attempt = 0; attempt < backoffMs.length; attempt++) {
    if (backoffMs[attempt]) await sleep(backoffMs[attempt]!);
    try {
      const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0', accept: 'application/json' } });
      // 429/422(버스트 스로틀)/5xx 는 재시도.
      if (res.status === 429 || res.status === 422 || res.status >= 500) {
        if (attempt < backoffMs.length - 1) {
          logger.warn({ ySym, status: res.status, attempt: attempt + 1 }, 'yahoo throttled — backing off and retrying');
          continue;
        }
        throw new Error(`${res.status} (throttled)`);
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const parsed = ChartResponse.parse(await res.json());
      const r = parsed.chart.result?.[0];
      const ts = r?.timestamp;
      const q = r?.indicators.quote?.[0];
      if (!ts || !q) return [];
      const adj = r?.indicators.adjclose?.[0]?.adjclose;
      const bars: Bar[] = [];
      for (let i = 0; i < ts.length; i++) {
        const o = q.open?.[i];
        const h = q.high?.[i];
        const l = q.low?.[i];
        const c = q.close?.[i];
        if (o == null || h == null || l == null || c == null) continue;
        // 수정주가 비율로 OHLC 보정(adjclose 제공 시).
        const factor = adj?.[i] != null && c !== 0 ? adj[i]! / c : 1;
        bars.push({
          symbol,
          timeframe,
          ts: ts[i]! * 1000,
          open: o * factor,
          high: h * factor,
          low: l * factor,
          close: c * factor,
          volume: q.volume?.[i] ?? 0,
          adjusted: adj?.[i] != null,
          source: 'yahoo',
        });
      }
      return bars;
    } catch (err) {
      const is429 = err instanceof Error && /Too Many Requests|429/.test(err.message);
      if (attempt < backoffMs.length - 1 && is429) {
        logger.warn({ ySym, attempt: attempt + 1 }, 'yahoo 429 — backing off and retrying');
        continue;
      }
      logger.error({ err: err instanceof Error ? err.message : err, ySym }, 'yahoo hourly backfill failed (unofficial source) — skipping symbol');
      return [];
    }
  }
  return [];
}
