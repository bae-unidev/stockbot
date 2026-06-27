/** 백테스트 결과 저장(11장 데이터 모델: backtest_runs/trades/equity/metrics). */
import type { DB } from '../db/client.js';
import * as s from '../db/schema.js';
import type { BacktestResult } from './runner.js';

export async function saveBacktest(
  db: DB,
  result: BacktestResult,
  meta: { label?: string; params: unknown },
): Promise<number> {
  const runRows = await db
    .insert(s.backtestRuns)
    .values({
      label: meta.label,
      fromTs: new Date(result.from),
      toTs: new Date(result.to),
      params: meta.params as never,
    })
    .returning({ id: s.backtestRuns.id });
  const runId = runRows[0]!.id;

  if (result.trades.length) {
    await db.insert(s.backtestTrades).values(
      result.trades.map((t) => ({
        runId,
        symbol: t.symbol,
        side: t.side,
        quantity: t.quantity,
        price: t.price,
        fee: t.fee,
        tax: t.tax,
        ts: new Date(t.ts),
        reason: t.reason,
      })),
    );
  }

  for (let i = 0; i < result.equityCurve.length; i += 1000) {
    const chunk = result.equityCurve.slice(i, i + 1000);
    await db.insert(s.backtestEquity).values(chunk.map((e) => ({ runId, ts: new Date(e.ts), equity: e.equity })));
  }

  if (result.allocationCurve?.length) {
    await db.insert(s.backtestAllocation).values({ runId, series: result.allocationCurve as never });
  }

  await db.insert(s.backtestMetrics).values({
    runId,
    totalReturn: result.metrics.totalReturn,
    maxDrawdown: result.metrics.maxDrawdown,
    sharpe: result.metrics.sharpe,
    winRate: result.metrics.winRate,
    turnover: result.metrics.turnover,
    numTrades: result.metrics.numTrades,
  });

  return runId;
}
