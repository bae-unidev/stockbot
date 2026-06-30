/**
 * 일별 섹터 신호(8장 확장): 네이버 주요뉴스 헤드라인 → LLM 으로 섹터별 그날 강세/약세 점수.
 * 원칙(8장): LLM 은 트리거가 아니라 팩터. 점수만 만들고 매수 결정은 규칙 엔진(워치리스트 가중).
 * 결정적 루브릭 + temperature 0 + 고정 스케일 + 원문/모델/프롬프트버전 저장.
 */
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { sql } from 'drizzle-orm';
import { fetchNaverMainNews } from './news.js';
import { SECTORS } from '../sectors.js';
import { tradingDateKey } from '../market/calendar.js';
import * as schema from '../db/schema.js';
import type { DB } from '../db/client.js';
import type { Logger } from '../logger.js';

const SectorScore = z.object({ sector: z.string(), score: z.number().min(-1).max(1), rationale: z.string() });
const Result = z.object({ sectors: z.array(SectorScore) });

const RUBRIC = `너는 한국 증시 뉴스에서 그날의 섹터 분위기를 분류하는 도구다. 절대 매매 조언을 하지 않는다.
주어진 오늘의 주요뉴스 헤드라인들을 보고, 아래 섹터 각각에 대해 "오늘 단기 강세/약세 분위기"를 평가한다.
- score: -1.0(뚜렷한 악재/약세) ~ +1.0(뚜렷한 호재/강세). 관련 뉴스가 없거나 모호하면 0.
- rationale: 한 줄 근거(어떤 헤드라인 때문인지).
모든 섹터를 빠짐없이 포함하라. 추측을 자제하고 헤드라인에 실제 근거가 있을 때만 0에서 벗어나라.`;

const JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    sectors: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: { sector: { type: 'string' }, score: { type: 'number' }, rationale: { type: 'string' } },
        required: ['sector', 'score', 'rationale'],
      },
    },
  },
  required: ['sectors'],
} as const;

export class SectorSignalService {
  private readonly client: Anthropic | null;
  constructor(
    private readonly db: DB,
    private readonly logger: Logger,
    private readonly opts: { apiKey?: string; model: string; promptVersion: string },
  ) {
    this.client = opts.apiKey ? new Anthropic({ apiKey: opts.apiKey }) : null;
  }

  /** 오늘 뉴스로 섹터 신호를 산출해 sector_signals 에 적재. 적재 섹터 수 반환. */
  async rebuild(asOf: number): Promise<number> {
    if (!this.client) {
      this.logger.warn('ANTHROPIC_API_KEY 미설정 — 섹터 신호 스킵(워치리스트는 기존 팩터로)');
      return 0;
    }
    const headlines = await fetchNaverMainNews(this.logger);
    if (headlines.length === 0) {
      this.logger.warn('섹터 신호: 헤드라인 0 — 스킵');
      return 0;
    }
    let scores: z.infer<typeof Result>;
    try {
      scores = await this.scoreSectors(headlines);
    } catch (err) {
      this.logger.error({ err }, '섹터 신호 LLM 실패 — 스킵');
      return 0;
    }
    const date = tradingDateKey(asOf);
    const valid = scores.sectors.filter((s) => (SECTORS as readonly string[]).includes(s.sector));
    if (valid.length === 0) return 0;

    await this.db
      .insert(schema.sectorSignals)
      .values(valid.map((s) => ({ date, sector: s.sector, score: s.score, rationale: s.rationale, headlineCount: headlines.length })))
      .onConflictDoUpdate({
        target: [schema.sectorSignals.date, schema.sectorSignals.sector],
        set: { score: sql`excluded.score`, rationale: sql`excluded.rationale`, headlineCount: headlines.length },
      });
    const top = [...valid].sort((a, b) => b.score - a.score).slice(0, 3).map((s) => `${s.sector}(${s.score.toFixed(2)})`);
    this.logger.info({ date, sectors: valid.length, headlines: headlines.length, top }, '섹터 신호 적재');
    return valid.length;
  }

  private async scoreSectors(headlines: string[]): Promise<z.infer<typeof Result>> {
    const res = await this.client!.messages.create({
      model: this.opts.model,
      max_tokens: 2048,
      system: RUBRIC,
      output_config: { format: { type: 'json_schema', schema: JSON_SCHEMA } },
      messages: [{ role: 'user', content: `섹터 목록: ${SECTORS.join(', ')}\n\n오늘 주요뉴스 헤드라인:\n${headlines.map((h, i) => `${i + 1}. ${h}`).join('\n')}` }],
    } as Anthropic.MessageCreateParamsNonStreaming);
    const textBlock = res.content.find((b) => b.type === 'text');
    if (!textBlock || textBlock.type !== 'text') throw new Error('no text block in LLM response');
    return Result.parse(JSON.parse(textBlock.text));
  }

  /** 특정 섹터의 당일 점수(없으면 null). 워치리스트 팩터 조회용. */
  async scoreFor(sector: string, asOf: number): Promise<number | null> {
    const rows = await this.db
      .select({ score: schema.sectorSignals.score })
      .from(schema.sectorSignals)
      .where(sql`${schema.sectorSignals.date} = ${tradingDateKey(asOf)} and ${schema.sectorSignals.sector} = ${sector}`)
      .limit(1);
    return rows[0]?.score ?? null;
  }
}
