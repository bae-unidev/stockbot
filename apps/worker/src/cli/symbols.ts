/**
 * 종목 코드↔명 참조 테이블 시드: `pnpm symbols`.
 * 내장 KOSPI 주요 종목명 맵을 symbols 테이블에 upsert. (추후 KIS 마스터로 확장 가능)
 */
import '../bootstrap.js';
import { buildContainer, logger } from '../container.js';
import * as s from '../db/schema.js';

/** KOSPI 주요 종목명(코드: 명). 필요 시 확장. */
const KNOWN_NAMES: Record<string, string> = {
  '005930': '삼성전자',
  '000660': 'SK하이닉스',
  '035420': 'NAVER',
  '005380': '현대차',
  '051910': 'LG화학',
  '035720': '카카오',
  '005490': 'POSCO홀딩스',
  '068270': '셀트리온',
  '105560': 'KB금융',
  '207940': '삼성바이오로직스',
  '000270': '기아',
  '012330': '현대모비스',
  '028260': '삼성물산',
  '066570': 'LG전자',
  '003670': '포스코퓨처엠',
  '055550': '신한지주',
  '015760': '한국전력',
  '032830': '삼성생명',
  '017670': 'SK텔레콤',
  '034730': 'SK',
  // 추가 코스피 상위 30
  '005935': '삼성전자우',
  '000810': '삼성화재',
  '086790': '하나금융지주',
  '316140': '우리금융지주',
  '138040': '메리츠금융지주',
  '010130': '고려아연',
  '011200': 'HMM',
  '009150': '삼성전기',
  '010950': 'S-Oil',
  '018260': '삼성에스디에스',
  '051900': 'LG생활건강',
  '097950': 'CJ제일제당',
  '030200': 'KT',
  '033780': 'KT&G',
  '003550': 'LG',
  '096770': 'SK이노베이션',
  '011170': '롯데케미칼',
  '047810': '한국항공우주',
  '024110': '기업은행',
  '029780': '삼성카드',
  '000100': '유한양행',
  '128940': '한미약품',
  '012450': '한화에어로스페이스',
  '042660': '한화오션',
  '064350': '현대로템',
  '267260': 'HD현대일렉트릭',
  '010140': '삼성중공업',
  '009540': 'HD한국조선해양',
  '034220': 'LG디스플레이',
  '271560': '오리온',
  // 국면 필터용 지수 프록시
  '069500': 'KODEX 200',
};

async function main() {
  const c = buildContainer();
  const rows = Object.entries(KNOWN_NAMES).map(([code, name]) => ({ code, name, market: 'KS' }));
  for (const r of rows) {
    await c.db.insert(s.symbols).values(r).onConflictDoUpdate({ target: s.symbols.code, set: { name: r.name, market: r.market } });
  }
  logger.info({ count: rows.length }, 'symbols seeded');
  await c.shutdown();
}

main().catch((err) => {
  logger.error({ err }, 'symbols cli failed');
  process.exit(1);
});
