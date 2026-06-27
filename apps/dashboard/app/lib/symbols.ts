/** 종목 코드→명 조회(symbols 테이블). 서버 전용(postgres). 순수 헬퍼 nm 은 ./names 에서. */
import { sql } from './db';
export { nm } from './names';

export async function loadSymbolNames(): Promise<Record<string, string>> {
  const rows = await sql<{ code: string; name: string }[]>`select code, name from symbols`;
  const map: Record<string, string> = {};
  for (const r of rows) map[r.code] = r.name;
  return map;
}
