/**
 * 네이버 금융 주요뉴스 크롤링(비공식 소스 — 16장: try/catch + 로깅, 실패해도 전체 흐름 유지).
 * EUC-KR 페이지를 디코드해 헤드라인만 추출한다. 섹터/테마 신호의 LLM 입력으로 사용.
 * ⚠️ 비공식이라 페이지 구조 변경 시 깨질 수 있음 — 깨지면 빈 배열 반환(워치리스트는 기존 팩터로 폴백).
 */
import type { Logger } from '../logger.js';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

const ENTITIES: Record<string, string> = {
  hellip: '…', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', middot: '·',
  quot: '"', amp: '&', lt: '<', gt: '>', nbsp: ' ', apos: "'", hellips: '…',
};
function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&([a-zA-Z]+);/g, (m, name) => ENTITIES[name] ?? m)
    .trim();
}

/** 네이버 금융 주요뉴스 헤드라인(최대 limit). 실패 시 빈 배열. */
export async function fetchNaverMainNews(logger: Logger, limit = 40): Promise<string[]> {
  try {
    const res = await fetch('https://finance.naver.com/news/mainnews.naver', { headers: { 'user-agent': UA } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = new TextDecoder('euc-kr').decode(await res.arrayBuffer());
    // 기사 링크(news_read) 의 앵커 텍스트가 헤드라인. 중복 제거 + 짧은 텍스트 제거.
    const seen = new Set<string>();
    const out: string[] = [];
    for (const m of html.matchAll(/<a[^>]+href="[^"]*news_read[^"]*"[^>]*>([^<]+)<\/a>/g)) {
      const title = decodeEntities(m[1]!);
      if (title.length >= 8 && !title.endsWith('. .') && !seen.has(title)) {
        seen.add(title);
        out.push(title);
        if (out.length >= limit) break;
      }
    }
    logger.info({ headlines: out.length }, 'naver 주요뉴스 크롤링');
    return out;
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : err }, 'naver 뉴스 크롤링 실패(비공식 소스) — 빈 결과');
    return [];
  }
}
