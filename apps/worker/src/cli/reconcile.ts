/**
 * 주문/체결 대사 백필: `pnpm reconcile [--days N] [--repair]` (기본 90일).
 * 기간 내 모든 평일의 KIS 일별체결을 조회해 미종결 주문을 확정하고, 빠진 fills(봇 주문기록 없는 체결 포함)를 적재한다.
 * 워커 틱은 최근 30일만 보므로, 그보다 오래 멈춰 있던 주문을 한 번에 정리할 때 쓴다(KIS 는 읽기 조회만, 주문 안 냄).
 *
 * --repair: 이미 적재된 fills 를 브로커 원장 기준으로 보정한다(로컬 DB 갱신).
 *   - ts: KIS 주문시각(ord_dt+ord_tmd). 예전 적재분은 일자 09:00 으로 뭉개져 같은 날 매수·매도 순서가 흔들렸다.
 *   - 흡수 주문(kis-*)의 created_at 도 같은 시각으로.
 *   - 수수료·세금: 현재 비용 상수(DEFAULT_SIM_COSTS)로 재계산.
 */
import '../bootstrap.js';
import { and, eq, like } from 'drizzle-orm';
import { buildContainer, logger } from '../container.js';
import { tradingDateKey } from '../market/calendar.js';
import { DEFAULT_SIM_COSTS } from '../adapters/backtest/sim-broker.js';
import * as s from '../db/schema.js';
import type { BrokerFill, FillSource } from '../order-manager/index.js';

async function main() {
  const argv = process.argv.slice(2);
  const i = argv.indexOf('--days');
  const lookbackDays = i >= 0 ? Number(argv[i + 1]) : 90;
  const repair = argv.includes('--repair');
  const c = buildContainer();
  if (!c.orderManager || !c.kis) {
    logger.error('KIS 모의투자 자격증명이 없어 주문 관리자가 비활성입니다(.env MOCK_KIS_* 확인).');
    await c.shutdown();
    process.exit(1);
  }
  const before = (await c.repos.orders.openOrders()).length;
  await c.orderManager.reconcileOrders(tradingDateKey(Date.now()).replace(/-/g, ''), { lookbackDays, scanAllDays: true });
  const after = (await c.repos.orders.openOrders()).length;
  logger.info({ lookbackDays, openBefore: before, openAfter: after }, '주문 대사 백필 완료');

  if (repair) await repairFills(c.db, c.kis.orders, lookbackDays);
  await c.shutdown();
}

async function repairFills(db: ReturnType<typeof buildContainer>['db'], source: FillSource, lookbackDays: number) {
  const fills = await db.select().from(s.fills);
  const orders = await db.select({ clientOrderId: s.orders.clientOrderId, createdAt: s.orders.createdAt }).from(s.orders);
  const orderDay = new Map(orders.map((o) => [o.clientOrderId, tradingDateKey(o.createdAt.getTime()).replace(/-/g, '')]));

  const byDate = new Map<string, Map<string, BrokerFill>>();
  const now = Date.now();
  for (let t = now - lookbackDays * 86_400_000; t <= now; t += 86_400_000) {
    const wd = new Date(t + 9 * 3600_000).getUTCDay();
    if (wd === 0 || wd === 6) continue;
    const d = tradingDateKey(t).replace(/-/g, '');
    const rows = await source.inquireDailyFills(d, d);
    byDate.set(d, new Map(rows.map((r) => [r.brokerOrderId, r])));
  }

  let fixedTs = 0;
  let fixedCost = 0;
  let missing = 0;
  for (const f of fills) {
    const d = orderDay.get(f.clientOrderId) ?? tradingDateKey(f.ts.getTime()).replace(/-/g, '');
    const bf = f.brokerOrderId ? byDate.get(d)?.get(f.brokerOrderId) : undefined;
    if (!bf || bf.symbol !== f.symbol || bf.side !== f.side || bf.ts == null) {
      missing++;
      continue;
    }
    const gross = f.price * f.quantity;
    const fee = Math.round(gross * DEFAULT_SIM_COSTS.commissionRate);
    const tax = f.side === 'sell' ? Math.round(gross * DEFAULT_SIM_COSTS.sellTaxRate) : 0;
    const set: Partial<typeof s.fills.$inferInsert> = {};
    if (f.ts.getTime() !== bf.ts) set.ts = new Date(bf.ts);
    if (f.fee !== fee || f.tax !== tax) Object.assign(set, { fee, tax });
    if (Object.keys(set).length === 0) continue;
    await db.update(s.fills).set(set).where(eq(s.fills.id, f.id));
    if (set.ts) fixedTs++;
    if (set.tax !== undefined) fixedCost++;
    if (set.ts && f.clientOrderId.startsWith('kis-')) {
      await db.update(s.orders).set({ createdAt: set.ts }).where(and(eq(s.orders.clientOrderId, f.clientOrderId), like(s.orders.clientOrderId, 'kis-%')));
    }
  }
  logger.info({ fills: fills.length, fixedTs, fixedCost, notInLedger: missing }, 'fills 보정 완료(브로커 원장 기준)');
}

main().catch((err) => {
  logger.error({ err }, 'reconcile cli failed');
  process.exit(1);
});
