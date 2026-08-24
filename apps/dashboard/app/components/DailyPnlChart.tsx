'use client';
import { useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

export interface DailyPnlPoint {
  day: string;      // KST 거래일 YYYY-MM-DD
  equity: number;   // 그날 종료 시점 총자산
  pnl: number;      // 전 거래일 대비 총손익(실현+평가)
  realized: number; // 그중 실현손익(체결 기준)
}

const GREEN = '#34d399';
const RED = '#f87171';
const LINE = '#60a5fa';
const W = 1040;
const H = 200;
const ZERO = H / 2;
const won = (n: number) => n.toLocaleString('ko-KR', { maximumFractionDigits: 0 });
const signed = (n: number) => `${n >= 0 ? '+' : ''}${won(n)}`;

/**
 * 일별 손익 차트 — 막대는 거래일별 총손익(전일 대비 총자산 변화), 선은 누적 손익.
 * 막대 클릭 시 그 거래일로 이동(?day=), hover 시 실현/평가 분해 툴팁.
 */
export function DailyPnlChart({ series, selected }: { series: DailyPnlPoint[]; selected: string }) {
  const router = useRouter();
  const wrapRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<{ i: number; x: number; y: number } | null>(null);

  const { bars, cumPath, maxAbs } = useMemo(() => {
    let cum = 0;
    const bars = series.map((p) => {
      cum += p.pnl;
      return { ...p, cum };
    });
    const maxAbs = Math.max(1, ...bars.map((b) => Math.abs(b.pnl)));
    const cums = bars.map((b) => b.cum);
    const cMin = Math.min(0, ...cums);
    const span = (Math.max(0, ...cums) - cMin) || 1;
    // 누적선은 막대와 스케일이 다르다(금액 규모 차이) → 차트 전 영역을 자체 min~max 로 사용.
    const cumY = (v: number) => H - 8 - ((v - cMin) / span) * (H - 16);
    const cumPath = bars.map((b, i) => `${i === 0 ? 'M' : 'L'}${(i + 0.5) * (W / bars.length)},${cumY(b.cum)}`).join(' ');
    return { bars, cumPath, maxAbs };
  }, [series]);

  if (bars.length < 2) return <div className="empty">일별 손익 데이터 부족 (거래일 2일 이상 필요)</div>;

  const step = W / bars.length;
  const barW = step * 0.7;
  const barY = (v: number) => ZERO - (v / maxAbs) * (H / 2 - 6);

  const onMove = (e: React.MouseEvent) => {
    const el = wrapRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const i = Math.min(bars.length - 1, Math.max(0, Math.floor(((e.clientX - rect.left) / rect.width) * bars.length)));
    setHover({ i, x: e.clientX - rect.left, y: e.clientY - rect.top });
  };

  const hb = hover ? bars[hover.i]! : null;
  const axisStep = Math.max(1, Math.ceil(bars.length / 10));
  const total = bars[bars.length - 1]!.cum;
  const wins = bars.filter((b) => b.pnl > 0).length;
  const best = bars.reduce((a, b) => (b.pnl > a.pnl ? b : a));
  const worst = bars.reduce((a, b) => (b.pnl < a.pnl ? b : a));

  return (
    <div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[12px] mb-2">
        <span className="muted">{bars[0]!.day} ~ {bars[bars.length - 1]!.day} · {bars.length}거래일</span>
        <span>누적손익 <b className={total >= 0 ? 'green' : 'red'}>{signed(total)}원</b></span>
        <span className="muted">승률 {((wins / bars.length) * 100).toFixed(0)}% ({wins}/{bars.length})</span>
        <span className="muted">최고 <span className="green">{signed(best.pnl)}</span> ({best.day})</span>
        <span className="muted">최저 <span className="red">{signed(worst.pnl)}</span> ({worst.day})</span>
      </div>

      <div ref={wrapRef} style={{ position: 'relative' }} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
        <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} preserveAspectRatio="none" style={{ display: 'block' }}>
          {bars.map((b, i) => {
            const y = barY(b.pnl);
            const h = Math.max(1, Math.abs(ZERO - y));
            const isSel = b.day === selected;
            return (
              <g key={b.day} onClick={() => router.push(`/?day=${b.day}`)} style={{ cursor: 'pointer' }}>
                {hover?.i === i && <rect x={i * step} y={0} width={step} height={H} fill="#ffffff" opacity={0.08} />}
                <rect
                  x={i * step + (step - barW) / 2}
                  y={b.pnl >= 0 ? y : ZERO}
                  width={barW}
                  height={h}
                  fill={b.pnl >= 0 ? GREEN : RED}
                  opacity={hover && hover.i !== i ? 0.6 : 1}
                  stroke={isSel ? '#e5e7eb' : undefined}
                  strokeWidth={isSel ? 1 : undefined}
                  vectorEffect="non-scaling-stroke"
                />
              </g>
            );
          })}
          <line x1={0} y1={ZERO} x2={W} y2={ZERO} stroke="#262b36" strokeWidth={1} />
          <path d={cumPath} fill="none" stroke={LINE} strokeWidth={1.6} opacity={0.85} vectorEffect="non-scaling-stroke" />
        </svg>

        {/* 날짜 축 */}
        <div style={{ position: 'relative', height: 16, marginTop: 2 }}>
          {bars.map((b, i) =>
            i % axisStep === 0 || b.day === selected ? (
              <span key={b.day} className={b.day === selected ? '' : 'text-muted'} style={{ position: 'absolute', left: `${((i + 0.5) / bars.length) * 100}%`, transform: 'translateX(-50%)', fontSize: 11 }}>
                {b.day === selected ? `▲ ${b.day.slice(5)}` : b.day.slice(5)}
              </span>
            ) : null,
          )}
        </div>

        <div className="flex flex-wrap gap-x-3 gap-y-1 mt-2 text-[12px]">
          <span className="inline-flex items-center gap-1"><span style={{ background: GREEN, width: 10, height: 10, display: 'inline-block', borderRadius: 2 }} />이익일</span>
          <span className="inline-flex items-center gap-1"><span style={{ background: RED, width: 10, height: 10, display: 'inline-block', borderRadius: 2 }} />손실일</span>
          <span className="inline-flex items-center gap-1"><span style={{ background: LINE, width: 10, height: 2, display: 'inline-block' }} />누적손익(별도 스케일)</span>
          <span className="text-muted">막대 클릭 = 그 거래일 보기</span>
        </div>

        {hover && hb && (
          <div
            style={{
              position: 'absolute',
              left: Math.min(hover.x + 14, (wrapRef.current?.clientWidth ?? 300) - 215),
              top: Math.max(hover.y - 10, 0),
              background: '#0f1115',
              border: '1px solid #262b36',
              borderRadius: 8,
              padding: '8px 10px',
              fontSize: 12,
              pointerEvents: 'none',
              minWidth: 200,
              zIndex: 10,
              boxShadow: '0 6px 24px rgba(0,0,0,0.5)',
            }}
          >
            <div className="muted" style={{ marginBottom: 4 }}>{hb.day}</div>
            {[
              ['총자산', `${won(hb.equity)}원`, ''],
              ['일별손익', `${signed(hb.pnl)}원 (${hb.equity - hb.pnl > 0 ? `${hb.pnl >= 0 ? '+' : ''}${((hb.pnl / (hb.equity - hb.pnl)) * 100).toFixed(2)}%` : '–'})`, hb.pnl >= 0 ? 'green' : 'red'],
              ['· 실현', `${signed(hb.realized)}원`, hb.realized > 0 ? 'green' : hb.realized < 0 ? 'red' : 'muted'],
              ['· 평가', `${signed(hb.pnl - hb.realized)}원`, hb.pnl - hb.realized > 0 ? 'green' : hb.pnl - hb.realized < 0 ? 'red' : 'muted'],
              ['누적손익', `${signed(hb.cum)}원`, hb.cum >= 0 ? 'green' : 'red'],
            ].map(([k, v, cls]) => (
              <div key={k} className="flex" style={{ justifyContent: 'space-between', gap: 10 }}>
                <span className="muted">{k}</span>
                <span className={cls} style={{ fontVariantNumeric: 'tabular-nums' }}>{v}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
