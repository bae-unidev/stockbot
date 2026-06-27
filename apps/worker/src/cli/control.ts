/**
 * 제어 명령 큐 1회 드레인: `pnpm control`.
 * 스케줄러(`pnpm dev`)가 떠 있으면 10초마다 자동 처리되지만,
 * 워커가 안 떠 있을 때 대기 중인 정리/킬스위치 명령을 수동으로 즉시 실행/정리하는 용도.
 * 장 운영시간 판정은 ControlService 내부에서 수행(장외면 청산 보류/skipped).
 */
import '../bootstrap.js';
import { buildContainer, logger } from '../container.js';

async function main() {
  const c = buildContainer();
  if (!c.control) {
    logger.error('KIS 모의투자 자격증명이 없어 제어 서비스가 비활성입니다(.env MOCK_KIS_* 확인).');
    await c.shutdown();
    process.exit(1);
  }
  const handled = await c.control.processPending(Date.now());
  logger.info({ handled }, handled ? '제어 명령 처리 완료' : '대기 중 명령 없음');
  await c.shutdown();
}

main().catch((err) => {
  logger.error({ err }, 'control cli failed');
  process.exit(1);
});
