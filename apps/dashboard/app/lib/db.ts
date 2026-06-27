/**
 * 대시보드 DB 접근(읽기 전용, 13장). 워커와 같은 Postgres 를 직접 조회.
 * 자체 postgres 클라이언트로 자기완결 — 워커 런타임에 의존하지 않는다.
 */
import postgres from 'postgres';

const url =
  process.env.DATABASE_URL ?? 'postgresql://stockbot:stockbot@localhost:5432/stockbot';

// Next dev 의 HMR 에서 커넥션 누수 방지(전역 캐시).
const g = globalThis as unknown as { __sql?: ReturnType<typeof postgres> };
export const sql = g.__sql ?? postgres(url, { max: 5 });
if (process.env.NODE_ENV !== 'production') g.__sql = sql;
