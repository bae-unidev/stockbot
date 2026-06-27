'use server';
/**
 * 운영 제어 — 명령 큐에 적재만 한다(13장 안전제약). 대시보드는 KIS 를 직접 만지지 않는다.
 * 실제 청산/킬스위치는 워커(매매 주체)가 control_commands 를 폴링해 OrderManager 경유로 실행.
 */
import { revalidatePath } from 'next/cache';
import { sql } from './lib/db';

type Kind = 'flatten' | 'kill' | 'kill_off';

async function enqueue(kind: Kind): Promise<void> {
  await sql`insert into control_commands (kind, status, requested_by) values (${kind}, 'pending', 'dashboard')`;
  revalidatePath('/');
}

/** 전 포지션 시장가 청산(봇은 계속 가동). */
export async function flattenPositions(): Promise<void> {
  await enqueue('flatten');
}

/** 킬스위치 ON: 당일 신규매수 차단 + 전 포지션 시장가 청산. */
export async function killSwitch(): Promise<void> {
  await enqueue('kill');
}

/** 킬스위치 해제(당일 재가동). */
export async function releaseKillSwitch(): Promise<void> {
  await enqueue('kill_off');
}
