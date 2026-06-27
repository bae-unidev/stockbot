/** 백테스트 상세(13장): 자산곡선 · 요약지표 · 종목별 캔들(지표·마커)+거래내역. */
import { sql } from '../../lib/db';
import { loadSymbolNames } from '../../lib/symbols';
import { EquityChart } from '../../components/EquityChart';
import { BacktestExplorer } from '../../components/BacktestExplorer';
import { AllocationChart, type AllocationPoint } from '../../components/AllocationChart';
import { Term } from '../../components/Term';
import type { Candle, TradeMarker } from '../../components/PriceChart';
import type { TradeWithPnl } from '../../components/TradesTable';

export const dynamic = 'force-dynamic';

interface CandleRow { symbol: string; ts: string; open: number; high: number; low: number; close: number; volume: number }
interface EquityPoint { ts: string; equity: number }
interface TradeRow { symbol: string; side: string; quantity: number; price: number; fee: number; tax: number; ts: string; reason: string | null }
interface MetricRow { total_return: number; max_drawdown: number; sharpe: number; win_rate: number; turnover: number; num_trades: number }
interface RunRow { id: number; label: string | null; from_ts: string; to_ts: string; params: unknown }

const toSec = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);

async function load(id: number) {
  const [run, metrics, equity, trades, alloc] = await Promise.all([
    sql<RunRow[]>`select id, label, from_ts, to_ts, params from backtest_runs where id = ${id}`,
    sql<MetricRow[]>`select total_return, max_drawdown, sharpe, win_rate, turnover, num_trades from backtest_metrics where run_id = ${id}`,
    sql<EquityPoint[]>`select ts, equity from backtest_equity where run_id = ${id} order by ts asc`,
    sql<TradeRow[]>`select symbol, side, quantity, price, fee, tax, ts, reason from backtest_trades where run_id = ${id} order by ts asc limit 3000`,
    sql<{ series: AllocationPoint[] }[]>`select series from backtest_allocation where run_id = ${id}`,
  ]);
  const allocation: AllocationPoint[] = alloc[0]?.series ?? [];

  // 거래된 모든 종목의 60m 봉을 실행 기간에서 조회 → 종목별 그룹.
  const candlesBySymbol: Record<string, Candle[]> = {};
  let primarySymbol = '';
  if (run[0] && trades.length) {
    const counts = new Map<string, number>();
    for (const t of trades) counts.set(t.symbol, (counts.get(t.symbol) ?? 0) + 1);
    const tradedSymbols = [...counts.keys()];
    primarySymbol = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]![0];
    const rows = await sql<CandleRow[]>`
      select symbol, ts, open, high, low, close, volume from bars
      where symbol in ${sql(tradedSymbols)} and timeframe = '60m'
        and ts >= ${run[0].from_ts} and ts <= ${run[0].to_ts}
      order by ts asc`;
    for (const r of rows) {
      (candlesBySymbol[r.symbol] ??= []).push({ time: toSec(r.ts), open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume });
    }
  }
  const names = await loadSymbolNames();
  return { run: run[0], metrics: metrics[0], equity, trades, candlesBySymbol, primarySymbol, names, allocation };
}

export default async function BacktestDetail({ params }: { params: { id: string } }) {
  const id = Number(params.id);
  const { run, metrics, equity, trades, candlesBySymbol, primarySymbol, names, allocation } = await load(id);
  if (!run) return <div className="empty">백테스트 #{id} 를 찾을 수 없습니다.</div>;

  const equityData = equity.map((e) => ({ time: toSec(e.ts), value: e.equity }));

  // 거래별 실현손익(평균원가 장부, ts 오름차순).
  const ledger = new Map<string, { qty: number; avg: number }>();
  const tradesWithPnl: TradeWithPnl[] = trades.map((t) => {
    const c = ledger.get(t.symbol) ?? { qty: 0, avg: 0 };
    let realized: number | null = null;
    let realizedPct: number | null = null;
    if (t.side === 'buy') {
      const newQty = c.qty + t.quantity;
      c.avg = newQty > 0 ? (c.avg * c.qty + t.price * t.quantity + t.fee) / newQty : 0;
      c.qty = newQty;
    } else {
      const basis = c.avg * t.quantity;
      realized = (t.price - c.avg) * t.quantity - t.fee - t.tax;
      realizedPct = basis > 0 ? realized / basis : 0;
      c.qty = Math.max(0, c.qty - t.quantity);
    }
    ledger.set(t.symbol, c);
    return { ts: t.ts, symbol: t.symbol, side: t.side, quantity: t.quantity, price: t.price, fee: t.fee, tax: t.tax, reason: t.reason, realized, realizedPct };
  });

  // 종목별 매수/매도 마커.
  const markersBySymbol: Record<string, TradeMarker[]> = {};
  for (const t of trades) {
    (markersBySymbol[t.symbol] ??= []).push({ time: toSec(t.ts), side: t.side as 'buy' | 'sell', text: t.side === 'buy' ? 'B' : 'S' });
  }

  return (
    <>
      <h2 style={{ fontSize: 16 }}>
        <a href="/backtests">백테스트</a> / #{run.id} {run.label ? `· ${run.label}` : ''}
      </h2>
      <p className="muted">{new Date(run.from_ts).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })} ~ {new Date(run.to_ts).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}</p>

      <section className="panel">
        <h2>자산곡선</h2>
        <EquityChart data={equityData} />
      </section>

      {allocation.length > 1 && (
        <section className="panel" style={{ marginTop: 16 }}>
          <h2>종목 비중 추이 (100% 스택)</h2>
          <AllocationChart series={allocation} names={names} />
        </section>
      )}

      {metrics && (
        <section className="panel" style={{ marginTop: 16 }}>
          <h2>요약 지표</h2>
          <div className="grid-cards">
            <div className="metric"><span className="muted"><Term t="총수익률">총수익률</Term></span><span className={`v ${metrics.total_return >= 0 ? 'green' : 'red'}`}>{(metrics.total_return * 100).toFixed(2)}%</span></div>
            <div className="metric"><span className="muted"><Term t="MDD">MDD</Term></span><span className="v red">{(metrics.max_drawdown * 100).toFixed(2)}%</span></div>
            <div className="metric"><span className="muted"><Term t="샤프">샤프</Term></span><span className="v">{metrics.sharpe.toFixed(2)}</span></div>
            <div className="metric"><span className="muted"><Term t="승률">승률</Term></span><span className="v">{(metrics.win_rate * 100).toFixed(1)}%</span></div>
            <div className="metric"><span className="muted"><Term t="턴오버">턴오버</Term></span><span className="v">{metrics.turnover.toFixed(2)}x</span></div>
            <div className="metric"><span className="muted">거래수</span><span className="v">{metrics.num_trades}</span></div>
          </div>
        </section>
      )}

      <div style={{ marginTop: 16 }}>
        <BacktestExplorer candlesBySymbol={candlesBySymbol} markersBySymbol={markersBySymbol} trades={tradesWithPnl} names={names} primarySymbol={primarySymbol} />
      </div>
    </>
  );
}
