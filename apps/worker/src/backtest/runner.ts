/**
 * 백테스트 엔진(9장) — core 전략 엔진을 그대로 재사용. 어댑터와 루프만 제공.
 * canonical 봉/이벤트를 가상 시계 순서로 엔진에 주입 → 체결 시뮬 → 결과(자산곡선·지표) 산출.
 */
import {
  runStrategyTick,
  sma,
  type Bar,
  type EngineContext,
  type EventDataPort,
  type EventScore,
  type PortfolioPort,
  type PositionMark,
  type StrategyConfig,
  type Symbol,
} from '@stockbot/core';
import { ReplayMarketData, VirtualClock } from '../adapters/backtest/replay.js';
import { SimBroker, type SimCosts, DEFAULT_SIM_COSTS } from '../adapters/backtest/sim-broker.js';
import { minutesToClose, tradingDateKey } from '../market/calendar.js';

class SimEventData implements EventDataPort {
  constructor(private readonly scores: EventScore[]) {}
  async getScores(params: { symbols: Symbol[]; asOf: number }): Promise<EventScore[]> {
    return this.scores.filter((s) => params.symbols.includes(s.symbol) && s.publishedAt <= params.asOf);
  }
}

export interface BacktestInput {
  bars: Bar[]; // canonical 60m (+ 선택적으로 종목 일봉)
  eventScores?: EventScore[];
  /** false면 이벤트 점수를 무시(veto 비활성) — event_score 포함/미포함 비교용(15장). 기본 true. */
  useEventScores?: boolean;
  config: StrategyConfig;
  initialCash: number;
  costs?: SimCosts;
  /** 국면 필터용 지수 일봉(없으면 200일선 조건 통과로 간주). */
  indexDailyBars?: Bar[];
  /** 날짜별 워치리스트 결정. 기본: 봉에 존재하는 전 종목. */
  watchlistFor?: (asOf: number, allSymbols: Symbol[]) => Symbol[];
  fromTs?: number;
  toTs?: number;
}

export interface AllocationPoint {
  ts: number;
  cash: number;
  positions: Record<Symbol, number>; // 종목별 평가금액(원)
}

export interface BacktestResult {
  equityCurve: { ts: number; equity: number }[];
  /** 종목 비중 시계열(일자별 1점). */
  allocationCurve: AllocationPoint[];
  trades: SimBroker['trades'];
  metrics: {
    totalReturn: number;
    maxDrawdown: number;
    sharpe: number;
    winRate: number;
    turnover: number;
    numTrades: number;
  };
  from: number;
  to: number;
}

function indexAbove200dma(indexBars: Bar[] | undefined, asOf: number): boolean {
  if (!indexBars || indexBars.length === 0) return true; // 데이터 없으면 차단하지 않음
  const closes = indexBars.filter((b) => b.ts <= asOf).map((b) => b.close);
  const ma = sma(closes, 200);
  if (ma == null) return true;
  const last = closes[closes.length - 1]!;
  return last > ma;
}

