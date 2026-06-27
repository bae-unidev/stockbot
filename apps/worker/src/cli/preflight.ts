/**
 * 모의투자 연동 사전점검: `pnpm preflight`.
 * 주문은 절대 내지 않는다(읽기 전용). DB·Redis·KIS(토큰+잔고)·데이터 준비 상태를 체크리스트로 출력.
 */
import '../bootstrap.js';
import { sql as drizzleSql } from 'drizzle-orm';
import { buildContainer, logger } from '../container.js';
import * as s from '../db/schema.js';

const OK = '✅';
const NO = '❌';
const WARN = '⚠️ ';

async function main() {
  const c = buildContainer();
  const lines: string[] = [];
  let fatal = false;

  // 1) 설정
  lines.push(`설정: RUN_MODE=${c.config.runMode}, KIS_ENV=${c.config.env.KIS_ENV} ${c.config.env.KIS_ENV === 'paper' ? OK : NO + ' (paper 여야 함)'}`);
  if (!c.config.kis) {
    lines.push(`${NO} KIS 모의투자 자격증명 없음 — .env 의 MOCK_KIS_API_KEY/SECRET/MOCK_ACCOUNT 확인`);
    fatal = true;
  } else {
    lines.push(`${OK} KIS 자격증명 로드됨 (계좌 ${c.config.kis.account})`);
  }

  // 2) DB
  try {
    await c.db.execute(drizzleSql`select 1`);
    lines.push(`${OK} Postgres 연결`);
  } catch (err) {
    lines.push(`${NO} Postgres 연결 실패: ${(err as Error).message}`);
    fatal = true;
  }

  // 3) Redis
  try {
    const pong = await c.redis.ping();
    lines.push(`${pong === 'PONG' ? OK : NO} Redis ping (${pong})`);
  } catch (err) {
    lines.push(`${NO} Redis 연결 실패: ${(err as Error).message}`);
    fatal = true;
  }

  // 4) KIS 토큰 + 잔고(읽기 전용)
  if (c.kis) {
    try {
      const pf = await c.kis.portfolio.getPortfolio();
      lines.push(`${OK} KIS 토큰 발급 + 잔고 조회 성공 (현금 ₩${Math.round(pf.cash).toLocaleString('ko-KR')}, 보유 ${pf.positions.length}종목)`);
    } catch (err) {
      lines.push(`${NO} KIS 토큰/잔고 조회 실패: ${(err as Error).message}`);
      fatal = true;
    }
  }

  // 5) 데이터 준비
  const [bars60] = await c.db.execute(drizzleSql`select count(*)::int as n from ${s.bars} where timeframe='60m'`) as unknown as [{ n: number }];
  const [fund] = await c.db.execute(drizzleSql`select count(*)::int as n from ${s.fundamentals}`) as unknown as [{ n: number }];
  lines.push(`${bars60.n > 0 ? OK : WARN} 60m 봉 ${bars60.n}행 (워치리스트/시세용)`);
  lines.push(`${fund.n > 0 ? OK : WARN} 펀더멘털 ${fund.n}행 ${fund.n === 0 ? '(밸류/퀄리티 팩터 중립 처리됨 — KIS 펀더멘털 수집 권장)' : ''}`);
  lines.push(`${c.config.indexSymbol ? OK : WARN} INDEX_SYMBOL ${c.config.indexSymbol ?? '미설정 (200일선 국면필터 비활성 → 진입 차단 안 함)'}`);
  lines.push(`${c.config.defaultUniverse.length > 0 ? OK : WARN} 유니버스 ${c.config.defaultUniverse.length}종목 (블랙리스트 ${c.config.blacklist.length}개 제외)`);

  console.log('\n=== 모의투자 연동 사전점검 ===');
  for (const l of lines) console.log('  ' + l);
  console.log(`\n${fatal ? NO + ' 치명적 항목이 있습니다 — 위 ❌를 해결 후 `pnpm tick` 하세요.' : OK + ' 핵심 점검 통과 — `pnpm tick`(단발) 또는 `pnpm dev`(스케줄러)로 시작하세요.'}\n`);

  await c.shutdown();
  process.exit(fatal ? 1 : 0);
}

main().catch((err) => {
  logger.error({ err }, 'preflight failed');
  process.exit(1);
});
