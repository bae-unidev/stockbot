/**
 * 엔트리포인트에서 가장 먼저 import 한다. 저장소 루트의 .env 를 process.env 로 로드.
 * (Node 20.12+ 내장 loadEnvFile 사용 — 외부 의존성 없음.)
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
// apps/worker/src → repo root
const candidates = [
  resolve(here, '../../../.env'),
  resolve(process.cwd(), '.env'),
];

for (const path of candidates) {
  if (existsSync(path)) {
    try {
      process.loadEnvFile(path);
      break;
    } catch {
      // 무시 — 이미 환경변수가 주입된 경우(컨테이너/CI)
    }
  }
}
