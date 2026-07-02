/**
 * Order Manager (10장) — 멱등 주문, 상태 머신, 대사, 크래시 복구.
 *
 * 멱등성: clientOrderId 는 (tickId, index, symbol, side) 로 결정적으로 생성된다.
 *   같은 틱을 재시도하면 동일 키 → 이미 제출된(accepted 이상) 주문은 다시 보내지 않는다.
 *   서로 다른 틱에서의 중복 진입은 "전략이 보유 포지션을 보고 재진입하지 않음"으로 차단된다(대사 선행).
 * 브로커가 진실의 원천: 포지션은 항상 KIS 잔고 대사 결과로 덮어쓴다.
 */
import type { Fill, Order, OrderGateway, OrderIntent, Position, Side } from '@stockbot/core';
import { KisRejectedError } from '../adapters/kis/errors.js';
import type { Logger } from '../logger.js';

/** 브로커 주문별 누적 체결 요약(대사용). */
export interface BrokerFill {
  brokerOrderId: string;
  symbol: string;
  side: Side;
  totalFilledQty: number;
  avgFillPrice: number;
  canceled: boolean;
  /** 체결 귀속 시각(epoch ms). 없으면 대사 시각 사용. */
  ts?: number;
}

/** 일별 체결 조회 소스(KIS 어댑터가 구조적으로 충족). */
export interface FillSource {
  inquireDailyFills(from: string, to: string): Promise<BrokerFill[]>;
}

/** 체결 멱등 적재(FillRepo 가 충족). */
export interface FillRecorder {
  recordIfNew(fill: Fill & { brokerFillId?: string }): Promise<void>;
}

/** OrderManager 가 의존하는 최소 영속화 계약(테스트 시 in-memory 로 교체 가능). */
export interface OrderStore {
  get(clientOrderId: string): Promise<Order | null>;
  upsert(order: Order, reason?: string): Promise<void>;
  openOrders(): Promise<Order[]>;
}

export interface PositionStore {
  reconcile(positions: Position[]): Promise<void>;
}

/** 잔고를 돌려주는 최소 계약(KIS portfolio). */
export interface BrokerPortfolio {
  getPortfolio(): Promise<{ cash: number; positions: Position[]; equity?: number }>;
}

const TERMINAL: ReadonlySet<Order['status']> = new Set(['filled', 'rejected', 'canceled']);
const SUBMITTED: ReadonlySet<Order['status']> = new Set(['submitted', 'accepted', 'partially_filled', 'filled']);

export function clientOrderId(tickId: string | number, index: number, intent: OrderIntent): string {
  return `t${tickId}-${index}-${intent.symbol}-${intent.side}`;
}

export interface PlaceResult {
  placed: Order[];
  skipped: { clientOrderId: string; reason: string }[];
  rejected: { intent: OrderIntent; reason: string }[];
}

export class OrderManager {
  constructor(
    private readonly gateway: OrderGateway,
    private readonly orders: OrderStore,
    private readonly positions: PositionStore,
    private readonly broker: BrokerPortfolio,
    private readonly logger: Logger,
    private readonly clock: { now(): number } = { now: () => Date.now() },
    private readonly fills?: FillRecorder,
    private readonly fillSource?: FillSource,
  ) {}

