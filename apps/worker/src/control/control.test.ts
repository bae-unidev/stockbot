import { describe, expect, it, vi } from 'vitest';
import { ControlService } from './index.js';
import type { ControlCommand } from '../db/repositories.js';
import type { OrderIntent } from '@stockbot/core';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
const notifier = { async notify() {} } as never;

function fakeCommands(pending: ControlCommand[]) {
  const finished: { id: number; status: string; result: unknown }[] = [];
  return {
    finished,
    async pending() { return pending; },
    async finish(id: number, status: 'done' | 'failed', result: unknown) { finished.push({ id, status, result }); },
  };
}

function fakePositions(held: { symbol: string; quantity: number }[]) {
  return { async all() { return held.map((h) => ({ ...h, avgPrice: 1000, highWaterMark: null, scaledOut: false, entryTs: null })); } };
}

function fakeOrderManager() {
  const placed: { intents: OrderIntent[]; tickId: string | number }[] = [];
  let reconciled = 0;
  return {
    placed,
    reconciledCount: () => reconciled,
    async place(intents: OrderIntent[], tickId: string | number) {
      placed.push({ intents, tickId });
      return { placed: intents.map((i) => ({ symbol: i.symbol, quantity: i.quantity })), skipped: [], rejected: [] };
    },
    async reconcile() { reconciled++; return { cash: 0, positions: [] }; },
  };
}

function fakeRisk() {
  const calls: { on: boolean }[] = [];
  return { calls, async setKillSwitch(_now: number, on: boolean) { calls.push({ on }); } };
}

const clock = { now: () => 1_000 };
// 장중/장외 고정 시각(KST). 2026-06-29(월) 10:30 = 개장, 2026-06-27(토) = 휴장.
const OPEN = Date.UTC(2026, 5, 29, 1, 30); // 10:30 KST 월요일
const CLOSED = Date.UTC(2026, 5, 27, 1, 30); // 토요일

describe('ControlService 명령 큐 실행 (장중)', () => {
  it('flatten: 보유 전 종목 시장가 매도 + 재대사, 명령 done 처리', async () => {
    const commands = fakeCommands([{ id: 7, kind: 'flatten', status: 'pending' }]);
    const positions = fakePositions([{ symbol: '005930', quantity: 10 }, { symbol: '000660', quantity: 3 }]);
    const om = fakeOrderManager();
    const risk = fakeRisk();
    const svc = new ControlService(commands as never, positions as never, om as never, risk as never, notifier, logger, clock);

    const n = await svc.processPending(OPEN);
    expect(n).toBe(1);
    expect(om.placed).toHaveLength(1);
    expect(om.placed[0]!.intents.every((i) => i.side === 'sell' && i.type === 'market')).toBe(true);
    expect(om.placed[0]!.intents.map((i) => i.quantity)).toEqual([10, 3]);
    expect(om.placed[0]!.tickId).toBe('ctrl7'); // 명령 id 기반 멱등키
    expect(om.reconciledCount()).toBe(1);
    expect(risk.calls).toHaveLength(0); // flatten 은 킬스위치 안 건드림
    expect(commands.finished[0]).toMatchObject({ id: 7, status: 'done' });
  });

  it('kill: 킬스위치 ON + 전량 청산', async () => {
    const commands = fakeCommands([{ id: 8, kind: 'kill', status: 'pending' }]);
    const positions = fakePositions([{ symbol: '005930', quantity: 5 }]);
    const om = fakeOrderManager();
    const risk = fakeRisk();
    const svc = new ControlService(commands as never, positions as never, om as never, risk as never, notifier, logger, clock);

    await svc.processPending(OPEN);
    expect(risk.calls).toEqual([{ on: true }]);
    expect(om.placed[0]!.intents).toHaveLength(1);
    expect(commands.finished[0]!.status).toBe('done');
  });

  it('kill_off: 킬스위치 해제만, 청산 없음 (장외에도 가능)', async () => {
    const commands = fakeCommands([{ id: 9, kind: 'kill_off', status: 'pending' }]);
    const om = fakeOrderManager();
    const risk = fakeRisk();
    const svc = new ControlService(commands as never, fakePositions([{ symbol: '005930', quantity: 5 }]) as never, om as never, risk as never, notifier, logger, clock);

    await svc.processPending(CLOSED);
    expect(risk.calls).toEqual([{ on: false }]);
    expect(om.placed).toHaveLength(0);
    expect(commands.finished[0]!.status).toBe('done');
  });

  it('알 수 없는 명령은 failed 로 마킹', async () => {
    const commands = fakeCommands([{ id: 11, kind: 'bogus' as never, status: 'pending' }]);
    const om = fakeOrderManager();
    const svc = new ControlService(commands as never, fakePositions([]) as never, om as never, fakeRisk() as never, notifier, logger, clock);
    await svc.processPending(OPEN);
    expect(commands.finished[0]!.status).toBe('failed');
  });
});

describe('ControlService 장 운영시간 게이트 (장외)', () => {
  it('flatten: 장외면 주문 미발생 + skipped', async () => {
    const commands = fakeCommands([{ id: 20, kind: 'flatten', status: 'pending' }]);
    const om = fakeOrderManager();
    const svc = new ControlService(commands as never, fakePositions([{ symbol: '005930', quantity: 5 }]) as never, om as never, fakeRisk() as never, notifier, logger, clock);

    await svc.processPending(CLOSED);
    expect(om.placed).toHaveLength(0); // KIS 로 주문 안 던짐
    expect(commands.finished[0]!.status).toBe('skipped');
  });

  it('kill: 장외면 킬스위치만 ON, 청산은 보류(done)', async () => {
    const commands = fakeCommands([{ id: 21, kind: 'kill', status: 'pending' }]);
    const om = fakeOrderManager();
    const risk = fakeRisk();
    const svc = new ControlService(commands as never, fakePositions([{ symbol: '005930', quantity: 5 }]) as never, om as never, risk as never, notifier, logger, clock);

    await svc.processPending(CLOSED);
    expect(risk.calls).toEqual([{ on: true }]); // 킬스위치는 설정됨
    expect(om.placed).toHaveLength(0); // 청산 주문은 미발생
    expect(commands.finished[0]!.status).toBe('done');
  });
});
