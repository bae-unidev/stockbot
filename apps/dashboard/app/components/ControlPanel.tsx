'use client';
/**
 * 운영 제어 패널 — 포지션 정리 / 킬스위치 / 해제.
 * 버튼은 명령 큐에 적재만 한다(워커가 폴링 실행). 되돌리기 어려운 작업이라 확인 다이얼로그 필수.
 */
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { flattenPositions, killSwitch, releaseKillSwitch } from '../actions';

export function ControlPanel({ killSwitchOn, positionsCount }: { killSwitchOn: boolean; positionsCount: number }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);

  const run = (label: string, confirmText: string, action: () => Promise<void>) => {
    if (!window.confirm(confirmText)) return;
    start(async () => {
      await action();
      setMsg(`${label} 명령 접수됨 — 워커가 곧 실행합니다(최대 ~10초).`);
      router.refresh();
    });
  };

  return (
    <section className="panel">
      <h2>운영 제어</h2>
      <div className="flex flex-wrap gap-2">
        <button
          className="btn"
          disabled={pending || positionsCount === 0}
          onClick={() => run('포지션 정리', `보유 ${positionsCount}종목을 전량 시장가로 청산합니다. (봇은 계속 가동)\n진행할까요?`, flattenPositions)}
        >
          포지션 정리 ({positionsCount})
        </button>

        {killSwitchOn ? (
          <button
            className="btn btn-ok"
            disabled={pending}
            onClick={() => run('킬스위치 해제', '킬스위치를 해제합니다. 당일 신규 매수가 다시 허용됩니다.\n진행할까요?', releaseKillSwitch)}
          >
            킬스위치 해제
          </button>
        ) : (
          <button
            className="btn btn-danger"
            disabled={pending}
            onClick={() => run('킬스위치', `🚨 킬스위치: 당일 신규매수를 중단하고 보유 ${positionsCount}종목을 전량 시장가 청산합니다.\n정말 진행할까요?`, killSwitch)}
          >
            🚨 킬스위치
          </button>
        )}
      </div>
      <p className="muted mt-2 text-[12px]">
        정리=청산만(봇 계속) · 킬스위치=청산+당일 매수중단. 명령은 큐에 적재되고 워커가 실행합니다(브로커 직접 접근 없음).
      </p>
      {msg && <p className="mt-1 text-[12px] text-accent">{msg}</p>}
      {pending && <p className="muted mt-1 text-[12px]">접수 중…</p>}
    </section>
  );
}
