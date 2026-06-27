'use client';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

/** 1차는 읽기 전용 + 폴링(13장). N초마다 서버 컴포넌트 데이터를 새로 가져온다. */
export function AutoRefresh({ seconds = 5 }: { seconds?: number }) {
  const router = useRouter();
  useEffect(() => {
    const id = setInterval(() => router.refresh(), seconds * 1000);
    return () => clearInterval(id);
  }, [router, seconds]);
  return <span className="muted" style={{ fontSize: 12 }}>· {seconds}s 폴링</span>;
}
