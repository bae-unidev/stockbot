/**
 * 백테스트 CLI(12장): `pnpm backtest [--cash N] [--label X] [symbols...]`.
 * DB 의 canonical 60m 봉을 core 엔진에 리플레이 → 결과를 backtest_* 테이블에 저장.
 */
import '../bootstrap.js';
import { buildContainer, logger } from '../container.js';
import { runBacktest, type BacktestResult } from '../backtest/runner.js';
import { saveBacktest } from '../backtest/persist.js';
import { loadBars, loadEventScores } from '../backtest/data.js';

function parseArgs() {
  const argv = process.argv.slice(2);
  let cash = 10_000_000;
  let label: string | undefined;
  let compareEvents = false;
  const symbols: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--cash') cash = Number(argv[++i]);
    else if (argv[i] === '--label') label = argv[++i];
    else if (argv[i] === '--compare-events') compareEvents = true;
    else symbols.push(argv[i]!);
  }
  return { cash, label, compareEvents, symbols };
}

function summary(runId: number, label: string, r: BacktestResult): string {
  const m = r.metrics;
  return (
    `=== #${runId} ${label} ===\n` +
    `기간: ${new Date(r.from).toISOString().slice(0, 10)} ~ ${new Date(r.to).toISOString().slice(0, 10)}  | ` +
    `총수익률 ${(m.totalReturn * 100).toFixed(2)}%  MDD ${(m.maxDrawdown * 100).toFixed(2)}%  ` +
    `샤프 ${m.sharpe.toFixed(2)}  승률 ${(m.winRate * 100).toFixed(1)}%  거래 ${m.numTrades}  턴오버 ${m.turnover.toFixed(2)}x`
  );
}

async function main() {
  const { cash, label, compareEvents, symbols } = parseArgs();
  const c = buildContainer();
  const universe = (symbols.length ? symbols : c.config.defaultUniverse).filter((s) => !c.config.blacklist.includes(s));

  const bars = await loadBars(c.db, universe.length ? universe : [], '60m');
  if (bars.length === 0) {
    logger.error('60m canonical 봉이 없습니다. 먼저 `pnpm collect backfill-yahoo` 또는 `pnpm collect seed` 실행.');
    await c.shutdown();
    process.exit(1);
  }
  const indexDailyBars = c.config.indexSymbol ? await loadBars(c.db, [c.config.indexSymbol], 'D') : undefined;
  const allSymbols = [...new Set(bars.map((b) => b.symbol))];
  const toTs = bars[bars.length - 1]!.ts;
  const eventScores = await loadEventScores(c.db, allSymbols, toTs);
  const base = { bars, indexDailyBars, config: { ...c.config.strategy, minTradingValue: 0 }, initialCash: cash, eventScores };

  if (compareEvents) {
    // event_score 포함 vs 미포함 A/B (15장 완료기준).
    const withEv = await runBacktest({ ...base, useEventScores: true });
    const withoutEv = await runBacktest({ ...base, useEventScores: false });
    const idWith = await saveBacktest(c.db, withEv, { label: `${label ?? 'compare'} · +event_score`, params: { universe, cash, useEventScores: true } });
    const idWithout = await saveBacktest(c.db, withoutEv, { label: `${label ?? 'compare'} · -event_score`, params: { universe, cash, useEventScores: false } });
    console.log('\n' + summary(idWith, '+event_score', withEv) + '\n' + summary(idWithout, '-event_score', withoutEv) + '\n');
    logger.info({ idWith, idWithout, eventScores: eventScores.length }, 'event_score 비교 백테스트 완료');
  } else {
    const result = await runBacktest(base);
    const runId = await saveBacktest(c.db, result, { label: label ?? `backtest ${new Date().toISOString()}`, params: { strategy: c.config.strategy, cash, universe } });
    console.log('\n' + summary(runId, label ?? '', result) + '\n');
    logger.info({ runId, ...result.metrics, bars: bars.length }, 'backtest complete');
  }

  await c.shutdown();
}

main().catch((err) => {
  logger.error({ err }, 'backtest cli failed');
  process.exit(1);
});
