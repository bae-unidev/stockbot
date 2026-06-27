/**
 * 리플레이용 가상 브로커 — 라이브 파이프라인(OrderManager 대사/체결)을 그대로 태우기 위한 KIS 대역.
 *
 * SimBroker(백테스트)와 달리 submit 은 즉시 'filled' 이 아니라 'accepted' 를 돌려준다:
 * 실 KIS 처럼 "접수 → 다음 틱 reconcileOrders(일별체결조회)에서 체결 확정 + fills 적재" 경로를
 * 그대로 밟게 하려는 것. 그래서 inquireDailyFills(FillSource) 를 구현한다.
 * 내부 장부(cash/positions)는 접수 즉시 시장가로 갱신(시장가 즉시체결 가정).
 */
import type { Fill, Order, OrderGateway, Portfolio, Position, Side, Symbol } from '@stockbot/core';
import type { BrokerFill } from '../../order-manager/index.js';
import { DEFAULT_SIM_COSTS, type SimCosts } from './sim-broker.js';
import { tradingDateKey } from '../../market/calendar.js';

interface AcceptedFill {
  brokerOrderId: string;
  symbol: Symbol;
  side: Side;
  quantity: number;
  price: number;
  ts: number;
}

export class ReplayBroker implements OrderGateway {
  private cash: number;
  private readonly positions = new Map<Symbol, Position>();
  private readonly fills: AcceptedFill[] = [];
  private seq = 0;
  private priceProvider: (s: Symbol) => number | undefined = () => undefined;
  private clockMs = 0;

  constructor(
    initialCash: number,
    private readonly costs: SimCosts = DEFAULT_SIM_COSTS,
  ) {
    this.cash = initialCash;
  }

  setPriceProvider(fn: (s: Symbol) => number | undefined): void {
    this.priceProvider = fn;
  }
  setClock(ms: number): void {
    this.clockMs = ms;
  }

  async getPortfolio(_asOf?: number): Promise<Portfolio> {
    const positions = [...this.positions.values()].filter((p) => p.quantity > 0);
    const equity = this.cash + positions.reduce((a, p) => a + p.quantity * (this.priceProvider(p.symbol) ?? p.avgPrice), 0);
    return { cash: this.cash, positions: positions.map((p) => ({ ...p })), equity };
  }

  /** 접수(accepted) 반환 + 내부 장부 시장가 즉시 갱신 + 체결분 기록(다음 틱 대사에서 확정). */
  async submit(order: Order): Promise<Order> {
    const ref = order.limitPrice ?? this.priceProvider(order.symbol);
    if (ref == null) return { ...order, status: 'rejected', updatedAt: this.clockMs };
    const slip = order.side === 'buy' ? 1 + this.costs.slippageRate : 1 - this.costs.slippageRate;
    const price = ref * slip;
    const gross = price * order.quantity;
    const fee = gross * this.costs.commissionRate;

    if (order.side === 'buy') {
      if (gross + fee > this.cash + 1e-6) return { ...order, status: 'rejected', updatedAt: this.clockMs };
      this.cash -= gross + fee;
      const ex = this.positions.get(order.symbol);
      if (ex) {
        const nq = ex.quantity + order.quantity;
        ex.avgPrice = (ex.avgPrice * ex.quantity + price * order.quantity) / nq;
        ex.quantity = nq;
      } else {
        this.positions.set(order.symbol, { symbol: order.symbol, quantity: order.quantity, avgPrice: price });
      }
    } else {
      const ex = this.positions.get(order.symbol);
      const qty = Math.min(order.quantity, ex?.quantity ?? 0);
      if (qty <= 0) return { ...order, status: 'rejected', updatedAt: this.clockMs };
      const tax = gross * this.costs.sellTaxRate;
      this.cash += gross - fee - tax;
      ex!.quantity -= qty;
      if (ex!.quantity <= 0) this.positions.delete(order.symbol);
    }

    const brokerOrderId = `replay-${++this.seq}`;
    this.fills.push({ brokerOrderId, symbol: order.symbol, side: order.side, quantity: order.quantity, price, ts: this.clockMs });
    // 실 KIS 와 동일하게 '접수' 만 알려준다(체결 확정은 reconcileOrders).
    return { ...order, status: 'accepted', brokerOrderId, updatedAt: this.clockMs };
  }

  async getOrder(): Promise<Order | null> {
    return null;
  }
  async cancel(): Promise<Order> {
    throw new Error('replay cancel unsupported');
  }

  /** FillSource: 해당 거래일(KST)의 체결을 brokerOrderId 별 누적으로 반환(전량체결 가정). */
  async inquireDailyFills(from: string, to: string): Promise<BrokerFill[]> {
    return this.fills
      .filter((f) => {
        // 라이브 reconcileOrders 는 YYYYMMDD(대시 제거)로 호출 → 동일 포맷으로 비교.
        const d = tradingDateKey(f.ts).replace(/-/g, '');
        return d >= from && d <= to;
      })
      .map<BrokerFill>((f) => ({
        brokerOrderId: f.brokerOrderId,
        symbol: f.symbol,
        side: f.side,
        totalFilledQty: f.quantity,
        avgFillPrice: f.price,
        canceled: false,
      }));
  }
}

export type { Fill };
