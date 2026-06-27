/**
 * 백테스트 체결 시뮬레이터 + 내부 장부(9장).
 * - OrderGateway: 주문 의도를 즉시(시장가, 슬리피지 반영) 체결로 변환.
 * - PortfolioPort: 내부 cash/positions 장부.
 * 수수료·세금·슬리피지를 반영하고, 모든 거래를 trade 로그로 남긴다.
 * 결정성: 외부 난수 없음 — 같은 입력 → 같은 결과(9장).
 */
import type { Fill, Order, OrderGateway, Portfolio, Position, Symbol } from '@stockbot/core';

export interface SimCosts {
  /** 매수/매도 수수료율(예: 0.00015 = 0.015%). */
  commissionRate: number;
  /** 매도 거래세율(예: 0.0018). 매수에는 미적용. */
  sellTaxRate: number;
  /** 슬리피지(예: 0.0005). 매수는 불리하게 +, 매도는 -. */
  slippageRate: number;
}

export const DEFAULT_SIM_COSTS: SimCosts = {
  commissionRate: 0.00015,
  sellTaxRate: 0.0018,
  slippageRate: 0.0005,
};

export interface SimTrade extends Fill {
  reason?: string;
}

export class SimBroker implements OrderGateway {
  private cash: number;
  private readonly positions = new Map<Symbol, Position>();
  readonly trades: SimTrade[] = [];
  /** 체결 가격 소스: 현재 시각의 종가를 런타임이 주입. */
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

  /** 시장가 즉시 체결. 지정가는 1차 백테스트에서 시장가처럼 처리(현재가 기준). */
  async submit(order: Order): Promise<Order> {
    const ref = order.limitPrice ?? this.priceProvider(order.symbol);
    if (ref == null) {
      return { ...order, status: 'rejected', updatedAt: this.clockMs };
    }
    const slip = order.side === 'buy' ? 1 + this.costs.slippageRate : 1 - this.costs.slippageRate;
    const price = ref * slip;
    const gross = price * order.quantity;
    const fee = gross * this.costs.commissionRate;
    const tax = order.side === 'sell' ? gross * this.costs.sellTaxRate : 0;

    if (order.side === 'buy') {
      const total = gross + fee;
      if (total > this.cash + 1e-6) return { ...order, status: 'rejected', updatedAt: this.clockMs };
      this.cash -= total;
      const existing = this.positions.get(order.symbol);
      if (existing) {
        const newQty = existing.quantity + order.quantity;
        existing.avgPrice = (existing.avgPrice * existing.quantity + price * order.quantity) / newQty;
        existing.quantity = newQty;
      } else {
        this.positions.set(order.symbol, { symbol: order.symbol, quantity: order.quantity, avgPrice: price });
      }
    } else {
      const existing = this.positions.get(order.symbol);
      const qty = Math.min(order.quantity, existing?.quantity ?? 0);
      if (qty <= 0) return { ...order, status: 'rejected', updatedAt: this.clockMs };
      this.cash += gross - fee - tax;
      existing!.quantity -= qty;
      if (existing!.quantity <= 0) this.positions.delete(order.symbol);
    }

    this.trades.push({
      clientOrderId: order.clientOrderId,
      symbol: order.symbol,
      side: order.side,
      quantity: order.quantity,
      price,
      fee,
      tax,
      ts: this.clockMs,
    });

    return {
      ...order,
      status: 'filled',
      filledQuantity: order.quantity,
      avgFillPrice: price,
      brokerOrderId: `sim-${this.trades.length}`,
      updatedAt: this.clockMs,
    };
  }

  async getOrder(): Promise<Order | null> {
    return null;
  }

  async cancel(_id: string): Promise<Order> {
    throw new Error('sim cancel unsupported');
  }

  positionsSnapshot(): Position[] {
    return [...this.positions.values()].map((p) => ({ ...p }));
  }

  equity(): number {
    return this.cash + this.positionsSnapshot().reduce((a, p) => a + p.quantity * (this.priceProvider(p.symbol) ?? p.avgPrice), 0);
  }
}
