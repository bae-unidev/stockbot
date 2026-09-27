/** KIS 에러 타입 분리(5장). 호출부는 재시도/알림 정책을 타입으로 판단한다. */
export class KisError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'KisError';
  }
}

/** 인증/토큰 관련(재발급 필요). */
export class KisAuthError extends KisError {
  constructor(message: string, code?: string) {
    super(message, code);
    this.name = 'KisAuthError';
  }
}

/** 레이트리밋 초과(백오프 후 재시도). */
export class KisRateLimitError extends KisError {
  constructor(message: string, code?: string) {
    super(message, code);
    this.name = 'KisRateLimitError';
  }
}

/** 비즈니스 거부(주문 거부 등 — 재시도 무의미). */
export class KisRejectedError extends KisError {
  constructor(message: string, code?: string) {
    super(message, code);
    this.name = 'KisRejectedError';
  }
}

/**
 * 주문 전송 후 응답을 못 받음(타임아웃/연결 끊김) — 브로커 접수 여부 불명.
 * 재시도하면 중복 주문이 된다(2026-08-13 SK텔레콤 3중 매수 실제 발생) → 재시도 금지, 대사로 확정.
 */
export class KisAmbiguousError extends KisError {
  constructor(message: string, code?: string) {
    super(message, code);
    this.name = 'KisAmbiguousError';
  }
}
