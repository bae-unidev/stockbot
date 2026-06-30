/**
 * 섹터 신호 산출 CLI: `pnpm sectors`.
 * 네이버 주요뉴스 크롤링 → LLM 섹터 점수 → sector_signals 적재 + 강세순 출력.
 */
import '../bootstrap.js';
import { sql as dsql } from 'drizzle-orm';
import { buildContainer, logger } from '../container.js';
import { tradingDateKey } from '../market/calendar.js';
import * as s from '../db/schema.js';

async function main() {
  const c = buildContainer();
  const n = await c.sectorSignal.rebuild(Date.now());
  const date = tradingDateKey(Date.now());
  const rows = (await c.db.execute(
    dsql`select sector, score, rationale from ${s.sectorSignals} where date = ${date} order by score desc`,
  )) as unknown as Array<{ sector: string; score: number; rationale: string }>;
  // eslint-disable-next-line no-console
  console.log(`\n=== ${date} 섹터 신호 (강세순, ${n}개) ===`);
  for (const r of rows) {
    const bar = r.score > 0 ? '▲' : r.score < 0 ? '▼' : '·';
    // eslint-disable-next-line no-console
    console.log(`${bar} ${r.score >= 0 ? '+' : ''}${r.score.toFixed(2)}  ${r.sector.padEnd(12)} ${r.rationale}`);
  }
  await c.shutdown();
}
main().catch((e) => { logger.error({ e }, 'sectors cli failed'); process.exit(1); });
