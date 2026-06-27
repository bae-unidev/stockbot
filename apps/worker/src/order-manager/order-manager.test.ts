import { describe, expect, it, vi } from 'vitest';
import { OrderManager, clientOrderId, type OrderStore, type PositionStore } from './index.js';
import { KisRejectedError } from '../adapters/kis/errors.js';
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
    store.map.set('t1-0-005930-buy', { clientOrderId: 't1-0-005930-buy', brokerOrderId: 'B1', symbol: '005930', side: 'buy', type: 'market', quantity: 10, status: 'accepted', filledQuantity: 0, createdAt: 1, updatedAt: 1 });
    const recorded: { brokerFillId?: string; quantity: number }[] = [];
    const fills = { async recordIfNew(f: { brokerFillId?: string; quantity: number }) { if (!recorded.find((x) => x.brokerFillId === f.brokerFillId)) recorded.push({ brokerFillId: f.brokerFillId, quantity: f.quantity }); } };
    let totalFilled = 4; // 1차: 부분체결 4
    const fillSource = { async inquireDailyFills() { return [{ brokerOrderId: 'B1', symbol: '005930', side: 'buy' as const, totalFilledQty: totalFilled, avgFillPrice: 70000, canceled: false }]; } };
    const gateway: OrderGateway = { async submit(o) { return o; }, async getOrder() { return null; }, async cancel() { throw new Error('no'); } };
    const om = new OrderManager(gateway, store, posStore, broker, logger, { now: () => 2 }, fills, fillSource);

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
