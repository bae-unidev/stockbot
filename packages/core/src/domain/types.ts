/**
 * 증권사 중립 도메인 타입.
 *
 * 절대 규칙(4장·10장-9): KIS의 rt_cd / tr_id / 한글 약어 필드는 여기에 새어 나오지 않는다.
 * 각 어댑터가 "raw 응답 → zod 파싱 → 이 타입으로 매핑"을 내부에 가둔다.
 * 엔진·주문매니저·리스크·백테스터는 오직 이 타입만 본다.
 */

/** 종목 식별자. 코스피/코스닥 6자리 코드(예: '005930'). */
export type Symbol = string;

/** 봉 주기. canonical 저장 단위. */
export type Timeframe = 'D' | '60m' | '30m' | '15m' | '5m' | '1m';

export type Side = 'buy' | 'sell';

/** 주문 유형. 1차는 시장가/지정가만. */
export type OrderType = 'market' | 'limit';

/**
 * 주문 상태 머신 (10장-3): 제출→접수→(부분체결)→완전체결/거부/취소.
 * - new: 클라이언트가 만들었으나 아직 브로커 미제출(멱등키만 발급)
 * - submitted: 브로커에 제출됨, 접수 응답 대기
 * - accepted: 브로커 접수 확인(브로커 주문번호 확보)
 * - partially_filled: 일부 체결
 * - filled: 완전 체결
 * - rejected: 브로커 거부
 * - canceled: 취소됨
 */
export type OrderStatus =
  | 'new'
  | 'submitted'
  | 'accepted'
  | 'partially_filled'
  | 'filled'
  | 'rejected'
  | 'canceled';

/** OHLCV canonical 봉. ts 는 봉의 시작 시각(UTC epoch ms). */
export interface Bar {
  symbol: Symbol;
  timeframe: Timeframe;
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  /** 수정주가 적용 여부. 백테스트(야후)와 live(KIS) 정합성 추적용(7장). */
  adjusted: boolean;
  /** 데이터 출처 태그: 'yahoo' | 'kis' 등(7장). */
  source: string;
}

/** 실시간 호가/현재가 스냅샷. */
export interface Quote {
  symbol: Symbol;
  ts: number;
  last: number;
  bid?: number;
  ask?: number;
  /** 당일 누적 거래대금(원). 유동성 필터용. */
  tradingValue?: number;
}

/** 보유 포지션(대사 결과 = 브로커가 진실의 원천, 10장-2). */
export interface Position {
  symbol: Symbol;
  quantity: number;
  /** 평균 매입 단가. */
  avgPrice: number;
}

/** 현금 + 포지션 = 포트폴리오 스냅샷. */
export interface Portfolio {
  cash: number;
  positions: Position[];
  /** 평가금액 포함 총 자산(브로커 제공 시). */
  equity?: number;
}

/**
 * 주문 의도(intent). 전략 엔진의 출력. 부수효과 없음(4장).
 * 엔진은 "무엇을 하고 싶다"만 표현하고, 멱등키·실제 제출은 Order Manager 가 부여한다.
 */
export interface OrderIntent {
  symbol: Symbol;
  side: Side;
  type: OrderType;
  quantity: number;
  /** limit 주문일 때만. */
  limitPrice?: number;
  /** 의사결정 근거(로깅/대시보드용). */
  reason: string;
}

/** 실제 주문(멱등키 부여 후). */
export interface Order {
  /** 클라이언트 멱등키(10장-1). 재시도해도 동일 키로 중복 차단. */
  clientOrderId: string;
  /** 브로커가 발급한 주문번호(접수 후). */
  brokerOrderId?: string;
  symbol: Symbol;
  side: Side;
  type: OrderType;
  quantity: number;
  limitPrice?: number;
  status: OrderStatus;
  filledQuantity: number;
  avgFillPrice?: number;
  createdAt: number;
  updatedAt: number;
}

/** 체결 내역(부분체결 포함, 10장-3). */
export interface Fill {
  clientOrderId: string;
  brokerOrderId?: string;
  symbol: Symbol;
  side: Side;
  quantity: number;
  price: number;
  /** 수수료(원). */
  fee: number;
  /** 거래세(원). 매도 시 적용. */
  tax: number;
  ts: number;
}

/**
 * 이벤트 점수(8장). point-in-time 으로 노출되어야 한다(scoredAt/publishedAt 기준).
 * LLM 은 이 점수만 만든다 — 주문 결정은 규칙 엔진.
 */
export interface EventScore {
  symbol: Symbol;
  /** [-1, +1] 고정 스케일. */
  sentiment: number;
  eventType: string;
  /** [0,1]. */
  confidence: number;
  /** 이벤트 공개 시각(look-ahead 방지의 기준, 8장). */
  publishedAt: number;
  /** 점수화 시각. */
  scoredAt: number;
}
