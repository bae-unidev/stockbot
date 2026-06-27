/** 전략 설명 페이지(/strategy) — 중학생 눈높이 + 현재 파라미터값 표시. */
import { DEFAULT_STRATEGY_CONFIG as C } from '@stockbot/core';
import { Term } from '../components/Term';

export const dynamic = 'force-static';

function Row({ name, value, desc }: { name: React.ReactNode; value: string; desc: string }) {
  return (
    <tr>
      <td style={{ whiteSpace: 'nowrap' }}>{name}</td>
      <td className="right" style={{ whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}><b>{value}</b></td>
      <td className="muted">{desc}</td>
    </tr>
  );
}
const pct = (n: number) => `${(n * 100).toFixed(n < 0.1 ? 1 : 0)}%`;

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="panel" style={{ marginTop: 16 }}>
      <h2>{title}</h2>
      <div style={{ fontSize: 14, lineHeight: 1.7 }}>{children}</div>
    </section>
  );
}

export default function StrategyPage() {
  return (
    <>
      <h2 style={{ fontSize: 16 }}>전략 설명</h2>
      <p className="muted">코스피 모의투자 봇이 어떻게 사고파는지 — 아주 쉽게. (밑줄 친 용어는 마우스를 올리면 설명이 떠요)</p>

      <Card title="한 줄 요약">
        <b>잠깐 싸진 좋은 주식을 사서 조금 오르면 팔되, 돈을 너무 놀리지 않게 항상 절반 이상은 투자해 둔다.</b> 그리고 미리 정한 안전장치(<Term t="하드 스탑로스">손절선</Term> 등)를 칼같이 지킨다.
      </Card>

      <Card title="① 후보 고르기 — 워치리스트 (하루 1번)">
        반에서 "오늘 눈여겨볼 애들" 명단을 뽑듯, 4가지로 점수를 매겨 상위 종목만 추려요.
        <ul style={{ margin: '8px 0', paddingLeft: 18 }}>
          <li><b>모멘텀</b>: 요즘 잘 나가는가 (최근에 오른 종목)</li>
          <li><b>밸류</b>: 실력보다 싼가 (PER·PBR 낮은 종목)</li>
          <li><b>퀄리티</b>: 회사가 돈을 잘 버는가 (ROE 높은 종목)</li>
          <li><b><Term t="event_score">이벤트 점수</Term></b>: 뉴스·공시가 좋은가 — 여기만 AI가 점수를 매겨요. <u>AI는 점수만 주고, 사고파는 결정은 규칙이 합니다.</u></li>
        </ul>
      </Card>

      <Card title="② 지금 살 때인가 — 국면 필터 (매시간)">
        명단에 있어도 분위기가 나쁘면 안 사요. 신호등이 모두 초록이어야 진입 허용:
        <ul style={{ margin: '8px 0', paddingLeft: 18 }}>
          <li>시장 전체가 상승 추세인가 (지수가 200일 평균 위)</li>
          <li>이 종목이 <Term t="VWAP">VWAP</Term> 위 그리고 <Term t="EMA20">20시간 평균선</Term> 위에 있나</li>
          <li>나쁜 뉴스가 터졌으면 <b>진입 거부(veto)</b></li>
        </ul>
      </Card>

      <Card title="③ 사고팔기 — 세 가지 진입 알고리즘">
        <b>① 전술(눌림 매수):</b> 신호등 통과 + <Term t="RSI">RSI</Term>가 아주 낮을 때(잠깐 푹 빠졌을 때) 산다. (평균회귀)
        <br />
        <b>② 추세 눌림(pullback):</b> 상승추세(EMA 우상향) 종목이 <Term t="EMA20">EMA</Term>/<Term t="VWAP">VWAP</Term>까지 눌렸다가 다시 위로 회복하는 순간 산다. (추세 지속) — 백테스트상 이 진입이 수익에 크게 기여(+7.5%→+37.7%).
        <br />
        <b>③ 코어(항상 투자):</b> 돈이 너무 놀고 있으면(투자 비중 <b>{pct(C.minInvestedRatio)} 미만</b>) 신호등 통과한 강한 종목으로 비중을 채워 <b>최소 {pct(C.minInvestedRatio)}는 늘 투자</b>(현금 {pct(1 - C.minInvestedRatio)} 이하).
        <div style={{ marginTop: 8 }}>
          <b>팔 때</b>: <Term t="하드 스탑로스">하드 스탑로스</Term>(산 값 −7%) · <Term t="트레일링 스탑">트레일링 스탑</Term>(고점 −5%) · 추세 이탈(20시간 평균선 아래로) 중 먼저 닿는 것.
        </div>
      </Card>

      <Card title="파는 기준 자세히 — &quot;조금 오르면 판다&quot;가 +5% 익절이냐고요? 🤔">
        이 봇엔 <b>&quot;+X% 오르면 무조건 판다&quot;(<Term t="익절(take-profit)">고정 익절</Term>) 규칙이 없습니다.</b> 대신 아래 넷 중 <b>먼저 닿는 것</b>으로 팔아요:
        <ul style={{ margin: '8px 0', paddingLeft: 18 }}>
          <li><b><Term t="트레일링 스탑">트레일링 스탑</Term></b>: <Term t="고점">고점</Term> − 3×ATR(샹들리에) 아래로 빠지면 매도 — 변동성 큰 종목은 넓게, 잔잔한 종목은 좁게(낙폭 방어)</li>
          <li><b>추세이탈</b>: 가격이 20시간 평균선(EMA20) 아래로 내려오면</li>
          <li><b><Term t="하드 스탑로스">하드 스탑로스</Term></b>: 산 값 −7%</li>
          <li><b>최대 보유일수</b>: 14일 경과</li>
        </ul>
        <div style={{ marginTop: 6 }}>
          <b>여기서 &quot;고점&quot;은 52주 고점이 아니라</b> 그 종목을 <u>산 뒤부터 본 최고가</u>(보유하는 동안만)예요. 팔고 다시 사면 새로 시작합니다.
        </div>
        <div style={{ marginTop: 8 }}>
          <b>왜 +5% 익절을 안 쓰나?</b> 이 전략은 추세추종이라 <u>승자를 끝까지 들고 가는 게 핵심</u>입니다. 트레일링 스탑 폭을 바꿔 백테스트한 결과:
          <table style={{ marginTop: 6 }}>
            <thead><tr><th>트레일링</th><th className="right">수익률</th><th className="muted">해석</th></tr></thead>
            <tbody>
              <tr><td>3% (타이트)</td><td className="right red">−0.9%</td><td className="muted">작은 이익에 일찍 잘림(휩쏘)</td></tr>
              <tr><td>5% (고정 기준)</td><td className="right green">+21.3%</td><td className="muted">고정%의 sweet spot</td></tr>
              <tr><td>8%</td><td className="right">+6.9%</td><td className="muted">너무 늦게 팔아 게워냄</td></tr>
              <tr><td>10%</td><td className="right">+5.2%</td><td className="muted">〃</td></tr>
            </tbody>
          </table>
          → "조금 오르면 바로 판다(+5% 익절)"는 오히려 <b>3% 트레일링과 같은 이유로 수익을 깎습니다.</b> 그래서 고정 익절은 안 씁니다.
          <div style={{ marginTop: 6 }}>
            <b>최종 선택: 고정%가 아니라 <Term t="트레일링 스탑">샹들리에 ATR(고점 − 3×ATR)</Term>.</b> 수익은 약간 낮아도(+11%→+7.5%) <b>낙폭(MDD)을 25.8%→17.9%로 크게 줄여</b>서 낙폭 방어를 우선했습니다. 변동성 큰 종목엔 넓게·잔잔한 종목엔 좁게 손절이 자동 조절돼요. (`pnpm chandeliersweep`로 재확인)
          </div>
        </div>
      </Card>

      <Card title="안전장치 🛡️">
        <ul style={{ margin: '8px 0', paddingLeft: 18 }}>
          <li><b>인트라아워 스탑</b>: 1시간 기다리지 않고 매분 가격을 확인해 손절선에 닿으면 즉시 청산</li>
          <li><b><Term t="ATR">ATR</Term> 사이징</b>: 많이 출렁이는 종목은 조금만, 잔잔한 종목은 더 많이 — 한 종목 몰빵 방지</li>
          <li><b>재진입 쿨다운</b>: 방금 판 종목은 잠깐 다시 안 삼 (출렁임에 휘둘리지 않게)</li>
          <li><b><Term t="킬스위치">킬스위치</Term></b>: 하루 손실 한도를 넘으면 그날은 더 안 삼</li>
          <li><b>멱등 주문·대사</b>: 같은 주문을 두 번 넣지 않고, 항상 증권사 잔고를 진실로 삼아 맞춤</li>
        </ul>
      </Card>

      <Card title="지금 적용된 파라미터값">
        <table>
          <thead><tr><th>파라미터</th><th className="right">현재값</th><th>의미</th></tr></thead>
          <tbody>
            <Row name={<Term t="RSI">진입 RSI(2)</Term>} value={`< ${C.rsiEntry}`} desc="이보다 낮게 눌리면 매수(전술)" />
            <Row name="청산 RSI" value={`> ${C.rsiExit}`} desc="회복 시 청산(순수 전술 모드에서만)" />
            <Row name={<Term t="EMA20">EMA 기간</Term>} value={`${C.emaPeriod}시간`} desc="추세 기준선" />
            <Row name={<Term t="트레일링 스탑">트레일링 스탑</Term>} value={C.trailingMode === 'atr' ? `샹들리에 ATR ×${C.trailingAtrMult}` : pct(C.trailingStopPct)} desc={C.trailingMode === 'atr' ? '고점 − k×ATR (변동성 적응, 낙폭 방어)' : '고점 대비 이만큼 빠지면 청산'} />
            <Row name={<Term t="하드 스탑로스">하드 스탑로스</Term>} value={pct(C.hardStopPct)} desc="진입가 대비 손절선(최후 방어)" />
            <Row name="최대 보유일수" value={`${C.maxHoldDays}일`} desc="이 기간 넘기면 시간기반 강제 청산" />
            <Row name="최소 투자비중" value={pct(C.minInvestedRatio)} desc="항상 이만큼은 투자 유지(코어)" />
            <Row name="추세 눌림 진입" value={C.pullbackEntry ? `ON (EMA±${pct(C.pullbackBandPct)}, ${C.pullbackLookback}봉)` : 'OFF'} desc="상승추세가 EMA/VWAP 눌림 후 회복 시 매수" />
            <Row name="마감 전량청산" value={C.liquidateAtClose ? 'ON' : 'OFF'} desc="OFF=오버나잇 보유 허용" />
            <Row name="동시 보유 최대" value={`${C.maxPositions}종목`} desc="포트폴리오 최대 종목 수" />
            <Row name="종목당 비중 캡" value={pct(C.perSymbolWeightCap)} desc="한 종목 최대 비중" />
            <Row name="재진입 쿨다운" value={`${C.reentryCooldownBars}봉`} desc="청산 후 재진입 금지 기간" />
            <Row name={<Term t="ATR">ATR 사이징</Term>} value={C.atrSizing ? `ON (위험 ${pct(C.riskPerTradePct)}/거래)` : 'OFF'} desc="변동성 기반 수량 조절" />
            <Row name="이벤트 veto" value={C.negativeEventVetoThreshold.toFixed(1)} desc="감성점수 이 값 이하면 진입 거부" />
            <Row name="워치리스트 크기" value={`${C.watchlistSize}종목`} desc="하루 후보 상위 N" />
            <Row name="팩터 가중치" value={`모멘텀 ${C.factorWeights.momentum} / 밸류 ${C.factorWeights.value} / 퀄리티 ${C.factorWeights.quality} / 이벤트 ${C.factorWeights.event}`} desc="워치리스트 종목 점수 비중" />
            <Row name="일일 손실 한도" value="5%" desc="당일 이 손실 넘으면 킬스위치(.env)" />
          </tbody>
        </table>
        <div className="muted" style={{ marginTop: 6 }}>
          ※ 동시보유·종목당캡·일일손실한도는 환경변수(.env)로 덮어쓸 수 있어요. 백테스트는 야후 시간봉(비공식·근사)이라 실제와 다를 수 있습니다.
        </div>
      </Card>

      <Card title="솔직한 한계 ⚠️">
        <ul style={{ margin: '8px 0', paddingLeft: 18 }}>
          <li>거래를 <b>자주 할수록 수수료·세금·노이즈에 당해</b> 보통 성적이 나빠져요. 적게·정확히가 유리.</li>
          <li>1차는 <b>모의투자(paper) 전용</b> — 실제 돈으로 거래하지 않아요.</li>
          <li>AI는 <b>점수만</b> 만들고, 매매 결정은 규칙 엔진이 합니다.</li>
        </ul>
      </Card>
    </>
  );
}
