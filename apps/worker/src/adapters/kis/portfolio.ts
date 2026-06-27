/**
 * KIS 잔고 조회 → 도메인 Portfolio 매핑. PortfolioPort live 구현.
 * 브로커가 진실의 원천(10장-2) — 대사는 이 결과로 수행.
 */
import { TR_ID } from './constants.js';
import { BalanceResponse } from './schemas.js';
import type { KisClient } from './client.js';
import type { Portfolio } from '@stockbot/core';

export class KisPortfolioApi {
  constructor(private readonly client: KisClient) {}

  // 한 틱 내 중복 잔고조회 방지용 짧은 캐시(대사 + 엔진이 같은 호출 공유 → 레이트리밋 절감).
  private cache: { at: number; pf: Portfolio } | null = null;
  private static readonly TTL_MS = 4000;

  async getPortfolio(): Promise<Portfolio> {
    if (this.cache && Date.now() - this.cache.at < KisPortfolioApi.TTL_MS) return this.cache.pf;
    const pf = await this.fetch();
    this.cache = { at: Date.now(), pf };
    return pf;
  }

  private async fetch(): Promise<Portfolio> {
    const { cano, acntPrdtCd } = this.client.accountParts();
    const res = await this.client.request<unknown>({
      method: 'GET',
      path: '/uapi/domestic-stock/v1/trading/inquire-balance',
      trId: TR_ID[this.client.env].balance,
      query: {
        CANO: cano,
        ACNT_PRDT_CD: acntPrdtCd,
        AFHR_FLPR_YN: 'N',
        OFL_YN: '',
        INQR_DVSN: '02',
        UNPR_DVSN: '01',
        FUND_STTL_ICLD_YN: 'N',
        FNCG_AMT_AUTO_RDPT_YN: 'N',
        PRCS_DVSN: '00',
        CTX_AREA_FK100: '',
        CTX_AREA_NK100: '',
      },
    });
    const parsed = BalanceResponse.parse(res);

    const positions = (parsed.output1 ?? [])
      .map((p) => ({ symbol: p.pdno, quantity: Number(p.hldg_qty), avgPrice: Number(p.pchs_avg_pric) }))
      .filter((p) => p.quantity > 0);

    const summary = parsed.output2?.[0];
    const cash = summary ? Number(summary.prvs_rcdl_excc_amt ?? summary.dnca_tot_amt ?? 0) : 0;
    // tot_evlu_amt(총평가금액)은 현금 포함 총자산 → 그대로 equity. (현금 중복합산 금지)
    const equity = summary?.tot_evlu_amt ? Number(summary.tot_evlu_amt) : cash;

    return { cash, positions, equity };
  }
}
