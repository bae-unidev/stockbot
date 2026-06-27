/**
 * 포트(추상 인터페이스). core 가 정의하고, 실행 환경(live/backtest)이 어댑터를 주입한다(4장).
 * 엔진은 이 포트에만 의존한다 — Date.now()/fetch/DB 직접 호출 금지.
 */
import type {
  Bar,
  EventScore,
  Order,
  OrderIntent,
  Portfolio,
  Quote,
  Symbol,
  Timeframe,
} from '../domain/types.js';

/** 현재 시각. live=시스템 시계, backtest=가상 시계(과거 타임스탬프 순차 전진). */
export interface Clock {
  /** UTC epoch ms. */
  now(): number;
}

/** 시세/봉 조회. live=KIS REST, backtest=canonical 봉 리플레이. */
export interface MarketDataPort {
  /** 특정 시각(asOf) 이전의 마지막 `limit`개 봉을, 시각 오름차순으로 반환. point-in-time. */
  getBars(params: {
    symbol: Symbol;
    timeframe: Timeframe;
    asOf: number;
    limit: number;
  }): Promise<Bar[]>;

  /** asOf 시점의 현재가 스냅샷. */
  getQuote(symbol: Symbol, asOf: number): Promise<Quote | null>;
}

/** 특정 시점까지 알 수 있던 이벤트 점수 조회(point-in-time, look-ahead 금지). */
export interface EventDataPort {
  /** publishedAt <= asOf 인 점수만 반환. */
  getScores(params: { symbols: Symbol[]; asOf: number }): Promise<EventScore[]>;
}

/** 포지션/현금 조회. live=KIS 잔고 대사, backtest=시뮬레이터 장부. */
export interface PortfolioPort {
  getPortfolio(asOf: number): Promise<Portfolio>;
}

/** 주문 제출/조회. live=KIS 주문 API, backtest=체결 시뮬레이터. */
export interface OrderGateway {
  /** 멱등 제출. 동일 clientOrderId 재시도 시 중복 주문을 만들지 않는다(10장-1). */
  submit(order: Order): Promise<Order>;
  /** 브로커 기준 주문 상태 조회(대사용, 10장-2). */
  getOrder(clientOrderId: string): Promise<Order | null>;
  /** 미체결 주문 취소. */
  cancel(clientOrderId: string): Promise<Order>;
}

/** 엔진이 한 틱에서 받는 모든 입력(포트 경유로 조립됨). */
export interface EngineContext {
  clock: Clock;
  marketData: MarketDataPort;
  eventData: EventDataPort;
  portfolio: PortfolioPort;
}

export type { Bar, EventScore, Order, OrderIntent, Portfolio, Quote };
