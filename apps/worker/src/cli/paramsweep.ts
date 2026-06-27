/**
 * 범용 단일 파라미터 스윕: `pnpm paramsweep <param> <v1> <v2> ... [-- symbols...]`.
 * 예) pnpm paramsweep hardStopPct 0.05 0.07 0.1 0.15
 * 다른 파라미터는 고정하고 지정한 숫자 파라미터만 바꿔 백테스트 비교.
 */
import '../bootstrap.js';
import { buildContainer, logger } from '../container.js';
import { runBacktest } from '../backtest/runner.js';
import { loadBars, loadEventScores } from '../backtest/data.js';
import { DEFAULT_STRATEGY_CONFIG, type StrategyConfig } from '@stockbot/core';

async function main() {
  const argv = process.argv.slice(2);
  const param = argv[0] as keyof StrategyConfig;
  if (!param || !(param in DEFAULT_STRATEGY_CONFIG) || typeof DEFAULT_STRATEGY_CONFIG[param] !== 'number') {
    logger.error('usage: pnpm paramsweep <numericParam> <v1> <v2> ... [symbols...]');
    process.exit(1);
  }
  const values: number[] = [];
  const symbols: string[] = [];
  for (const a of argv.slice(1)) {
    if (/^\d{6}$/.test(a)) symbols.push(a);
    else if (!Number.isNaN(Number(a))) values.push(Number(a));
  }
  if (values.length === 0) {
    logger.error('값을 하나 이상 지정하세요');
    process.exit(1);
  }

  const c = buildContainer();
  const universe = (symbols.length ? symbols : c.config.defaultUniverse).filter((s) => !c.config.blacklist.includes(s));
  const bars = await loadBars(c.db, universe, '60m');
  if (bars.length === 0) {
    logger.error('60m 봉 없음 — 먼저 backfill-yahoo');
    await c.shutdown();
    process.exit(1);
  }
  const allSymbols = [...new Set(bars.map((b) => b.symbol))];
  const eventScores = await loadEventScores(c.db, allSymbols, bars[bars.length - 1]!.ts);
  const indexDailyBars = c.config.indexSymbol ? await loadBars(c.db, [c.config.indexSymbol], 'D') : undefined;
  const base: StrategyConfig = { ...c.config.strategy, minTradingValue: 0 };
  const current = base[param];

  console.log(`\n=== ${param} 비교 (현재값 ${current}, 다른 파라미터 고정) ===`);
  for (const v of values) {
    const r = await runBacktest({ bars, indexDailyBars, eventScores, config: { ...base, [param]: v }, initialCash: 10_000_000 });
    const m = r.metrics;
    const mark = v === current ? ' ← 현재' : '';
    console.log(`  ${param}=${v}\t수익률 ${(m.totalReturn * 100).toFixed(2)}%  MDD ${(m.maxDrawdown * 100).toFixed(2)}%  샤프 ${m.sharpe.toFixed(2)}  (${m.numTrades}거래)${mark}`);
  }
  console.log('');
  await c.shutdown();
}

main().catch((err) => {
  logger.error({ err }, 'paramsweep failed');
  process.exit(1);
});
