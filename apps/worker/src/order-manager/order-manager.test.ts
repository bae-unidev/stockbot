import { describe, expect, it, vi } from 'vitest';
import { OrderManager, clientOrderId, type OrderStore, type PositionStore } from './index.js';
import { KisAmbiguousError, KisRejectedError } from '../adapters/kis/errors.js';
import type { Order, OrderGateway, OrderIntent, Position } from '@stockbot/core';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;

function memStore(): OrderStore & { map: Map<string, Order> } {
  const map = new Map<string, Order>();
  return {
    map,
    async get(id) {
      return map.get(id) ?? null;
    },
    async upsert(o) {
      map.set(o.clientOrderId, { ...o });
    },
    async openOrders() {
      return [...map.values()].filter((o) => !['filled', 'rejected', 'canceled'].includes(o.status));
    },
    async brokerOrderRefs(sinceMs) {
      return [...map.values()].filter((o) => o.brokerOrderId && o.createdAt >= sinceMs).map((o) => ({ brokerOrderId: o.brokerOrderId!, createdAt: o.createdAt }));
    },
  };
}

const posStore: PositionStore = { async reconcile() {} };
const broker = { async getPortfolio() { return { cash: 1_000_000, positions: [] as Position[] }; } };

const buy: OrderIntent = { symbol: '005930', side: 'buy', type: 'market', quantity: 10, reason: 'test' };

