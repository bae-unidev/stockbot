/** Postgres repository — 도메인 타입 ↔ 테이블 매핑을 한 곳에 가둔다(State Store, 5장). */
import { and, asc, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import type { Bar, EventScore, Fill, Order, Position, Symbol, Timeframe } from '@stockbot/core';
import type { DB } from './client.js';
import * as s from './schema.js';

// ── bars ──
export class BarRepo {
  constructor(private db: DB) {}

  async upsertMany(rows: Bar[]): Promise<number> {
    if (rows.length === 0) return 0;
    const values = rows.map((b) => ({
      symbol: b.symbol,
      timeframe: b.timeframe,
      ts: new Date(b.ts),
      open: b.open,
      high: b.high,
      low: b.low,
      close: b.close,
      volume: b.volume,
      adjusted: b.adjusted,
      source: b.source,
    }));
    // 청크 단위 upsert(파라미터 한도 회피).
    let n = 0;
    for (let i = 0; i < values.length; i += 500) {
      const chunk = values.slice(i, i + 500);
      await this.db
        .insert(s.bars)
        .values(chunk)
        .onConflictDoUpdate({
          target: [s.bars.symbol, s.bars.timeframe, s.bars.ts],
          set: {
            open: sql`excluded.open`,
            high: sql`excluded.high`,
            low: sql`excluded.low`,
            close: sql`excluded.close`,
            volume: sql`excluded.volume`,
            adjusted: sql`excluded.adjusted`,
            source: sql`excluded.source`,
          },
        });
      n += chunk.length;
    }
    return n;
  }

  /** asOf 이전 마지막 limit개 봉(시각 오름차순). point-in-time. */
  async getBars(symbol: Symbol, timeframe: Timeframe, asOf: number, limit: number): Promise<Bar[]> {
    const rows = await this.db
      .select()
      .from(s.bars)
      .where(
        and(eq(s.bars.symbol, symbol), eq(s.bars.timeframe, timeframe), lte(s.bars.ts, new Date(asOf))),
      )
      .orderBy(desc(s.bars.ts))
      .limit(limit);
    return rows.reverse().map(mapBar);
  }

  async getRange(symbol: Symbol, timeframe: Timeframe, from: number, to: number): Promise<Bar[]> {
    const rows = await this.db
      .select()
      .from(s.bars)
      .where(
        and(
          eq(s.bars.symbol, symbol),
          eq(s.bars.timeframe, timeframe),
          gte(s.bars.ts, new Date(from)),
          lte(s.bars.ts, new Date(to)),
        ),
      )
      .orderBy(asc(s.bars.ts));
    return rows.map(mapBar);
  }

  async lastTs(source: string, symbol: Symbol, timeframe: Timeframe): Promise<number | null> {
    const rows = await this.db
      .select({ ts: s.bars.ts })
      .from(s.bars)
      .where(and(eq(s.bars.symbol, symbol), eq(s.bars.timeframe, timeframe), eq(s.bars.source, source)))
      .orderBy(desc(s.bars.ts))
      .limit(1);
    return rows[0] ? rows[0].ts.getTime() : null;
  }
}

function mapBar(r: typeof s.bars.$inferSelect): Bar {
  return {
    symbol: r.symbol,
    timeframe: r.timeframe as Timeframe,
    ts: r.ts.getTime(),
    open: r.open,
    high: r.high,
    low: r.low,
    close: r.close,
    volume: r.volume,
    adjusted: r.adjusted,
    source: r.source,
  };
}

// ── orders / fills / positions ──
export class OrderRepo {
  constructor(private db: DB) {}

  async upsert(o: Order, reason?: string): Promise<void> {
    await this.db
      .insert(s.orders)
      .values({
        clientOrderId: o.clientOrderId,
        brokerOrderId: o.brokerOrderId,
        symbol: o.symbol,
        side: o.side,
        type: o.type,
        quantity: o.quantity,
        limitPrice: o.limitPrice,
        status: o.status,
        filledQuantity: o.filledQuantity,
        avgFillPrice: o.avgFillPrice,
        reason,
        createdAt: new Date(o.createdAt),
        updatedAt: new Date(o.updatedAt),
      })
      .onConflictDoUpdate({
        target: s.orders.clientOrderId,
        set: {
          brokerOrderId: o.brokerOrderId,
          status: o.status,
          filledQuantity: o.filledQuantity,
          avgFillPrice: o.avgFillPrice,
          // reason 은 제공됐을 때만 갱신(대사 시 reason 미전달 → 기존 사유 보존).
          reason: reason !== undefined ? reason : sql`${s.orders.reason}`,
          updatedAt: new Date(o.updatedAt),
        },
      });
  }

  async get(clientOrderId: string): Promise<Order | null> {
    const rows = await this.db.select().from(s.orders).where(eq(s.orders.clientOrderId, clientOrderId)).limit(1);
    return rows[0] ? mapOrder(rows[0]) : null;
  }

  /** 미종결(완전체결/거부/취소 이외) 주문 — 크래시 복구 시 대사 대상. */
  async openOrders(): Promise<Order[]> {
    const rows = await this.db
      .select()
      .from(s.orders)
      .where(inArray(s.orders.status, ['new', 'submitted', 'accepted', 'partially_filled']));
    return rows.map(mapOrder);
  }
}

function mapOrder(r: typeof s.orders.$inferSelect): Order {
  return {
    clientOrderId: r.clientOrderId,
    brokerOrderId: r.brokerOrderId ?? undefined,
    symbol: r.symbol,
    side: r.side as Order['side'],
    type: r.type as Order['type'],
    quantity: r.quantity,
    limitPrice: r.limitPrice ?? undefined,
    status: r.status as Order['status'],
    filledQuantity: r.filledQuantity,
    avgFillPrice: r.avgFillPrice ?? undefined,
    createdAt: r.createdAt.getTime(),
    updatedAt: r.updatedAt.getTime(),
  };
}

export class FillRepo {
  constructor(private db: DB) {}

  /** 브로커 체결 식별자로 멱등 적재(대사 중복 방지). */
  async record(f: Fill & { brokerFillId?: string }): Promise<void> {
    await this.db.insert(s.fills).values({
      clientOrderId: f.clientOrderId,
      brokerOrderId: f.brokerOrderId,
      symbol: f.symbol,
      side: f.side,
      quantity: f.quantity,
      price: f.price,
      fee: f.fee,
      tax: f.tax,
      ts: new Date(f.ts),
      brokerFillId: f.brokerFillId,
    });
  }

  /** brokerFillId 충돌 시 무시(대사 재실행 시 중복 적재 방지, 10장-2). */
  async recordIfNew(f: Fill & { brokerFillId?: string }): Promise<void> {
    await this.db
      .insert(s.fills)
      .values({
        clientOrderId: f.clientOrderId,
        brokerOrderId: f.brokerOrderId,
        symbol: f.symbol,
        side: f.side,
        quantity: f.quantity,
        price: f.price,
        fee: f.fee,
        tax: f.tax,
        ts: new Date(f.ts),
        brokerFillId: f.brokerFillId,
      })
      .onConflictDoNothing({ target: s.fills.brokerFillId });
  }
}

export class PositionRepo {
  constructor(private db: DB) {}

  /** 대사 결과로 포지션 전체 교체(브로커가 진실의 원천, 10장-2·4). highWaterMark·scaledOut 보존. */
  async reconcile(positions: Position[]): Promise<void> {
    await this.db.transaction(async (tx) => {
      const existing = await tx.select().from(s.positions);
      const prev = new Map(existing.map((e) => [e.symbol, e]));
      await tx.delete(s.positions);
      if (positions.length === 0) return;
      await tx.insert(s.positions).values(
        positions.map((p) => ({
          symbol: p.symbol,
          quantity: p.quantity,
          avgPrice: p.avgPrice,
          highWaterMark: Math.max(prev.get(p.symbol)?.highWaterMark ?? p.avgPrice, p.avgPrice),
          scaledOut: prev.get(p.symbol)?.scaledOut ?? false,
          // 기존 보유면 진입시각 유지, 신규 보유면 지금을 진입시각으로.
          entryTs: prev.get(p.symbol)?.entryTs ?? new Date(),
          updatedAt: new Date(),
        })),
      );
    });
  }

  async all(): Promise<(Position & { highWaterMark: number | null; scaledOut: boolean; entryTs: number | null })[]> {
    const rows = await this.db.select().from(s.positions);
    return rows.map((r) => ({ symbol: r.symbol, quantity: r.quantity, avgPrice: r.avgPrice, highWaterMark: r.highWaterMark, scaledOut: r.scaledOut, entryTs: r.entryTs ? r.entryTs.getTime() : null }));
  }

  async bumpHighWaterMark(symbol: Symbol, price: number): Promise<void> {
    await this.db
      .update(s.positions)
      .set({ highWaterMark: sql`GREATEST(COALESCE(${s.positions.highWaterMark}, 0), ${price})`, updatedAt: new Date() })
      .where(eq(s.positions.symbol, symbol));
  }

  async setScaledOut(symbol: Symbol, scaledOut: boolean): Promise<void> {
    await this.db.update(s.positions).set({ scaledOut, updatedAt: new Date() }).where(eq(s.positions.symbol, symbol));
  }
}

// ── event scores (point-in-time) ──
export class EventScoreRepo {
  constructor(private db: DB) {}

  async getScores(symbols: Symbol[], asOf: number): Promise<EventScore[]> {
    if (symbols.length === 0) return [];
    const rows = await this.db
      .select()
      .from(s.eventScores)
      .where(and(inArray(s.eventScores.symbol, symbols), lte(s.eventScores.publishedAt, new Date(asOf))));
    return rows.map((r) => ({
      symbol: r.symbol,
      sentiment: r.sentiment,
      eventType: r.eventType ?? 'unknown',
      confidence: r.confidence,
      publishedAt: r.publishedAt.getTime(),
      scoredAt: r.scoredAt.getTime(),
    }));
  }
}

// ── tick runs ──
export class TickRunRepo {
  constructor(private db: DB) {}

  async start(startedAt?: number): Promise<number> {
    const values = startedAt != null ? { status: 'running', startedAt: new Date(startedAt) } : { status: 'running' };
    const rows = await this.db.insert(s.tickRuns).values(values).returning({ id: s.tickRuns.id });
    return rows[0]!.id;
  }

  async finish(id: number, patch: { status: string; intentsCount?: number; ordersCount?: number; equity?: number; cash?: number; detail?: unknown; error?: string }): Promise<void> {
    await this.db
      .update(s.tickRuns)
      .set({
        finishedAt: new Date(),
        status: patch.status,
        intentsCount: patch.intentsCount ?? 0,
        ordersCount: patch.ordersCount ?? 0,
        equity: patch.equity,
        cash: patch.cash,
        detail: patch.detail as never,
        error: patch.error,
      })
      .where(eq(s.tickRuns.id, id));
  }
}

// ── 운영 제어 명령 큐 ──
export interface ControlCommand {
  id: number;
  kind: 'flatten' | 'kill' | 'kill_off';
  status: 'pending' | 'done' | 'failed' | 'skipped';
}

export class ControlCommandRepo {
  constructor(private db: DB) {}

  /** 대기 중 명령을 생성순으로 반환. */
  async pending(): Promise<ControlCommand[]> {
    const rows = await this.db
      .select({ id: s.controlCommands.id, kind: s.controlCommands.kind, status: s.controlCommands.status })
      .from(s.controlCommands)
      .where(eq(s.controlCommands.status, 'pending'))
      .orderBy(s.controlCommands.id);
    return rows as ControlCommand[];
  }

  async finish(id: number, status: 'done' | 'failed' | 'skipped', result: unknown): Promise<void> {
    await this.db
      .update(s.controlCommands)
      .set({ status, executedAt: new Date(), result: result as never })
      .where(eq(s.controlCommands.id, id));
  }
}

// ── risk state ──
export class RiskStateRepo {
  constructor(private db: DB) {}

  async get(date: string): Promise<{ dailyLossPct: number; killSwitch: boolean; startEquity: number | null } | null> {
    const rows = await this.db.select().from(s.riskState).where(eq(s.riskState.date, date)).limit(1);
    return rows[0] ? { dailyLossPct: rows[0].dailyLossPct, killSwitch: rows[0].killSwitch, startEquity: rows[0].startEquity } : null;
  }

  async upsert(date: string, patch: { startEquity?: number; dailyLossPct?: number; killSwitch?: boolean }): Promise<void> {
    await this.db
      .insert(s.riskState)
      .values({ date, startEquity: patch.startEquity, dailyLossPct: patch.dailyLossPct ?? 0, killSwitch: patch.killSwitch ?? false, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: s.riskState.date,
        set: {
          startEquity: patch.startEquity != null ? patch.startEquity : sql`${s.riskState.startEquity}`,
          dailyLossPct: patch.dailyLossPct != null ? patch.dailyLossPct : sql`${s.riskState.dailyLossPct}`,
          killSwitch: patch.killSwitch != null ? patch.killSwitch : sql`${s.riskState.killSwitch}`,
          updatedAt: new Date(),
        },
      });
  }
}

export interface Repos {
  bars: BarRepo;
  orders: OrderRepo;
  fills: FillRepo;
  positions: PositionRepo;
  eventScores: EventScoreRepo;
  tickRuns: TickRunRepo;
  riskState: RiskStateRepo;
  controlCommands: ControlCommandRepo;
}

export function createRepos(db: DB): Repos {
  return {
    bars: new BarRepo(db),
    orders: new OrderRepo(db),
    fills: new FillRepo(db),
    positions: new PositionRepo(db),
    eventScores: new EventScoreRepo(db),
    tickRuns: new TickRunRepo(db),
    riskState: new RiskStateRepo(db),
    controlCommands: new ControlCommandRepo(db),
  };
}