export async function runBacktest(input: BacktestInput): Promise<BacktestResult> {
  const replay = new ReplayMarketData(input.bars);
  const clock = new VirtualClock();
  const broker = new SimBroker(input.initialCash, input.costs ?? DEFAULT_SIM_COSTS);
  const eventData = new SimEventData(input.useEventScores === false ? [] : input.eventScores ?? []);

  const allSymbols = [...new Set(input.bars.filter((b) => b.timeframe === '60m').map((b) => b.symbol))];
  const watchlistFor = input.watchlistFor ?? ((_a: number, all: Symbol[]) => all);

  const ctx: EngineContext = {
    clock,
    marketData: replay,
    eventData,
    portfolio: broker as unknown as PortfolioPort,
  };

  // 현재 시각 종가를 체결가로 제공. 종목별 (ts,close) 사전정렬 + 이진탐색(O(log n))으로 조회.
  const closesBySym = new Map<Symbol, { ts: number; close: number }[]>();
  for (const b of input.bars) {
    if (b.timeframe !== '60m') continue;
    const arr = closesBySym.get(b.symbol) ?? [];
    arr.push({ ts: b.ts, close: b.close });
    closesBySym.set(b.symbol, arr);
  }
  for (const arr of closesBySym.values()) arr.sort((a, b) => a.ts - b.ts);
  const priceAt = (asOf: number) => (sym: Symbol): number | undefined => {
    const arr = closesBySym.get(sym);
    if (!arr || arr.length === 0) return undefined;
    // 마지막 ts <= asOf 를 이진탐색.
    let lo = 0;
    let hi = arr.length - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid]!.ts <= asOf) {
        ans = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return ans >= 0 ? arr[ans]!.close : undefined;
  };

  let timeline = replay.timeline('60m');
  if (input.fromTs != null) timeline = timeline.filter((t) => t >= input.fromTs!);
  if (input.toTs != null) timeline = timeline.filter((t) => t <= input.toTs!);

  const equityCurve: { ts: number; equity: number }[] = [];
  const allocByDay = new Map<string, AllocationPoint>(); // 일자별 마지막 비중 스냅샷
  const marks: Record<Symbol, PositionMark> = {};
  const cooldownUntil: Record<Symbol, number> = {};
  // 일봉 국면은 개장 시 1회 고정(레이어2). 거래일별 캐시.
  const regimeByDay = new Map<string, boolean>();

  for (const ts of timeline) {
    clock.set(ts);
    broker.setClock(ts);
    broker.setPriceProvider(priceAt(ts));

    const day = tradingDateKey(ts);
    if (!regimeByDay.has(day)) regimeByDay.set(day, indexAbove200dma(input.indexDailyBars, ts));

    // 트레일링 앵커 갱신: 보유 종목 현재가로 high-water-mark 상향(scaledOut 보존).
    const pf = await broker.getPortfolio(ts);
    const heldQty = new Map(pf.positions.map((p) => [p.symbol, p.quantity]));
    for (const p of pf.positions) {
      const price = priceAt(ts)(p.symbol);
      const prev = marks[p.symbol]?.highWaterMark ?? p.avgPrice;
      marks[p.symbol] = { highWaterMark: Math.max(prev, price ?? prev), scaledOut: marks[p.symbol]?.scaledOut, entryTs: marks[p.symbol]?.entryTs };
    }

    const decision = await runStrategyTick(ctx, {
      asOf: ts,
      watchlist: watchlistFor(ts, allSymbols),
      indexAbove200dma: regimeByDay.get(day)!,
      minutesToClose: minutesToClose(ts),
      marks,
      cooldownUntil,
      config: input.config,
    });

    // 체결(동기). 매수 후 새 포지션의 앵커 초기화.
    let idx = 0;
    for (const intent of decision.intents) {
      const order = {
        clientOrderId: `bt-${ts}-${idx++}`,
        symbol: intent.symbol,
        side: intent.side,
        type: intent.type,
        quantity: intent.quantity,
        limitPrice: intent.limitPrice,
        status: 'new' as const,
        filledQuantity: 0,
        createdAt: ts,
        updatedAt: ts,
      };
      const filled = await broker.submit(order);
      if (filled.status === 'filled') {
        // 체결 로그에 의사결정 근거 기록(대시보드 표시용).
        const last = broker.trades[broker.trades.length - 1];
        if (last) last.reason = intent.reason;
        if (intent.side === 'buy') {
          // 신규 진입이면 entryTs 설정(엔진은 동일 종목 보유 시 재진입 안 하므로 매수=신규).
          marks[intent.symbol] = { highWaterMark: filled.avgFillPrice ?? priceAt(ts)(intent.symbol) ?? 0, scaledOut: false, entryTs: marks[intent.symbol]?.entryTs ?? ts };
          delete cooldownUntil[intent.symbol];
        } else {
          const before = heldQty.get(intent.symbol) ?? 0;
          if (intent.quantity < before) {
            // 부분 청산(scale-out): 마크 유지 + scaledOut 표시.
            marks[intent.symbol] = { highWaterMark: marks[intent.symbol]?.highWaterMark ?? filled.avgFillPrice ?? 0, scaledOut: true, entryTs: marks[intent.symbol]?.entryTs };
            heldQty.set(intent.symbol, before - intent.quantity);
          } else {
            // 전량 청산: 마크 제거 + 재진입 쿨다운.
            delete marks[intent.symbol];
            cooldownUntil[intent.symbol] = ts + input.config.reentryCooldownBars * 3600_000;
          }
        }
      }
    }

    equityCurve.push({ ts, equity: broker.equity() });

    // 비중 스냅샷(일자별 마지막 틱이 그날 대표값).
    const pfNow = await broker.getPortfolio(ts);
    const positions: Record<Symbol, number> = {};
    for (const p of pfNow.positions) positions[p.symbol] = p.quantity * (priceAt(ts)(p.symbol) ?? p.avgPrice);
    allocByDay.set(day, { ts, cash: pfNow.cash, positions });
  }

  const metrics = computeMetrics(equityCurve, broker.trades, input.initialCash);
  return {
    equityCurve,
    allocationCurve: [...allocByDay.values()].sort((a, b) => a.ts - b.ts),
    trades: broker.trades,
    metrics,
    from: timeline[0] ?? 0,
    to: timeline[timeline.length - 1] ?? 0,
  };
}

