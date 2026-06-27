import type { Config } from 'tailwindcss';

/** 다크 테마 토큰. 차트 컴포넌트는 별도 hex 사용. */
const config: Config = {
  content: ['./app/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: '#0f1115',
        panel: '#171a21',
        'panel-border': '#262b36',
        ink: '#e6e9ef',
        muted: '#8b93a7',
        up: '#34d399',
        down: '#f87171',
        accent: '#60a5fa',
      },
    },
  },
  plugins: [],
};
export default config;
