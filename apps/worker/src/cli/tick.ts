/**
 * 단발 live 틱 실행(15장 완료기준 검증용): `pnpm tick`.
 * 스케줄러 없이 지금 한 틱을 엔드투엔드로 돌린다(모의투자).
 */
import '../bootstrap.js';
import { buildContainer, logger } from '../container.js';
import { runLiveTick, type TickDeps } from '../tick/index.js';

async function main() {
  const c = buildContainer({ runMode: 'live' });
  if (!c.orderManager || !c.kis) {
    logger.error('KIS 모의투자 자격증명 없음 — .env 의 MOCK_KIS_* 확인');
    process.exit(1);
  }
  const deps: TickDeps = {
    db: c.db,
    redis: c.redis,
    repos: c.repos,
    ctx: c.ctx,
    orderManager: c.orderManager,
    risk: c.risk,
    notifier: c.notifier,
    config: c.config,
    logger,
    defaultUniverse: c.config.defaultUniverse,
    indexSymbol: c.config.indexSymbol,
  };
  await runLiveTick(deps, Date.now());
  await c.shutdown();
}

main().catch((err) => {
  logger.error({ err }, 'tick cli failed');
  process.exit(1);
});
