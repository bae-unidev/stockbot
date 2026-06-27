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
