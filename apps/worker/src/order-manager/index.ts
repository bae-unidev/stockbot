/**
 * Order Manager (10장) — 멱등 주문, 상태 머신, 대사, 크래시 복구.
 *
 * 멱등성: clientOrderId 는 (tickId, index, symbol, side) 로 결정적으로 생성된다.
 *   같은 틱을 재시도하면 동일 키 → 이미 제출된(accepted 이상) 주문은 다시 보내지 않는다.
 *   서로 다른 틱에서의 중복 진입은 "전략이 보유 포지션을 보고 재진입하지 않음"으로 차단된다(대사 선행).
 * 브로커가 진실의 원천: 포지션은 항상 KIS 잔고 대사 결과로 덮어쓴다.
 */
import type { Fill, Order, OrderGateway, OrderIntent, Position, Side } from '@stockbot/core';
import { KisAmbiguousError, KisRejectedError } from '../adapters/kis/errors.js';
import type { Logger } from '../logger.js';
import { tradingDateKey } from '../market/calendar.js';
import { DEFAULT_SIM_COSTS } from '../adapters/backtest/sim-broker.js';

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
  /** sinceMs 이후 생성된 주문 중 브로커 주문번호가 있는 것(주문일자별 odno 소유 판정용). */
  brokerOrderRefs(sinceMs: number): Promise<{ brokerOrderId: string; createdAt: number }[]>;
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
   * 신규 체결분을 fills 에 멱등 적재한다. dateYYYYMMDD: 오늘 거래일(KST). 브로커 원장 = 진실의 원천.
   * 흐름: submitted/accepted → (부분체결)partially_filled → filled/canceled.
   *
   * 1) 조회는 "오늘"만이 아니라 미종결 주문의 **주문일자별**로 한다. 장 막판 틱(15:0x) 주문은 틱 이후
   *    체결되는데, 다음 날 틱이 다음 날만 보면 영영 accepted 로 남아 fills 가 비었다(2026-09 실제 발생).
   * 2) KIS 주문번호(odno)는 거래일마다 새로 매겨진다 → (주문일자, odno) + 종목/방향으로만 매칭.
   * 3) 응답 타임아웃으로 odno 없이 남은 주문(접수 여부 불명)은 같은 날 "주인 없는" 브로커 체결 중
   *    종목·방향·수량이 같은 것에 귀속한다. 그날이 지났는데도 없으면 미접수로 확정(rejected).
   * 4) 그래도 주인 없는 브로커 체결(타임아웃 재시도 중복, 수동 주문 등)은 `kis-<일자>-<odno>` 주문으로
   *    흡수해 fills 를 브로커와 일치시킨다 — 빠지면 대시보드 포지션/실현손익이 틀어진다.
   * lookbackDays 보다 오래된 미종결 주문은 매 틱 비용을 막기 위해 건너뛴다.
   * scanAllDays=true 면 lookback 내 모든 평일을 조회(백필 `pnpm reconcile`).
   */
  async reconcileOrders(dateYYYYMMDD: string, opts: { lookbackDays?: number; scanAllDays?: boolean } = {}): Promise<void> {
    if (!this.fillSource) return;
    const lookbackMs = (opts.lookbackDays ?? 30) * 86_400_000;
    const nowMs = this.clock.now();
    const sinceMs = nowMs - lookbackMs;
    const open = await this.orders.openOrders();

    const orderDate = (o: { createdAt: number }) => tradingDateKey(o.createdAt).replace(/-/g, '');
    const dates = new Set<string>([dateYYYYMMDD]);
    for (const o of open) if (o.createdAt >= sinceMs) dates.add(orderDate(o));
    if (opts.scanAllDays) {
      for (let t = sinceMs; t <= nowMs; t += 86_400_000) {
        const wd = new Date(t + 9 * 3600_000).getUTCDay();
        if (wd !== 0 && wd !== 6) dates.add(tradingDateKey(t).replace(/-/g, ''));
      }
    }

    const byDate = new Map<string, Map<string, BrokerFill>>();
    for (const d of [...dates].sort()) {
      try {
        const fills = await this.fillSource.inquireDailyFills(d, d);
        byDate.set(d, new Map(fills.map((f) => [f.brokerOrderId, f])));
      } catch (err) {
        this.logger.error({ err, date: d }, 'order reconciliation: daily-fills inquiry failed');
      }
    }

    // (일자, odno) 소유 주문 — 이미 우리 주문에 매칭된 브로커 주문번호.
    const owned = new Set((await this.orders.brokerOrderRefs(sinceMs - 86_400_000)).map((r) => `${orderDate(r)}:${r.brokerOrderId}`));
    const unowned = (d: string) => [...(byDate.get(d)?.values() ?? [])].filter((f) => !owned.has(`${d}:${f.brokerOrderId}`));

    // 3) odno 없는 미종결 주문(접수 여부 불명) → 같은 날 주인 없는 체결에 귀속.
    const RECENT_MS = 90_000; // 진행 중일 수 있는 제출(응답 대기)과 경합 방지
    const pendingUnknown = open.filter((o) => !o.brokerOrderId);
    const newlyMatched = new Set<string>();
    for (const o of pendingUnknown) {
      const d = orderDate(o);
      if (!byDate.has(d) || nowMs - o.updatedAt < RECENT_MS) continue;
      const bf = unowned(d).find((f) => f.symbol === o.symbol && f.side === o.side && f.totalFilledQty === o.quantity);
      if (bf) {
        o.brokerOrderId = bf.brokerOrderId;
        newlyMatched.add(o.clientOrderId);
        owned.add(`${d}:${bf.brokerOrderId}`);
        this.logger.warn({ coid: o.clientOrderId, broker: bf.brokerOrderId }, 'ambiguous order matched to broker fill');
      } else if (d < dateYYYYMMDD) {
        await this.orders.upsert({ ...o, status: 'rejected', updatedAt: nowMs }, '브로커 기록 없음 — 미접수 확정');
        this.logger.warn({ coid: o.clientOrderId }, 'ambiguous order not found at broker — marked rejected');
      }
    }

    for (const o of open) {
      if (!o.brokerOrderId) continue;
      const bf = byDate.get(orderDate(o))?.get(o.brokerOrderId);
      if (!bf || bf.symbol !== o.symbol || bf.side !== o.side) continue;
      await this.applyBrokerFill(o, bf, orderDate(o), newlyMatched.has(o.clientOrderId));
    }

    // 4) 그래도 주인 없는 체결 → kis-<일자>-<odno> 주문으로 흡수(원장 일치). 진행 중 제출이 있으면 다음 틱으로.
    const inflight = new Set(pendingUnknown.filter((o) => nowMs - o.updatedAt < RECENT_MS).map((o) => `${o.symbol}:${o.side}`));
    for (const d of byDate.keys()) {
      for (const bf of unowned(d)) {
        if (bf.totalFilledQty <= 0 || inflight.has(`${bf.symbol}:${bf.side}`)) continue;
        const ts = bf.ts ?? nowMs;
        const adopted: Order = {
          clientOrderId: `kis-${d}-${bf.brokerOrderId}`,
          brokerOrderId: bf.brokerOrderId,
          symbol: bf.symbol,
          side: bf.side,
          type: 'market',
          quantity: bf.totalFilledQty,
          status: 'accepted',
          filledQuantity: 0,
          createdAt: ts,
          updatedAt: nowMs,
        };
        await this.orders.upsert(adopted, '브로커 체결 — 봇 주문기록 없음(타임아웃 재시도 중복/수동 주문) 흡수');
        await this.applyBrokerFill(adopted, bf, d, true);
        this.logger.warn({ date: d, broker: bf.brokerOrderId, symbol: bf.symbol, side: bf.side, qty: bf.totalFilledQty }, 'untracked broker fill adopted');
      }
    }
  }

  /** 브로커 누적 체결로 주문 상태 전진 + 신규 체결 델타를 fills 에 멱등 적재. */
  private async applyBrokerFill(o: Order, bf: BrokerFill, date: string, persist = false): Promise<void> {
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
        fee: Math.round(gross * DEFAULT_SIM_COSTS.commissionRate),
        tax: o.side === 'sell' ? Math.round(gross * DEFAULT_SIM_COSTS.sellTaxRate) : 0,
        ts: bf.ts ?? this.clock.now(), // 체결 귀속일(주문일자) 우선 — 실현손익 날짜 정확
        brokerFillId: `${date}:${o.brokerOrderId}:${newFilled}`, // odno 는 일자별 재사용 → 일자 포함
      });
    }

    // 상태머신 전진.
    let status: Order['status'] = o.status;
    if (bf.canceled) status = 'canceled';
    else if (newFilled >= o.quantity && o.quantity > 0) status = 'filled';
    else if (newFilled > 0) status = 'partially_filled';

    if (newFilled !== prevFilled || status !== o.status || persist) {
      await this.orders.upsert({
        ...o,
        filledQuantity: newFilled,
        avgFillPrice: bf.avgFillPrice || o.avgFillPrice,
        status,
        updatedAt: this.clock.now(),
      });
      if (newFilled !== prevFilled || status !== o.status) {
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
        if (err instanceof KisAmbiguousError) {
          // 접수됐을 수도 있음 → rejected 로 확정하지 않고 submitted 로 남겨 다음 대사가 브로커 원장으로 확정.
          const pending: Order = { ...order, status: 'submitted', updatedAt: this.clock.now() };
          const stored = `${intent.reason ?? ''} · 응답 없음 — 체결 여부 대사 대기`.slice(0, 480);
          await this.orders.upsert(pending, stored);
          result.placed.push(pending);
          this.logger.error({ coid, err }, 'order submission ambiguous (no response) — will reconcile from broker ledger');
          continue;
        }
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
