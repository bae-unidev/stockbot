/**
 * 워치리스트 수동 산출 CLI: `pnpm watchlist [symbols...]`.
 * 레이어1 복합팩터(모멘텀/밸류/퀄리티/event_score)로 상위 N 선정 → watchlist 테이블 적재.
 */
import '../bootstrap.js';
import { buildContainer, logger } from '../container.js';

async function main() {
  const symbols = process.argv.slice(2);
  const c = buildContainer();
  const universe = symbols.length ? symbols : c.config.defaultUniverse;
  const n = await c.watchlist.rebuild(Date.now(), universe);
  logger.info({ selected: n, candidates: universe.length }, 'watchlist 산출 완료');
  await c.shutdown();
}

main().catch((err) => {
  logger.error({ err }, 'watchlist cli failed');
  process.exit(1);
});
