import { afterEach, describe, expect, it, vi } from 'vitest';
import { KisClient } from './client.js';
import { KisAmbiguousError } from './errors.js';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
const tokens = { async getToken() { return 'tok'; } } as never;
const creds = { env: 'paper', appKey: 'k', appSecret: 's', account: '12345678-01' } as never;
const abort = () => Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });

describe('KisClient timeout policy', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('does NOT retry an order POST that timed out after sending (would duplicate the order)', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
      const u = String(url);
      calls.push(u);
      if (u.endsWith('/uapi/hashkey')) return new Response(JSON.stringify({ HASH: 'h' }));
      throw abort();
    }));
    const c = new KisClient(creds, tokens, logger);
    await expect(c.request({ method: 'POST', path: '/uapi/domestic-stock/v1/trading/order-cash', trId: 'VTTC0802U', body: { a: 1 }, hashBody: true })).rejects.toBeInstanceOf(KisAmbiguousError);
    expect(calls.filter((u) => u.includes('order-cash'))).toHaveLength(1);
  });

  it('retries an idempotent GET after a timeout', async () => {
    let n = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      if (n++ === 0) throw abort();
      return new Response(JSON.stringify({ rt_cd: '0', output: [] }));
    }));
    const c = new KisClient(creds, tokens, logger);
    await expect(c.request({ method: 'GET', path: '/x', trId: 'T' })).resolves.toEqual({ rt_cd: '0', output: [] });
    expect(n).toBe(2);
  });
});
