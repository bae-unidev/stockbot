'use client';
import { useEffect, useRef } from 'react';
import { createChart, ColorType, type UTCTimestamp, type SeriesMarker, type Time } from 'lightweight-charts';
import { Term } from './Term';

export interface Candle {
  time: number; // epoch seconds
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}
export interface TradeMarker {
  time: number; // epoch seconds
  side: 'buy' | 'sell';
  text?: string;
}

// lightweight-charts 는 시간축을 UTC 로 렌더 → epoch 에 +9h 를 더해 한국시간(KST) 벽시계로 표시.
// (저장 ts 는 정확한 UTC epoch. 이 오프셋은 표시 전용이며 모든 시리즈/마커에 동일 적용해 정렬 유지.)
const KST = 9 * 3600;
const kst = (t: number): UTCTimestamp => (t + KST) as UTCTimestamp;

/** 시간봉 20-EMA(전략이 쓰는 추세선). */
function ema20(candles: Candle[]): { time: UTCTimestamp; value: number }[] {
  const period = 20;
  if (candles.length < period) return [];
  const k = 2 / (period + 1);
  const out: { time: UTCTimestamp; value: number }[] = [];
  let prev = candles.slice(0, period).reduce((a, c) => a + c.close, 0) / period;
  out.push({ time: kst(candles[period - 1]!.time), value: prev });
  for (let i = period; i < candles.length; i++) {
    prev = candles[i]!.close * k + prev * (1 - k);
    out.push({ time: kst(candles[i]!.time), value: prev });
  }
  return out;
}

/** 세션 VWAP(KST 거래일별 리셋, 전략 레이어2 조건). */
function sessionVwap(candles: Candle[]): { time: UTCTimestamp; value: number }[] {
  const out: { time: UTCTimestamp; value: number }[] = [];
  let day = -1;
  let pv = 0;
  let vol = 0;
  for (const c of candles) {
    const d = Math.floor((c.time * 1000 + 9 * 3600_000) / 86_400_000);
    if (d !== day) {
      day = d;
      pv = 0;
      vol = 0;
    }
    const typical = (c.high + c.low + c.close) / 3;
    const v = c.volume ?? 0;
    pv += typical * v;
    vol += v;
    out.push({ time: kst(c.time), value: vol > 0 ? pv / vol : typical });
  }
  return out;
}

/** 가격 캔들차트 + 매수/매도 마커 + 지표(EMA20·VWAP). */
export function PriceChart({ symbol, candles, markers }: { symbol: string; candles: Candle[]; markers: TradeMarker[] }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ref.current || candles.length < 2) return;
    const chart = createChart(ref.current, {
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: '#8b93a7' },
      grid: { vertLines: { color: '#1e2330' }, horzLines: { color: '#1e2330' } },
      rightPriceScale: { borderColor: '#262b36' },
      timeScale: { borderColor: '#262b36', timeVisible: true },
      height: 340,
      autoSize: true,
    });
    const candleSeries = chart.addCandlestickSeries({
      upColor: '#34d399',
      downColor: '#f87171',
      borderUpColor: '#34d399',
      borderDownColor: '#f87171',
      wickUpColor: '#34d399',
      wickDownColor: '#f87171',
    });
    candleSeries.setData(
      candles.map((c) => ({ time: kst(c.time), open: c.open, high: c.high, low: c.low, close: c.close })),
    );

    // 지표 오버레이.
    const emaSeries = chart.addLineSeries({ color: '#f59e0b', lineWidth: 1, title: 'EMA20', priceLineVisible: false, lastValueVisible: false });
    emaSeries.setData(ema20(candles));
    const vwapSeries = chart.addLineSeries({ color: '#a78bfa', lineWidth: 1, title: 'VWAP', priceLineVisible: false, lastValueVisible: false });
    vwapSeries.setData(sessionVwap(candles));

    if (markers.length) {
      const m: SeriesMarker<Time>[] = markers
        .slice()
        .sort((a, b) => a.time - b.time)
        .map((mk) => ({
          time: kst(mk.time),
          position: mk.side === 'buy' ? 'belowBar' : 'aboveBar',
          color: mk.side === 'buy' ? '#34d399' : '#f87171',
          shape: mk.side === 'buy' ? 'arrowUp' : 'arrowDown',
          text: mk.text ?? (mk.side === 'buy' ? 'B' : 'S'),
        }));
      candleSeries.setMarkers(m);
    }
    chart.timeScale().fitContent();
    return () => chart.remove();
  }, [symbol, candles, markers]);

  if (candles.length < 2)
    return <div className="empty">{symbol} 가격 봉 데이터 없음 (해당 기간 canonical 60m 봉 미적재)</div>;
  return (
    <>
      <div className="flex gap-3 text-[12px] mb-1">
        <span style={{ color: '#f59e0b' }}>— <Term t="EMA20">EMA20</Term></span>
        <span style={{ color: '#a78bfa' }}>— <Term t="VWAP">VWAP</Term></span>
        <span className="text-up">▲ 매수</span>
        <span className="text-down">▼ 매도</span>
      </div>
      <div ref={ref} style={{ width: '100%' }} />
    </>
  );
}
