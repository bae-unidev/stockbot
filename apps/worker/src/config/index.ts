/**
 * 환경변수 → 검증된 설정. zod 로 강제(2장·16장). 시크릿은 코드/문서에 평문 금지.
 * 12-factor 지향: 모든 설정은 env 로만 들어온다. Railway 이전 시 그대로 동작.
 */
import { z } from 'zod';
import { DEFAULT_STRATEGY_CONFIG, type StrategyConfig } from '@stockbot/core';

const EnvSchema = z.object({
  RUN_MODE: z.enum(['live', 'backtest']).default('live'),
  KIS_ENV: z.enum(['paper', 'prod']).default('paper'),

  HTS_ID: z.string().optional(),
  MOCK_ACCOUNT: z.string().optional(),
  MOCK_KIS_API_KEY: z.string().optional(),
  MOCK_KIS_API_SECRET: z.string().optional(),
  KIS_API_KEY: z.string().optional(),
  KIS_API_SECRET: z.string().optional(),

  DATABASE_URL: z.string().default('postgresql://stockbot:stockbot@localhost:5432/stockbot'),
  REDIS_URL: z.string().default('redis://localhost:6379'),

  ANTHROPIC_API_KEY: z.string().optional(),
  LLM_MODEL: z.string().default('claude-opus-4-8'), // 뉴스/섹터 추론 품질 우선(temperature 미지원 → 호출부에서 생략)
  EVENT_PROMPT_VERSION: z.string().default('v1'),
  DART_API_KEY: z.string().optional(),

  NOTIFIER_WEBHOOK_URL: z.string().optional(),

  // 기본 유니버스(워치리스트 비었을 때) + 국면 판정용 지수 심볼.
  WATCHLIST_SYMBOLS: z.string().optional(), // 콤마 구분 6자리 코드
  INDEX_SYMBOL: z.string().optional(),
  BLACKLIST_SYMBOLS: z.string().optional(), // 절대 매수 안 할 종목(콤마 구분)

  MAX_POSITIONS: z.coerce.number().int().positive().default(8),
  PER_SYMBOL_WEIGHT_CAP: z.coerce.number().positive().max(1).default(0.1),
  MIN_INVESTED_RATIO: z.coerce.number().min(0).max(1).default(0.7), // 최소 투자비중(1-현금비중) → 현금 30%
  DAILY_LOSS_LIMIT_PCT: z.coerce.number().positive().max(1).default(0.05),

  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
});

export type Env = z.infer<typeof EnvSchema>;

export interface KisCredentials {
  appKey: string;
  appSecret: string;
  account: string;
  htsId?: string;
  /** paper=모의투자 도메인, prod=실거래 도메인. */
  env: 'paper' | 'prod';
}

export interface AppConfig {
  runMode: 'live' | 'backtest';
  env: Env;
  strategy: StrategyConfig;
  kis: KisCredentials | null;
  riskLimits: {
    maxPositions: number;
    perSymbolWeightCap: number;
    dailyLossLimitPct: number;
  };
  defaultUniverse: string[];
  indexSymbol?: string;
  /** 절대 매수하지 않을 종목(유니버스/워치리스트에서 제외). */
  blacklist: string[];
}

export function loadConfig(): AppConfig {
  const env = EnvSchema.parse(process.env);

  // 3장 안전 제약: 1차는 paper 전용. prod 선택 시 명시적으로 막는다.
  if (env.KIS_ENV === 'prod') {
    throw new Error(
      'KIS_ENV=prod 는 1차 비범위입니다(실거래 금지). 모의투자(paper)로만 동작시키세요.',
    );
  }

  let kis: KisCredentials | null = null;
  if (env.MOCK_KIS_API_KEY && env.MOCK_KIS_API_SECRET && env.MOCK_ACCOUNT) {
    kis = {
      appKey: env.MOCK_KIS_API_KEY,
      appSecret: env.MOCK_KIS_API_SECRET,
      account: env.MOCK_ACCOUNT,
      htsId: env.HTS_ID,
      env: 'paper',
    };
  }

  const blacklist = (env.BLACKLIST_SYMBOLS ?? '')
    .split(',')
    .map((sym) => sym.trim())
    .filter(Boolean);

  const strategy: StrategyConfig = {
    ...DEFAULT_STRATEGY_CONFIG,
    maxPositions: env.MAX_POSITIONS,
    perSymbolWeightCap: env.PER_SYMBOL_WEIGHT_CAP,
    minInvestedRatio: env.MIN_INVESTED_RATIO,
  };

  return {
    runMode: env.RUN_MODE,
    env,
    strategy,
    kis,
    riskLimits: {
      maxPositions: env.MAX_POSITIONS,
      perSymbolWeightCap: env.PER_SYMBOL_WEIGHT_CAP,
      dailyLossLimitPct: env.DAILY_LOSS_LIMIT_PCT,
    },
    defaultUniverse: (env.WATCHLIST_SYMBOLS ?? '')
      .split(',')
      .map((sym) => sym.trim())
      .filter(Boolean)
      .filter((sym) => !blacklist.includes(sym)),
    indexSymbol: env.INDEX_SYMBOL,
    blacklist,
  };
}
