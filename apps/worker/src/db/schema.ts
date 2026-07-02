/**
 * Drizzle 스키마 — 11장 데이터 모델.
 * canonical 봉, 펀더멘털, 수집상태, 워치리스트, 이벤트/점수, 주문/체결/포지션,
 * 틱 로그, 리스크 상태, 백테스트 결과.
 */
import {
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  serial,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core';

/** canonical 봉: symbol, timeframe(D/60m 등), ts, OHLCV, adjusted, source */
export const bars = pgTable(
  'bars',
  {
    symbol: varchar('symbol', { length: 16 }).notNull(),
    timeframe: varchar('timeframe', { length: 8 }).notNull(),
    ts: timestamp('ts', { withTimezone: true }).notNull(),
    open: doublePrecision('open').notNull(),
    high: doublePrecision('high').notNull(),
    low: doublePrecision('low').notNull(),
    close: doublePrecision('close').notNull(),
    volume: doublePrecision('volume').notNull(),
    adjusted: boolean('adjusted').notNull().default(false),
    source: varchar('source', { length: 16 }).notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.symbol, t.timeframe, t.ts] }),
    bySymbolTf: index('bars_symbol_tf_ts_idx').on(t.symbol, t.timeframe, t.ts),
  }),
);

/** 종목 코드 ↔ 종목명 참조. 대시보드 표시용. */
export const symbols = pgTable('symbols', {
  code: varchar('code', { length: 16 }).primaryKey(),
  name: varchar('name', { length: 64 }).notNull(),
  market: varchar('market', { length: 8 }), // KS | KQ
});

/** 펀더멘털 — KIS 제공분(7장, TS-only). 운영은 이 테이블만 읽음. */
export const fundamentals = pgTable(
  'fundamentals',
  {
    symbol: varchar('symbol', { length: 16 }).notNull(),
    date: varchar('date', { length: 10 }).notNull(), // YYYY-MM-DD
    per: doublePrecision('per'),
    pbr: doublePrecision('pbr'),
    roe: doublePrecision('roe'),
    div: doublePrecision('div'),
  },
  (t) => ({ pk: primaryKey({ columns: [t.symbol, t.date] }) }),
);

/**
 * 일별 섹터/테마 신호(8장 확장): 뉴스 헤드라인 → LLM 으로 그날 강세/약세 섹터 점수화.
 * 워치리스트가 종목의 섹터 점수를 팩터로 사용. date+sector 유니크.
 */
export const sectorSignals = pgTable(
  'sector_signals',
  {
    date: varchar('date', { length: 10 }).notNull(), // YYYY-MM-DD (KST 거래일)
    sector: varchar('sector', { length: 32 }).notNull(),
    score: doublePrecision('score').notNull(), // -1(약세) ~ +1(강세)
    rationale: text('rationale'),
    headlineCount: integer('headline_count').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.date, t.sector] }) }),
);

/** 수집 상태: source/symbol/timeframe 별 마지막 적재 지점 커서. */
export const collectorState = pgTable(
  'collector_state',
  {
    source: varchar('source', { length: 16 }).notNull(),
    symbol: varchar('symbol', { length: 16 }).notNull(),
    timeframe: varchar('timeframe', { length: 8 }).notNull(),
    lastTs: timestamp('last_ts', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.source, t.symbol, t.timeframe] }) }),
);

/** 날짜별 워치리스트 + 팩터 점수(event_score 포함). */
export const watchlist = pgTable(
  'watchlist',
  {
    date: varchar('date', { length: 10 }).notNull(),
    symbol: varchar('symbol', { length: 16 }).notNull(),
    rank: integer('rank').notNull(),
    score: doublePrecision('score').notNull(),
    components: jsonb('components').notNull(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.date, t.symbol] }) }),
);

