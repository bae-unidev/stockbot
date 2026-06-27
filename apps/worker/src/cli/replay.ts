/**
 * 리플레이 e2e CLI: `pnpm replay <YYYY-MM-DD> [endYYYY-MM-DD] [--cash N] [--keep] [--no-watchlist]`.
 * 과거 봉으로 실제 라이브 틱 파이프라인을 가상 시계로 빠르게 돌려 런타임 테이블에 기록.
 * 예) pnpm replay 2026-06-23            (하루)
 *     pnpm replay 2026-06-22 2026-06-23 (기간)
 */
import '../bootstrap.js';
import { logger } from '../container.js';
import { runReplay } from '../replay/index.js';

/** YYYY-MM-DD(KST) → 그 날 00:00 / 23:59:59 KST epoch. */
function kstDayStart(date: string): number { return new Date(`${date}T00:00:00+09:00`).getTime(); }
function kstDayEnd(date: string): number { return new Date(`${date}T23:59:59+09:00`).getTime(); }

async function main() {
  const args = process.argv.slice(2);
  const dates = args.filter((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));
  const start = dates[0];
  if (!start) {
    logger.error('usage: pnpm replay <YYYY-MM-DD> [endYYYY-MM-DD] [--cash N] [--keep] [--no-watchlist]');
    process.exit(1);
    return;
  }
  const end = dates[1] ?? start;
  const cashArg = args[args.indexOf('--cash') + 1];
  const initialCash = args.includes('--cash') && cashArg ? Number(cashArg) : undefined;

  const r = await runReplay({
    fromTs: kstDayStart(start),
    toTs: kstDayEnd(end),
    initialCash,
    clear: !args.includes('--keep'),
    buildWatchlist: !args.includes('--no-watchlist'),
  });
  logger.info({ ...r, finalEquity: Math.round(r.finalEquity) }, `리플레이 완료 — 대시보드(/)에서 ${start}${end !== start ? `~${end}` : ''} 결과 확인`);
  process.exit(0);
}

main().catch((err) => {
  logger.error({ err }, 'replay cli failed');
  process.exit(1);
});
