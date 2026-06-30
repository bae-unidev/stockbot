/** 실매매 모니터링(13장): 일자별 KPI/포지션/손익/틱로그/주문·체결 + 운영 제어·명령이력·이벤트. */
import { sql } from './lib/db';
import { loadSymbolNames, nm } from './lib/symbols';
import { AutoRefresh } from './components/AutoRefresh';
import { ControlPanel } from './components/ControlPanel';
import { DaySelector } from './components/DaySelector';
import { Term } from './components/Term';

export const dynamic = 'force-dynamic';

interface Position { symbol: string; quantity: number; avg_price: number }
interface OrderRow { client_order_id: string; symbol: string; side: string; quantity: number; status: string; avg_fill_price: number | null; reason: string | null; updated_at: string }
interface FillRow { symbol: string; side: string; quantity: number; price: number; fee: number; tax: number; ts: string }
interface TickDetail { diagnostics?: Record<string, string>; indexAbove200dma?: boolean; watchlist?: string[]; rejected?: { symbol: string; reason: string }[] }
interface TickRow { id: number; started_at: string; status: string; intents_count: number; orders_count: number; error: string | null; detail: TickDetail | null }
interface RiskRow { date: string; daily_loss_pct: number; kill_switch: boolean; start_equity: number | null }
interface ScoreRow { symbol: string; sentiment: number; event_type: string | null; confidence: number; published_at: string }
interface SnapRow { equity: number | null; cash: number | null }
interface CmdRow { id: number; kind: string; status: string; created_at: string; executed_at: string | null; result: unknown }
interface SectorRow { sector: string; score: number; rationale: string | null }
interface WatchComponents { momentum?: number; value?: number; quality?: number; event?: number; sector?: number; volume?: number }
interface WatchRow { symbol: string; rank: number; score: number; components: WatchComponents | null }

/** KST(UTC+9) 거래일 키 YYYY-MM-DD. */
function kstDay(ts: number): string {
  return new Date(ts + 9 * 3600_000).toISOString().slice(0, 10);
}
const dayBounds = (day: string) => ({ start: `${day}T00:00:00.000+09:00`, end: `${day}T23:59:59.999+09:00` });

/** 체결(ts 오름차순)에서 이동평균원가로 일별 실현손익 누적. */
function realizedByDay(fills: FillRow[]): Map<string, number> {
  const cost = new Map<string, { qty: number; avg: number }>();
  const byDay = new Map<string, number>();
  for (const f of fills) {
    const c = cost.get(f.symbol) ?? { qty: 0, avg: 0 };
    if (f.side === 'buy') {
      c.avg = (c.avg * c.qty + f.price * f.quantity + f.fee) / (c.qty + f.quantity || 1);
      c.qty += f.quantity;
    } else {
      byDay.set(kstDay(new Date(f.ts).getTime()), (byDay.get(kstDay(new Date(f.ts).getTime())) ?? 0) + ((f.price - c.avg) * f.quantity - f.fee - f.tax));
      c.qty = Math.max(0, c.qty - f.quantity);
    }
    cost.set(f.symbol, c);
  }
  return byDay;
}

/** 체결 누적으로 특정 시점 보유 포지션 재구성(이동평균원가). 과거 일자 종료 시점 보유 표시용. */
function positionsFromFills(fills: FillRow[]): Position[] {
  const cost = new Map<string, { qty: number; avg: number }>();
  for (const f of fills) {
    const c = cost.get(f.symbol) ?? { qty: 0, avg: 0 };
    if (f.side === 'buy') {
      c.avg = (c.avg * c.qty + f.price * f.quantity + f.fee) / (c.qty + f.quantity || 1);
      c.qty += f.quantity;
    } else {
      c.qty = Math.max(0, c.qty - f.quantity);
    }
    cost.set(f.symbol, c);
  }
  return [...cost.entries()].filter(([, c]) => c.qty > 0).map(([symbol, c]) => ({ symbol, quantity: c.qty, avg_price: c.avg }));
}

