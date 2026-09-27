/**
 * 주문/체결 대사 백필: `pnpm reconcile [--days N]` (기본 90일).
 * 미종결(accepted 등) 주문을 주문일자별 KIS 일별체결로 다시 조회해 상태를 전진시키고 빠진 fills 를 적재한다.
 * 워커 틱은 최근 30일만 보므로, 그보다 오래 멈춰 있던 주문을 한 번에 정리할 때 쓴다(읽기 조회 + 로컬 DB 기록만, 주문 안 냄).
 */
import '../bootstrap.js';
import { buildContainer, logger } from '../container.js';
import { tradingDateKey } from '../market/calendar.js';

async function main() {
  const argv = process.argv.slice(2);
  const i = argv.indexOf('--days');
  const lookbackDays = i >= 0 ? Number(argv[i + 1]) : 90;
  const c = buildContainer();
  if (!c.orderManager) {
    logger.error('KIS 모의투자 자격증명이 없어 주문 관리자가 비활성입니다(.env MOCK_KIS_* 확인).');
    await c.shutdown();
    process.exit(1);
  }
  const before = (await c.repos.orders.openOrders()).length;
  await c.orderManager.reconcileOrders(tradingDateKey(Date.now()).replace(/-/g, ''), { lookbackDays });
  const after = (await c.repos.orders.openOrders()).length;
  logger.info({ lookbackDays, openBefore: before, openAfter: after }, '주문 대사 백필 완료');
  await c.shutdown();
}

main().catch((err) => {
  logger.error({ err }, 'reconcile cli failed');
  process.exit(1);
});
