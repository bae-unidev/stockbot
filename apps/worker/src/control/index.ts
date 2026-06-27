/**
 * 운영 제어 서비스 — 대시보드 명령 큐(control_commands) 소비.
 *
 * 단일 매매 권한 원칙(10장): 대시보드는 KIS 를 직접 만지지 않고 명령만 적재하고,
 * 워커(매매 주체)가 여기서 OrderManager/RiskService 경유로 실행한다.
 *   - flatten  : 전 포지션 시장가 청산(봇은 계속 가동 → 다음 틱에 재진입 가능).
 *   - kill     : 킬스위치 ON(당일 신규매수 차단) + 전 포지션 시장가 청산.
 *   - kill_off : 킬스위치 해제(당일 재가동).
 * 청산 주문은 명령 id 기반 결정적 clientOrderId 로 멱등 — 폴링이 겹쳐도 이중 제출 안 됨.
 */
import type { OrderIntent } from '@stockbot/core';
import { isMarketOpen } from '../market/calendar.js';
import type { OrderManager } from '../order-manager/index.js';
import type { RiskService } from '../risk/index.js';
import type { ControlCommandRepo, PositionRepo } from '../db/repositories.js';
import type { Notifier } from '../notifier/index.js';
import type { Logger } from '../logger.js';

type Outcome = { status: 'done' | 'skipped'; result: unknown };

export class ControlService {
  constructor(
    private readonly commands: ControlCommandRepo,
    private readonly positions: PositionRepo,
    private readonly orderManager: OrderManager,
    private readonly risk: RiskService,
    private readonly notifier: Notifier,
    private readonly logger: Logger,
    private readonly clock: { now(): number } = { now: () => Date.now() },
  ) {}

  /** 대기 명령을 순서대로 실행. 스케줄러가 짧은 주기로 호출(now 주입 — 테스트/리플레이 동일 경로). */
  async processPending(now: number = this.clock.now()): Promise<number> {
    const pending = await this.commands.pending();
    if (pending.length === 0) return 0;
    let handled = 0;
    for (const cmd of pending) {
      try {
        const { status, result } = await this.execute(cmd.kind, cmd.id, now);
        await this.commands.finish(cmd.id, status, result);
        handled += 1;
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        await this.commands.finish(cmd.id, 'failed', { reason });
        await this.notifier.notify('warn', 'control command failed', { id: cmd.id, kind: cmd.kind, reason });
        this.logger.error({ id: cmd.id, kind: cmd.kind, err }, 'control command failed');
      }
    }
    return handled;
  }

  /**
   * 명령 정책은 전부 여기(워커)에 모은다 — 대시보드는 적재만, core 는 무관.
   * 장 운영시간 판정(거래소 캘린더)도 여기서 한다: 장외엔 주문을 KIS 로 던지지 않는다.
   *   - kill_off : 항상 가능(플래그 해제, 주문 없음).
   *   - kill     : 킬스위치 항상 ON(주문 아님). 청산은 장중에만, 장외면 보류.
   *   - flatten  : 장중에만 청산. 장외면 skipped(주문 미발생).
   */
  private async execute(kind: string, commandId: number, now: number): Promise<Outcome> {
    const open = isMarketOpen(now);
    switch (kind) {
      case 'kill_off':
        await this.risk.setKillSwitch(now, false);
        return { status: 'done', result: { killSwitch: false } };
      case 'kill': {
        await this.risk.setKillSwitch(now, true);
        if (!open) {
          this.logger.warn({ commandId }, 'kill: 시장 마감 — 킬스위치만 설정, 청산 보류');
          return { status: 'done', result: { killSwitch: true, liquidation: 'skipped: 시장 마감 — 개장 시 청산 규칙/수동 정리' } };
        }
        return { status: 'done', result: { killSwitch: true, ...(await this.liquidateAll(commandId)) } };
      }
      case 'flatten': {
        if (!open) {
          this.logger.warn({ commandId }, 'flatten: 시장 마감 — 청산 미실행(skipped)');
          return { status: 'skipped', result: { reason: '시장 마감 — 청산 미실행. 개장(평일 09:00~15:30 KST) 후 다시 시도하세요.' } };
        }
        return { status: 'done', result: await this.liquidateAll(commandId) };
      }
      default:
        throw new Error(`unknown command kind: ${kind}`);
    }
  }

  /** 보유 전 종목을 시장가로 청산하고 브로커 잔고로 재대사. */
  private async liquidateAll(commandId: number): Promise<{ liquidated: { symbol: string; qty: number }[]; rejected: { symbol: string; reason: string }[] }> {
    const held = (await this.positions.all()).filter((p) => p.quantity > 0);
    if (held.length === 0) {
      this.logger.info('liquidate-all: 보유 포지션 없음');
      return { liquidated: [], rejected: [] };
    }
    const intents: OrderIntent[] = held.map((p) => ({
      symbol: p.symbol,
      side: 'sell',
      type: 'market',
      quantity: p.quantity,
      reason: `manual liquidate (cmd ${commandId})`,
    }));
    // 명령 id 기반 멱등키 → 폴링 중복/재시도에도 이중 제출 방지.
    const result = await this.orderManager.place(intents, `ctrl${commandId}`);
    // 청산 결과를 잔고로 재대사(브로커=진실의 원천).
    await this.orderManager.reconcile();
    const liquidated = result.placed.map((o) => ({ symbol: o.symbol, qty: o.quantity }));
    const rejected = result.rejected.map((r) => ({ symbol: r.intent.symbol, reason: r.reason }));
    await this.notifier.notify('warn', 'manual liquidation', { commandId, liquidated, rejected: rejected.length });
    this.logger.warn({ commandId, liquidated: liquidated.length, rejected: rejected.length }, 'manual liquidate-all executed');
    return { liquidated, rejected };
  }
}
