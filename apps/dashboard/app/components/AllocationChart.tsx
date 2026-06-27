'use client';
import { useMemo, useRef, useState } from 'react';
import { nm } from '../lib/names';

export interface AllocationPoint {
  ts: number; // epoch ms
  cash: number;
  positions: Record<string, number>;
}

const PALETTE = ['#60a5fa', '#34d399', '#f59e0b', '#a78bfa', '#f87171', '#22d3ee', '#fb7185', '#a3e635', '#e879f9', '#fbbf24'];
const CASH_COLOR = '#64748b';
const ETC_COLOR = '#475569';

const won = (n: number) => n.toLocaleString('ko-KR', { maximumFractionDigits: 0 });

interface Band { key: string; label: string; color: string }
interface MonthBar { label: string; frac: Record<string, number>; amount: Record<string, number>; total: number }

/** 월별 누적 막대 차트 — 시간순으로 현금/종목 비중이 어떻게 변하는지. hover 시 월·비중·금액 툴팁. */
export function AllocationChart({ series, names }: { series: AllocationPoint[]; names: Record<string, string> }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<{ i: number; x: number; y: number } | null>(null);

  const { bands, months } = useMemo(() => {
    const totals = series.map((p) => p.cash + Object.values(p.positions).reduce((a, b) => a + b, 0) || 1);
    const sumFrac = new Map<string, number>();
    series.forEach((p, i) => {
      for (const [sym, v] of Object.entries(p.positions)) sumFrac.set(sym, (sumFrac.get(sym) ?? 0) + v / totals[i]!);
    });
    const ranked = [...sumFrac.entries()].sort((a, b) => b[1] - a[1]).map(([s]) => s);
    const top = new Set(ranked.slice(0, 8));
    const bands: Band[] = [
      { key: '__cash', label: '현금', color: CASH_COLOR },
      ...ranked.filter((s) => top.has(s)).map((s, i) => ({ key: s, label: nm(s, names), color: PALETTE[i % PALETTE.length]! })),
    ];
    if (ranked.some((s) => !top.has(s))) bands.push({ key: '__etc', label: '기타', color: ETC_COLOR });

    // KST 월별 버킷으로 평균 비중·금액 집계.
    const buckets = new Map<string, { fracSum: Record<string, number>; amtSum: Record<string, number>; totSum: number; n: number }>();
    series.forEach((p, i) => {
      const d = new Date(p.ts + 9 * 3600_000);
      const key = `${d.getUTCFullYear()}.${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
      const b = buckets.get(key) ?? { fracSum: {}, amtSum: {}, totSum: 0, n: 0 };
      const t = totals[i]!;
      const add = (k: string, v: number) => {
        b.fracSum[k] = (b.fracSum[k] ?? 0) + v / t;
        b.amtSum[k] = (b.amtSum[k] ?? 0) + v;
      };
      add('__cash', p.cash);
      let etc = 0;
      for (const [sym, v] of Object.entries(p.positions)) {
        if (top.has(sym)) add(sym, v);
        else etc += v;
      }
      if (etc > 0) add('__etc', etc);
      b.totSum += t;
      b.n += 1;
      buckets.set(key, b);
    });
    const months: MonthBar[] = [...buckets.entries()].map(([label, b]) => {
      const frac: Record<string, number> = {};
      const amount: Record<string, number> = {};
      for (const k of Object.keys(b.fracSum)) {
        frac[k] = b.fracSum[k]! / b.n;
        amount[k] = b.amtSum[k]! / b.n;
      }
      return { label, frac, amount, total: b.totSum / b.n };
    });
    return { bands, months };
  }, [series, names]);

  if (months.length < 1) return <div className="empty">비중 데이터 부족</div>;

  const W = 1040;
  const H = 240;
  const P = months.length;
  const step = W / P;
  const barW = step * 0.82;
  const gap = step * 0.18;
  const y = (f: number) => H - f * H;

  const onMove = (e: React.MouseEvent) => {
    const el = wrapRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const i = Math.min(P - 1, Math.max(0, Math.floor(((e.clientX - rect.left) / rect.width) * P)));
    setHover({ i, x: e.clientX - rect.left, y: e.clientY - rect.top });
  };

  const hb = hover ? months[hover.i]! : null;
  const tipBands = hb ? bands.map((b) => ({ b, f: hb.frac[b.key] ?? 0, a: hb.amount[b.key] ?? 0 })).filter((x) => x.f > 0.001).sort((a, b) => b.f - a.f) : [];
  const axisStep = Math.max(1, Math.ceil(P / 8));

  return (
    <div ref={wrapRef} style={{ position: 'relative' }} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} preserveAspectRatio="none" style={{ display: 'block', borderRadius: 6 }}>
        {months.map((m, i) => {
          let cum = 0;
          return (
            <g key={i}>
              {hover?.i === i && <rect x={i * step} y={0} width={step} height={H} fill="#ffffff" opacity={0.08} />}
              {bands.map((b) => {
                const f = m.frac[b.key] ?? 0;
                if (f <= 0) return null;
                const yTop = y(cum + f);
                const h = f * H;
                cum += f;
                return <rect key={b.key} x={i * step + gap / 2} y={yTop} width={barW} height={h} fill={b.color} opacity={hover && hover.i !== i ? 0.55 : 1} />;
              })}
            </g>
          );
        })}
      </svg>

      {/* 월 축 */}
      <div style={{ position: 'relative', height: 16, marginTop: 2 }}>
        {months.map((m, i) =>
          i % axisStep === 0 ? (
            <span key={i} className="text-muted" style={{ position: 'absolute', left: `${((i + 0.5) / P) * 100}%`, transform: 'translateX(-50%)', fontSize: 11 }}>
              {m.label}
            </span>
          ) : null,
        )}
      </div>

      <div className="flex flex-wrap gap-x-3 gap-y-1 mt-2 text-[12px]">
        {bands.map((b) => (
          <span key={b.key} className="inline-flex items-center gap-1">
            <span style={{ background: b.color, width: 10, height: 10, display: 'inline-block', borderRadius: 2 }} />
            {b.label}
          </span>
        ))}
      </div>
      <div className="text-muted text-[11px] mt-1">월별 평균 비중(0~100%) · 막대에 올리면 월·비중·금액</div>

      {hover && hb && (
        <div
          style={{
            position: 'absolute',
            left: Math.min(hover.x + 14, (wrapRef.current?.clientWidth ?? 300) - 210),
            top: Math.max(hover.y - 10, 0),
            background: '#0f1115',
            border: '1px solid #262b36',
            borderRadius: 8,
            padding: '8px 10px',
            fontSize: 12,
            pointerEvents: 'none',
            minWidth: 195,
            zIndex: 10,
            boxShadow: '0 6px 24px rgba(0,0,0,0.5)',
          }}
        >
          <div className="muted" style={{ marginBottom: 4 }}>
            {hb.label} · 평균 총자산 {won(hb.total)}원
          </div>
          {tipBands.map(({ b, f, a }) => (
            <div key={b.key} className="flex" style={{ justifyContent: 'space-between', gap: 8 }}>
              <span className="inline-flex items-center gap-1">
                <span style={{ background: b.color, width: 8, height: 8, display: 'inline-block', borderRadius: 2 }} />
                {b.label}
              </span>
              <span style={{ fontVariantNumeric: 'tabular-nums' }}>
                {(f * 100).toFixed(1)}% · {won(a)}원
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