/** 이벤트: 종목, 출처(DART/뉴스), 유형, 원문/요지, published_at, 수집시각. */
export const events = pgTable(
  'events',
  {
    id: serial('id').primaryKey(),
    symbol: varchar('symbol', { length: 16 }),
    source: varchar('source', { length: 16 }).notNull(), // dart | news
    eventType: varchar('event_type', { length: 64 }),
    title: text('title').notNull(),
    body: text('body'),
    /** 외부 식별자(중복수집 방지용 멱등키). */
    externalId: varchar('external_id', { length: 128 }),
    publishedAt: timestamp('published_at', { withTimezone: true }).notNull(),
    collectedAt: timestamp('collected_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniqExternal: uniqueIndex('events_source_external_idx').on(t.source, t.externalId),
    byPublished: index('events_published_idx').on(t.publishedAt),
  }),
);

/** 이벤트 점수: LLM 구조화 출력 + 원문/모델/프롬프트버전/scored_at(8장). */
export const eventScores = pgTable('event_scores', {
  id: serial('id').primaryKey(),
  eventId: integer('event_id').notNull(),
  symbol: varchar('symbol', { length: 16 }).notNull(),
  sentiment: real('sentiment').notNull(), // [-1,+1]
  eventType: varchar('event_type', { length: 64 }),
  confidence: real('confidence').notNull(), // [0,1]
  rawOutput: jsonb('raw_output').notNull(),
  model: varchar('model', { length: 64 }).notNull(),
  promptVersion: varchar('prompt_version', { length: 16 }).notNull(),
  publishedAt: timestamp('published_at', { withTimezone: true }).notNull(),
  scoredAt: timestamp('scored_at', { withTimezone: true }).notNull().defaultNow(),
});

