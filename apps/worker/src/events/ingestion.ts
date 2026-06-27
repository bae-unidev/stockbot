/**
 * 이벤트 수집(8장): Open DART 공시 신규 폴링(주), 네이버 뉴스(보조).
 * 각 이벤트에 published_at 기록. externalId 로 중복 수집 방지(멱등).
 * 비공식/외부 소스는 try/catch + 로깅 필수(16장).
 */
import { z } from 'zod';
import { eq, isNull } from 'drizzle-orm';
import { DateTime } from 'luxon';
import { KST } from '../market/calendar.js';
import type { DB } from '../db/client.js';
import * as schema from '../db/schema.js';
import type { Logger } from '../logger.js';

const DartListResponse = z.object({
  status: z.string(),
  message: z.string(),
  list: z
    .array(
      z.object({
        rcept_no: z.string(),
        corp_name: z.string(),
        stock_code: z.string().optional(),
        report_nm: z.string(),
        rcept_dt: z.string(), // YYYYMMDD
        corp_cls: z.string().optional(),
      }),
    )
    .optional(),
});

export interface IngestedEvent {
  symbol: string | null;
  source: 'dart' | 'news';
  eventType: string | null;
  title: string;
  body: string | null;
  externalId: string;
  publishedAt: number;
}

export class EventIngestion {
  constructor(
    private readonly db: DB,
    private readonly logger: Logger,
    private readonly dartApiKey?: string,
  ) {}

  /** DART 공시 목록 폴링(특정 일자 구간). 신규만 저장. */
  async pollDart(from: string, to: string): Promise<number> {
    if (!this.dartApiKey) {
      this.logger.warn('DART_API_KEY 미설정 — DART 수집 스킵');
      return 0;
    }
    const events: IngestedEvent[] = [];
    try {
      const url = new URL('https://opendart.fss.or.kr/api/list.json');
      url.searchParams.set('crtfc_key', this.dartApiKey);
      url.searchParams.set('bgn_de', from);
      url.searchParams.set('end_de', to);
      url.searchParams.set('page_count', '100');
      const res = await fetch(url);
      if (!res.ok) throw new Error(`DART HTTP ${res.status}`);
      const parsed = DartListResponse.parse(await res.json());
      if (parsed.status !== '000' || !parsed.list) {
        this.logger.info({ status: parsed.status, msg: parsed.message }, 'DART: no new disclosures');
        return 0;
      }
      for (const d of parsed.list) {
        events.push({
          symbol: d.stock_code && d.stock_code.trim() ? d.stock_code.trim() : null,
          source: 'dart',
          eventType: 'disclosure',
          title: `[${d.corp_name}] ${d.report_nm}`,
          body: null,
          externalId: d.rcept_no,
          // 공시 일자(KST 09:00 기준 근사 — 공개시각이 분단위로 제공되지 않을 때).
          publishedAt: DateTime.fromFormat(d.rcept_dt, 'yyyyMMdd', { zone: KST }).set({ hour: 9 }).toMillis(),
        });
      }
    } catch (err) {
      this.logger.error({ err }, 'DART poll failed (external source)');
      return 0;
    }
    return this.store(events);
  }

  /** 멱등 저장: (source, externalId) 충돌 시 무시. 새로 저장한 건수 반환. */
  private async store(events: IngestedEvent[]): Promise<number> {
    let stored = 0;
    for (const e of events) {
      // 종목코드 없는 공시는 점수화 대상이 아니므로 스킵(저장은 하되 symbol null).
      const inserted = await this.db
        .insert(schema.events)
        .values({
          symbol: e.symbol,
          source: e.source,
          eventType: e.eventType,
          title: e.title,
          body: e.body,
          externalId: e.externalId,
          publishedAt: new Date(e.publishedAt),
        })
        .onConflictDoNothing({ target: [schema.events.source, schema.events.externalId] })
        .returning({ id: schema.events.id });
      if (inserted.length) stored += 1;
    }
    this.logger.info({ stored, seen: events.length }, 'DART events stored');
    return stored;
  }

  /** 아직 점수화되지 않은 (종목 보유) 이벤트 조회 — enrichment 대상. */
  async unscored(limit = 50): Promise<{ id: number; symbol: string; title: string; body: string | null; publishedAt: number }[]> {
    const rows = await this.db
      .select({
        id: schema.events.id,
        symbol: schema.events.symbol,
        title: schema.events.title,
        body: schema.events.body,
        publishedAt: schema.events.publishedAt,
      })
      .from(schema.events)
      .leftJoin(schema.eventScores, eq(schema.eventScores.eventId, schema.events.id))
      .where(isNull(schema.eventScores.id))
      .limit(limit);
    // symbol null 제외
    return rows
      .filter((r) => r.symbol)
      .map((r) => ({ id: r.id, symbol: r.symbol!, title: r.title, body: r.body, publishedAt: r.publishedAt.getTime() }));
  }
}
