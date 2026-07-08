/**
 * KIS REST 저수준 클라이언트: 토큰 주입, 레이트리밋 스로틀(bottleneck), 헤더 구성, hashkey.
 * 모의투자 계좌는 제한이 더 낮으므로(10장-6) 보수적 스로틀.
 */
import Bottleneck from 'bottleneck';
import { fetchWithTimeout } from './fetch.js';
import { KIS_DOMAIN } from './constants.js';
import { KisAuthError, KisError, KisRateLimitError } from './errors.js';
import type { KisTokenManager } from './token.js';
import type { KisCredentials } from '../../config/index.js';
import type { Logger } from '../../logger.js';

export interface KisRequest {
  method: 'GET' | 'POST';
  path: string;
  trId: string;
  query?: Record<string, string>;
  body?: Record<string, unknown>;
  /** 주문 등 body 변조 방지용 hashkey 필요 여부. */
  hashBody?: boolean;
}

export class KisClient {
  private readonly limiter: Bottleneck;
  private readonly domain: string;
  /** paper | prod — tr_id 선택용(KIS 전용, 어댑터 내부에서만 사용). */
  readonly env: 'paper' | 'prod';

  constructor(
    private readonly creds: KisCredentials,
    private readonly tokens: KisTokenManager,
    private readonly logger: Logger,
  ) {
    this.domain = KIS_DOMAIN[creds.env];
    this.env = creds.env;
    // 모의투자는 초당 거래건수 제한이 매우 빡빡 → 직렬화 + 최소 간격 800ms(≈초당 1.25건).
    // 너무 촘촘하면(350ms) EGW00215 rate-limit → 재시도 폭주(death spiral)로 워커가 멈춤.
    this.limiter = new Bottleneck({ minTime: 800, maxConcurrent: 1 });
  }

  /** 레이트리밋(EGW00201/429)은 백오프 후 재시도. */
  async request<T>(req: KisRequest): Promise<T> {
    const backoff = [600, 1400, 3000];
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.limiter.schedule(() => this.doRequest<T>(req));
      } catch (err) {
        if (err instanceof KisRateLimitError && attempt < backoff.length) {
          this.logger.warn({ trId: req.trId, attempt: attempt + 1 }, 'KIS rate limited — backing off');
          await new Promise((r) => setTimeout(r, backoff[attempt]!));
          continue;
        }
        throw err;
      }
    }
  }

  private async doRequest<T>(req: KisRequest): Promise<T> {
    const token = await this.tokens.getToken();
    const url = new URL(this.domain + req.path);
    if (req.query) for (const [k, v] of Object.entries(req.query)) url.searchParams.set(k, v);

    const headers: Record<string, string> = {
      'content-type': 'application/json; charset=utf-8',
      authorization: `Bearer ${token}`,
      appkey: this.creds.appKey,
      appsecret: this.creds.appSecret,
      tr_id: req.trId,
      custtype: 'P', // 개인
    };

    let body: string | undefined;
    if (req.body) {
      body = JSON.stringify(req.body);
      if (req.hashBody) headers.hashkey = await this.hashkey(req.body);
    }

    // 타임아웃 fetch: 멈춘 연결이 Bottleneck(동시 1)을 막아 모든 호출(틱 포함)을 정지시키는 것 방지.
    let res: Response;
    try {
      res = await fetchWithTimeout(url, { method: req.method, headers, body });
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new KisRateLimitError(`KIS ${req.trId} fetch timeout`, 'TIMEOUT'); // 재시도 대상
      }
      throw err;
    }
    const text = await res.text();

    if (res.status === 401 || res.status === 403) throw new KisAuthError(`${res.status}: ${text}`);

    // KIS 는 레이트리밋을 HTTP 500 + 본문 rt_cd=1 로 주기도 한다 → 상태코드보다 본문을 먼저 본다.
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* 비-JSON */
    }
    const obj = (json ?? {}) as { rt_cd?: string; msg_cd?: string; msg1?: string };
    // 레이트리밋 코드: EGW00201(접근토큰 초당), EGW00215(원장 초당 거래건수) 모두 백오프 재시도 대상.
    if (obj.msg_cd === 'EGW00201' || obj.msg_cd === 'EGW00215' || res.status === 429) {
      throw new KisRateLimitError(obj.msg1 ?? `rate limited: ${text.slice(0, 120)}`, obj.msg_cd ?? 'EGW00201');
    }
    if (!res.ok) throw new KisError(`KIS ${req.trId} HTTP ${res.status}: ${text.slice(0, 200)}`);
    if (json == null) throw new KisError(`KIS ${req.trId} non-JSON response: ${text.slice(0, 200)}`);

    // rt_cd 가 있으면 '0' 만 성공.
    if (obj.rt_cd != null && obj.rt_cd !== '0') {
      throw new KisError(`KIS ${req.trId} rt_cd=${obj.rt_cd} ${obj.msg_cd ?? ''} ${obj.msg1 ?? ''}`, obj.msg_cd);
    }
    return json as T;
  }

  /** 주문 body 의 hashkey 발급. (타임아웃 필수 — 주문 시 여기서 hang 하면 워커 프리즈) */
  private async hashkey(body: Record<string, unknown>): Promise<string> {
    const res = await fetchWithTimeout(`${this.domain}/uapi/hashkey`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json; charset=utf-8',
        appkey: this.creds.appKey,
        appsecret: this.creds.appSecret,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new KisError(`hashkey failed: ${res.status}`);
    const json = (await res.json()) as { HASH?: string };
    if (!json.HASH) throw new KisError('hashkey missing HASH');
    return json.HASH;
  }

  /** 계좌번호 분해: 8자리-2자리 → CANO / ACNT_PRDT_CD. */
  accountParts(): { cano: string; acntPrdtCd: string } {
    const raw = this.creds.account.replace('-', '');
    return { cano: raw.slice(0, 8), acntPrdtCd: raw.slice(8, 10) || '01' };
  }
}
