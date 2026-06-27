/**
 * 데이터 수집 CLI(12장): `pnpm collect <mode> [symbols...]`.
 *   modes: backfill-yahoo | yahoo-daily | kis-daily | kis-hourly | fundamentals | seed
 * symbols 미지정 시 WATCHLIST_SYMBOLS(.env) 사용.
 */
import '../bootstrap.js';
import { buildContainer, logger } from '../container.js';
import type { Market } from '../collector/index.js';

function parseArgs() {
  const [mode, ...rest] = process.argv.slice(2);
  return { mode, symbols: rest };
}

async function main() {
  const { mode, symbols } = parseArgs();
  const c = buildContainer();
  const list = symbols.length ? symbols : c.config.defaultUniverse;
  const specs = list.map((symbol) => ({ symbol, market: 'KS' as Market }));

  if (!mode) {
    logger.error('usage: pnpm collect <backfill-yahoo|yahoo-daily|kis-daily|kis-hourly|fundamentals|seed> [symbols...]');
    process.exit(1);
  }

  switch (mode) {
    case 'backfill-yahoo': {
      const n = await c.collector.backfillYahoo(specs, 2);
      logger.info({ bars: n }, 'yahoo backfill complete');
      break;
    }
    case 'yahoo-daily': {
      // 일봉 ~3년(200일선 국면필터 시드). symbols 미지정 시 INDEX_SYMBOL 사용.
      const idx = symbols.length ? specs : c.config.indexSymbol ? [{ symbol: c.config.indexSymbol, market: 'KS' as Market }] : [];
      if (!idx.length) {
        logger.error('yahoo-daily: symbols 미지정 & INDEX_SYMBOL 미설정 — 대상 없음');
        break;
      }
      const n = await c.collector.backfillYahooDaily(idx, 3);
      logger.info({ bars: n, symbols: idx.map((s) => s.symbol) }, 'yahoo daily backfill complete');
      break;
    }
    case 'kis-daily': {
      // 최근 1년 일봉.
      const to = new Date();
      const from = new Date(to.getTime() - 365 * 86_400_000);
      const fmt = (d: Date) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
      const n = await c.collector.accumulateKisDaily(specs, fmt(from), fmt(to));
      logger.info({ bars: n }, 'kis daily accumulate complete');
      break;
    }
    case 'kis-hourly': {
      const n = await c.collector.accumulateKisHourly(specs);
      logger.info({ bars: n }, 'kis hourly accumulate complete');
      break;
    }
    case 'fundamentals': {
      const n = await c.collector.loadFundamentals(specs);
      logger.info({ symbols: n }, 'kis fundamentals load complete');
      break;
    }
    case 'clear-demo': {
      await c.collector.clearBySources(['demo', 'synthetic']);
      break;
    }
    case 'seed': {
      let total = 0;
      for (const spec of specs.length ? specs : [{ symbol: '005930', market: 'KS' as Market }]) {
        total += await c.collector.seedSynthetic(spec.symbol, 24 * 60); // 60거래일치 시간봉 근사
      }
      logger.info({ bars: total }, 'synthetic seed complete');
      break;
    }
    default:
      logger.error({ mode }, 'unknown mode');
      process.exit(1);
  }

  await c.shutdown();
}

main().catch((err) => {
  logger.error({ err }, 'collect cli failed');
  process.exit(1);
});
