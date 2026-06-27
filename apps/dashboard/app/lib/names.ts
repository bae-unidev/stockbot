/** 순수 헬퍼(서버/클라이언트 공용) — DB import 없음(클라이언트 번들 안전). */
export function nm(code: string, names: Record<string, string>): string {
  return names[code] ?? code;
}
