/**
 * 레이어 2(국면 필터) + 레이어 3(진입/청산) — 매시간 틱. 순수 도메인 로직(4장).
 *
 * 절대 규칙: 엔진 내부에서 Date.now()/fetch/DB 직접 호출 금지, if(backtest) 분기 금지.
 * 입력은 전부 포트(EngineContext) 경유. 출력은 주문 의도(OrderIntent) 목록뿐 — 부수효과 없음.
 * live 와 backtest 가 이 함수를 그대로 공유한다(10장-8).
 *
 * 청산 우선순위(높→낮): 장마감 전량 → 하드 스탑로스 → 트레일링 스탑 → RSI(부분→전량).
 * 사이징: ATR 변동성 타깃(거래당 리스크 고정), 종목당 비중캡으로 상한.
 * 재진입 쿨다운: 청산 후 일정 봉 수 동안 같은 종목 진입 차단.
 */
import { atr, ema, emaSeries, rsi, vwap } from '../indicators/index.js';
import type { EngineContext } from '../ports/index.js';
import type { Bar, OrderIntent, Symbol } from '../domain/types.js';
import type { StrategyConfig } from './config.js';

/** 종목별 보유 상태(런타임이 유지·주입). */
export interface PositionMark {
  /** 진입 후 최고가(트레일링 앵커). */
  highWaterMark: number;
  /** 1차 부분청산(scale-out) 완료 여부. */
  scaledOut?: boolean;
  /** 진입 시각(epoch ms). 최대 보유일수 청산 판정용. */
  entryTs?: number;
}

export interface StrategyTickInput {
  asOf: number;
  /** 레이어1(워치리스트)에서 오늘 선정된 후보 종목. */
  watchlist: Symbol[];
  /** 레이어2 일봉 조건: 지수가 200일선 위(개장 시 1회 고정). */
  indexAbove200dma: boolean;
  /** 장 마감까지 남은 분(레이어3 전량 청산용). */
  minutesToClose: number;
  /** 종목별 보유 상태(트레일링 앵커·부분청산 여부). 미보유면 없음. */
  marks: Record<Symbol, PositionMark>;
  /** 종목별 재진입 가능 시각(epoch ms). asOf 가 이 값 미만이면 진입 차단. */
  cooldownUntil?: Record<Symbol, number>;
  config: StrategyConfig;
}

export interface TickDecision {
  intents: OrderIntent[];
  /** 디버깅/대시보드용 종목별 판단 근거. */
  diagnostics: Record<Symbol, string>;
}

/** 같은 거래일(KST) 봉만 골라 VWAP 계산에 쓰기 위한 단순 일자 키(UTC+9 기준 일). */
function tradingDayKey(ts: number): number {
  return Math.floor((ts + 9 * 3600_000) / 86_400_000);
}

