/**
 * 타임아웃 있는 fetch(AbortController). KIS 연결이 멈추면(hang) await 가 영원히 안 끝나
 * 워커 이벤트루프/Bottleneck 이 통째로 얼어붙는다 → 모든 KIS 호출에 이 헬퍼를 쓴다.
 */
export async function fetchWithTimeout(url: string, opts: RequestInit = {}, ms = 8_000): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}