/** 활동(틱) 또는 워치리스트가 있는 KST 거래일 목록(최신순). 개장 전 산출된 당일도 포함. */
async function loadDays(): Promise<string[]> {
  const rows = await sql<{ day: string }[]>`
    select day from (
      select distinct (started_at at time zone 'Asia/Seoul')::date::text as day from tick_runs
      union
      select distinct date as day from watchlist
    ) d where day is not null order by day desc limit 60`;
  return rows.map((r) => r.day);
}

async function load(day: string, isLatest: boolean) {
  const { start, end } = dayBounds(day);
  const [brokerPositions, orders, fills, ticks, risk, scores, snap, cmds, fillsUpToEnd, sectors, watch] = await Promise.all([
    sql<Position[]>`select symbol, quantity, avg_price from positions order by symbol`,
    sql<OrderRow[]>`select client_order_id, symbol, side, quantity, status, avg_fill_price, reason, updated_at from orders where updated_at >= ${start} and updated_at <= ${end} order by updated_at desc limit 100`,
    sql<FillRow[]>`select symbol, side, quantity, price, fee, tax, ts from fills where ts >= ${start} and ts <= ${end} order by ts desc limit 100`,
    sql<TickRow[]>`select id, started_at, status, intents_count, orders_count, error, detail from tick_runs where started_at >= ${start} and started_at <= ${end} order by started_at desc limit 50`,
    sql<RiskRow[]>`select date, daily_loss_pct, kill_switch, start_equity from risk_state where date = ${day} limit 1`,
    sql<ScoreRow[]>`select symbol, sentiment, event_type, confidence, published_at from event_scores order by scored_at desc limit 15`,
    sql<SnapRow[]>`select equity, cash from tick_runs where equity is not null and started_at >= ${start} and started_at <= ${end} order by id desc limit 1`,
    sql<CmdRow[]>`select id, kind, status, created_at, executed_at, result from control_commands order by id desc limit 8`,
    sql<FillRow[]>`select symbol, side, quantity, price, fee, tax, ts from fills where ts <= ${end} order by ts asc`,
    sql<SectorRow[]>`select sector, score, rationale from sector_signals where date = ${day} order by score desc`,
    sql<WatchRow[]>`select symbol, rank, score, components from watchlist where date = ${day} order by rank`,
  ]);

  // 포지션: 최신일=브로커 잔고(진실의 원천), 과거일=체결 누적 재구성(그날 종료 시점).
  const positions = isLatest ? brokerPositions : positionsFromFills(fillsUpToEnd);

  // 보유 종목 현재가 = 선택일 종료 시점 이하 최신 60m 종가.
  const priceBySymbol: Record<string, number> = {};
  if (positions.length) {
    const syms = positions.map((p) => p.symbol);
    const rows = await sql<{ symbol: string; close: number }[]>`
      select distinct on (symbol) symbol, close from bars
      where symbol in ${sql(syms)} and timeframe = '60m' and ts <= ${end}
      order by symbol, ts desc`;
    for (const r of rows) priceBySymbol[r.symbol] = r.close;
  }

  const names = await loadSymbolNames();
  const realized = realizedByDay(fillsUpToEnd);
  return { positions, orders, fills, ticks, risk: risk[0], scores, snap: snap[0], cmds, names, priceBySymbol, realized, sectors, watch };
}