function computeMetrics(
  equityCurve: { ts: number; equity: number }[],
  trades: SimBroker['trades'],
  initialCash: number,
): BacktestResult['metrics'] {
  const n = equityCurve.length;
  const finalEquity = n ? equityCurve[n - 1]!.equity : initialCash;
  const totalReturn = finalEquity / initialCash - 1;

  // MDD
  let peak = -Infinity;
  let maxDrawdown = 0;
  for (const p of equityCurve) {
    peak = Math.max(peak, p.equity);
    if (peak > 0) maxDrawdown = Math.max(maxDrawdown, (peak - p.equity) / peak);
  }

  // 봉별 수익률 → 샤프(연율화: 시간봉 가정, 1년 ≈ 252*6.5 ≈ 1638 시간봉)
  const rets: number[] = [];
  for (let i = 1; i < n; i++) {
    const prev = equityCurve[i - 1]!.equity;
    if (prev > 0) rets.push(equityCurve[i]!.equity / prev - 1);
  }
  const mean = rets.length ? rets.reduce((a, b) => a + b, 0) / rets.length : 0;
  const variance = rets.length > 1 ? rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1) : 0;
  const sd = Math.sqrt(variance);
  const periodsPerYear = 1638;
  const sharpe = sd > 0 ? (mean / sd) * Math.sqrt(periodsPerYear) : 0;

  // 승률: 매도 체결마다 평균원가 대비 실현손익을 계산해 양수 비율.
  const cost = new Map<string, { qty: number; avg: number }>();
  let wins = 0;
  let sells = 0;
  for (const t of trades) {
    const c = cost.get(t.symbol) ?? { qty: 0, avg: 0 };
    if (t.side === 'buy') {
      const newQty = c.qty + t.quantity;
      // 매수 수수료를 원가에 포함.
      c.avg = newQty > 0 ? (c.avg * c.qty + t.price * t.quantity + t.fee) / newQty : 0;
      c.qty = newQty;
    } else {
      sells++;
      const realized = (t.price - c.avg) * t.quantity - t.fee - t.tax;
      if (realized > 0) wins++;
      c.qty = Math.max(0, c.qty - t.quantity);
    }
    cost.set(t.symbol, c);
  }
  const winRate = sells ? wins / sells : 0;

  const turnover = trades.reduce((a, t) => a + t.price * t.quantity, 0) / (initialCash || 1);

  return { totalReturn, maxDrawdown, sharpe, winRate, numTrades: trades.length, turnover };
}
