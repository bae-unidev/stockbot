'use client';
import { nm } from '../lib/names';
import { Term } from './Term';

export interface TradeWithPnl {
  ts: string;
  symbol: string;
  side: string;
  quantity: number;
  price: number;
  fee: number;
  tax: number;
  reason: string | null;
  realized: number | null; // 매도 실현손익(원). 매수는 null.
  realizedPct: number | null;
}

const fmt = (n: number) => n.toLocaleString('ko-KR', { maximumFractionDigits: 0 });

/** 거래내역(표시 전용). 종목 필터는 상위 BacktestExplorer 가 제어. 매도엔 실현손익. */
export function TradesTable({ trades, names }: { trades: TradeWithPnl[]; names: Record<string, string> }) {
  const totalRealized = trades.reduce((a, t) => a + (t.realized ?? 0), 0);

  if (trades.length === 0) return <div className="empty">거래 없음</div>;
  return (
    <>
      <div className="flex mb-2">
        <span className="text-muted text-[12px] ml-auto">
          실현손익 합계{' '}
          <span className={totalRealized >= 0 ? 'green' : 'red'}>
            {totalRealized >= 0 ? '+' : ''}
            {fmt(totalRealized)}원
          </span>
        </span>
      </div>
      <div className="overflow-x-auto">
        <table>
          <thead>
            <tr>
              <th>시각</th>
              <th>종목</th>
              <th>방향</th>
              <th className="right">수량</th>
              <th className="right">가격</th>
              <th className="right"><Term t="수수료+세금">수수료+세금</Term></th>
              <th className="right"><Term t="실현손익">실현손익</Term></th>
              <th className="right"><Term t="수익률">수익률</Term></th>
              <th><Term t="근거">근거</Term></th>
            </tr>
          </thead>
          <tbody>
            {trades.map((t, i) => (
              <tr key={i}>
                <td className="muted whitespace-nowrap">{new Date(t.ts).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}</td>
                <td>{nm(t.symbol, names)}</td>
                <td className={t.side === 'buy' ? 'green' : 'red'}>{t.side === 'buy' ? '매수' : '매도'}</td>
                <td className="right">{t.quantity}</td>
                <td className="right">{fmt(t.price)}</td>
                <td className="right muted">{fmt(t.fee + t.tax)}</td>
                <td className={`right ${t.realized == null ? 'muted' : t.realized >= 0 ? 'green' : 'red'}`}>
                  {t.realized == null ? '–' : `${t.realized >= 0 ? '+' : ''}${fmt(t.realized)}`}
                </td>
                <td className={`right ${t.realizedPct == null ? 'muted' : t.realizedPct >= 0 ? 'green' : 'red'}`}>
                  {t.realizedPct == null ? '–' : `${t.realizedPct >= 0 ? '+' : ''}${(t.realizedPct * 100).toFixed(2)}%`}
                </td>
                <td className="muted">{t.reason ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