function fmt(n: number | null | undefined, digits = 0) {
  if (n == null) return '–';
  return n.toLocaleString('ko-KR', { maximumFractionDigits: digits });
}
function signed(n: number | null | undefined) {
  if (n == null) return '–';
  return `${n >= 0 ? '+' : ''}${fmt(n)}`;
}
function ago(iso: string | null): string {
  if (!iso) return '–';
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s}초 전`;
  if (s < 3600) return `${Math.floor(s / 60)}분 전`;
  if (s < 86400) return `${Math.floor(s / 3600)}시간 전`;
  return `${Math.floor(s / 86400)}일 전`;
}
const CMD_LABEL: Record<string, string> = { flatten: '포지션 정리', kill: '킬스위치', kill_off: '킬스위치 해제' };
const FACTOR_LABEL: Record<string, string> = { momentum: '모멘텀', value: '밸류', quality: '퀄리티', event: '이벤트', sector: '섹터', volume: '거래량' };
/** 워치리스트 종목의 최대 기여 팩터(왜 뽑혔는지) 라벨. */
function topFactor(c: WatchComponents | null): string {
  if (!c) return '';
  const entries = Object.entries(c).filter(([, v]) => typeof v === 'number') as [string, number][];
  if (!entries.length) return '';
  const [k, v] = entries.reduce((a, b) => (Math.abs(b[1]) > Math.abs(a[1]) ? b : a));
  return `${FACTOR_LABEL[k] ?? k} ${v >= 0 ? '+' : ''}${v.toFixed(2)}`;
}

function diagClass(d: string): string {
  if (d.startsWith('entry')) return 'green';
  if (d.startsWith('exit') || d.startsWith('veto')) return 'red';
  return 'muted';
}
function diagRank(d: string): number {
  if (d.startsWith('entry')) return 0;
  if (d.startsWith('exit')) return 1;
  if (d.startsWith('veto')) return 2;
  if (d.startsWith('no-entry: cooldown') || d.startsWith('skip')) return 4;
  return 3;
}
function cmdNote(result: unknown): string {
  if (!result || typeof result !== 'object') return '';
  const r = result as Record<string, unknown>;
  if (typeof r.reason === 'string') return r.reason;
  if (typeof r.liquidation === 'string') return r.liquidation;
  if (Array.isArray(r.liquidated)) return `청산 ${r.liquidated.length}건${Array.isArray(r.rejected) && r.rejected.length ? ` · 거부 ${r.rejected.length}` : ''}`;
  return '';
}

export default async function Page({ searchParams }: { searchParams: { day?: string } }) {
  const days = await loadDays();
  const selectedDay = searchParams.day && days.includes(searchParams.day) ? searchParams.day : days[0] ?? kstDay(Date.now());
  const isLatest = selectedDay === (days[0] ?? selectedDay);
  const { positions, orders, fills, ticks, risk, scores, snap, cmds, names, priceBySymbol, realized, sectors, watch } = await load(selectedDay, isLatest);

  // 파생 지표.
  let investedValue = 0;
  let unrealized = 0;
  for (const p of positions) {
    const cur = priceBySymbol[p.symbol];
    if (cur != null) {
      investedValue += cur * p.quantity;
      unrealized += (cur - p.avg_price) * p.quantity;
    }
  }
  const equity = snap?.equity ?? risk?.start_equity ?? null;
  const cash = snap?.cash ?? null;
  const investedPct = equity && equity > 0 ? investedValue / equity : null;
  const realizedDay = realized.get(selectedDay) ?? 0;
  const recentRealized = [...realized.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1)).slice(0, 7);
  const lastTick = ticks[0];

  return (
    <>
      <div className="flex items-center gap-[10px] mb-3 flex-wrap">
        <h2 className="m-0 text-base">실매매 모니터링</h2>
        <DaySelector days={days} selected={selectedDay} />
        {isLatest && <AutoRefresh seconds={5} />}
        {risk?.kill_switch ? <span className="pill bad">KILL SWITCH ON</span> : <span className="pill ok">정상</span>}
        <span className="muted text-[12px] ml-auto">{isLatest ? `마지막 틱 ${ago(lastTick?.started_at ?? null)}` : `${selectedDay} 기록 보기`}{lastTick ? ` · ${ticks.length}틱` : ''}</span>
      </div>

      {/* KPI 스트립 */}
      <div className="kpi-strip">
        <div className="kpi"><span className="label"><Term t="총자산">총자산</Term></span><span className="value">{fmt(equity)}원</span></div>
        <div className="kpi"><span className="label">현금</span><span className="value">{fmt(cash)}원</span></div>
        <div className="kpi"><span className="label"><Term t="투자비중">투자비중</Term></span><span className="value">{investedPct == null ? '–' : `${(investedPct * 100).toFixed(0)}%`}</span></div>
        <div className="kpi"><span className="label"><Term t="실현손익">당일 실현손익</Term></span><span className={`value ${realizedDay > 0 ? 'green' : realizedDay < 0 ? 'red' : ''}`}>{signed(realizedDay)}원</span></div>
        <div className="kpi"><span className="label">평가손익(미실현)</span><span className={`value ${unrealized > 0 ? 'green' : unrealized < 0 ? 'red' : ''}`}>{positions.length ? `${signed(unrealized)}원` : '–'}</span></div>
        <div className="kpi"><span className="label">보유 종목</span><span className="value">{positions.length}</span></div>
      </div>

      <div className="grid-cards">
        <section className="panel" style={{ gridColumn: '1 / -1' }}>
          <h2><Term t="워치리스트">워치리스트</Term> — {selectedDay} ({watch.length})</h2>
          {watch.length === 0 ? <div className="empty">이 날짜 워치리스트 없음 (개장 전 산출 / 데이터 부족)</div> : (
            <table>
              <thead><tr><th>#</th><th>종목</th><th className="right">종합점수</th><th className="right">모멘텀</th><th className="right">밸류</th><th className="right">퀄리티</th><th className="right">이벤트</th><th className="right"><Term t="섹터">섹터</Term></th><th className="right"><Term t="거래량">거래량</Term></th><th>주도팩터</th></tr></thead>
              <tbody>
                {watch.map((r) => {
                  const c = r.components ?? {};
                  const z = (v?: number) => (v == null ? '–' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}`);
                  const zc = (v?: number) => (v == null ? 'muted' : v > 0 ? 'green' : v < 0 ? 'red' : 'muted');
                  return (
                    <tr key={r.symbol}>
                      <td>{r.rank}</td>
                      <td>{nm(r.symbol, names)}</td>
                      <td className={`right ${r.score >= 0 ? 'green' : 'red'}`}>{r.score >= 0 ? '+' : ''}{r.score.toFixed(2)}</td>
                      <td className={`right ${zc(c.momentum)}`}>{z(c.momentum)}</td>
                      <td className={`right ${zc(c.value)}`}>{z(c.value)}</td>
                      <td className={`right ${zc(c.quality)}`}>{z(c.quality)}</td>
                      <td className={`right ${zc(c.event)}`}>{z(c.event)}</td>
                      <td className={`right ${zc(c.sector)}`}>{z(c.sector)}</td>
                      <td className={`right ${zc(c.volume)}`}>{z(c.volume)}</td>
                      <td className="muted text-[12px]">{topFactor(r.components)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </section>

        <ControlPanel killSwitchOn={!!risk?.kill_switch} positionsCount={positions.length} />

        <section className="panel">
          <h2>리스크 상태 ({selectedDay})</h2>
          {risk ? (
            <>
              <div className="metric"><span className="muted">기준일</span><span className="v">{risk.date}</span></div>
              <div className="metric"><span className="muted"><Term t="시작 자산">시작 자산</Term></span><span className="v">{fmt(risk.start_equity)}원</span></div>
              <div className="metric"><span className="muted"><Term t="당일 손실률">당일 손실률</Term></span><span className={`v ${risk.daily_loss_pct > 0 ? 'red' : ''}`}>{(risk.daily_loss_pct * 100).toFixed(2)}%</span></div>
              <div className="metric"><span className="muted"><Term t="킬스위치">킬스위치</Term></span><span className="v">{risk.kill_switch ? '🔴 ON' : '🟢 OFF'}</span></div>
            </>
          ) : <div className="empty">이 날짜 리스크 기록 없음</div>}
        </section>

        <section className="panel">
          <h2>오늘의 강세/약세 섹터 (뉴스·LLM)</h2>
          {sectors.length === 0 ? <div className="empty">섹터 신호 없음 (뉴스 미수집 / API키 미설정)</div> : (
            <table>
              <thead><tr><th>섹터</th><th className="right">점수</th><th>근거</th></tr></thead>
              <tbody>
                {sectors.filter((s) => s.score !== 0).map((s) => (
                  <tr key={s.sector}>
                    <td>{s.score > 0 ? '▲' : '▼'} {s.sector}</td>
                    <td className={`right ${s.score > 0 ? 'green' : 'red'}`}>{s.score >= 0 ? '+' : ''}{s.score.toFixed(2)}</td>
                    <td className="muted text-[12px]">{s.rationale}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <section className="panel" style={{ gridColumn: '1 / -1' }}>
          <h2>포지션 ({positions.length}){isLatest ? '' : ` · ${selectedDay} 종료 시점`}</h2>
          {positions.length === 0 ? (
            <div className="empty">보유 포지션 없음</div>
          ) : (
            <table>
              <thead><tr><th>종목</th><th className="right">수량</th><th className="right"><Term t="평단">평단</Term></th><th className="right">종가</th><th className="right"><Term t="실현손익">평가손익</Term></th><th className="right"><Term t="수익률">수익률</Term></th></tr></thead>
              <tbody>
                {positions.map((p) => {
                  const cur = priceBySymbol[p.symbol];
                  const pnl = cur != null ? (cur - p.avg_price) * p.quantity : null;
                  const pct = cur != null && p.avg_price > 0 ? (cur - p.avg_price) / p.avg_price : null;
                  const cls = pnl == null ? 'muted' : pnl >= 0 ? 'green' : 'red';
                  return (
                    <tr key={p.symbol}>
                      <td>{nm(p.symbol, names)}</td>
                      <td className="right">{fmt(p.quantity)}</td>
                      <td className="right">{fmt(p.avg_price)}</td>
                      <td className="right">{cur == null ? '–' : fmt(cur)}</td>
                      <td className={`right ${cls}`}>{pnl == null ? '–' : signed(pnl)}</td>
                      <td className={`right ${cls}`}>{pct == null ? '–' : `${pct >= 0 ? '+' : ''}${(pct * 100).toFixed(2)}%`}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </section>

        <section className="panel" style={{ gridColumn: '1 / -1' }}>
          <h2>틱 로그 — {selectedDay} ({ticks.length})</h2>
          {ticks.length === 0 ? <div className="empty">이 날짜 실행 기록 없음</div> : (
            <table>
              <thead><tr><th>#</th><th>시각</th><th>상태</th><th><Term t="국면">국면</Term></th><th className="right"><Term t="의도">의도</Term></th><th className="right">주문</th><th>상세 / 에러</th></tr></thead>
              <tbody>
                {ticks.map((t) => {
                  const d = t.detail ?? {};
                  const diags = Object.entries(d.diagnostics ?? {}).sort((a, b) => diagRank(a[1]) - diagRank(b[1]) || (a[0] < b[0] ? -1 : 1));
                  return (
                    <tr key={t.id}>
                      <td>{t.id}</td>
                      <td className="muted whitespace-nowrap">{new Date(t.started_at).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}</td>
                      <td><span className={`pill ${t.status === 'ok' ? 'ok' : t.status === 'error' ? 'bad' : ''}`}>{t.status}</span></td>
                      <td className={d.indexAbove200dma === false ? 'red' : d.indexAbove200dma ? 'green' : 'muted'}>{d.indexAbove200dma == null ? '–' : d.indexAbove200dma ? '▲ 위' : '▼ 아래'}</td>
                      <td className="right">{t.intents_count}</td>
                      <td className="right">{t.orders_count}</td>
                      <td>
                        {t.error ? <span className="red">{t.error}</span> : diags.length ? (
                          <details>
                            <summary className="cursor-pointer text-muted text-[12px] select-none">진단 {diags.length}종목{d.watchlist?.length ? ` · 워치 ${d.watchlist.length}` : ''}</summary>
                            <div className="flex flex-wrap gap-1 mt-2">
                              {diags.map(([sym, decision]) => (
                                <span key={sym} className="inline-flex items-center gap-1 text-[12px] px-[6px] py-[2px] rounded border border-panel-border">
                                  <span>{nm(sym, names)}</span>
                                  <span className={diagClass(decision)}>{decision}</span>
                                </span>
                              ))}
                            </div>
                          </details>
                        ) : <span className="muted text-[12px]">의도 없음</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </section>

        <section className="panel">
          <h2>일별 실현손익 (최근 7)</h2>
          {recentRealized.length === 0 ? <div className="empty">실현 손익 없음</div> : (
            <table>
              <thead><tr><th>거래일</th><th className="right">실현손익</th></tr></thead>
              <tbody>
                {recentRealized.map(([d, pnl]) => (
                  <tr key={d} className={d === selectedDay ? 'bg-panel-border/30' : ''}>
                    <td className={d === selectedDay ? '' : 'muted'}>{d === selectedDay ? `▶ ${d}` : d}</td>
                    <td className={`right ${pnl > 0 ? 'green' : pnl < 0 ? 'red' : ''}`}>{signed(pnl)}원</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <section className="panel">
          <h2>제어 명령 이력</h2>
          {cmds.some((c) => c.status === 'pending') && (
            <p className="red text-[12px] mb-2">⚠ 대기(pending) 명령이 있습니다 — 워커(`pnpm dev`/`app:up`)가 실행 중인지 확인하세요. 명령 실행은 워커가 합니다.</p>
          )}
          {cmds.length === 0 ? <div className="empty">명령 없음</div> : (
            <table>
              <thead><tr><th>명령</th><th>상태</th><th>요청</th><th>메모</th></tr></thead>
              <tbody>
                {cmds.map((c) => (
                  <tr key={c.id}>
                    <td>{CMD_LABEL[c.kind] ?? c.kind}</td>
                    <td><span className={`pill ${c.status === 'done' ? 'ok' : c.status === 'failed' ? 'bad' : ''}`}>{c.status}</span></td>
                    <td className="muted">{ago(c.created_at)}</td>
                    <td className="muted text-[12px]">{cmdNote(c.result)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <section className="panel" style={{ gridColumn: '1 / -1' }}>
          <h2>주문 — {selectedDay} ({orders.length})</h2>
          {orders.length === 0 ? <div className="empty">이 날짜 주문 없음</div> : (
            <table>
              <thead><tr><th>종목</th><th>방향</th><th className="right">수량</th><th>상태</th><th>사유</th></tr></thead>
              <tbody>
                {orders.map((o) => (
                  <tr key={o.client_order_id}>
                    <td>{nm(o.symbol, names)}</td>
                    <td className={o.side === 'buy' ? 'green' : 'red'}>{o.side}</td>
                    <td className="right">{o.quantity}</td>
                    <td><span className={`pill ${o.status === 'filled' || o.status === 'accepted' ? 'ok' : o.status === 'rejected' ? 'bad' : ''}`}>{o.status}</span></td>
                    <td className={`text-[12px] ${o.status === 'rejected' ? 'red' : 'muted'}`}>{o.reason ?? '–'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <section className="panel">
          <h2>체결 — {selectedDay} ({fills.length})</h2>
          {fills.length === 0 ? <div className="empty">이 날짜 체결 없음</div> : (
            <table>
              <thead><tr><th>종목</th><th>방향</th><th className="right">수량</th><th className="right">가격</th></tr></thead>
              <tbody>
                {fills.map((f, i) => (
                  <tr key={i}><td>{nm(f.symbol, names)}</td><td className={f.side === 'buy' ? 'green' : 'red'}>{f.side}</td><td className="right">{f.quantity}</td><td className="right">{fmt(f.price)}</td></tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <section className="panel" style={{ gridColumn: '1 / -1' }}>
          <h2>최근 <Term t="event_score">이벤트 점수</Term> (LLM)</h2>
          {scores.length === 0 ? <div className="empty">점수 없음</div> : (
            <table>
              <thead><tr><th>종목</th><th>유형</th><th className="right"><Term t="감성">감성</Term></th><th className="right"><Term t="확신도">확신도</Term></th><th>공개시각</th></tr></thead>
              <tbody>
                {scores.map((sc, i) => (
                  <tr key={i}><td>{nm(sc.symbol, names)}</td><td className="muted">{sc.event_type}</td><td className={`right ${sc.sentiment >= 0 ? 'green' : 'red'}`}>{sc.sentiment.toFixed(2)}</td><td className="right">{sc.confidence.toFixed(2)}</td><td className="muted">{new Date(sc.published_at).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}</td></tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>
    </>
  );
}
