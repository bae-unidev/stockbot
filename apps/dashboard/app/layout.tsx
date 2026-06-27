import './globals.css';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: 'stockbot 대시보드',
  description: '코스피 자동매매 모니터링 (모의투자)',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ko">
      <body>
        <div className="container">
          <header className="flex items-baseline gap-4 border-b border-panel-border pb-3 mb-5">
            <h1 className="text-lg font-semibold m-0">📈 stockbot</h1>
            <nav className="flex gap-[14px]">
              <a href="/" className="text-muted">실매매 모니터링</a>
              <a href="/backtests" className="text-muted">백테스트</a>
              <a href="/strategy" className="text-muted">전략 설명</a>
            </nav>
            <span className="text-muted ml-auto">모의투자 (paper)</span>
          </header>
          {children}
        </div>
      </body>
    </html>
  );
}
