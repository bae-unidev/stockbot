/**
 * KIS 주문 API → 도메인 Order 매핑. OrderGateway live 구현.
 *
 * 멱등성(10장-1): KIS 자체는 clientOrderId 를 받지 않으므로, 멱등은 Order Manager 가
 * "제출 전 brokerOrderId 보유 여부"로 보장한다. 이 어댑터는 단발 제출/조회/취소만 책임진다.
 * getOrder 는 브로커 기준 상태를 돌려주되, KIS 일별주문 조회는 별도 조회키가 필요해
 * 1차에서는 brokerOrderId 매칭을 Order Manager 의 대사 단계에 위임한다.
 */
import { TR_ID } from './constants.js';
import { DailyCcldResponse, OrderResponse } from './schemas.js';
import { KisRejectedError } from './errors.js';
import type { KisClient } from './client.js';
import type { Order, Side } from '@stockbot/core';

/** 브로커 기준 주문별 누적 체결 요약(증권사 중립). KIS 필드는 어댑터 안에서만 다룸. */
export interface BrokerFill {
  brokerOrderId: string;
  symbol: string;
  side: Side;
  totalFilledQty: number;
  avgFillPrice: number;
  canceled: boolean;
}

export class KisOrderGateway {
  constructor(private readonly client: KisClient) {}

  /** 신규 주문 제출. 접수 성공 시 brokerOrderId(ODNO) 를 채워 반환. */
  async submit(order: Order): Promise<Order> {
    const { cano, acntPrdtCd } = this.client.accountParts();
    const trId = order.side === 'buy' ? TR_ID[this.client.env].buy : TR_ID[this.client.env].sell;
    // 시장가=01, 지정가=00. 시장가는 단가 0.
    const ordDvsn = order.type === 'market' ? '01' : '00';
    const ordUnpr = order.type === 'limit' && order.limitPrice != null ? String(Math.round(order.limitPrice)) : '0';

    const body = {
      CANO: cano,
      ACNT_PRDT_CD: acntPrdtCd,
      PDNO: order.symbol,
      ORD_DVSN: ordDvsn,
      ORD_QTY: String(order.quantity),
      ORD_UNPR: ordUnpr,
    };

    const res = await this.client.request<unknown>({
      method: 'POST',
      path: '/uapi/domestic-stock/v1/trading/order-cash',
      trId,
      body,
      hashBody: true,
    });
    const parsed = OrderResponse.parse(res);
    if (!parsed.output?.ODNO) {
      throw new KisRejectedError(`order accepted but no ODNO: ${parsed.msg1 ?? ''}`, parsed.msg_cd);
    }
    return {
      ...order,
      brokerOrderId: parsed.output.ODNO,
      status: 'accepted',
      updatedAt: Date.now(),
    };
  }

  /**
   * 브로커 기준 주문 상태 조회. KIS 일별주문체결 조회는 추가 파라미터가 필요하므로,
   * 1차에서는 Order Manager 가 잔고/체결 대사로 상태를 갱신한다(브로커=진실의 원천).
   * 여기서는 호출부 계약을 만족시키기 위해 null 을 반환(상태 미확정).
   */
  async getOrder(_clientOrderId: string): Promise<Order | null> {
    return null;
  }

  async cancel(_clientOrderId: string): Promise<Order> {
    // 1차 전략은 시장가 위주라 취소 경로를 거의 쓰지 않는다. 미구현 명시.
    throw new KisRejectedError('KIS cancel not implemented in phase 1 (market orders only)');
  }

  /**
   * 일별 주문체결 조회 → 주문별 누적 체결 요약(대사·체결 적재용, 10장-2,3).
   * from/to: YYYYMMDD(KST). Order Manager 가 이 결과로 상태머신을 전진시키고 fills 를 적재한다.
   */
  async inquireDailyFills(from: string, to: string): Promise<BrokerFill[]> {
    const { cano, acntPrdtCd } = this.client.accountParts();
    const res = await this.client.request<unknown>({
      method: 'GET',
      path: '/uapi/domestic-stock/v1/trading/inquire-daily-ccld',
      trId: TR_ID[this.client.env].orderList,
      query: {
        CANO: cano,
        ACNT_PRDT_CD: acntPrdtCd,
        INQR_STRT_DT: from,
        INQR_END_DT: to,
        SLL_BUY_DVSN_CD: '00',
        INQR_DVSN: '00',
        PDNO: '',
        CCLD_DVSN: '00',
        ORD_GNO_BRNO: '',
        ODNO: '',
        INQR_DVSN_3: '00',
        INQR_DVSN_1: '',
        CTX_AREA_FK100: '',
        CTX_AREA_NK100: '',
      },
    });
    const parsed = DailyCcldResponse.parse(res);
    return (parsed.output1 ?? []).map<BrokerFill>((o) => {
      const qty = Number(o.tot_ccld_qty ?? 0);
      const amt = Number(o.tot_ccld_amt ?? 0);
      const avg = qty > 0 && amt > 0 ? amt / qty : Number(o.avg_prvs ?? 0);
      return {
        brokerOrderId: o.odno,
        symbol: o.pdno,
        side: o.sll_buy_dvsn_cd === '01' ? 'sell' : 'buy',
        totalFilledQty: qty,
        avgFillPrice: avg,
        canceled: o.cncl_yn === 'Y',
      };
    });
  }
}
