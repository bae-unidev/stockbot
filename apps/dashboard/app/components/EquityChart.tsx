'use client';
import { useEffect, useRef } from 'react';
import { createChart, ColorType, type UTCTimestamp } from 'lightweight-charts';

export interface EquityPoint {
  time: number; // epoch seconds
  value: number;
}

/** 자산곡선(영역 차트, TradingView lightweight-charts). 평가액은 단일 값 시계열이라 라인/영역이 맞다. */
export function EquityChart({ data }: { data: EquityPoint[] }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ref.current || data.length < 2) return;
    const up = data[data.length - 1]!.value >= data[0]!.value;
    const color = up ? '#34d399' : '#f87171';
    const chart = createChart(ref.current, {
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: '#8b93a7' },
      grid: { vertLines: { color: '#1e2330' }, horzLines: { color: '#1e2330' } },
      rightPriceScale: { borderColor: '#262b36' },
      timeScale: { borderColor: '#262b36', timeVisible: true },
      height: 260,
      autoSize: true,
      crosshair: { mode: 0 },
    });
    const series = chart.addAreaSeries({
      lineColor: color,
      topColor: up ? 'rgba(52,211,153,0.35)' : 'rgba(248,113,113,0.35)',
      bottomColor: 'rgba(0,0,0,0)',
      lineWidth: 2,
      priceFormat: { type: 'price', precision: 0, minMove: 1 },
    });
    // lightweight-charts 는 UTC 축 → +9h 로 KST 표시(자산곡선 시점도 한국시간 정렬).
    series.setData(data.map((d) => ({ time: (d.time + 9 * 3600) as UTCTimestamp, value: d.value })));
    chart.timeScale().fitContent();
    return () => chart.remove();
  }, [data]);

  if (data.length < 2) return <div className="empty">자산곡선 데이터 부족</div>;
  return <div ref={ref} style={{ width: '100%' }} />;
}
