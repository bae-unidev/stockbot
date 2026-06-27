'use client';
import { useMemo, useState } from 'react';
import { nm } from '../lib/names';
import { PriceChart, type Candle, type TradeMarker } from './PriceChart';
import { TradesTable, type TradeWithPnl } from './TradesTable';

/**
 * 종목 선택기 하나로 가격 캔들차트(+해당 종목 매수/매도 마커·지표)와 거래내역 필터를 동시 제어.
 * '전체' 선택 시 차트는 기본 종목(primary), 표는 전 거래.
 */
export function BacktestExplorer({
  candlesBySymbol,
  markersBySymbol,
  trades,
  names,
  primarySymbol,
}: {
  candlesBySymbol: Record<string, Candle[]>;
  markersBySymbol: Record<string, TradeMarker[]>;
  trades: TradeWithPnl[];
  names: Record<string, string>;
  primarySymbol: string;
}) {
  const symbols = useMemo(() => [...new Set(trades.map((t) => t.symbol))].sort(), [trades]);
  const [sel, setSel] = useState<string>('ALL');

  const chartSymbol = sel === 'ALL' ? primarySymbol : sel;
  const candles = candlesBySymbol[chartSymbol] ?? [];
  const markers = markersBySymbol[chartSymbol] ?? [];
  const filteredTrades = sel === 'ALL' ? trades : trades.filter((t) => t.symbol === sel);

  return (
    <>
      <section className="panel">
        <div className="flex items-center gap-2 mb-2">
          <h2 className="!mb-0">종목별 보기</h2>
          <select
            value={sel}
            onChange={(e) => setSel(e.target.value)}
            className="bg-bg border border-panel-border rounded px-2 py-1 text-ink text-[13px]"
          >
            <option value="ALL">전체 ({trades.length}거래)</option>
            {symbols.map((s) => (
              <option key={s} value={s}>
                {nm(s, names)} ({trades.filter((t) => t.symbol === s).length})
              </option>
            ))}
          </select>
          <span className="text-muted text-[12px]">
            캔들 차트: {nm(chartSymbol, names)} {sel === 'ALL' && '(기본)'}
          </span>
        </div>
        <PriceChart symbol={chartSymbol} candles={candles} markers={markers} />
      </section>

      <section className="panel" style={{ marginTop: 16 }}>
        <h2>거래 내역 {sel === 'ALL' ? `(전체 ${trades.length})` : `· ${nm(sel, names)} (${filteredTrades.length})`}</h2>
        <TradesTable trades={filteredTrades} names={names} />
      </section>
    </>
  );
}
