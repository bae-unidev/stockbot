/** 백테스트 실행 목록 + 요약 지표(13장). 실행 간 비교(예: event_score 포함 vs 미포함)는 라벨로 식별. */
import { sql } from '../lib/db';

export const dynamic = 'force-dynamic';

interface RunRow {
  id: number;
  label: string | null;
  from_ts: string;
  to_ts: string;
  total_return: number | null;
  max_drawdown: number | null;
  sharpe: number | null;
  win_rate: number | null;
  num_trades: number | null;
}

async function load() {
  return sql<RunRow[]>`
    select r.id, r.label, r.from_ts, r.to_ts,
           m.total_return, m.max_drawdown, m.sharpe, m.win_rate, m.num_trades
    from backtest_runs r
    left join backtest_metrics m on m.run_id = r.id
    order by r.created_at desc
    limit 100`;
}

export default async function Backtests() {
  const runs = await load();
  return (
    <>
      <h2 style={{ fontSize: 16 }}>백테스트 실행</h2>
      <section className="panel">
        {runs.length === 0 ? (
          <div className="empty">
            실행 기록 없음. <code>pnpm backtest</code> 로 백테스트를 실행하세요.
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>#</th><th>라벨</th><th className="right">총수익률</th><th className="right">MDD</th>
                <th className="right">샤프</th><th className="right">승률</th><th className="right">거래수</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id}>
                  <td><a href={`/backtests/${r.id}`}>{r.id}</a></td>
                  <td>{r.label ?? '–'}</td>
                  <td className={`right ${(r.total_return ?? 0) >= 0 ? 'green' : 'red'}`}>{r.total_return != null ? (r.total_return * 100).toFixed(2) + '%' : '–'}</td>
                  <td className="right red">{r.max_drawdown != null ? (r.max_drawdown * 100).toFixed(2) + '%' : '–'}</td>
                  <td className="right">{r.sharpe?.toFixed(2) ?? '–'}</td>
                  <td className="right">{r.win_rate != null ? (r.win_rate * 100).toFixed(1) + '%' : '–'}</td>
                  <td className="right">{r.num_trades ?? '–'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
