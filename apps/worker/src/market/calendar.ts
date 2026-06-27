/**
 * 거래소 운영시간/휴장일(KST). 코스피 정규장 09:00~15:30.
 * 휴장일은 주말 + 정적 공휴일 셋(근사). 운영 전 갱신 필요 — TODO 로 명시.
 */
import { DateTime } from 'luxon';

export const KST = 'Asia/Seoul';
export const MARKET_OPEN = { hour: 9, minute: 0 };
export const MARKET_CLOSE = { hour: 15, minute: 30 };

/** 한국거래소 휴장일(근사, YYYY-MM-DD). 매년 갱신 필요. */
const STATIC_HOLIDAYS = new Set<string>([
  // 2025
  '2025-01-01', '2025-01-28', '2025-01-29', '2025-01-30', '2025-03-03',
  '2025-05-05', '2025-05-06', '2025-06-06', '2025-08-15', '2025-10-03',
  '2025-10-06', '2025-10-07', '2025-10-08', '2025-10-09', '2025-12-25',
  // 2026 (주요 공휴일 — 운영 전 확정 필요)
  '2026-01-01', '2026-02-16', '2026-02-17', '2026-02-18', '2026-03-01',
  '2026-05-05', '2026-05-25', '2026-06-06', '2026-08-15', '2026-09-24',
  '2026-09-25', '2026-09-26', '2026-10-03', '2026-10-09', '2026-12-25',
]);

function kst(ts: number): DateTime {
  return DateTime.fromMillis(ts, { zone: KST });
}

export function isHoliday(ts: number): boolean {
  const dt = kst(ts);
  if (dt.weekday >= 6) return true; // 토(6)/일(7)
  return STATIC_HOLIDAYS.has(dt.toFormat('yyyy-MM-dd'));
}

export function isMarketOpen(ts: number): boolean {
  if (isHoliday(ts)) return false;
  const dt = kst(ts);
  const open = dt.set({ ...MARKET_OPEN, second: 0, millisecond: 0 });
  const close = dt.set({ ...MARKET_CLOSE, second: 0, millisecond: 0 });
  return ts >= open.toMillis() && ts <= close.toMillis();
}

/** 장 마감(15:30 KST)까지 남은 분. 마감 후면 음수/0. */
export function minutesToClose(ts: number): number {
  const dt = kst(ts);
  const close = dt.set({ ...MARKET_CLOSE, second: 0, millisecond: 0 });
  return Math.round((close.toMillis() - ts) / 60_000);
}

/** KST 거래일 키(YYYY-MM-DD). 일일 리스크/워치리스트 키로 사용. */
export function tradingDateKey(ts: number): string {
  return kst(ts).toFormat('yyyy-MM-dd');
}

/** 장중 hourly 틱 트리거 시각인지(정시 부근). 스케줄러 보조. */
export function isHourlyTickTime(ts: number): boolean {
  return isMarketOpen(ts);
}