describe('OrderManager idempotency & state machine', () => {
  it('generates a deterministic clientOrderId for the same tick+intent', () => {
    expect(clientOrderId(42, 0, buy)).toBe(clientOrderId(42, 0, buy));
    expect(clientOrderId(42, 0, buy)).not.toBe(clientOrderId(43, 0, buy));
  });

  it('submits once and transitions new→submitted→accepted', async () => {
    const store = memStore();
    let submits = 0;
    const gateway: OrderGateway = {
      async submit(o) {
        submits++;
        return { ...o, status: 'accepted', brokerOrderId: 'B123', updatedAt: 1 };
      },
      async getOrder() { return null; },
      async cancel(o) { throw new Error('no'); },
    };
    const om = new OrderManager(gateway, store, posStore, broker, logger, { now: () => 1 });

    const r1 = await om.place([buy], 42);
    expect(r1.placed).toHaveLength(1);
    expect(r1.placed[0]!.status).toBe('accepted');
    expect(r1.placed[0]!.brokerOrderId).toBe('B123');
    expect(submits).toBe(1);

    // 같은 틱 재시도 — 다시 제출하지 않는다(멱등).
    const r2 = await om.place([buy], 42);
    expect(submits).toBe(1);
    expect(r2.skipped).toHaveLength(1);
    expect(r2.placed).toHaveLength(0);
  });

  it('captures broker rejection without throwing', async () => {
    const store = memStore();
    const gateway: OrderGateway = {
      async submit() { throw new KisRejectedError('insufficient balance'); },
      async getOrder() { return null; },
      async cancel() { throw new Error('no'); },
    };
    const om = new OrderManager(gateway, store, posStore, broker, logger, { now: () => 1 });
    const r = await om.place([buy], 1);
    expect(r.rejected).toHaveLength(1);
    expect(store.map.get(clientOrderId(1, 0, buy))!.status).toBe('rejected');
  });

  it('reconcileOrders advances the state machine and records fills idempotently', async () => {
    const store = memStore();
    // 제출된 주문 1건(미종결).
    const t1 = Date.parse('2026-01-01T01:00:00Z'); // 2026-01-01 10:00 KST
    store.map.set('t1-0-005930-buy', { clientOrderId: 't1-0-005930-buy', brokerOrderId: 'B1', symbol: '005930', side: 'buy', type: 'market', quantity: 10, status: 'accepted', filledQuantity: 0, createdAt: t1, updatedAt: t1 });
    const recorded: { brokerFillId?: string; quantity: number }[] = [];
    const fills = { async recordIfNew(f: { brokerFillId?: string; quantity: number }) { if (!recorded.find((x) => x.brokerFillId === f.brokerFillId)) recorded.push({ brokerFillId: f.brokerFillId, quantity: f.quantity }); } };
    let totalFilled = 4; // 1차: 부분체결 4
    const fillSource = { async inquireDailyFills(from: string) { return from === '20260101' ? [{ brokerOrderId: 'B1', symbol: '005930', side: 'buy' as const, totalFilledQty: totalFilled, avgFillPrice: 70000, canceled: false }] : []; } };
    const gateway: OrderGateway = { async submit(o) { return o; }, async getOrder() { return null; }, async cancel() { throw new Error('no'); } };
    const om = new OrderManager(gateway, store, posStore, broker, logger, { now: () => t1 + 60_000 }, fills, fillSource);

    await om.reconcileOrders('20260101');
    expect(store.map.get('t1-0-005930-buy')!.status).toBe('partially_filled');
    expect(store.map.get('t1-0-005930-buy')!.filledQuantity).toBe(4);
    expect(recorded).toHaveLength(1);

    // 재실행(같은 4): 멱등 — 새 fill 없음.
    await om.reconcileOrders('20260101');
    expect(recorded).toHaveLength(1);

    // 2차: 전량체결 10 → filled + 신규 델타 fill.
    totalFilled = 10;
    await om.reconcileOrders('20260101');
    expect(store.map.get('t1-0-005930-buy')!.status).toBe('filled');
    expect(recorded).toHaveLength(2);
    expect(recorded[1]!.quantity).toBe(6);
  });

  it('reconcileOrders queries each open order on its own order date (late-day orders do not get stuck)', async () => {
    const store = memStore();
    const day1 = Date.parse('2026-09-04T06:02:00Z'); // 15:02 KST — 마지막 틱 이후 체결
    const day2 = Date.parse('2026-09-07T01:00:00Z'); // 다음 거래일 10:00 KST
    store.map.set('t326-0-033780-sell', { clientOrderId: 't326-0-033780-sell', brokerOrderId: 'B9', symbol: '033780', side: 'sell', type: 'market', quantity: 5, status: 'accepted', filledQuantity: 0, createdAt: day1, updatedAt: day1 });
    const recorded: { quantity: number }[] = [];
    const fills = { async recordIfNew(f: { quantity: number }) { recorded.push({ quantity: f.quantity }); } };
    const queried: string[] = [];
    const fillSource = {
      async inquireDailyFills(from: string) {
        queried.push(from);
        return from === '20260904' ? [{ brokerOrderId: 'B9', symbol: '033780', side: 'sell' as const, totalFilledQty: 5, avgFillPrice: 170000, canceled: false }] : [];
      },
    };
    const gateway: OrderGateway = { async submit(o) { return o; }, async getOrder() { return null; }, async cancel() { throw new Error('no'); } };
    const om = new OrderManager(gateway, store, posStore, broker, logger, { now: () => day2 }, fills, fillSource);

    await om.reconcileOrders('20260907');
    expect(queried.sort()).toEqual(['20260904', '20260907']);
    expect(store.map.get('t326-0-033780-sell')!.status).toBe('filled');
    expect(recorded).toEqual([{ quantity: 5 }]);

    // odno 는 날마다 재사용된다: 다른 날 같은 odno 체결이 섞이면 안 된다.
    store.map.set('t340-0-005930-buy', { clientOrderId: 't340-0-005930-buy', brokerOrderId: 'B9', symbol: '005930', side: 'buy', type: 'market', quantity: 3, status: 'accepted', filledQuantity: 0, createdAt: day2, updatedAt: day2 });
    await om.reconcileOrders('20260907');
    expect(store.map.get('t340-0-005930-buy')!.status).toBe('accepted');
    expect(recorded).toHaveLength(1);
    store.map.delete('t340-0-005930-buy');

    // lookback 밖이면 조회하지 않는다(매 틱 비용 상한).
    queried.length = 0;
    store.map.get('t326-0-033780-sell')!.status = 'accepted';
    store.map.get('t326-0-033780-sell')!.filledQuantity = 0;
    await om.reconcileOrders('20260907', { lookbackDays: 1 });
    expect(queried).toEqual(['20260907']);
  });

  it('ambiguous submit (no response) stays submitted, is not resent, and resolves from the broker ledger', async () => {
    const store = memStore();
    const t0 = Date.parse('2026-08-13T06:01:15Z'); // 15:01 KST
    let now = t0;
    let submits = 0;
    const gateway: OrderGateway = {
      async submit() { submits++; throw new KisAmbiguousError('응답 없음'); },
      async getOrder() { return null; },
      async cancel() { throw new Error('no'); },
    };
    const recorded: { clientOrderId: string; quantity: number }[] = [];
    const fills = { async recordIfNew(f: { clientOrderId: string; quantity: number; brokerFillId?: string }) { recorded.push({ clientOrderId: f.clientOrderId, quantity: f.quantity }); } };
    // 브로커 원장: 우리 주문(응답 못 받음) 1건 + 봇이 모르는 중복 체결 1건.
    const ledger = [
      { brokerOrderId: '0000038467', symbol: '017670', side: 'buy' as const, totalFilledQty: 10, avgFillPrice: 91900, canceled: false, ts: t0 },
      { brokerOrderId: '0000038492', symbol: '017670', side: 'buy' as const, totalFilledQty: 10, avgFillPrice: 91900, canceled: false, ts: t0 },
    ];
    const fillSource = { async inquireDailyFills(from: string) { return from === '20260813' ? ledger : []; } };
    const om = new OrderManager(gateway, store, posStore, broker, logger, { now: () => now }, fills, fillSource);
    const intent: OrderIntent = { symbol: '017670', side: 'buy', type: 'market', quantity: 10, reason: 'core' };

    const r = await om.place([intent], 215);
    const coid = clientOrderId(215, 0, intent);
    expect(r.rejected).toHaveLength(0);
    expect(store.map.get(coid)!.status).toBe('submitted');
    await om.place([intent], 215); // 같은 틱 재시도 — 재전송 금지
    expect(submits).toBe(1);

    // 제출 직후(경합 창)엔 귀속/흡수하지 않는다.
    await om.reconcileOrders('20260813');
    expect(recorded).toHaveLength(0);

    now = t0 + 5 * 60_000;
    await om.reconcileOrders('20260813');
    expect(store.map.get(coid)!.status).toBe('filled');
    expect(store.map.get(coid)!.brokerOrderId).toBe('0000038467');
    // 주인 없는 중복 체결은 kis-* 주문으로 흡수 → fills 가 브로커와 일치(10+10).
    expect(store.map.get('kis-20260813-0000038492')!.status).toBe('filled');
    expect(recorded.map((x) => x.quantity)).toEqual([10, 10]);

    // 재실행 멱등.
    await om.reconcileOrders('20260813');
    expect(recorded).toHaveLength(2);
  });

  it('ambiguous order with no broker record is marked rejected once its day has passed', async () => {
    const store = memStore();
    const t0 = Date.parse('2026-08-11T06:23:00Z');
    store.map.set('tstop1-0-086790-sell', { clientOrderId: 'tstop1-0-086790-sell', symbol: '086790', side: 'sell', type: 'market', quantity: 7, status: 'submitted', filledQuantity: 0, createdAt: t0, updatedAt: t0 });
    const fillSource = { async inquireDailyFills() { return []; } };
    const gateway: OrderGateway = { async submit(o) { return o; }, async getOrder() { return null; }, async cancel() { throw new Error('no'); } };
    const om = new OrderManager(gateway, store, posStore, broker, logger, { now: () => t0 + 10 * 60_000 }, undefined, fillSource);
    await om.reconcileOrders('20260811');
    expect(store.map.get('tstop1-0-086790-sell')!.status).toBe('submitted'); // 당일엔 아직 판정 보류
    const om2 = new OrderManager(gateway, store, posStore, broker, logger, { now: () => t0 + 86_400_000 }, undefined, fillSource);
    await om2.reconcileOrders('20260812');
    expect(store.map.get('tstop1-0-086790-sell')!.status).toBe('rejected');
  });

  it('reconcile pulls positions from the broker as source of truth', async () => {
    const store = memStore();
    const reconciled: Position[][] = [];
    const ps: PositionStore = { async reconcile(p) { reconciled.push(p); } };
    const brokerWithPos = { async getPortfolio() { return { cash: 500, positions: [{ symbol: '005930', quantity: 10, avgPrice: 70000 }] }; } };
    const gateway: OrderGateway = { async submit(o) { return o; }, async getOrder() { return null; }, async cancel() { throw new Error('no'); } };
    const om = new OrderManager(gateway, store, ps, brokerWithPos, logger, { now: () => 1 });
    const pf = await om.reconcile();
    expect(pf.positions[0]!.symbol).toBe('005930');
    expect(reconciled[0]![0]!.quantity).toBe(10);
  });
});
