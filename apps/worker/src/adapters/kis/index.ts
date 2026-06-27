/** KIS 어댑터 팩토리 — 토큰/클라이언트/시세/잔고/주문 묶음. 수동 DI 로 주입(2장). */
import type Redis from 'ioredis';
import { KisClient } from './client.js';
import { KisTokenManager } from './token.js';
import { KisMarketDataApi } from './market-data.js';
import { KisPortfolioApi } from './portfolio.js';
import { KisOrderGateway } from './order-gateway.js';
import type { KisCredentials } from '../../config/index.js';
import type { Logger } from '../../logger.js';

export interface KisAdapter {
  client: KisClient;
  marketData: KisMarketDataApi;
  portfolio: KisPortfolioApi;
  orders: KisOrderGateway;
}

export function createKisAdapter(creds: KisCredentials, redis: Redis, logger: Logger): KisAdapter {
  const tokens = new KisTokenManager(redis, creds, logger);
  const client = new KisClient(creds, tokens, logger);
  return {
    client,
    marketData: new KisMarketDataApi(client),
    portfolio: new KisPortfolioApi(client),
    orders: new KisOrderGateway(client),
  };
}

export { KisClient, KisTokenManager };
export * from './errors.js';
