/**
 * Notifier(5장): 틱 실패/주문 거부/킬스위치 알림. 웹훅 URL 은 환경변수(시크릿 아님).
 * 실패를 조용히 넘기지 않는다(16장) — 알림 전송 실패도 로깅.
 */
import type { Logger } from '../logger.js';

export type AlertLevel = 'info' | 'warn' | 'critical';

export class Notifier {
  constructor(
    private readonly logger: Logger,
    private readonly webhookUrl?: string,
  ) {}

  async notify(level: AlertLevel, title: string, detail?: Record<string, unknown>): Promise<void> {
    const payload = { level, title, detail, ts: new Date().toISOString(), service: 'stockbot-worker' };
    // 항상 로깅(웹훅 유무와 무관).
    if (level === 'critical') this.logger.error(payload, title);
    else if (level === 'warn') this.logger.warn(payload, title);
    else this.logger.info(payload, title);

    if (!this.webhookUrl) return;
    try {
      const res = await fetch(this.webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: `[${level.toUpperCase()}] ${title}`, ...payload }),
      });
      if (!res.ok) this.logger.warn({ status: res.status }, 'notifier webhook non-2xx');
    } catch (err) {
      this.logger.warn({ err }, 'notifier webhook failed');
    }
  }
}
