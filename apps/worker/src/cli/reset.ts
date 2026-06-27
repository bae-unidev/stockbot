/**
 * 데이터 정리: `pnpm reset`.
 * 모의투자 클린 시작을 위해 런타임/백테스트 데이터를 비운다.
 * 보존: bars(시세) · symbols(종목명) · fundamentals · collector_state.
 * 삭제: positions · orders · fills · tick_runs · risk_state · control_commands · events · event_scores · watchlist · backtest_*
 */
import '../bootstrap.js';
import { buildContainer, logger } from '../container.js';
import * as s from '../db/schema.js';

async function main() {
  const c = buildContainer();
  const tables = [
    s.positions,
    s.orders,
    s.fills,
    s.tickRuns,
    s.riskState,
    s.controlCommands,
    s.eventScores,
    s.events,
    s.watchlist,
    s.backtestMetrics,
    s.backtestEquity,
    s.backtestTrades,
    s.backtestAllocation,
    s.backtestRuns,
  ];
  for (const t of tables) await c.db.delete(t);
  logger.info({ cleared: tables.length }, '런타임/백테스트 데이터 정리 완료 (bars·symbols·fundamentals 보존)');
  await c.shutdown();
}

main().catch((err) => {
  logger.error({ err }, 'reset failed');
  process.exit(1);
});