export async function runStrategyTick(
  ctx: EngineContext,
  input: StrategyTickInput,
): Promise<TickDecision> {
  const { asOf, config } = input;
  const intents: OrderIntent[] = [];
  const diagnostics: Record<Symbol, string> = {};
  const cooldownUntil = input.cooldownUntil ?? {};

  const portfolio = await ctx.portfolio.getPortfolio(asOf);
  const heldBySymbol = new Map(portfolio.positions.map((p) => [p.symbol, p]));
  const heldSymbols = [...heldBySymbol.keys()];

  // ── 레이어3 청산: 장 마감 N분 전 전량 청산(최우선). liquidateAtClose=false면 비활성. ──
  if (config.liquidateAtClose && input.minutesToClose <= config.liquidateMinutesBeforeClose) {
    for (const pos of portfolio.positions) {
      if (pos.quantity > 0) {
        intents.push({ symbol: pos.symbol, side: 'sell', type: 'market', quantity: pos.quantity, reason: `EOD liquidation (T-${input.minutesToClose}m)` });
        diagnostics[pos.symbol] = 'exit:eod';
      }
    }
    return { intents, diagnostics };
  }

  // 이벤트 점수 (point-in-time): 후보 + 보유 종목
  const universe = [...new Set([...input.watchlist, ...heldSymbols])];
  const scores = await ctx.eventData.getScores({ symbols: universe, asOf });
  const worstSentiment = new Map<Symbol, number>();
  for (const s of scores) {
    const cur = worstSentiment.get(s.symbol);
    if (cur == null || s.sentiment < cur) worstSentiment.set(s.symbol, s.sentiment);
  }

  // ── 보유 종목 청산 판단 ──
  // 우선순위: 하드스탑 → 트레일링. 그다음:
  //   stay-invested 모드(minInvestedRatio>0): 추세이탈(가격<EMA20)에서만 청산 — 승자를 RSI로 덤프하지 않음(과매매 방지).
  //   순수 전술 모드(minInvestedRatio=0): RSI 회복 시 부분/전량 청산(평균회귀).
  const stayInvested = config.minInvestedRatio > 0;
  for (const pos of portfolio.positions) {
    if (pos.quantity <= 0) continue;
    const limit = Math.max(config.rsiPeriod, config.emaPeriod, config.atrPeriod) + 5;
    const bars = await ctx.marketData.getBars({ symbol: pos.symbol, timeframe: '60m', asOf, limit });
    const closes = bars.map((b) => b.close);
    const last = closes[closes.length - 1];
    if (last == null) {
      diagnostics[pos.symbol] = 'hold:no-data';
      continue;
    }
    const r = rsi(closes, config.rsiPeriod);
    const e = ema(closes, config.emaPeriod);
    const mark = input.marks[pos.symbol];
    const entryPrice = pos.avgPrice;
    const hwm = Math.max(mark?.highWaterMark ?? entryPrice, last);
    // 트레일링 스탑: fixed=고점×(1−%), atr=샹들리에(고점 − k×ATR, 변동성 적응). ATR 없으면 fixed 폴백.
    let trailStop = hwm * (1 - config.trailingStopPct);
    if (config.trailingMode === 'atr') {
      const a = atr(bars, config.atrPeriod);
      if (a != null && a > 0) trailStop = hwm - config.trailingAtrMult * a;
    }
    const hardStop = entryPrice * (1 - config.hardStopPct);
    const scaledOut = mark?.scaledOut ?? false;

    const heldMs = mark?.entryTs != null ? asOf - mark.entryTs : 0;
    const maxHoldExceeded = config.maxHoldDays > 0 && mark?.entryTs != null && heldMs >= config.maxHoldDays * 86_400_000;

    if (maxHoldExceeded) {
      intents.push({ symbol: pos.symbol, side: 'sell', type: 'market', quantity: pos.quantity, reason: `max-hold ${config.maxHoldDays}d (held ${(heldMs / 86_400_000).toFixed(1)}d)` });
      diagnostics[pos.symbol] = 'exit:max-hold';
    } else if (last <= hardStop) {
      intents.push({ symbol: pos.symbol, side: 'sell', type: 'market', quantity: pos.quantity, reason: `hard stop ${hardStop.toFixed(0)} (entry ${entryPrice.toFixed(0)})` });
      diagnostics[pos.symbol] = 'exit:hardstop';
    } else if (last <= trailStop) {
      intents.push({ symbol: pos.symbol, side: 'sell', type: 'market', quantity: pos.quantity, reason: `trailing stop ${trailStop.toFixed(0)} (hwm ${hwm.toFixed(0)})` });
      diagnostics[pos.symbol] = 'exit:trailing';
    } else if (stayInvested) {
      // 추세이탈 청산: 가격이 20-EMA 아래로 내려오면 청산(그 외엔 보유 = 과매매 방지).
      if (e != null && last < e) {
        intents.push({ symbol: pos.symbol, side: 'sell', type: 'market', quantity: pos.quantity, reason: `trend-break (price<${e.toFixed(0)} ema${config.emaPeriod})` });
        diagnostics[pos.symbol] = 'exit:trend-break';
      } else {
        diagnostics[pos.symbol] = `hold (ema${config.emaPeriod}=${e?.toFixed(0) ?? 'na'}, trail=${trailStop.toFixed(0)})`;
      }
    } else if (r != null && r > config.rsiExit) {
      const f = config.scaleOutFraction;
      const partialQty = Math.floor(pos.quantity * f);
      if (!scaledOut && f > 0 && f < 1 && partialQty >= 1 && partialQty < pos.quantity) {
        intents.push({ symbol: pos.symbol, side: 'sell', type: 'market', quantity: partialQty, reason: `scale-out ${(f * 100).toFixed(0)}% RSI(${config.rsiPeriod})=${r.toFixed(1)}` });
        diagnostics[pos.symbol] = 'exit:rsi-partial';
      } else {
        intents.push({ symbol: pos.symbol, side: 'sell', type: 'market', quantity: pos.quantity, reason: `RSI(${config.rsiPeriod})=${r.toFixed(1)}>${config.rsiExit}` });
        diagnostics[pos.symbol] = 'exit:rsi';
      }
    } else {
      diagnostics[pos.symbol] = `hold (rsi=${r?.toFixed(1) ?? 'na'}, trail=${trailStop.toFixed(0)}, hard=${hardStop.toFixed(0)})`;
    }
  }

  // ── 레이어2 + 레이어3 진입 판단 ──
  if (!input.indexAbove200dma) {
    for (const sym of input.watchlist) diagnostics[sym] ??= 'no-entry: index<200dma';
    return { intents, diagnostics };
  }

  const slotsOpen = config.maxPositions - heldSymbols.length;
  if (slotsOpen <= 0) {
    for (const sym of input.watchlist) diagnostics[sym] ??= 'no-entry: max positions';
    return { intents, diagnostics };
  }

  const equity = portfolio.equity ?? portfolio.cash;
  const targetNotional = equity * config.perSymbolWeightCap;
  let cashLeft = portfolio.cash;
  let slots = slotsOpen;

  for (const sym of input.watchlist) {
    if (slots <= 0) break;
    if (heldBySymbol.has(sym)) {
      diagnostics[sym] ??= 'skip: already held';
      continue;
    }
    // 재진입 쿨다운
    if (asOf < (cooldownUntil[sym] ?? 0)) {
      diagnostics[sym] = 'no-entry: cooldown';
      continue;
    }
    // 이벤트 veto
    const sent = worstSentiment.get(sym);
    if (sent != null && sent <= config.negativeEventVetoThreshold) {
      diagnostics[sym] = `veto: negative event (${sent.toFixed(2)})`;
      continue;
    }

    const limit = Math.max(config.emaPeriod, config.rsiPeriod, config.atrPeriod) + (config.pullbackEntry ? config.pullbackLookback : 0) + 5;
    const bars = await ctx.marketData.getBars({ symbol: sym, timeframe: '60m', asOf, limit });
    const closes = bars.map((b) => b.close);
    const price = closes[closes.length - 1];
    if (price == null) {
      diagnostics[sym] = 'no-entry: no bars';
      continue;
    }

    // 레이어2 장중: 가격이 VWAP 위 AND 시간봉 20-EMA 위
    const today = tradingDayKey(asOf);
    const todayBars = bars.filter((b: Bar) => tradingDayKey(b.ts) === today);
    const vw = vwap(todayBars.length ? todayBars : bars);
    const e = ema(closes, config.emaPeriod);
    const r = rsi(closes, config.rsiPeriod);

    const aboveVwap = vw != null && price > vw;
    const aboveEma = e != null && price > e;
    if (!(aboveVwap && aboveEma)) {
      diagnostics[sym] = `no-entry: regime (vwap=${aboveVwap}, ema=${aboveEma})`;
      continue;
    }

    const investedValue = equity - cashLeft;
    const underInvested = investedValue < config.minInvestedRatio * equity;
    const tactical = r != null && r < config.rsiEntry; // 눌림(평균회귀) 진입 신호

    // 추세 눌림(pullback): 상승추세(EMA 상승) + 최근 저점이 EMA까지 눌림 + 지금 회복(반등, 라인 위).
    // 국면 게이트(price>VWAP & >EMA)는 위에서 이미 통과 → 여기선 "되돌림 후 재상승" 판정만.
    let pullback = false;
    if (config.pullbackEntry && e != null) {
      const lb = config.pullbackLookback;
      const eseq = emaSeries(closes, config.emaPeriod);
      const emaPast = eseq[eseq.length - 1 - lb] ?? null;
      const trendUp = emaPast != null && e > emaPast; // EMA 우상향
      const recent = bars.slice(-lb);
      const minLow = recent.length ? Math.min(...recent.map((b) => b.low)) : price;
      const touchedMA = minLow <= e * (1 + config.pullbackBandPct); // 최근 저점이 EMA 근처까지 눌림
      const prevClose = closes[closes.length - 2];
      const resuming = prevClose != null && price > prevClose; // 직전봉 대비 반등(추세 회복)
      pullback = trendUp && touchedMA && resuming;
    }

    const atrSize = () => {
      let q = Math.floor(targetNotional / price);
      if (config.atrSizing) {
        const a = atr(bars, config.atrPeriod);
        if (a != null && a > 0) q = Math.min(Math.floor((equity * config.riskPerTradePct) / (config.atrStopMult * a)), q);
      }
      return q;
    };

    let qty: number;
    let reason: string;
    if (tactical) {
      // 전술 레이어: RSI 눌림 매수 + ATR 변동성 타깃 사이징(비중캡 상한).
      qty = atrSize();
      reason = `entry rsi=${r!.toFixed(1)} >vwap >ema${config.emaPeriod}${config.atrSizing ? ' atr-sized' : ''}`;
    } else if (pullback) {
      // 추세 눌림 레이어: EMA/VWAP까지 눌렸다 회복 → ATR 사이징 매수.
      qty = atrSize();
      reason = `pullback: 상승추세 EMA${config.emaPeriod} 눌림 후 회복`;
    } else if (underInvested) {
      // 코어 레이어(stay-invested): 투자비중이 최소치 미달이면 국면통과 종목으로 비중을 채운다(추세추종 성격).
      const deficit = config.minInvestedRatio * equity - investedValue;
      qty = Math.floor(Math.min(targetNotional, deficit, cashLeft) / price);
      reason = `core top-up (invested<${(config.minInvestedRatio * 100).toFixed(0)}%) >vwap >ema${config.emaPeriod}`;
    } else {
      diagnostics[sym] = `no-entry: rsi=${r?.toFixed(1) ?? 'na'} !< ${config.rsiEntry}, invested ok`;
      continue;
    }

    qty = Math.min(qty, Math.floor(cashLeft / price)); // 현금 상한
    if (qty <= 0) {
      diagnostics[sym] = 'no-entry: size 0 (cash/atr cap)';
      continue;
    }

    intents.push({ symbol: sym, side: 'buy', type: 'market', quantity: qty, reason });
    diagnostics[sym] = tactical ? 'entry' : pullback ? 'entry:pullback' : 'entry:core';
    cashLeft -= qty * price;
    slots -= 1;
  }

  return { intents, diagnostics };
}
