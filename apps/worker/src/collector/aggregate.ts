/** 분봉 → 시간봉 집계(KST 시각 정각 버킷). canonical 정규화의 일부(7장). */
import { DateTime } from 'luxon';
import { KST } from '../market/calendar.js';
import type { Bar, Symbol } from '@stockbot/core';

/** ts 를 KST 기준 해당 시(hour)의 시작 epoch ms 로 내림. */
function floorToHourKST(ts: number): number {
  return DateTime.fromMillis(ts, { zone: KST }).startOf('hour').toMillis();
}

/** 1m(또는 분봉) → 60m. 같은 시(hour) 버킷의 OHLCV 를 합성. */
export function aggregateToHourly(minuteBars: Bar[], symbol: Symbol, source: string): Bar[] {
  const buckets = new Map<number, Bar[]>();
  for (const b of minuteBars) {
    const h = floorToHourKST(b.ts);
    const arr = buckets.get(h) ?? [];
    arr.push(b);
    buckets.set(h, arr);
  }
  const out: Bar[] = [];
  for (const [h, arr] of [...buckets.entries()].sort((a, b) => a[0] - b[0])) {
    arr.sort((a, b) => a.ts - b.ts);
    out.push({
      symbol,
      timeframe: '60m',
      ts: h,
      open: arr[0]!.open,
      high: Math.max(...arr.map((x) => x.high)),
      low: Math.min(...arr.map((x) => x.low)),
      close: arr[arr.length - 1]!.close,
      volume: arr.reduce((a, x) => a + x.volume, 0),
      adjusted: arr[0]!.adjusted,
      source,
    });
  }
  return out;
}
