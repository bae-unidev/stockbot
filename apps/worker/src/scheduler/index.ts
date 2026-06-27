/**
 * Scheduler(5장): 거래소 운영시간/휴장일 인지, 장중 hourly 틱 트리거(KST). in-process node-cron.
 * 워커는 요청 서버가 아니라 스케줄 기반 백그라운드 프로세스(2장).
 */
import cron from 'node-cron';
import { isMarketOpen } from '../market/calendar.js';
import type { Logger } from '../logger.js';

export interface SchedulerHooks {
  /** 장중 매시간 틱. */
  onHourlyTick: (now: number) => Promise<void>;
  /** 장중 매분 인트라아워 스탑 가드(틱 사이 손절 방어). */
  onStopGuard?: (now: number) => Promise<void>;
  /** 개장 전 워치리스트 산출(평일 08:30 KST). */
  onPreOpen?: (now: number) => Promise<void>;
  /** 장 마감 후 수집(평일 16:00 KST). */
  onPostClose?: (now: number) => Promise<void>;
  /** 대시보드 제어 명령 큐 폴링(상시, 10초). 장외에도 동작(킬스위치 해제 등). */
  onControlPoll?: (now: number) => Promise<void>;
}

export class Scheduler {
  private readonly tasks: cron.ScheduledTask[] = [];

  constructor(
    private readonly hooks: SchedulerHooks,
    private readonly logger: Logger,
  ) {}

  start(): void {
    // 매시간 정각(09~15시 KST). 휴장/장외면 스킵.
    this.tasks.push(
      cron.schedule(
        '0 9-15 * * 1-5',
        () => {
          const now = Date.now();
          if (!isMarketOpen(now)) {
            this.logger.debug('hourly tick skipped (market closed/holiday)');
            return;
          }
          void this.hooks.onHourlyTick(now).catch((err) => this.logger.error({ err }, 'hourly tick failed'));
        },
        { timezone: 'Asia/Seoul' },
      ),
    );

    // 매분 스탑 가드(09~15시 KST). 휴장/장외면 스킵.
    if (this.hooks.onStopGuard) {
      this.tasks.push(
        cron.schedule(
          '* 9-15 * * 1-5',
          () => {
            const now = Date.now();
            if (!isMarketOpen(now)) return;
            void this.hooks.onStopGuard!(now).catch((err) => this.logger.error({ err }, 'stop guard failed'));
          },
          { timezone: 'Asia/Seoul' },
        ),
      );
    }

    if (this.hooks.onPreOpen) {
      this.tasks.push(
        cron.schedule('30 8 * * 1-5', () => void this.hooks.onPreOpen!(Date.now()).catch((err) => this.logger.error({ err }, 'pre-open failed')), {
          timezone: 'Asia/Seoul',
        }),
      );
    }
    if (this.hooks.onPostClose) {
      this.tasks.push(
        cron.schedule('0 16 * * 1-5', () => void this.hooks.onPostClose!(Date.now()).catch((err) => this.logger.error({ err }, 'post-close failed')), {
          timezone: 'Asia/Seoul',
        }),
      );
    }

    // 제어 명령 폴링: 매 10초(6필드 cron). 장외에도 동작 — 킬스위치/정리는 시각 무관.
    if (this.hooks.onControlPoll) {
      this.tasks.push(
        cron.schedule('*/10 * * * * *', () => void this.hooks.onControlPoll!(Date.now()).catch((err) => this.logger.error({ err }, 'control poll failed')), {
          timezone: 'Asia/Seoul',
        }),
      );
    }

    this.logger.info({ tasks: this.tasks.length }, 'scheduler started (KST)');
  }

  stop(): void {
    for (const t of this.tasks) t.stop();
    this.tasks.length = 0;
  }
}
