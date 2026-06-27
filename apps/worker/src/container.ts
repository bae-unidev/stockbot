/**
 * 수동 DI 컨테이너(2장): 설정으로부터 모든 어댑터/서비스를 조립한다.
 * DI 컨테이너 프레임워크 미사용 — 팩토리 함수로 명시적 주입.
 */
import type { EngineContext } from '@stockbot/core';
import { loadConfig, type AppConfig } from './config/index.js';
import { logger } from './logger.js';
import { createDb, type DB } from './db/client.js';
import { createRepos, type Repos } from './db/repositories.js';
import { createRedis } from './redis.js';
import { createKisAdapter, type KisAdapter } from './adapters/kis/index.js';
import { DbEventData, LiveMarketData, LivePortfolio, SystemClock } from './adapters/live/index.js';
import { OrderManager } from './order-manager/index.js';
import { RiskService } from './risk/index.js';
import { ControlService } from './control/index.js';
import { Notifier } from './notifier/index.js';
import { Collector } from './collector/index.js';
import { EventIngestion } from './events/ingestion.js';
import { EventEnrichment } from './events/enrichment.js';
import { WatchlistService } from './watchlist/index.js';
import type Redis from 'ioredis';

export interface Container {
  config: AppConfig;
  db: DB;
  dbClient: ReturnType<typeof createDb>['client'];
  redis: Redis;
  repos: Repos;
  kis: KisAdapter | null;
  ctx: EngineContext;
  orderManager: OrderManager | null;
  control: ControlService | null;
  risk: RiskService;
  notifier: Notifier;
  collector: Collector;
  ingestion: EventIngestion;
  enrichment: EventEnrichment | null;
  watchlist: WatchlistService;
  shutdown: () => Promise<void>;
}

export function buildContainer(overrides?: Partial<AppConfig>): Container {
  const config = { ...loadConfig(), ...overrides };
  const { db, client: dbClient } = createDb(config.env.DATABASE_URL);
  const redis = createRedis(config.env.REDIS_URL);
  const repos = createRepos(db);
  const notifier = new Notifier(logger, config.env.NOTIFIER_WEBHOOK_URL || undefined);

  const kis = config.kis ? createKisAdapter(config.kis, redis, logger) : null;

  // live 포트 — KIS+DB 합성. KIS 없으면 시세/포트폴리오는 DB 폴백만 가능.
  const ctx: EngineContext = {
    clock: new SystemClock(),
    marketData: new LiveMarketData(repos.bars, kis?.marketData as never, logger),
    eventData: new DbEventData(repos.eventScores),
    portfolio: kis ? new LivePortfolio(kis.portfolio) : ({ async getPortfolio() { return { cash: 0, positions: [] }; } } as never),
  };

  const orderManager =
    kis != null
      ? new OrderManager(kis.orders, repos.orders, repos.positions, kis.portfolio, logger, undefined, repos.fills, kis.orders)
      : null;

  const risk = new RiskService(repos.riskState, config.riskLimits, notifier, logger);
  const control = orderManager ? new ControlService(repos.controlCommands, repos.positions, orderManager, risk, notifier, logger) : null;
  const collector = new Collector(db, repos.bars, logger, kis?.marketData);
  const watchlist = new WatchlistService(db, repos.bars, repos.eventScores, config.strategy, logger);
  const ingestion = new EventIngestion(db, logger, config.env.DART_API_KEY);
  const enrichment = config.env.ANTHROPIC_API_KEY
    ? new EventEnrichment(db, ingestion, logger, {
        apiKey: config.env.ANTHROPIC_API_KEY,
        model: config.env.LLM_MODEL,
        promptVersion: config.env.EVENT_PROMPT_VERSION,
      })
    : null;

  const shutdown = async () => {
    await redis.quit().catch(() => undefined);
    await dbClient.end({ timeout: 5 }).catch(() => undefined);
  };

  return {
    config,
    db,
    dbClient,
    redis,
    repos,
    kis,
    ctx,
    orderManager,
    control,
    risk,
    notifier,
    collector,
    ingestion,
    enrichment,
    watchlist,
    shutdown,
  };
}

export { logger };
