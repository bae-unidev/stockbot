/**
 * KIS 토큰 관리(10장-5): 24h 수명, 만료시각과 함께 Redis 캐시, 만료 전 갱신, concurrency-safe.
 * KIS 는 토큰 재발급 빈도 제한이 있어 캐시가 필수다.
 */
import type Redis from 'ioredis';
import { KIS_DOMAIN } from './constants.js';
import { fetchWithTimeout } from './fetch.js';
import { TokenResponse } from './schemas.js';
import type { KisCredentials } from '../../config/index.js';
import type { Logger } from '../../logger.js';

interface CachedToken {
  accessToken: string;
  expiresAt: number; // epoch ms
}

/** 만료 N분 전이면 갱신. */
const REFRESH_MARGIN_MS = 10 * 60_000;
const LOCK_TTL_MS = 30_000;

export class KisTokenManager {
  private readonly cacheKey: string;
  private readonly lockKey: string;
  private mem: CachedToken | null = null;

  constructor(
    private readonly redis: Redis,
    private readonly creds: KisCredentials,
    private readonly logger: Logger,
  ) {
    this.cacheKey = `kis:token:${creds.env}:${creds.appKey.slice(0, 8)}`;
    this.lockKey = `${this.cacheKey}:lock`;
  }

  async getToken(): Promise<string> {
    const now = Date.now();
    if (this.mem && this.mem.expiresAt - REFRESH_MARGIN_MS > now) return this.mem.accessToken;

    const cached = await this.readCache();
    if (cached && cached.expiresAt - REFRESH_MARGIN_MS > now) {
      this.mem = cached;
      return cached.accessToken;
    }

    return this.refresh();
  }

  private async readCache(): Promise<CachedToken | null> {
    const raw = await this.redis.get(this.cacheKey);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as CachedToken;
    } catch {
      return null;
    }
  }

  /** concurrency-safe: 락을 잡은 인스턴스만 발급, 나머지는 캐시를 재확인. */
  private async refresh(): Promise<string> {
    const lockToken = `${process.pid}:${this.creds.appKey.slice(0, 4)}`;
    const gotLock = await this.redis.set(this.lockKey, lockToken, 'PX', LOCK_TTL_MS, 'NX');

    if (gotLock !== 'OK') {
      // 다른 프로세스가 갱신 중 — 잠깐 기다렸다 캐시 재확인.
      await delay(500);
      const cached = await this.readCache();
      if (cached) {
        this.mem = cached;
        return cached.accessToken;
      }
      // 그래도 없으면 직접 시도(드문 경합).
    }

    try {
      const token = await this.issue();
      this.mem = token;
      const ttlSec = Math.max(60, Math.floor((token.expiresAt - Date.now()) / 1000));
      await this.redis.set(this.cacheKey, JSON.stringify(token), 'EX', ttlSec);
      this.logger.info({ expiresAt: new Date(token.expiresAt).toISOString() }, 'KIS token issued');
      return token.accessToken;
    } finally {
      if (gotLock === 'OK') {
        await this.redis
          .eval(
            "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
            1,
            this.lockKey,
            lockToken,
          )
          .catch(() => undefined);
      }
    }
  }

  private async issue(): Promise<CachedToken> {
    const res = await fetchWithTimeout(`${KIS_DOMAIN[this.creds.env]}/oauth2/tokenP`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'client_credentials',
        appkey: this.creds.appKey,
        appsecret: this.creds.appSecret,
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`KIS token issue failed: ${res.status} ${text}`);
    }
    const parsed = TokenResponse.parse(await res.json());
    return {
      accessToken: parsed.access_token,
      expiresAt: Date.now() + parsed.expires_in * 1000,
    };
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
