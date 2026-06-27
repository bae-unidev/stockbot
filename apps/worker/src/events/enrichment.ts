/**
 * LLM Enrichment(8장): 헤드라인/공시 요지 → {sentiment, event_type, confidence} 구조화 추출.
 * 원칙: LLM 은 트리거가 아니라 팩터를 만든다. 점수만 생성, 주문 결정은 규칙 엔진.
 * 고정 스케일([-1,+1]) + structured output + 낮은 temperature + 고정 루브릭.
 * 원문 출력·파싱점수·모델명·프롬프트 버전·scored_at 저장.
 */
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import type { DB } from '../db/client.js';
import * as schema from '../db/schema.js';
import type { EventIngestion } from './ingestion.js';
import type { Logger } from '../logger.js';

const ScoreSchema = z.object({
  sentiment: z.number().min(-1).max(1),
  event_type: z.string(),
  confidence: z.number().min(0).max(1),
  rationale: z.string(),
});
type Score = z.infer<typeof ScoreSchema>;

// 고정 루브릭 — 프롬프트 버전과 함께 변경 이력 관리.
const RUBRIC = `너는 한국 주식 공시/뉴스의 감성을 분류하는 도구다. 절대 매매 조언을 하지 않는다.
주어진 공시/뉴스 제목(과 본문)에 대해 해당 종목 주가에 대한 단기 감성을 평가한다.
- sentiment: -1.0(매우 부정) ~ +1.0(매우 긍정). 중립이면 0.
- event_type: 간단한 분류(예: earnings, guidance, mna, lawsuit, supply, buyback, dividend, etc.).
- confidence: 0~1, 판단 확신도.
- rationale: 한 줄 근거.
정보가 모호하면 sentiment 를 0 근처, confidence 를 낮게.`;

const JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    sentiment: { type: 'number' },
    event_type: { type: 'string' },
    confidence: { type: 'number' },
    rationale: { type: 'string' },
  },
  required: ['sentiment', 'event_type', 'confidence', 'rationale'],
} as const;

export class EventEnrichment {
  private readonly client: Anthropic;

  constructor(
    private readonly db: DB,
    private readonly ingestion: EventIngestion,
    private readonly logger: Logger,
    private readonly opts: { apiKey: string; model: string; promptVersion: string },
  ) {
    this.client = new Anthropic({ apiKey: opts.apiKey });
  }

  /** 미점수 이벤트를 일괄 점수화해 event_scores 에 저장. 처리 건수 반환. */
  async scorePending(limit = 25): Promise<number> {
    const pending = await this.ingestion.unscored(limit);
    let scored = 0;
    for (const e of pending) {
      try {
        const { score, raw } = await this.scoreOne(e.title, e.body);
        await this.db.insert(schema.eventScores).values({
          eventId: e.id,
          symbol: e.symbol,
          sentiment: score.sentiment,
          eventType: score.event_type,
          confidence: score.confidence,
          rawOutput: raw,
          model: this.opts.model,
          promptVersion: this.opts.promptVersion,
          publishedAt: new Date(e.publishedAt),
        });
        scored += 1;
      } catch (err) {
        this.logger.error({ err, eventId: e.id }, 'event scoring failed');
      }
    }
    this.logger.info({ scored, pending: pending.length }, 'event enrichment done');
    return scored;
  }

  private async scoreOne(title: string, body: string | null): Promise<{ score: Score; raw: unknown }> {
    const content = body ? `${title}\n\n${body}` : title;
    const res = await this.client.messages.create({
      model: this.opts.model,
      max_tokens: 512,
      temperature: 0, // 결정적 루브릭(8장)
      system: RUBRIC,
      output_config: { format: { type: 'json_schema', schema: JSON_SCHEMA } },
      messages: [{ role: 'user', content: `다음 공시/뉴스를 평가:\n${content}` }],
    } as Anthropic.MessageCreateParamsNonStreaming);

    const textBlock = res.content.find((b) => b.type === 'text');
    if (!textBlock || textBlock.type !== 'text') throw new Error('no text block in LLM response');
    const parsed = JSON.parse(textBlock.text);
    const score = ScoreSchema.parse(parsed); // 스키마 강제 — 어긋나면 throw
    return { score, raw: parsed };
  }
}
