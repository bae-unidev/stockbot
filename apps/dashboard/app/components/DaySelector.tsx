'use client';
/** 실매매 모니터링 일자 선택. ?day=YYYY-MM-DD 로 네비게이션 → 서버 컴포넌트가 그 날 기준으로 렌더. */
import { useRouter } from 'next/navigation';

export function DaySelector({ days, selected }: { days: string[]; selected: string }) {
  const router = useRouter();
  if (days.length <= 1) return <span className="pill">세션 {selected}</span>;
  return (
    <label className="inline-flex items-center gap-1 text-[12px] text-muted">
      세션
      <select
        value={selected}
        onChange={(e) => router.push(`/?day=${e.target.value}`)}
        className="bg-panel border border-panel-border rounded-md px-2 py-[3px] text-ink text-[13px] cursor-pointer"
      >
        {days.map((d) => <option key={d} value={d}>{d}</option>)}
      </select>
    </label>
  );
}
