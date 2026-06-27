/**
 * KIS raw 응답 zod 스키마. 흐름: raw → 이 스키마로 파싱/검증 → 도메인 타입 매핑.
 * KIS 한글약어/rt_cd 필드는 여기까지만 등장하고, 매퍼를 거쳐 도메인 타입으로만 나간다.
 */
import { z } from 'zod';

export const TokenResponse = z.object({
  access_token: z.string(),
  token_type: z.string(),
  expires_in: z.number(), // seconds (보통 86400)
});

/** 공통 응답 헤더 판단용: rt_cd '0' 이 성공. */
export const BaseResponse = z.object({
  rt_cd: z.string(),
  msg_cd: z.string().optional(),
  msg1: z.string().optional(),
});

/** 현재가 조회(inquire-price). 밸류/퀄리티 팩터용 펀더멘털도 같은 응답에 포함된다. */
export const QuoteResponse = BaseResponse.extend({
  output: z
    .object({
      stck_prpr: z.string(), // 현재가
      stck_oprc: z.string().optional(), // 시가
      acml_vol: z.string().optional(), // 누적 거래량
      acml_tr_pbmn: z.string().optional(), // 누적 거래대금
      per: z.string().optional(), // 주가수익비율
      pbr: z.string().optional(), // 주가순자산비율
      eps: z.string().optional(), // 주당순이익
      bps: z.string().optional(), // 주당순자산
    })
    .optional(),
});

const ChartRow = z.object({
  stck_bsop_date: z.string().optional(), // 일자 YYYYMMDD
  stck_cntg_hour: z.string().optional(), // 체결시간 HHMMSS (분봉)
  stck_oprc: z.string(),
  stck_hgpr: z.string(),
  stck_lwpr: z.string(),
  stck_prpr: z.string().optional(), // 분봉 현재가(종가)
  stck_clpr: z.string().optional(), // 일봉 종가
  acml_vol: z.string().optional(),
  cntg_vol: z.string().optional(), // 분봉 체결량
});

export const ChartResponse = BaseResponse.extend({
  output2: z.array(ChartRow).optional(),
});

/** 잔고 조회(inquire-balance). output1=보유종목, output2=요약. */
export const BalanceResponse = BaseResponse.extend({
  output1: z
    .array(
      z.object({
        pdno: z.string(), // 종목코드
        hldg_qty: z.string(), // 보유수량
        pchs_avg_pric: z.string(), // 매입평균가
      }),
    )
    .optional(),
  output2: z
    .array(
      z.object({
        dnca_tot_amt: z.string().optional(), // 예수금
        tot_evlu_amt: z.string().optional(), // 총평가금액
        prvs_rcdl_excc_amt: z.string().optional(), // 가용현금(D+2 예수금)
      }),
    )
    .optional(),
});

/** 주문 응답(order-cash). */
export const OrderResponse = BaseResponse.extend({
  output: z
    .object({
      KRX_FWDG_ORD_ORGNO: z.string().optional(),
      ODNO: z.string(), // 주문번호
      ORD_TMD: z.string().optional(), // 주문시각
    })
    .optional(),
});

/** 일별 주문체결 조회(inquire-daily-ccld). 주문상태 대사·체결 적재용(10장-2,3). */
export const DailyCcldResponse = BaseResponse.extend({
  output1: z
    .array(
      z.object({
        odno: z.string(), // 주문번호
        pdno: z.string(), // 종목코드
        sll_buy_dvsn_cd: z.string().optional(), // 01=매도, 02=매수
        ord_qty: z.string().optional(), // 주문수량
        tot_ccld_qty: z.string().optional(), // 총체결수량
        tot_ccld_amt: z.string().optional(), // 총체결금액
        avg_prvs: z.string().optional(), // 평균체결단가
        cncl_yn: z.string().optional(), // 취소여부 Y/N
      }),
    )
    .optional(),
});

export type ChartRowT = z.infer<typeof ChartRow>;
