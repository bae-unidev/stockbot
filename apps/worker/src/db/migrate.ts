/** Drizzle 마이그레이션 적용. `pnpm db:migrate`. */
import '../bootstrap.js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { logger } from '../logger.js';

const url = process.env.DATABASE_URL ?? 'postgresql://stockbot:stockbot@localhost:5432/stockbot';
const migrationsFolder = resolve(dirname(fileURLToPath(import.meta.url)), '../../drizzle');

async function main() {
  const client = postgres(url, { max: 1 });
  const db = drizzle(client);
  logger.info({ migrationsFolder }, 'applying migrations');
  await migrate(db, { migrationsFolder });
  await client.end();
  logger.info('migrations applied');
}

main().catch((err) => {
  logger.error({ err }, 'migration failed');
  process.exit(1);
});
