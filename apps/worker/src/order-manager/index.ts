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
import { tradingDateKey } from '../market/calendar.js';

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
   * 신규 체결분을 fills 에 멱등 적재한다. dateYYYYMMDD: 오늘 거래일(KST).
   * 흐름: submitted/accepted → (부분체결)partially_filled → filled/canceled.
   *
   * 조회는 "오늘"만이 아니라 미종결 주문의 **주문일자별**로 한다. 장 막판 틱(15:0x)에 낸 주문은
   * 그 틱이 끝난 뒤 체결되는데, 다음 날 틱이 다음 날 체결만 보면 영영 accepted 로 남고 fills 가
   * 비어 대시보드 과거일 포지션/투자비중/실현손익이 틀어진다(2026-09 실제 발생). lookbackDays 보다
   * 오래된 미종결 주문은 매 틱 조회 비용을 막기 위해 건너뛴다(백필은 `pnpm reconcile --days N`).
   */
  async reconcileOrders(dateYYYYMMDD: string, opts: { lookbackDays?: number } = {}): Promise<void> {
    if (!this.fillSource) return;
    const open = (await this.orders.openOrders()).filter((o) => o.brokerOrderId);
    if (open.length === 0) return;

    const lookbackMs = (opts.lookbackDays ?? 30) * 86_400_000;
    const nowMs = this.clock.now();
    const orderDate = (o: Order) => tradingDateKey(o.createdAt).replace(/-/g, '');
    const dates = new Set<string>([dateYYYYMMDD]);
    for (const o of open) if (nowMs - o.createdAt <= lookbackMs) dates.add(orderDate(o));

    // KIS 주문번호(odno)는 매 거래일 새로 매겨진다 → (주문일자, odno) 로만 매칭해야 다른 날 체결과 안 섞인다.
    const byDate = new Map<string, Map<string, BrokerFill>>();
    for (const d of [...dates].sort()) {
      try {
        const fills = await this.fillSource.inquireDailyFills(d, d);
        byDate.set(d, new Map(fills.map((f) => [f.brokerOrderId, f])));
      } catch (err) {
        this.logger.error({ err, date: d }, 'order reconciliation: daily-fills inquiry failed');
      }
    }

    for (const o of open) {
      const bf = byDate.get(orderDate(o))?.get(o.brokerOrderId!);
      if (!bf || bf.symbol !== o.symbol || bf.side !== o.side) continue;

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
          brokerFillId: `${orderDate(o)}:${o.brokerOrderId}:${newFilled}`, // odno 는 일자별 재사용 → 일자 포함
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
