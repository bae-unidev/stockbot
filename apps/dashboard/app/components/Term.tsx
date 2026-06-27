import type { ReactNode } from 'react';
import { GLOSSARY } from '../lib/glossary';

/** 전문용어에 점선 밑줄 + hover 툴팁(네이티브 title — 표 안에서도 안 잘림). 서버/클라이언트 공용. */
export function Term({ t, children }: { t?: string; children: ReactNode }) {
  const key = t ?? (typeof children === 'string' ? children : '');
  const tip = GLOSSARY[key];
  if (!tip) return <>{children}</>;
  return (
    <abbr title={tip} className="no-underline border-b border-dotted border-muted cursor-help">
      {children}
    </abbr>
  );
}
