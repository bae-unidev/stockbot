/** Redis: 토큰 캐시 + 틱 중복실행 락(10장-5,7). */
import Redis from 'ioredis';

export function createRedis(url: string): Redis {
  return new Redis(url, { maxRetriesPerRequest: 3, lazyConnect: false });
}

/**
 * 틱 중복 실행 방지 락(10장-7). NX+PX 로 원자적 획득.
 * 반환된 release 를 반드시 호출(소유 토큰 일치 시에만 해제 — Lua).
 */
export async function acquireTickLock(
  redis: Redis,
  key: string,
  ttlMs: number,
  token: string,
): Promise<(() => Promise<void>) | null> {
  const ok = await redis.set(key, token, 'PX', ttlMs, 'NX');
  if (ok !== 'OK') return null;
  const release = async () => {
    // 소유자 검증 후 삭제
    await redis.eval(
      "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
      1,
      key,
      token,
    );
  };
  return release;
}

const cooldownKey = (symbol: string) => `stockbot:cooldown:${symbol}`;

/** 재진입 쿨다운 설정(자동 만료). value=재진입 가능 시각(epoch ms). */
export async function setCooldown(redis: Redis, symbol: string, untilMs: number): Promise<void> {
  const ttl = Math.max(1, untilMs - Date.now());
  await redis.set(cooldownKey(symbol), String(untilMs), 'PX', ttl);
}

export async function clearCooldown(redis: Redis, symbol: string): Promise<void> {
  await redis.del(cooldownKey(symbol));
}

/** 주어진 종목들의 재진입 가능 시각 맵(없으면 미포함). */
export async function getCooldowns(redis: Redis, symbols: string[]): Promise<Record<string, number>> {
  if (symbols.length === 0) return {};
  const vals = await redis.mget(symbols.map(cooldownKey));
  const out: Record<string, number> = {};
  symbols.forEach((sym, i) => {
    const v = vals[i];
    if (v != null) out[sym] = Number(v);
  });
  return out;
}