  /**
   * 주문 상태 대사(10장-2,3): 브로커 일별 체결로 미종결 주문의 상태머신을 전진시키고,
   * 신규 체결분을 fills 에 멱등 적재한다. dateYYYYMMDD: 조회 거래일(KST).
   * 흐름: submitted/accepted → (부분체결)partially_filled → filled/canceled.
   */
  async reconcileOrders(dateYYYYMMDD: string): Promise<void> {
    if (!this.fillSource) return;
    const open = await this.orders.openOrders();
    if (open.length === 0) return;

    let brokerFills: BrokerFill[];
    try {
      brokerFills = await this.fillSource.inquireDailyFills(dateYYYYMMDD, dateYYYYMMDD);
    } catch (err) {
      this.logger.error({ err }, 'order reconciliation: daily-fills inquiry failed');
      return;
    }
    const byOdno = new Map(brokerFills.map((f) => [f.brokerOrderId, f]));

    for (const o of open) {
      if (!o.brokerOrderId) continue;
      const bf = byOdno.get(o.brokerOrderId);
      if (!bf) continue;

      const prevFilled = o.filledQuantity;
      const newFilled = bf.totalFilledQty;

      // 신규 체결 델타를 fills 에 멱등 적재(수수료·세금은 근사).
      if (newFilled > prevFilled && this.fills) {
        const delta = newFilled - prevFilled;
        const gross = bf.avgFillPrice * delta;
        await this.fills.recordIfNew({
          clientOrderId: o.clientOrderId,
          brokerOrderId: o.brokerOrderId,
          symbol: o.symbol,
          side: o.side,
          quantity: delta,
          price: bf.avgFillPrice,
          fee: Math.round(gross * 0.00015),
          tax: o.side === 'sell' ? Math.round(gross * 0.0018) : 0,
          ts: bf.ts ?? this.clock.now(), // 체결 귀속일(주문일자) 우선 — 실현손익 날짜 정확
          brokerFillId: `${o.brokerOrderId}:${newFilled}`,
        });
      }

      // 상태머신 전진.
      let status: Order['status'] = o.status;
      if (bf.canceled) status = 'canceled';
      else if (newFilled >= o.quantity && o.quantity > 0) status = 'filled';
      else if (newFilled > 0) status = 'partially_filled';

      if (newFilled !== prevFilled || status !== o.status) {
        await this.orders.upsert({
          ...o,
          filledQuantity: newFilled,
          avgFillPrice: bf.avgFillPrice || o.avgFillPrice,
          status,
          updatedAt: this.clock.now(),
        });
        this.logger.info({ coid: o.clientOrderId, broker: o.brokerOrderId, filled: newFilled, status }, 'order reconciled');
      }
    }
  }

  /**
   * 크래시 복구 / 매 틱 시작 대사(10장-2,4): 브로커 잔고로 포지션을 진실로 복원한다.
   * 다른 어떤 행동보다 먼저 호출되어야 한다.
   */
  async reconcile(): Promise<{ cash: number; positions: Position[]; equity?: number }> {
    const pf = await this.broker.getPortfolio();
    await this.positions.reconcile(pf.positions);
    this.logger.info({ positions: pf.positions.length, cash: pf.cash }, 'reconciled positions from broker');
    return pf;
  }

  /** 주문 의도 목록을 멱등 제출. 상태 머신 전이를 영속화. */
  async place(intents: OrderIntent[], tickId: string | number): Promise<PlaceResult> {
    const result: PlaceResult = { placed: [], skipped: [], rejected: [] };

    for (let i = 0; i < intents.length; i++) {
      const intent = intents[i]!;
      const coid = clientOrderId(tickId, i, intent);

      // 멱등 검사: 이미 제출된 주문이면 스킵.
      const existing = await this.orders.get(coid);
      if (existing && SUBMITTED.has(existing.status)) {
        result.skipped.push({ clientOrderId: coid, reason: `already ${existing.status}` });
        continue;
      }

      const now = this.clock.now();
      const order: Order = existing ?? {
        clientOrderId: coid,
        symbol: intent.symbol,
        side: intent.side,
        type: intent.type,
        quantity: intent.quantity,
        limitPrice: intent.limitPrice,
        status: 'new',
        filledQuantity: 0,
        createdAt: now,
        updatedAt: now,
      };

      // new 상태로 먼저 영속화(크래시 시 흔적 남김).
      order.status = 'new';
      order.updatedAt = now;
      await this.orders.upsert(order, intent.reason);

      // 제출.
      try {
        const submitted: Order = { ...order, status: 'submitted', updatedAt: this.clock.now() };
        await this.orders.upsert(submitted, intent.reason);
        const accepted = await this.gateway.submit(submitted);
        await this.orders.upsert(accepted, intent.reason);
        result.placed.push(accepted);
        this.logger.info({ coid, broker: accepted.brokerOrderId, symbol: intent.symbol, side: intent.side, qty: intent.quantity }, 'order accepted');
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        const rejected: Order = { ...order, status: 'rejected', updatedAt: this.clock.now() };
        // 거부 사유를 주문 행에 보존(대시보드 표시용). 전략 의도 + 브로커 거부 메시지.
        const stored = intent.reason ? `${intent.reason} · 거부: ${reason}` : `거부: ${reason}`;
        await this.orders.upsert(rejected, stored.slice(0, 480));
        result.rejected.push({ intent, reason });
        // 비즈니스 거부는 경고, 그 외(네트워크 등)는 에러로 — 알림 대상(16장).
        if (err instanceof KisRejectedError) this.logger.warn({ coid, reason }, 'order rejected by broker');
        else this.logger.error({ coid, err }, 'order submission failed');
      }
    }

    return result;
  }
}