/** 주문: 멱등키, 종목, 방향, 수량, 가격, 상태, 브로커 주문번호, 타임스탬프(10장). */
export const orders = pgTable(
  'orders',
  {
    clientOrderId: varchar('client_order_id', { length: 64 }).primaryKey(),
    brokerOrderId: varchar('broker_order_id', { length: 64 }),
    symbol: varchar('symbol', { length: 16 }).notNull(),
    side: varchar('side', { length: 4 }).notNull(),
    type: varchar('type', { length: 8 }).notNull(),
    quantity: integer('quantity').notNull(),
    limitPrice: doublePrecision('limit_price'),
    status: varchar('status', { length: 20 }).notNull(),
    filledQuantity: integer('filled_quantity').notNull().default(0),
    avgFillPrice: doublePrecision('avg_fill_price'),
    reason: text('reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ byBroker: index('orders_broker_idx').on(t.brokerOrderId) }),
);

/** 체결 내역(부분체결 포함). */
export const fills = pgTable(
  'fills',
  {
    id: serial('id').primaryKey(),
    clientOrderId: varchar('client_order_id', { length: 64 }).notNull(),
    brokerOrderId: varchar('broker_order_id', { length: 64 }),
    symbol: varchar('symbol', { length: 16 }).notNull(),
    side: varchar('side', { length: 4 }).notNull(),
    quantity: integer('quantity').notNull(),
    price: doublePrecision('price').notNull(),
    fee: doublePrecision('fee').notNull().default(0),
    tax: doublePrecision('tax').notNull().default(0),
    ts: timestamp('ts', { withTimezone: true }).notNull(),
    /** 브로커 체결 식별자(대사 중복 방지). */
    brokerFillId: varchar('broker_fill_id', { length: 64 }),
  },
  (t) => ({
    byOrder: index('fills_order_idx').on(t.clientOrderId),
    uniqBrokerFill: uniqueIndex('fills_broker_fill_idx').on(t.brokerFillId),
  }),
);

/** 현재 보유(대사 결과). 브로커가 진실의 원천. */
export const positions = pgTable('positions', {
  symbol: varchar('symbol', { length: 16 }).primaryKey(),
  quantity: integer('quantity').notNull(),
  avgPrice: doublePrecision('avg_price').notNull(),
  /** 트레일링 스탑 앵커(진입 후 최고가). */
  highWaterMark: doublePrecision('high_water_mark'),
  /** 부분청산(scale-out) 완료 여부. */
  scaledOut: boolean('scaled_out').notNull().default(false),
  /** 진입 시각(최대 보유일수 청산 판정용). */
  entryTs: timestamp('entry_ts', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** 틱 실행 로그. */
export const tickRuns = pgTable('tick_runs', {
  id: serial('id').primaryKey(),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  status: varchar('status', { length: 16 }).notNull(), // ok | error | skipped
  intentsCount: integer('intents_count').notNull().default(0),
  ordersCount: integer('orders_count').notNull().default(0),
  // 대사 시점 계좌 스냅샷(대시보드 실시간 총자산/현금 표시용).
  equity: doublePrecision('equity'),
  cash: doublePrecision('cash'),
  detail: jsonb('detail'),
  error: text('error'),
});

/**
 * 운영 제어 명령 큐(대시보드 → 워커). 대시보드는 브로커를 직접 만지지 않고 의도만 적재하고,
 * 매매 주체인 워커가 OrderManager/RiskService 경유로 실행한다(단일 매매 권한·멱등 유지).
 */
export const controlCommands = pgTable('control_commands', {
  id: serial('id').primaryKey(),
  kind: varchar('kind', { length: 24 }).notNull(), // flatten | kill | kill_off
  status: varchar('status', { length: 16 }).notNull().default('pending'), // pending | done | failed
  requestedBy: varchar('requested_by', { length: 32 }), // 'dashboard' 등
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  executedAt: timestamp('executed_at', { withTimezone: true }),
  result: jsonb('result'), // { placed, rejected, reason }
});

/**
 * 계좌 스냅샷: 대사(분단위) 때마다 브로커 실잔고(현금/총자산) 기록.
 * 대시보드 KPI 가 실시간 현금/총자산을 이걸로 표시(틱당 1회·주문전 스냅샷의 지연 해소).
 */
export const accountSnapshots = pgTable('account_snapshots', {
  ts: timestamp('ts', { withTimezone: true }).notNull().defaultNow().primaryKey(),
  equity: doublePrecision('equity').notNull(),
  cash: doublePrecision('cash').notNull(),
});

/** 일일 손실 누적 + 킬스위치 상태(날짜별). */
export const riskState = pgTable('risk_state', {
  date: varchar('date', { length: 10 }).primaryKey(),
  startEquity: doublePrecision('start_equity'),
  dailyLossPct: doublePrecision('daily_loss_pct').notNull().default(0),
  killSwitch: boolean('kill_switch').notNull().default(false),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── 백테스트 결과 ──
export const backtestRuns = pgTable('backtest_runs', {
  id: serial('id').primaryKey(),
  label: varchar('label', { length: 128 }),
  fromTs: timestamp('from_ts', { withTimezone: true }).notNull(),
  toTs: timestamp('to_ts', { withTimezone: true }).notNull(),
  params: jsonb('params').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const backtestTrades = pgTable('backtest_trades', {
  id: serial('id').primaryKey(),
  runId: integer('run_id').notNull(),
  symbol: varchar('symbol', { length: 16 }).notNull(),
  side: varchar('side', { length: 4 }).notNull(),
  quantity: integer('quantity').notNull(),
  price: doublePrecision('price').notNull(),
  fee: doublePrecision('fee').notNull(),
  tax: doublePrecision('tax').notNull(),
  ts: timestamp('ts', { withTimezone: true }).notNull(),
  reason: text('reason'),
});

export const backtestEquity = pgTable('backtest_equity', {
  id: serial('id').primaryKey(),
  runId: integer('run_id').notNull(),
  ts: timestamp('ts', { withTimezone: true }).notNull(),
  equity: doublePrecision('equity').notNull(),
});

/** 종목 비중 시계열(일자별): { ts, cash, positions: {symbol: value} } 배열을 JSON 으로. */
export const backtestAllocation = pgTable('backtest_allocation', {
  runId: integer('run_id').primaryKey(),
  series: jsonb('series').notNull(),
});

export const backtestMetrics = pgTable('backtest_metrics', {
  runId: integer('run_id').primaryKey(),
  totalReturn: doublePrecision('total_return').notNull(),
  maxDrawdown: doublePrecision('max_drawdown').notNull(),
  sharpe: doublePrecision('sharpe').notNull(),
  winRate: doublePrecision('win_rate').notNull(),
  turnover: doublePrecision('turnover').notNull(),
  numTrades: integer('num_trades').notNull(),
});
